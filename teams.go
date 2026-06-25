package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Team is a first-class org unit. Members reference a team by ID; the 팀 설정
// 화면에서 관리한다. (별도 레지스트리 teams.json)
type Team struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Accent string `json:"accent"` // CSS 색 (UI 액센트)
	Active bool   `json:"active"`
}

func teamsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "teams.json"), nil
}

// loadTeams loads the team registry from disk (empty on first run).
func (a *App) loadTeams() {
	a.mu.Lock()
	a.teams = []Team{}
	a.mu.Unlock()
	p, err := teamsPath()
	if err != nil {
		return
	}
	var ts []Team
	if loadJSONFile(p, &ts) && ts != nil {
		a.mu.Lock()
		a.teams = ts
		a.mu.Unlock()
	}
}

func (a *App) saveTeams() {
	p, err := teamsPath()
	if err != nil {
		return
	}
	saveJSONFile(p, a.teamsSnapshot())
}

// teamsSnapshot returns a copy of the registry for lock-free reads.
func (a *App) teamsSnapshot() []Team {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Team, len(a.teams))
	copy(out, a.teams)
	return out
}

// GetTeams returns the team registry for the settings screen / pickers.
func (a *App) GetTeams() []Team {
	return a.teamsSnapshot()
}

// SaveTeams replaces the registry, ensuring unique non-empty IDs, and persists it.
func (a *App) SaveTeams(ts []Team) string {
	clean := make([]Team, 0, len(ts))
	seen := map[string]bool{}
	for i, t := range ts {
		t.Name = strings.TrimSpace(t.Name)
		if t.Name == "" {
			continue
		}
		id := strings.TrimSpace(t.ID)
		if id == "" {
			id = fmt.Sprintf("team-%d", i+1)
		}
		base, k := id, 2
		for seen[id] {
			id = fmt.Sprintf("%s-%d", base, k)
			k++
		}
		seen[id] = true
		t.ID = id
		clean = append(clean, t)
	}
	a.mu.Lock()
	a.teams = clean
	a.mu.Unlock()
	a.saveTeams()
	return ""
}
