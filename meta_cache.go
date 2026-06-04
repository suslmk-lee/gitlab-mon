package main

import (
	"os"
	"path/filepath"
	"time"

	"gitlab-mon/internal/gitlab"
)

// metaCache persists the small, slow-changing parts of a snapshot so the UI
// can render instantly from disk on startup, before the first poll finishes.
type metaCache struct {
	WindowDays int                   `json:"window_days"`
	FetchedAt  time.Time             `json:"fetched_at"`
	Version    *gitlab.Version       `json:"version"`
	Stats      *gitlab.Statistics    `json:"stats"`
	Groups     []gitlab.Group        `json:"groups"`
	Users      []gitlab.User         `json:"users"`
	Projects   []gitlab.Project      `json:"projects"` // full list (enrichment용)
	OpenMRs    []gitlab.MergeRequest `json:"open_mrs"`
	MergedMRs  []gitlab.MergeRequest `json:"merged_mrs"`
}

func metaCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "meta-cache.json"), nil
}

func (a *App) saveMeta(m *metaCache) {
	if p, err := metaCachePath(); err == nil {
		saveJSONFile(p, m)
	}
}

// publishFromCache assembles a snapshot purely from persisted caches and
// publishes it, so the app shows data within ~1s of launch. The regular poll
// loop then refreshes it incrementally.
func (a *App) publishFromCache() {
	p, err := metaCachePath()
	if err != nil {
		return
	}
	var m metaCache
	if !loadJSONFile(p, &m) || m.WindowDays != statsWindowDay || m.FetchedAt.IsZero() {
		return
	}

	a.mu.Lock()
	cfg := a.cfg
	// slow 메타데이터를 미리 채워 첫 사이클에서도 재사용 가능하게
	if a.lastVersion == nil {
		a.lastVersion = m.Version
	}
	if a.lastStats == nil {
		a.lastStats = m.Stats
	}
	if a.lastGroups == nil {
		a.lastGroups = m.Groups
	}
	if a.lastUsers == nil {
		a.lastUsers = m.Users
	}
	a.mu.Unlock()

	since := time.Now().Add(-statsWindow)
	events := a.aggregateEvents(since)
	pipelines := a.aggregatePipelines(since)
	codeDaily := a.aggregateCodeDaily(m.Users, since)

	// MR 리뷰 캐시 enrich
	a.mu.Lock()
	for _, mrs := range [][]gitlab.MergeRequest{m.OpenMRs, m.MergedMRs} {
		for i := range mrs {
			if c, ok := a.mrCache[mrs[i].ID]; ok {
				mrs[i].FirstReviewAt = c.FirstReviewAt
				mrs[i].FirstReviewer = c.FirstReviewer
				mrs[i].Approvers = c.Approvers
			}
		}
	}
	a.mu.Unlock()

	enrichAll(events, pipelines, [][]gitlab.MergeRequest{m.OpenMRs, m.MergedMRs}, m.Projects, m.Groups)

	projects := m.Projects
	if len(projects) > 30 {
		projects = projects[:30]
	}
	if events == nil {
		events = []gitlab.Event{}
	}
	if pipelines == nil {
		pipelines = []gitlab.Pipeline{}
	}
	if codeDaily == nil {
		codeDaily = []CodeDay{}
	}
	if m.OpenMRs == nil {
		m.OpenMRs = []gitlab.MergeRequest{}
	}
	if m.MergedMRs == nil {
		m.MergedMRs = []gitlab.MergeRequest{}
	}
	if projects == nil {
		projects = []gitlab.Project{}
	}

	a.publish(Snapshot{
		FetchedAt: m.FetchedAt, // 과거 시각 그대로 → UI에 "N분 전 갱신"으로 정직하게 표시
		GitLabURL: cfg.GitLabURL,
		Version:   m.Version,
		Stats:     m.Stats,
		Events:    events,
		Projects:  projects,
		OpenMRs:   m.OpenMRs,
		MergedMRs: m.MergedMRs,
		Pipelines: pipelines,
		CodeDaily: codeDaily,
	})
}
