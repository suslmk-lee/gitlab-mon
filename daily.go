package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// 데일리 리포트 — 특정 인원의 하루 커밋을 AI로 "그날 한 일"로 요약해 저장/표시.
// 매일 09시 이후 폴링 틱에서 전일 요약을 자동 생성(앱이 켜져 있을 때, catch-up 포함).

const dailyReportHour = 9 // 이 시각(로컬) 이후 전일 요약 자동 생성

type DailyReport struct {
	Date        string   `json:"date"`     // YYYY-MM-DD (로컬)
	Username    string   `json:"username"` // GitLab username (키)
	Name        string   `json:"name"`     // 표시명 (팀원명 > username)
	Team        string   `json:"team"`
	Summary     string   `json:"summary"`      // AI 마크다운 ("" = 미생성)
	CommitCount int      `json:"commit_count"`
	Commits     []string `json:"commits"`      // 근거 커밋 제목(조회 시 채움)
	GeneratedAt string   `json:"generated_at"`
	Error       string   `json:"error"`
}

type DailyTarget struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Team     string `json:"team"`
}

// ensureDailyTable creates the daily_reports table once (idempotent).
func (a *App) ensureDailyTable() {
	if db := a.notesDB(); db != nil {
		_, _ = db.Exec(`CREATE TABLE IF NOT EXISTS daily_reports (
  date TEXT NOT NULL,
  username TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  commit_count INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, username)
)`)
	}
}

// memberByGitLab finds a registered member by GitLab username (case-insensitive).
func (a *App) memberByGitLab(username string) (Member, bool) {
	lu := strings.ToLower(strings.TrimSpace(username))
	for _, m := range a.membersSnapshot() {
		if strings.ToLower(strings.TrimSpace(m.GitLabUsername)) == lu && lu != "" {
			return m, true
		}
	}
	return Member{}, false
}

func (a *App) dailyDisplay(username string) (name, team string) {
	if m, ok := a.memberByGitLab(username); ok {
		teams := a.teamsSnapshot()
		t := ""
		for _, tm := range teams {
			if tm.ID == m.TeamID {
				t = tm.Name
			}
		}
		return m.Name, t
	}
	return username, ""
}

// dailyCommitTitles collects the user's commit titles on the given local date.
func (a *App) dailyCommitTitles(username, date string) []string {
	a.mu.Lock()
	users := a.lastUsers
	a.mu.Unlock()
	resolve := buildUserResolver(users, a.effectiveAliases())
	var titles []string
	a.mu.Lock()
	for _, c := range a.commitCache {
		for _, cm := range c.Commits {
			if cm.Title == "" {
				continue
			}
			if cm.CreatedAt.Local().Format("2006-01-02") != date {
				continue
			}
			if resolve(cm.AuthorName, cm.AuthorEmail) == username {
				titles = append(titles, cm.Title)
			}
		}
	}
	a.mu.Unlock()
	return titles
}

// normalizeDate returns date or yesterday(local) when empty.
func normalizeDailyDate(date string) string {
	date = strings.TrimSpace(date)
	if date == "" {
		return time.Now().Local().AddDate(0, 0, -1).Format("2006-01-02")
	}
	return date
}

// genDailySummary collects commits + runs AI, returning the report (not stored).
func (a *App) genDailySummary(username, date string) DailyReport {
	name, team := a.dailyDisplay(username)
	rep := DailyReport{Date: date, Username: username, Name: name, Team: team}
	titles := a.dailyCommitTitles(username, date)
	rep.Commits = titles
	rep.CommitCount = len(titles)
	rep.GeneratedAt = time.Now().Format(time.RFC3339)
	if len(titles) == 0 {
		rep.Summary = "" // 활동 없음 (요약 생략)
		return rep
	}
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	if cfg.AIKey == "" {
		rep.Error = "AI API 키가 없습니다 — 설정 → AI에서 등록하세요"
		return rep
	}
	var b strings.Builder
	fmt.Fprintf(&b, "개발자: %s\n날짜: %s\n커밋 %d개\n\n커밋 목록:\n", name, date, len(titles))
	for _, t := range titles {
		fmt.Fprintf(&b, "- %s\n", t)
	}
	prompt := "다음은 한 개발자가 하루 동안 작성한 git 커밋 목록입니다. 한국어로 '그날 한 일'을 요약하세요.\n" +
		"- 맨 위 1~2문장 총평\n- 기능/작업 단위로 무엇을 했는지 2~5개 불릿(커밋 prefix feat/fix/refactor 등을 자연스러운 업무 서술로 해석)\n" +
		"원문에 없는 내용은 지어내지 마세요. 마크다운으로만 출력.\n\n---\n" + b.String()
	txt, err := aiComplete(cfg.AIProvider, cfg.AIModel, cfg.AIBaseURL, cfg.AIKey, prompt, 1200)
	if err != nil {
		rep.Error = err.Error()
		return rep
	}
	rep.Summary = strings.TrimSpace(txt)
	return rep
}

