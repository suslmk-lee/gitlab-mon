package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// WeeklyReportUsers returns the list of GitLab usernames that have any activity
// in the stats window, for the report's user picker.
func (a *App) WeeklyReportUsers() []string {
	a.mu.Lock()
	users := a.lastUsers
	a.mu.Unlock()
	resolve := buildUserResolver(users)

	set := map[string]bool{}
	a.mu.Lock()
	for _, c := range a.cache { // events
		for _, e := range c.Events {
			if u := e.Author.Username; u != "" && !e.Author.IsBot {
				set[u] = true
			}
		}
	}
	for _, c := range a.commitCache {
		for _, cm := range c.Commits {
			set[resolve(cm.AuthorName, cm.AuthorEmail)] = true
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
	apiKey := a.cfg.AnthropicKey
	// 프로젝트 메타(경로/URL)
	projMeta := map[int]gitlab.Project{}
	for _, p := range a.snap.Projects {
		projMeta[p.ID] = p
	}
	a.mu.Unlock()
	rep.HasAIKey = apiKey != ""
	resolve := buildUserResolver(users)

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

// SummarizeWeek sends the structured report to the Claude API and returns a
// Korean prose weekly summary. Requires ANTHROPIC_API_KEY.
func (a *App) SummarizeWeek(username string, offset int) string {
	a.mu.Lock()
	apiKey := a.cfg.AnthropicKey
	a.mu.Unlock()
	if apiKey == "" {
		return "ERR:ANTHROPIC_API_KEY가 설정되지 않았습니다 (env.local 또는 Keychain)"
	}

	rep := a.WeeklyReport(username, offset)
	if rep.Error != "" {
		return "ERR:" + rep.Error
	}

	// 보고서를 텍스트로 직렬화
	var b strings.Builder
	fmt.Fprintf(&b, "사용자: %s\n기간: %s ~ %s\n", rep.Username, rep.WeekStart, rep.WeekEnd)
	fmt.Fprintf(&b, "전체: 커밋 %d, +%d/-%d 라인, 머지 %d, MR생성 %d\n\n",
		rep.TotalCommits, rep.TotalAdd, rep.TotalDel, rep.MergedCount, rep.OpenedCount)
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

	prompt := "다음은 한 개발자의 일주일치 git/MR 활동 데이터입니다. 이를 바탕으로 " +
		"한국어로 주간 업무 보고서를 작성하세요. 프로젝트별로 무슨 작업을 했는지 " +
		"기능 단위로 묶어 3~6개의 불릿으로 요약하고, 맨 위에 2~3문장 총평을 넣으세요. " +
		"커밋 메시지의 prefix(feat/fix 등)와 내용을 해석해 자연스러운 업무 서술로 바꾸세요.\n\n" + b.String()

	reqBody, _ := json.Marshal(map[string]any{
		"model":      "claude-haiku-4-5-20251001",
		"max_tokens": 1500,
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(reqBody))
	if err != nil {
		return "ERR:" + err.Error()
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return "ERR:" + err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "ERR:Claude API " + resp.Status + " — " + string(body[:min(len(body), 200)])
	}
	var out struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(body, &out) != nil || len(out.Content) == 0 {
		return "ERR:응답 파싱 실패"
	}
	return out.Content[0].Text
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
