package main

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/gitlab"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	pollInterval = 30 * time.Second
	statsWindow  = 30 * 24 * time.Hour // event history kept for statistics
	maxEventPage = 5                   // per project, per fetch (×100 events)
	fetchWorkers = 6                   // concurrent project-event fetches
)

// projEvents caches one project's events within the stats window.
type projEvents struct {
	lastActivity time.Time
	events       []gitlab.Event
}

// Snapshot is the full dashboard state pushed to the frontend.
type Snapshot struct {
	FetchedAt   time.Time             `json:"fetched_at"`
	GitLabURL   string                `json:"gitlab_url"`
	Version     *gitlab.Version       `json:"version"`
	Stats       *gitlab.Statistics    `json:"stats"`
	Events      []gitlab.Event        `json:"events"` // all events in stats window, newest first
	Projects    []gitlab.Project      `json:"projects"`
	OpenMRs     []gitlab.MergeRequest `json:"open_mrs"`
	MergedMRs   []gitlab.MergeRequest `json:"merged_mrs"` // merged within stats window
	Error       string                `json:"error"`
	NeedsConfig bool                  `json:"needs_config"`
}

// App struct
type App struct {
	ctx    context.Context
	mu     sync.Mutex
	cfg    config.Config
	client *gitlab.Client
	snap   Snapshot
	cache  map[int]*projEvents // projectID → cached events
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{cache: map[int]*projEvents{}}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.cfg = config.Load()
	a.rebuildClient()
	go a.pollLoop(ctx)
}

func (a *App) rebuildClient() {
	if a.cfg.GitLabToken == "" {
		a.client = nil
		return
	}
	a.client = gitlab.NewClient(a.cfg.GitLabURL, a.cfg.GitLabToken)
}

func (a *App) pollLoop(ctx context.Context) {
	a.refresh()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.refresh()
		}
	}
}

func (a *App) refresh() {
	a.mu.Lock()
	client := a.client
	cfg := a.cfg
	a.mu.Unlock()

	snap := Snapshot{FetchedAt: time.Now(), GitLabURL: cfg.GitLabURL}
	if client == nil {
		snap.NeedsConfig = true
		a.publish(snap)
		return
	}

	since := time.Now().Add(-statsWindow)
	afterDate := since.AddDate(0, 0, -1).Format("2006-01-02") // API 'after' is exclusive, date-only

	type result struct {
		version  *gitlab.Version
		stats    *gitlab.Statistics
		projects []gitlab.Project
		openMRs  []gitlab.MergeRequest
		merged   []gitlab.MergeRequest
		errs     []error
	}
	var (
		res  result
		rmu  sync.Mutex
		wg   sync.WaitGroup
		call = func(f func() error) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := f(); err != nil {
					rmu.Lock()
					res.errs = append(res.errs, err)
					rmu.Unlock()
				}
			}()
		}
	)
	var groups []gitlab.Group
	call(func() (err error) { res.version, err = client.GetVersion(); return })
	call(func() (err error) { res.stats, err = client.GetStatistics(); return })
	call(func() (err error) { res.projects, err = client.GetAllProjects(); return })
	call(func() (err error) { groups, err = client.GetAllGroups(); return })
	call(func() (err error) { res.openMRs, err = client.GetOpenMergeRequests(); return })
	call(func() (err error) {
		res.merged, err = client.GetMergedMergeRequests(since.UTC().Format(time.RFC3339))
		return
	})
	wg.Wait()

	// Incrementally fetch events for projects whose activity changed.
	events := a.collectEvents(client, res.projects, since, afterDate)

	// Enrich events / MRs with project paths and resolve bot author names.
	byID := make(map[int]gitlab.Project, len(res.projects))
	for _, p := range res.projects {
		byID[p.ID] = p
	}
	groupByID := make(map[int]string, len(groups))
	for _, g := range groups {
		groupByID[g.ID] = g.FullPath
	}
	for i := range events {
		if p, ok := byID[events[i].ProjectID]; ok {
			events[i].ProjectPath = p.PathWithNamespace
			events[i].ProjectURL = p.WebURL
		}
		resolveBot(&events[i].Author, byID, groupByID)
	}
	for _, mrs := range [][]gitlab.MergeRequest{res.openMRs, res.merged} {
		for i := range mrs {
			if p, ok := byID[mrs[i].ProjectID]; ok {
				mrs[i].ProjectPath = p.PathWithNamespace
			}
			resolveBot(&mrs[i].Author, byID, groupByID)
		}
	}

	// Keep only recently active projects for the dashboard panel.
	if len(res.projects) > 30 {
		res.projects = res.projects[:30]
	}

	// nil slices marshal to JSON null — always send arrays to the frontend.
	if events == nil {
		events = []gitlab.Event{}
	}
	if res.projects == nil {
		res.projects = []gitlab.Project{}
	}
	if res.openMRs == nil {
		res.openMRs = []gitlab.MergeRequest{}
	}
	if res.merged == nil {
		res.merged = []gitlab.MergeRequest{}
	}

	snap.Version = res.version
	snap.Stats = res.stats
	snap.Events = events
	snap.Projects = res.projects
	snap.OpenMRs = res.openMRs
	snap.MergedMRs = res.merged
	if len(res.errs) > 0 {
		snap.Error = res.errs[0].Error()
	}
	a.publish(snap)
}

