package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gitlab-mon/internal/gitlab"
)

func itoa(n int) string { return strconv.Itoa(n) }

// WeekProjectWork is one project's work by a user within the week.
type WeekProjectWork struct {
	Path        string   `json:"path"`
	WebURL      string   `json:"web_url"`
	CommitCount int      `json:"commit_count"`
	Add         int      `json:"add"`
	Del         int      `json:"del"`
	CommitMsgs  []string `json:"commit_msgs"` // 커밋 제목
	MergedMRs   []string `json:"merged_mrs"`  // "!iid 제목"
	OpenedMRs   []string `json:"opened_mrs"`
	Branches    []string `json:"branches"` // push된 브랜치
}

// WeekDay is per-day activity counts for the timeline.
type WeekDay struct {
	Day     string `json:"day"`
	Commits int    `json:"commits"`
	Add     int    `json:"add"`
	Del     int    `json:"del"`
}

// WeekReport is the structured weekly report for one user.
type WeekReport struct {
	Username     string            `json:"username"`
	WeekStart    string            `json:"week_start"` // YYYY-MM-DD (월)
	WeekEnd      string            `json:"week_end"`   // YYYY-MM-DD (일)
	WeekOffset   int               `json:"week_offset"`
	TotalCommits int               `json:"total_commits"`
	TotalAdd     int               `json:"total_add"`
	TotalDel     int               `json:"total_del"`
	MergedCount  int               `json:"merged_count"`
	OpenedCount  int               `json:"opened_count"`
	Projects     []WeekProjectWork `json:"projects"`
	Days         []WeekDay         `json:"days"`
	HasAIKey     bool              `json:"has_ai_key"`
	Error        string            `json:"error"`
}

// weekRange returns [Monday 00:00, next Monday 00:00) for the given offset
// (0 = this week, 1 = last week …) in local time.
func weekRange(offset int) (time.Time, time.Time) {
	now := time.Now()
	wd := int(now.Weekday()) // Sun=0..Sat=6
	if wd == 0 {
		wd = 7
	}
	monday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).
		AddDate(0, 0, -(wd - 1))
	start := monday.AddDate(0, 0, -7*offset)
	return start, start.AddDate(0, 0, 7)
}

// Author identities filtered out of contributor lists, matched by lowercased name:
//
//	systemAuthors  — admin/system accounts.
//	junkAuthors    — pure CI/template placeholders that are never a person.
//	genericAuthors — default tool/OS git names; usually automation or a
//	                 misconfigured commit, so hidden from the picker/stats — but
//	                 kept in the 사용자 매핑 후보 목록 since they MAY be a real
//	                 person, who can then be mapped onto their GitLab account.
var systemAuthors = map[string]bool{"root": true, "ghost": true}
var junkAuthors = map[string]bool{
	"gitlab_user_name":           true, // GitLab CI 템플릿 placeholder
	"your_github_id_with_access": true,
	"ci_commit_author":           true,
}
var genericAuthors = map[string]bool{
	"claude": true, // Claude Code AI 커밋 author
	"ubuntu": true, // 서버 기본 git user.name
}

// isBotUsername reports whether a username is an automation/bot account.
// lastUsers (admin /users) doesn't carry a reliable is_bot flag, so we match by
// name pattern: group/project access-token bots (botUserRe) plus common CI bots.
func isBotUsername(u string) bool {
	if botUserRe.MatchString(u) {
		return true
	}
	lu := strings.ToLower(u)
	return lu == "gitlab-ci" || lu == "renovate" ||
		strings.HasSuffix(lu, "-bot") || strings.HasSuffix(lu, "_bot") ||
		strings.Contains(lu, "_bot_")
}

// isExcludedAuthor reports whether a resolved author should be hidden from
// contributor lists (the weekly picker and the code-daily stats). Applied in one
// place so the report and stats agree on who counts as a contributor.
func isExcludedAuthor(u string) bool {
	lu := strings.ToLower(u)
	return isBotUsername(u) || systemAuthors[lu] || junkAuthors[lu] || genericAuthors[lu]
}

// isUnmappableNoise reports whether an author is pure automation/placeholder that
// should never be offered as a mapping candidate. Unlike isExcludedAuthor it
// keeps genericAuthors (ubuntu/claude), which may be a real person to map.
func isUnmappableNoise(u string) bool {
	lu := strings.ToLower(u)
	return isBotUsername(u) || systemAuthors[lu] || junkAuthors[lu]
}

