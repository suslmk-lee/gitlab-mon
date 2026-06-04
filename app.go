package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/gitlab"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	pollInterval  = 30 * time.Second
	statsWindow   = 30 * 24 * time.Hour // event history kept for statistics
	maxFetchPages = 20                  // per project, per fetch (×100 events)
	fetchWorkers  = 6                   // concurrent project-event fetches
)

// projEvents caches one project's events within the stats window.
// Exported fields so the cache can be persisted to disk.
type projEvents struct {
	LastActivity time.Time      `json:"last_activity"`
	Events       []gitlab.Event `json:"events"`
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
	Warning     string                `json:"warning"`
	NeedsConfig bool                  `json:"needs_config"`
}

// Progress reports event-collection progress to the frontend.
type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
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
	a.loadCache()
	go a.pollLoop(ctx)
}

func (a *App) rebuildClient() {
	if a.cfg.GitLabToken == "" {
		a.client = nil
		return
	}
	a.client = gitlab.NewClient(a.cfg.GitLabURL, a.cfg.GitLabToken)
}

// ---- Cache persistence ----

func (a *App) loadCache() {
	p, err := config.CachePath()
	if err != nil {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	cache := map[int]*projEvents{}
	if json.Unmarshal(b, &cache) == nil {
		a.mu.Lock()
		a.cache = cache
		a.mu.Unlock()
	}
}

func (a *App) saveCache() {
	p, err := config.CachePath()
	if err != nil {
		return
	}
	a.mu.Lock()
	b, err := json.Marshal(a.cache)
	a.mu.Unlock()
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(p), 0o700) != nil {
		return
	}
	tmp := p + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, p)
	}
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
	events, capped := a.collectEvents(client, res.projects, since, afterDate)

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

	if len(capped) > 0 {
		var paths []string
		for _, id := range capped {
			if p, ok := byID[id]; ok {
				paths = append(paths, p.PathWithNamespace)
			} else {
				paths = append(paths, "#"+strconv.Itoa(id))
			}
		}
		snap.Warning = "이벤트 수집 상한(" + strconv.Itoa(maxFetchPages*100) + "건)에 도달한 프로젝트: " + strings.Join(paths, ", ")
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
	a.saveCache()
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

// fetchProject incrementally fetches one project's events, stopping as soon as
// a page reaches events already in the cache. Returns the merged window of
// events (newest first) and whether the page cap was hit before reaching
// known events (possible data loss).
func fetchProject(client *gitlab.Client, id int, after string, since time.Time, cached *projEvents) ([]gitlab.Event, bool, error) {
	known := map[int]bool{}
	var newest time.Time
	if cached != nil {
		for _, e := range cached.Events {
			known[e.ID] = true
		}
		if len(cached.Events) > 0 {
			newest = cached.Events[0].CreatedAt
		}
	}

	var fresh []gitlab.Event
	capped := true
	for page := 1; page <= maxFetchPages; page++ {
		batch, hasNext, err := client.GetProjectEventsPage(id, after, page)
		if err != nil {
			return nil, false, err
		}
		reachedKnown := false
		for _, e := range batch {
			if known[e.ID] || (!newest.IsZero() && e.CreatedAt.Before(newest)) {
				reachedKnown = true
				continue
			}
			fresh = append(fresh, e)
		}
		if reachedKnown || !hasNext {
			capped = false
			break
		}
	}

	// Merge fresh + cached, dedupe by ID, keep window, newest first.
	merged := fresh
	if cached != nil {
		seen := make(map[int]bool, len(fresh))
		for _, e := range fresh {
			seen[e.ID] = true
		}
		for _, e := range cached.Events {
			if !seen[e.ID] && !e.CreatedAt.Before(since) {
				merged = append(merged, e)
			}
		}
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].CreatedAt.After(merged[j].CreatedAt) })
	return merged, capped, nil
}

// collectEvents keeps a per-project event cache for the stats window and only
// re-fetches projects whose last_activity_at moved since the previous poll.
// Returns aggregated events and the IDs of projects that hit the fetch cap.
func (a *App) collectEvents(client *gitlab.Client, projects []gitlab.Project, since time.Time, afterDate string) ([]gitlab.Event, []int) {
	a.mu.Lock()
	var jobs []gitlab.Project
	active := make(map[int]bool, len(projects))
	for _, p := range projects {
		if p.LastActivityAt.Before(since) {
			continue
		}
		active[p.ID] = true
		c, ok := a.cache[p.ID]
		if !ok || p.LastActivityAt.After(c.LastActivity) {
			jobs = append(jobs, p)
		}
	}
	// Drop cache entries that fell out of the window.
	for id := range a.cache {
		if !active[id] {
			delete(a.cache, id)
		}
	}
	a.mu.Unlock()

	// Fetch changed projects with bounded concurrency, reporting progress.
	total := len(jobs)
	a.emitProgress(0, total)
	var (
		done      int
		cappedIDs []int
		sem       = make(chan struct{}, fetchWorkers)
		wg        sync.WaitGroup
	)
	for _, p := range jobs {
		wg.Add(1)
		go func(p gitlab.Project) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			a.mu.Lock()
			cached := a.cache[p.ID]
			a.mu.Unlock()

			merged, capped, err := fetchProject(client, p.ID, afterDate, since, cached)

			a.mu.Lock()
			if err == nil {
				a.cache[p.ID] = &projEvents{LastActivity: p.LastActivityAt, Events: merged}
				if capped {
					cappedIDs = append(cappedIDs, p.ID)
				}
			}
			done++
			d := done
			a.mu.Unlock()
			a.emitProgress(d, total)
		}(p)
	}
	wg.Wait()

	// Aggregate the whole window.
	a.mu.Lock()
	var all []gitlab.Event
	for _, c := range a.cache {
		for _, e := range c.Events {
			if !e.CreatedAt.Before(since) {
				all = append(all, e)
			}
		}
	}
	a.mu.Unlock()

	sort.Slice(all, func(i, j int) bool { return all[i].CreatedAt.After(all[j].CreatedAt) })
	return all, cappedIDs
}

func (a *App) emitProgress(done, total int) {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.EventsEmit(ctx, "progress", Progress{Done: done, Total: total})
	}
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