// botUserRe matches GitLab's group/project access-token bot usernames,
// whose display name is stored as "****".
var botUserRe = regexp.MustCompile(`^(group|project)_(\d+)_bot_`)

// resolveBot replaces the meaningless "****" display name of access-token bot
// users with the owning group/project path.
func resolveBot(a *gitlab.Author, byID map[int]gitlab.Project, groupByID map[int]string) {
	m := botUserRe.FindStringSubmatch(a.Username)
	if m == nil {
		return
	}
	a.IsBot = true
	id, _ := strconv.Atoi(m[2])
	if m[1] == "project" {
		if p, ok := byID[id]; ok {
			a.Name = p.PathWithNamespace + " 토큰봇"
		} else {
			a.Name = "project #" + m[2] + " 토큰봇"
		}
	} else {
		if path, ok := groupByID[id]; ok {
			a.Name = path + " 그룹토큰봇"
		} else {
			a.Name = "group #" + m[2] + " 그룹토큰봇"
		}
	}
}

// collectEvents keeps a per-project event cache for the stats window and only
// re-fetches projects whose last_activity_at moved since the previous poll.
func (a *App) collectEvents(client *gitlab.Client, projects []gitlab.Project, since time.Time, afterDate string) []gitlab.Event {
	a.mu.Lock()
	var jobs []int
	active := make(map[int]bool, len(projects))
	for _, p := range projects {
		if p.LastActivityAt.Before(since) {
			continue
		}
		active[p.ID] = true
		c, ok := a.cache[p.ID]
		if !ok || p.LastActivityAt.After(c.lastActivity) {
			jobs = append(jobs, p.ID)
		}
	}
	// Drop cache entries that fell out of the window.
	for id := range a.cache {
		if !active[id] {
			delete(a.cache, id)
		}
	}
	a.mu.Unlock()

	// Fetch changed projects with bounded concurrency.
	sem := make(chan struct{}, fetchWorkers)
	var wg sync.WaitGroup
	for _, id := range jobs {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			evs, err := client.GetProjectEvents(id, afterDate, maxEventPage)
			if err != nil {
				return // keep stale cache on error
			}
			a.mu.Lock()
			a.cache[id] = &projEvents{events: evs}
			a.mu.Unlock()
		}(id)
	}
	wg.Wait()

	// Stamp lastActivity after successful fetch and aggregate.
	a.mu.Lock()
	for _, p := range projects {
		if c, ok := a.cache[p.ID]; ok && c.lastActivity.IsZero() {
			c.lastActivity = p.LastActivityAt
		}
	}
	var all []gitlab.Event
	for _, c := range a.cache {
		for _, e := range c.events {
			if !e.CreatedAt.Before(since) {
				all = append(all, e)
			}
		}
	}
	a.mu.Unlock()

	sort.Slice(all, func(i, j int) bool { return all[i].CreatedAt.After(all[j].CreatedAt) })
	return all
}

func (a *App) publish(snap Snapshot) {
	a.mu.Lock()
	a.snap = snap
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.EventsEmit(ctx, "snapshot", snap)
	}
}

// ---- Bound methods (callable from frontend) ----

// GetSnapshot returns the latest cached dashboard state.
func (a *App) GetSnapshot() Snapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.snap
}

// Refresh forces an immediate poll.
func (a *App) Refresh() {
	go a.refresh()
}

// GetConfig returns current connection settings (token masked).
func (a *App) GetConfig() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	masked := ""
	if n := len(a.cfg.GitLabToken); n > 8 {
		masked = a.cfg.GitLabToken[:8] + "..."
	} else if n > 0 {
		masked = "***"
	}
	return map[string]any{
		"gitlab_url":   a.cfg.GitLabURL,
		"token_masked": masked,
		"has_token":    a.cfg.GitLabToken != "",
	}
}

// SaveConfig persists settings and reconnects.
func (a *App) SaveConfig(gitlabURL, token string) string {
	a.mu.Lock()
	if gitlabURL != "" {
		a.cfg.GitLabURL = gitlabURL
	}
	if token != "" {
		a.cfg.GitLabToken = token
	}
	cfg := a.cfg
	a.rebuildClient()
	a.mu.Unlock()
	if err := config.Save(cfg); err != nil {
		return err.Error()
	}
	go a.refresh()
	return ""
}

// OpenURL opens a link in the default browser.
func (a *App) OpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}