// WeeklyReportUsers returns the contributors with activity in the stats window,
// for the report's user picker. Commit authors are canonicalized through
// buildUserResolver (+ the alias map), so duplicate identities of one person
// collapse onto their GitLab username. Bots, system accounts, and placeholder
// identities are filtered out; a genuine but unmatched author (e.g. committing
// from a personal laptop) stays visible so their commits aren't lost — connect
// them to a GitLab user in the 사용자 매핑 screen (seeded by defaultAliases).
func (a *App) WeeklyReportUsers() []string {
	a.mu.Lock()
	users := a.lastUsers
	a.mu.Unlock()
	resolve := buildUserResolver(users, a.effectiveAliases())

	set := map[string]bool{}
	add := func(u string) {
		if u == "" || isExcludedAuthor(u) {
			return
		}
		set[u] = true
	}

	a.mu.Lock()
	for _, c := range a.cache { // events: author는 이미 GitLab username
		for _, e := range c.Events {
			if !e.Author.IsBot {
				add(e.Author.Username)
			}
		}
	}
	for _, c := range a.commitCache { // commits: 별칭/유저 매핑 후 후보로
		for _, cm := range c.Commits {
			add(resolve(cm.AuthorName, cm.AuthorEmail))
		}
	}
	a.mu.Unlock()

	out := make([]string, 0, len(set))
	for u := range set {
		out = append(out, u)
	}
	sort.Strings(out)
	return out
}

// WeeklyReport builds the structured weekly report for a user.
func (a *App) WeeklyReport(username string, offset int) WeekReport {
	start, end := weekRange(offset)
	rep := WeekReport{
		Username:   username,
		WeekStart:  start.Format("2006-01-02"),
		WeekEnd:    end.AddDate(0, 0, -1).Format("2006-01-02"),
		WeekOffset: offset,
	}
	if username == "" {
		rep.Error = "사용자를 선택하세요"
		return rep
	}

	a.mu.Lock()
	users := a.lastUsers
	hasAI := a.cfg.AIKey != ""
	// 프로젝트 메타(경로/URL)
	projMeta := map[int]gitlab.Project{}
	for _, p := range a.snap.Projects {
		projMeta[p.ID] = p
	}
	a.mu.Unlock()
	rep.HasAIKey = hasAI
	resolve := buildUserResolver(users, a.effectiveAliases())

	inWeek := func(t time.Time) bool { return !t.Before(start) && t.Before(end) }

	type pw struct {
		work    *WeekProjectWork
		commits map[string]bool
		brSet   map[string]bool
	}
	byProj := map[int]*pw{}
	getProj := func(id int) *pw {
		w := byProj[id]
		if w == nil {
			p := projMeta[id]
			w = &pw{
				work:    &WeekProjectWork{Path: p.PathWithNamespace, WebURL: p.WebURL},
				commits: map[string]bool{},
				brSet:   map[string]bool{},
			}
			if w.work.Path == "" {
				w.work.Path = "project #" + itoa(id)
			}
			byProj[id] = w
		}
		return w
	}
	days := map[string]*WeekDay{}

	// 커밋 (코드 변경량 + 메시지)
	a.mu.Lock()
	for pid, c := range a.commitCache {
		for _, cm := range c.Commits {
			if !inWeek(cm.CreatedAt) || resolve(cm.AuthorName, cm.AuthorEmail) != username {
				continue
			}
			w := getProj(pid)
			if w.commits[cm.SHA] {
				continue
			}
			w.commits[cm.SHA] = true
			w.work.CommitCount++
			w.work.Add += cm.Add
			w.work.Del += cm.Del
			if cm.Title != "" {
				w.work.CommitMsgs = append(w.work.CommitMsgs, cm.Title)
			}
			rep.TotalCommits++
			rep.TotalAdd += cm.Add
			rep.TotalDel += cm.Del
			d := cm.CreatedAt.Local().Format("2006-01-02")
			day := days[d]
			if day == nil {
				day = &WeekDay{Day: d}
				days[d] = day
			}
			day.Commits++
			day.Add += cm.Add
			day.Del += cm.Del
		}
	}
	// 이벤트 (MR open/merge, push 브랜치)
	for pid, c := range a.cache {
		for _, e := range c.Events {
			if !inWeek(e.CreatedAt) || e.Author.Username != username {
				continue
			}
			k := eventKindGo(e)
			switch {
			case k == "merge":
				w := getProj(pid)
				w.work.MergedMRs = append(w.work.MergedMRs, "!"+itoa(e.TargetIID)+" "+e.TargetTitle)
				rep.MergedCount++
			case k == "mr" && e.ActionName == "opened":
				w := getProj(pid)
				w.work.OpenedMRs = append(w.work.OpenedMRs, "!"+itoa(e.TargetIID)+" "+e.TargetTitle)
				rep.OpenedCount++
			case k == "push" && e.PushData != nil && e.PushData.Ref != "":
				w := getProj(pid)
				if !w.brSet[e.PushData.Ref] {
					w.brSet[e.PushData.Ref] = true
					w.work.Branches = append(w.work.Branches, e.PushData.Ref)
				}
			}
		}
	}
	a.mu.Unlock()

	for _, w := range byProj {
		rep.Projects = append(rep.Projects, *w.work)
	}
	sort.Slice(rep.Projects, func(i, j int) bool {
		pi, pj := rep.Projects[i], rep.Projects[j]
		si := pi.CommitCount + len(pi.MergedMRs)*5 + len(pi.OpenedMRs)*3
		sj := pj.CommitCount + len(pj.MergedMRs)*5 + len(pj.OpenedMRs)*3
		return si > sj
	})

	// 일별 타임라인 (월~일 7일 채움)
	for i := 0; i < 7; i++ {
		d := start.AddDate(0, 0, i).Format("2006-01-02")
		if day, ok := days[d]; ok {
			rep.Days = append(rep.Days, *day)
		} else {
			rep.Days = append(rep.Days, WeekDay{Day: d})
		}
	}
	return rep
}

