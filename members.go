package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Member is an organization/team member. The roster powers 회의록 참석자 선택과
// git 작성자 매핑(이름·이메일 별칭 → GitLab 계정). 팀 구분은 Team 문자열로(값별 그룹).
type Member struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Team           string   `json:"team"`            // 팀명 (그룹핑용)
	Role           string   `json:"role"`            // 직책/역할 (선택)
	Email          string   `json:"email"`           // 회사 이메일 (선택)
	GitLabUsername string   `json:"gitlab_username"` // git 매핑 대상 계정
	GitAliases     []string `json:"git_aliases"`     // 이 사람의 git author 이름/이메일들
	Active         bool     `json:"active"`
}

func membersPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "members.json"), nil
}

// loadMembers loads the roster from disk (empty on first run — user-managed).
func (a *App) loadMembers() {
	a.mu.Lock()
	a.members = []Member{}
	a.mu.Unlock()
	p, err := membersPath()
	if err != nil {
		return
	}
	var ms []Member
	if loadJSONFile(p, &ms) && ms != nil {
		a.mu.Lock()
		a.members = ms
		a.mu.Unlock()
	}
}

func (a *App) saveMembers() {
	p, err := membersPath()
	if err != nil {
		return
	}
	saveJSONFile(p, a.membersSnapshot())
}

// membersSnapshot returns a copy of the roster for lock-free reads.
func (a *App) membersSnapshot() []Member {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Member, len(a.members))
	copy(out, a.members)
	return out
}

// GetMembers returns the roster for the settings screen / pickers.
func (a *App) GetMembers() []Member {
	return a.membersSnapshot()
}

// SaveMembers replaces the roster, persists it, and re-publishes from cache so
// member-derived git aliases flow into stats/report without a network re-poll.
func (a *App) SaveMembers(ms []Member) string {
	clean := make([]Member, 0, len(ms))
	seen := map[string]bool{}
	for i, m := range ms {
		m.Name = strings.TrimSpace(m.Name)
		if m.Name == "" {
			continue
		}
		m.Team = strings.TrimSpace(m.Team)
		m.GitLabUsername = strings.TrimSpace(m.GitLabUsername)
		// git 별칭 정리(공백 제거, 빈 값 제외)
		cleaned := make([]string, 0, len(m.GitAliases))
		for _, ga := range m.GitAliases {
			if g := strings.TrimSpace(ga); g != "" {
				cleaned = append(cleaned, g)
			}
		}
		m.GitAliases = cleaned
		// 고유 id 보장 (엔티티와 동일 규칙)
		id := strings.TrimSpace(m.ID)
		if id == "" {
			id = fmt.Sprintf("mem-%d", i+1)
		}
		base, k := id, 2
		for seen[id] {
			id = fmt.Sprintf("%s-%d", base, k)
			k++
		}
		seen[id] = true
		m.ID = id
		clean = append(clean, m)
	}
	a.mu.Lock()
	a.members = clean
	a.mu.Unlock()
	a.saveMembers()
	go a.publishFromCache() // 멤버 파생 별칭이 통계/리포트에 반영되도록 재발행
	return ""
}

// effectiveAliases merges manual aliases (aliases.json) with member-derived
// aliases (member git_aliases → gitlab_username). Manual aliases win on conflict
// so an explicit mapping can override the roster. Used at all git-author
// resolution sites; persistence (saveAliases) still uses the pure aliasesSnapshot.
func (a *App) effectiveAliases() map[string]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	m := make(map[string]string, len(a.aliases)+8)
	for _, mem := range a.members { // 멤버 파생 먼저
		if !mem.Active || mem.GitLabUsername == "" {
			continue
		}
		for _, ga := range mem.GitAliases {
			if k := strings.ToLower(strings.TrimSpace(ga)); k != "" {
				m[k] = mem.GitLabUsername
			}
		}
	}
	for k, v := range a.aliases { // 수동 별칭 우선
		m[k] = v
	}
	return m
}
