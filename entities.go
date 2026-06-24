package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Entity is a first-class PoC/work unit — a project or a company(거래처) — that
// aggregates GitLab/Jira/Confluence (and later, notes) across the app. It
// replaces the previously hardcoded frontend PRODUCTS + backend
// confluenceProducts registries with one user-managed source of truth.
type Entity struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`             // "project" | "company"
	GitLabGroups    []string `json:"gitlab_groups"`    // 최상위 그룹 prefix (예: "akashiq")
	JiraKeys        []string `json:"jira_keys"`        // Jira 프로젝트 키
	ConfluenceQuery string   `json:"confluence_query"` // CQL text 매칭어 (빈 값이면 Name 사용)
	Aliases         []string `json:"aliases"`          // 이름 별칭(검색·매칭용)
	Accent          string   `json:"accent"`           // CSS 색 (UI 액센트)
	Active          bool     `json:"active"`
}

// cqlQuery returns the Confluence text-match term for this entity.
func (e Entity) cqlQuery() string {
	if strings.TrimSpace(e.ConfluenceQuery) != "" {
		return e.ConfluenceQuery
	}
	return e.Name
}

// defaultEntities seeds the registry on first run, migrating the prior hardcoded
// AkashiQ/KosmosAI mapping so existing behavior is preserved.
var defaultEntities = []Entity{
	{ID: "akashiq", Name: "AkashiQ", Kind: "project", GitLabGroups: []string{"akashiq"}, JiraKeys: []string{"KSHQ", "AK"}, ConfluenceQuery: "AkashiQ", Accent: "var(--accent)", Active: true},
	{ID: "kosmos", Name: "KosmosAI", Kind: "project", GitLabGroups: []string{"kosmos"}, JiraKeys: []string{"KU"}, ConfluenceQuery: "KosmosAI", Accent: "var(--purple)", Active: true},
}

func entitiesPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "entities.json"), nil
}

// loadEntities loads the registry from disk, seeding+persisting defaults on first
// run so AkashiQ/KosmosAI appear and stay editable in the settings screen.
func (a *App) loadEntities() {
	p, err := entitiesPath()
	if err != nil {
		return
	}
	var es []Entity
	if loadJSONFile(p, &es) && len(es) > 0 {
		a.mu.Lock()
		a.entities = es
		a.mu.Unlock()
		return
	}
	seed := make([]Entity, len(defaultEntities))
	copy(seed, defaultEntities)
	a.mu.Lock()
	a.entities = seed
	a.mu.Unlock()
	a.saveEntities()
}

func (a *App) saveEntities() {
	p, err := entitiesPath()
	if err != nil {
		return
	}
	saveJSONFile(p, a.entitiesSnapshot())
}

// entitiesSnapshot returns a copy of the registry for lock-free reads.
func (a *App) entitiesSnapshot() []Entity {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Entity, len(a.entities))
	copy(out, a.entities)
	return out
}

// GetEntities returns the registry for the settings screen.
func (a *App) GetEntities() []Entity {
	return a.entitiesSnapshot()
}

// SaveEntities replaces the registry, persists it, and re-publishes from cache so
// the change flows into hubs/collection. Returns "" on success or an error.
func (a *App) SaveEntities(es []Entity) string {
	clean := make([]Entity, 0, len(es))
	for _, e := range es {
		e.ID = strings.TrimSpace(e.ID)
		e.Name = strings.TrimSpace(e.Name)
		if e.ID == "" || e.Name == "" {
			continue
		}
		if e.Kind != "company" {
			e.Kind = "project"
		}
		clean = append(clean, e)
	}
	a.mu.Lock()
	a.entities = clean
	a.mu.Unlock()
	a.saveEntities()
	go a.publishFromCache() // 네트워크 없이 스냅샷의 Entities 갱신
	return ""
}
