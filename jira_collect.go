package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"gitlab-mon/internal/jira"
)

const jiraCacheVersion = 2 // 2: parent 필드 추가

type jiraCacheFile struct {
	Version    int                    `json:"version"`
	WindowDays int                    `json:"window_days"`
	FetchedAt  time.Time              `json:"fetched_at"`
	Issues     map[string]*jira.Issue `json:"issues"` // key → issue
}

func jiraCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "jira-cache.json"), nil
}

func (a *App) loadJiraCache() {
	if p, err := jiraCachePath(); err == nil {
		var f jiraCacheFile
		if loadJSONFile(p, &f) && f.Version == jiraCacheVersion && f.WindowDays == statsWindowDay && f.Issues != nil {
			a.mu.Lock()
			a.jiraCache = f.Issues
			a.jiraFetchedAt = f.FetchedAt
			a.mu.Unlock()
		}
	}
}

func (a *App) saveJiraCache() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, err := jiraCachePath(); err == nil {
		saveJSONFile(p, jiraCacheFile{Version: jiraCacheVersion, WindowDays: statsWindowDay, FetchedAt: a.jiraFetchedAt, Issues: a.jiraCache})
	}
}

// collectJira incrementally syncs Jira issues. Slow-cycle only (5분 주기):
// 첫 수집은 '열린 이슈 + 윈도우 내 업데이트' 전체, 이후엔 마지막 수집
// 이후 업데이트된 이슈만 가져와 키 기준으로 병합한다.
func (a *App) collectJira(client *jira.Client, since time.Time) error {
	a.mu.Lock()
	last := a.jiraFetchedAt
	empty := len(a.jiraCache) == 0
	a.mu.Unlock()

	var jql string
	if empty || last.IsZero() {
		jql = fmt.Sprintf("(statusCategory != Done OR updated >= %q) ORDER BY updated DESC",
			since.Format("2006-01-02"))
	} else {
		// 10분 오버랩, 분 단위 포맷 (JQL은 "yyyy-MM-dd HH:mm")
		overlap := last.Add(-10 * time.Minute)
		jql = fmt.Sprintf("updated >= %q ORDER BY updated DESC", overlap.Format("2006-01-02 15:04"))
	}

	now := time.Now()
	issues, err := client.SearchIssues(jql, 10)
	if err != nil {
		return err
	}

	a.mu.Lock()
	for i := range issues {
		is := issues[i]
		a.jiraCache[is.Key] = &is
	}
	// 윈도우 밖으로 벗어난 완료 이슈는 정리 (열린 이슈는 오래돼도 유지)
	for k, is := range a.jiraCache {
		if is.StatusCategory == "done" && is.Updated.Before(since) {
			delete(a.jiraCache, k)
		}
	}
	a.jiraFetchedAt = now
	a.mu.Unlock()
	return nil
}

// JiraMove transitions an issue to the workflow state whose status name is
// targetStatus (드래그&드롭 칸반 이동). Returns "" on success or an error message.
// 성공 시 해당 이슈만 재조회해 캐시·스냅샷을 즉시 갱신한다 (전체 재동기화 없음).
func (a *App) JiraMove(key, targetStatus string) string {
	a.mu.Lock()
	jc := a.jiraClient
	a.mu.Unlock()
	if jc == nil {
		return "Jira가 설정되지 않았습니다"
	}

	trs, err := jc.GetTransitions(key)
	if err != nil {
		return err.Error()
	}
	id := ""
	for _, t := range trs {
		if t.ToStatus == targetStatus {
			id = t.ID
			break
		}
	}
	if id == "" {
		return key + ": '" + targetStatus + "' 상태로의 전환이 워크플로우에 없습니다"
	}
	if err := jc.Transition(key, id); err != nil {
		return err.Error()
	}

	// 변경된 이슈만 재조회해 즉시 반영
	if is, err := jc.GetIssue(key); err == nil {
		a.mu.Lock()
		a.jiraCache[key] = &is
		for i := range a.snap.JiraIssues {
			if a.snap.JiraIssues[i].Key == key {
				a.snap.JiraIssues[i] = is
			}
		}
		snap := a.snap
		a.mu.Unlock()
		a.publish(snap)
		a.saveJiraCache()
	}
	return ""
}

// aggregateJira flattens the issue cache, newest-updated first.
func (a *App) aggregateJira() []jira.Issue {
	a.mu.Lock()
	out := make([]jira.Issue, 0, len(a.jiraCache))
	for _, is := range a.jiraCache {
		out = append(out, *is)
	}
	a.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}