// SummarizeWeek sends the week's commit/MR activity to the configured AI provider
// and returns a Korean weekly report + per-day work log (markdown).
func (a *App) SummarizeWeek(username string, offset int) string {
	a.mu.Lock()
	cfg := a.cfg
	users := a.lastUsers
	a.mu.Unlock()
	if cfg.AIKey == "" {
		return "ERR:AI API 키가 없습니다 — 설정 → AI에서 등록하세요"
	}

	rep := a.WeeklyReport(username, offset)
	if rep.Error != "" {
		return "ERR:" + rep.Error
	}

	start, end := weekRange(offset)
	inWeek := func(t time.Time) bool { return !t.Before(start) && t.Before(end) }
	resolve := buildUserResolver(users, a.effectiveAliases())

	// 일자별 커밋 제목 수집 (일간 업무 내역용)
	dayMsgs := map[string][]string{}
	a.mu.Lock()
	for _, c := range a.commitCache {
		for _, cm := range c.Commits {
			if cm.Title != "" && inWeek(cm.CreatedAt) && resolve(cm.AuthorName, cm.AuthorEmail) == username {
				d := cm.CreatedAt.Local().Format("2006-01-02")
				dayMsgs[d] = append(dayMsgs[d], cm.Title)
			}
		}
	}
	a.mu.Unlock()

	var b strings.Builder
	fmt.Fprintf(&b, "사용자: %s\n기간: %s ~ %s\n전체: 커밋 %d, +%d/-%d 라인, 머지 %d, MR생성 %d\n\n",
		rep.Username, rep.WeekStart, rep.WeekEnd, rep.TotalCommits, rep.TotalAdd, rep.TotalDel, rep.MergedCount, rep.OpenedCount)
	b.WriteString("# 프로젝트별 활동\n")
	for _, p := range rep.Projects {
		fmt.Fprintf(&b, "## %s (커밋 %d, +%d/-%d)\n", p.Path, p.CommitCount, p.Add, p.Del)
		for _, m := range p.MergedMRs {
			fmt.Fprintf(&b, "- 머지: %s\n", m)
		}
		for _, m := range p.OpenedMRs {
			fmt.Fprintf(&b, "- MR생성: %s\n", m)
		}
		for _, c := range p.CommitMsgs {
			fmt.Fprintf(&b, "- 커밋: %s\n", c)
		}
		b.WriteString("\n")
	}
	b.WriteString("# 일자별 커밋\n")
	for i := 0; i < 7; i++ {
		d := start.AddDate(0, 0, i).Format("2006-01-02")
		if msgs := dayMsgs[d]; len(msgs) > 0 {
			fmt.Fprintf(&b, "## %s\n", d)
			for _, m := range msgs {
				fmt.Fprintf(&b, "- %s\n", m)
			}
		}
	}

	prompt := "다음은 한 개발자의 일주일치 git/MR 활동 데이터입니다. 한국어로 아래 두 부분을 마크다운으로 정리하세요.\n\n" +
		"## 주간 업무 보고\n맨 위 2~3문장 총평 후, 프로젝트·기능 단위로 무슨 일을 했는지 3~6개 불릿. 커밋 prefix(feat/fix 등)와 내용을 자연스러운 업무 서술로 해석.\n\n" +
		"## 일간 업무 내역\n'일자별 커밋'을 바탕으로 날짜별(YYYY-MM-DD)로 그날 한 일을 1~3개 불릿으로 요약. 커밋 없는 날은 생략.\n\n" +
		"원문에 없는 내용은 지어내지 마세요.\n\n---\n" + b.String()

	txt, err := aiComplete(cfg.AIProvider, cfg.AIModel, cfg.AIBaseURL, cfg.AIKey, prompt, 2000)
	if err != nil {
		return "ERR:" + err.Error()
	}
	return txt
}

// eventKindGo mirrors the frontend eventKind classification.
func eventKindGo(e gitlab.Event) string {
	a := e.ActionName
	if strings.HasPrefix(a, "pushed") || e.PushData != nil {
		return "push"
	}
	if a == "accepted" {
		return "merge"
	}
	if e.TargetType == "MergeRequest" {
		return "mr"
	}
	if strings.HasPrefix(a, "commented") {
		return "comment"
	}
	return "other"
}
