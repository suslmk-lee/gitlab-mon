package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gitlab-mon/internal/gitlab"
)

// commitStat is one default-branch commit's line stats.
type commitStat struct {
	SHA         string    `json:"sha"`
	AuthorName  string    `json:"author_name"`
	AuthorEmail string    `json:"author_email"`
	CreatedAt   time.Time `json:"created_at"`
	Add         int       `json:"add"`
	Del         int       `json:"del"`
}

// projCommits caches one project's commits within the stats window.
type projCommits struct {
	LastActivity time.Time    `json:"last_activity"`
	Commits      []commitStat `json:"commits"`
}

type commitsCacheFile struct {
	WindowDays int                  `json:"window_days"`
	Projects   map[int]*projCommits `json:"projects"`
}

// CodeDay is per-user-per-day line stats shipped to the frontend.
type CodeDay struct {
	User    string `json:"user"` // GitLab username (매핑 성공 시) 또는 git author name
	Day     string `json:"day"`  // YYYY-MM-DD
	Add     int    `json:"add"`
	Del     int    `json:"del"`
	Commits int    `json:"commits"`
}

func commitsCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "commits-cache.json"), nil
}

func (a *App) loadCommitsCache() {
	if p, err := commitsCachePath(); err == nil {
		var f commitsCacheFile
		if loadJSONFile(p, &f) && f.WindowDays == statsWindowDay && f.Projects != nil {
			a.mu.Lock()
			a.commitCache = f.Projects
			a.mu.Unlock()
		}
	}
}

func (a *App) saveCommitsCache() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, err := commitsCachePath(); err == nil {
		saveJSONFile(p, commitsCacheFile{WindowDays: statsWindowDay, Projects: a.commitCache})
	}
}

// collectCommits incrementally fetches default-branch commit stats for
// projects whose activity moved (same trigger as events), keeping load near
// zero in steady state: only the newest commits since the last seen one.
func (a *App) collectCommits(client *gitlab.Client, projects []gitlab.Project, since time.Time) {
	type job struct {
		p     gitlab.Project
		since time.Time
	}
	a.mu.Lock()
	var jobs []job
	active := make(map[int]bool, len(projects))
	for _, p := range projects {
		if p.LastActivityAt.Before(since) {
			continue
		}
		active[p.ID] = true
		c, ok := a.commitCache[p.ID]
		switch {
		case !ok:
			jobs = append(jobs, job{p, since}) // 첫 수집: 윈도우 전체
		case p.LastActivityAt.After(c.LastActivity):
			// 증분: 캐시된 최신 커밋 이후만 (1시간 오버랩, SHA로 dedupe)
			after := since
			if len(c.Commits) > 0 && c.Commits[0].CreatedAt.After(after) {
				after = c.Commits[0].CreatedAt.Add(-1 * time.Hour)
			}
			jobs = append(jobs, job{p, after})
		}
	}
	for id := range a.commitCache {
		if !active[id] {
			delete(a.commitCache, id)
		}
	}
	a.mu.Unlock()

	total := len(jobs)
	if total > 0 {
		a.emitProgress("커밋", 0, total)
	}
	var (
		done int
		sem  = make(chan struct{}, fetchWorkers)
		wg   sync.WaitGroup
	)
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			commits, err := client.GetProjectCommits(j.p.ID, j.since.UTC().Format(time.RFC3339), maxFetchPages)

			a.mu.Lock()
			if err == nil {
				c := a.commitCache[j.p.ID]
				if c == nil {
					c = &projCommits{}
					a.commitCache[j.p.ID] = c
				}
				seen := make(map[string]bool, len(commits))
				merged := make([]commitStat, 0, len(commits)+len(c.Commits))
				for _, cm := range commits {
					if seen[cm.ID] {
						continue
					}
					seen[cm.ID] = true
					cs := commitStat{SHA: cm.ID, AuthorName: cm.AuthorName, AuthorEmail: cm.AuthorEmail, CreatedAt: cm.CreatedAt}
					if cm.Stats != nil {
						cs.Add, cs.Del = cm.Stats.Additions, cm.Stats.Deletions
					}
					merged = append(merged, cs)
				}
				for _, cs := range c.Commits {
					if !seen[cs.SHA] && !cs.CreatedAt.Before(since) {
						seen[cs.SHA] = true
						merged = append(merged, cs)
					}
				}
				sort.Slice(merged, func(x, y int) bool { return merged[x].CreatedAt.After(merged[y].CreatedAt) })
				c.Commits = merged
				c.LastActivity = j.p.LastActivityAt
			}
			done++
			d := done
			a.mu.Unlock()
			a.emitProgress("커밋", d, total)
		}(j)
	}
	wg.Wait()
}

// aggregateCodeDaily rolls the commit cache up to per-user-per-day rows,
// resolving git author identities to GitLab usernames where possible.
func (a *App) aggregateCodeDaily(users []gitlab.User, since time.Time) []CodeDay {
	byEmail := map[string]string{}
	byName := map[string]string{}
	for _, u := range users {
		if u.Email != "" {
			byEmail[strings.ToLower(u.Email)] = u.Username
		}
		if u.PublicEmail != "" {
			byEmail[strings.ToLower(u.PublicEmail)] = u.Username
		}
		if u.Name != "" {
			byName[strings.ToLower(u.Name)] = u.Username
		}
		byName[strings.ToLower(u.Username)] = u.Username
	}
	resolve := func(name, email string) string {
		e := strings.ToLower(email)
		if u, ok := byEmail[e]; ok {
			return u
		}
		if i := strings.IndexByte(e, '@'); i > 0 {
			if u, ok := byName[e[:i]]; ok {
				return u
			}
		}
		if u, ok := byName[strings.ToLower(name)]; ok {
			return u
		}
		return name // 매핑 실패: git author name 그대로
	}

	type key struct{ user, day string }
	agg := map[key]*CodeDay{}
	a.mu.Lock()
	for _, c := range a.commitCache {
		for _, cm := range c.Commits {
			if cm.CreatedAt.Before(since) {
				continue
			}
			k := key{resolve(cm.AuthorName, cm.AuthorEmail), cm.CreatedAt.Local().Format("2006-01-02")}
			row := agg[k]
			if row == nil {
				row = &CodeDay{User: k.user, Day: k.day}
				agg[k] = row
			}
			row.Add += cm.Add
			row.Del += cm.Del
			row.Commits++
		}
	}
	a.mu.Unlock()

	out := make([]CodeDay, 0, len(agg))
	for _, r := range agg {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Day != out[j].Day {
			return out[i].Day > out[j].Day
		}
		return out[i].User < out[j].User
	})
	return out
}