// storeDailyReport upserts a generated report.
func (a *App) storeDailyReport(r DailyReport) {
	a.ensureDailyTable()
	db := a.notesDB()
	if db == nil {
		return
	}
	_, _ = db.Exec(`INSERT INTO daily_reports(date,username,summary,commit_count,generated_at) VALUES(?,?,?,?,?)
		ON CONFLICT(date,username) DO UPDATE SET summary=excluded.summary, commit_count=excluded.commit_count, generated_at=excluded.generated_at`,
		r.Date, r.Username, r.Summary, r.CommitCount, r.GeneratedAt)
}

// GetDailyReport returns the stored report (regenerating if missing or force).
// date "" = 어제(로컬).
func (a *App) GetDailyReport(username, date string, force bool) DailyReport {
	username = strings.TrimSpace(username)
	if username == "" {
		return DailyReport{Error: "대상 인원을 선택하세요"}
	}
	date = normalizeDailyDate(date)
	a.ensureDailyTable()
	db := a.notesDB()
	if !force && db != nil {
		var r DailyReport
		row := db.QueryRow(`SELECT date,username,summary,commit_count,generated_at FROM daily_reports WHERE date=? AND username=?`, date, username)
		if row.Scan(&r.Date, &r.Username, &r.Summary, &r.CommitCount, &r.GeneratedAt) == nil {
			r.Name, r.Team = a.dailyDisplay(username)
			r.Commits = a.dailyCommitTitles(username, date)
			return r
		}
	}
	r := a.genDailySummary(username, date)
	if r.Error == "" {
		a.storeDailyReport(r)
	}
	return r
}

// DailyReportTargets lists selectable people (members with GitLab account ∪ contributors).
func (a *App) DailyReportTargets() []DailyTarget {
	seen := map[string]bool{}
	var out []DailyTarget
	add := func(username, name, team string) {
		lu := strings.ToLower(strings.TrimSpace(username))
		if lu == "" || seen[lu] {
			return
		}
		seen[lu] = true
		out = append(out, DailyTarget{Username: username, Name: name, Team: team})
	}
	teams := a.teamsSnapshot()
	teamName := func(id string) string {
		for _, t := range teams {
			if t.ID == id {
				return t.Name
			}
		}
		return ""
	}
	for _, m := range a.membersSnapshot() {
		if m.Active && strings.TrimSpace(m.GitLabUsername) != "" {
			add(m.GitLabUsername, m.Name, teamName(m.TeamID))
		}
	}
	for _, u := range a.WeeklyReportUsers() {
		add(u, u, "")
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ListDailyReports returns recent stored reports for a user (newest first).
func (a *App) ListDailyReports(username string, limit int) []DailyReport {
	a.ensureDailyTable()
	db := a.notesDB()
	if db == nil || strings.TrimSpace(username) == "" {
		return []DailyReport{}
	}
	if limit <= 0 || limit > 60 {
		limit = 30
	}
	rows, err := db.Query(`SELECT date,summary,commit_count,generated_at FROM daily_reports WHERE username=? ORDER BY date DESC LIMIT ?`, username, limit)
	if err != nil {
		return []DailyReport{}
	}
	defer rows.Close()
	name, team := a.dailyDisplay(username)
	out := []DailyReport{}
	for rows.Next() {
		r := DailyReport{Username: username, Name: name, Team: team}
		if rows.Scan(&r.Date, &r.Summary, &r.CommitCount, &r.GeneratedAt) == nil {
			out = append(out, r)
		}
	}
	return out
}

// maybeRunDailyReports auto-generates yesterday's reports for active members with a
// GitLab account, once per day after dailyReportHour. Called from the poll tick.
func (a *App) maybeRunDailyReports() {
	a.mu.Lock()
	cfg := a.cfg
	busy := a.dailyBusy
	done := a.dailyDoneDate
	a.mu.Unlock()
	if busy || cfg.AIKey == "" {
		return
	}
	now := time.Now().Local()
	if now.Hour() < dailyReportHour {
		return
	}
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")
	if done == yesterday {
		return
	}
	// 대상: 활성 멤버 중 GitLab 계정 보유자
	var targets []string
	for _, m := range a.membersSnapshot() {
		if m.Active && strings.TrimSpace(m.GitLabUsername) != "" {
			targets = append(targets, m.GitLabUsername)
		}
	}
	if len(targets) == 0 {
		a.mu.Lock()
		a.dailyDoneDate = yesterday
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.dailyBusy = true
	a.mu.Unlock()
	go func() {
		defer func() {
			a.mu.Lock()
			a.dailyBusy = false
			a.dailyDoneDate = yesterday
			a.mu.Unlock()
		}()
		a.ensureDailyTable()
		db := a.notesDB()
		for _, u := range targets {
			if db != nil { // 이미 생성됨 → 건너뜀
				var n int
				if db.QueryRow(`SELECT 1 FROM daily_reports WHERE date=? AND username=?`, yesterday, u).Scan(&n) == nil {
					continue
				}
			}
			r := a.genDailySummary(u, yesterday)
			if r.Error == "" {
				a.storeDailyReport(r)
			}
		}
	}()
}
