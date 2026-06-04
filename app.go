package main

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
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
	pollInterval   = 30 * time.Second
	slowEvery      = 10                              // version/stats/groups + CI full sweep cadence (cycles)
	statsWindowDay = 90                              // history kept, days (frontend can narrow to 7/30/90)
	statsWindow    = statsWindowDay * 24 * time.Hour // event/pipeline history kept
	maxFetchPages  = 30                              // per project, per fetch (×100 events)
	fetchWorkers   = 6                               // concurrent project-event fetches
)

// pipeLive marks pipeline statuses that can still transition — these are the
// only ones worth polling every cycle.
var pipeLive = map[string]bool{
	"created": true, "waiting_for_resource": true, "preparing": true,
	"pending": true, "running": true, "scheduled": true,
}

// projEvents caches one project's events within the stats window.
// Exported fields so the cache can be persisted to disk.
type projEvents struct {
	LastActivity time.Time      `json:"last_activity"`
	Events       []gitlab.Event `json:"events"`
}

// projPipelines caches one project's pipelines within the stats window.
type projPipelines struct {
	LastFetch    time.Time         `json:"last_fetch"`
	LastActivity time.Time         `json:"last_activity"`
	HasCI        bool              `json:"has_ci"`
	Pipelines    []gitlab.Pipeline `json:"pipelines"`
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
	Pipelines   []gitlab.Pipeline     `json:"pipelines"`  // updated within stats window
	CodeDaily   []CodeDay             `json:"code_daily"` // 사용자×날짜 라인 변경량 (기본 브랜치)
	Error       string                `json:"error"`
	Warning     string                `json:"warning"`
	NeedsConfig bool                  `json:"needs_config"`
}

// Progress reports collection progress to the frontend.
type Progress struct {
	Phase string `json:"phase"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

// App struct
type App struct {
	ctx         context.Context
	mu          sync.Mutex
	cfg         config.Config
	client      *gitlab.Client
	snap        Snapshot
	cache       map[int]*projEvents    // projectID → cached events
	pipeCache   map[int]*projPipelines // projectID → cached pipelines
	mrCache     map[int]*mrReview      // MR ID → cached review facts
	commitCache map[int]*projCommits   // projectID → cached commit stats
	cycle       int                    // poll cycle counter
	lastSig     uint64                 // signature of the last published snapshot
	// slow-changing metadata, refreshed every slowEvery cycles
	lastVersion *gitlab.Version
	lastStats   *gitlab.Statistics
	lastGroups  []gitlab.Group
	lastUsers   []gitlab.User
	// notification state
	notifyBaselined bool
	notifiedPipes   map[int]bool
	knownMRs        map[int]bool
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		cache:         map[int]*projEvents{},
		pipeCache:     map[int]*projPipelines{},
		mrCache:       map[int]*mrReview{},
		commitCache:   map[int]*projCommits{},
		notifiedPipes: map[int]bool{},
		knownMRs:      map[int]bool{},
	}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.cfg = config.Load()
	a.rebuildClient()
	a.loadCache()
	a.loadMRCache()
	a.loadCommitsCache()
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

func loadJSONFile(path string, v any) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

func saveJSONFile(path string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

// Cache files carry the collection window so widening/narrowing the window
// in a future build invalidates stale caches instead of leaving holes.
type eventsCacheFile struct {
	WindowDays int                 `json:"window_days"`
	Projects   map[int]*projEvents `json:"projects"`
}

type pipesCacheFile struct {
	WindowDays int                    `json:"window_days"`
	Projects   map[int]*projPipelines `json:"projects"`
}

func (a *App) loadCache() {
	if p, err := config.CachePath(); err == nil {
		var f eventsCacheFile
		if loadJSONFile(p, &f) && f.WindowDays == statsWindowDay && f.Projects != nil {
			a.mu.Lock()
			a.cache = f.Projects
			a.mu.Unlock()
		}
	}
	if p, err := config.PipelineCachePath(); err == nil {
		var f pipesCacheFile
		if loadJSONFile(p, &f) && f.WindowDays == statsWindowDay && f.Projects != nil {
			a.mu.Lock()
			a.pipeCache = f.Projects
			a.mu.Unlock()
		}
	}
}

func (a *App) saveCache() {
	// Marshal under the lock so concurrent refreshes can't mutate mid-encode.
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, err := config.CachePath(); err == nil {
		saveJSONFile(p, eventsCacheFile{WindowDays: statsWindowDay, Projects: a.cache})
	}
	if p, err := config.PipelineCachePath(); err == nil {
		saveJSONFile(p, pipesCacheFile{WindowDays: statsWindowDay, Projects: a.pipeCache})
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
	a.cycle++
	slow := a.cycle == 1 || a.cycle%slowEvery == 0 || a.lastVersion == nil
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
	var users []gitlab.User
	if slow {
		// 느리게 변하는 메타데이터는 slowEvery 사이클(5분)마다만 조회
		call(func() (err error) { res.version, err = client.GetVersion(); return })
		call(func() (err error) { res.stats, err = client.GetStatistics(); return })
		call(func() (err error) { groups, err = client.GetAllGroups(); return })
		call(func() (err error) { users, err = client.GetAllUsers(); return })
	}
	call(func() (err error) { res.projects, err = client.GetAllProjects(); return })
	call(func() (err error) { res.openMRs, err = client.GetOpenMergeRequests(); return })
	call(func() (err error) {
		res.merged, err = client.GetMergedMergeRequests(since.UTC().Format(time.RFC3339))
		return
	})
	wg.Wait()

	a.mu.Lock()
	if slow {
		if res.version != nil {
			a.lastVersion = res.version
		}
		if res.stats != nil {
			a.lastStats = res.stats
		}
		if groups != nil {
			a.lastGroups = groups
		}
		if users != nil {
			a.lastUsers = users
		}
	}
	res.version = a.lastVersion
	res.stats = a.lastStats
	groups = a.lastGroups
	users = a.lastUsers
	a.mu.Unlock()

	// Incrementally fetch events for projects whose activity changed.
	events, capped, evFails := a.collectEvents(client, res.projects, since, afterDate)

	// Incrementally fetch pipelines: live(실행 중)·활동 변경 프로젝트는 매 사이클,
	// 나머지 CI 프로젝트 전체 스윕은 slowEvery 사이클마다.
	pipelines, pipeFails := a.collectPipelines(client, res.projects, since, slow)

	// MR 리뷰 지표: updated_at이 변한 MR만 notes/approvals 재조회
	a.collectMRReviews(client, res.openMRs, res.merged)

	// 코드 변경량: 활동이 변한 프로젝트의 기본 브랜치 커밋만 증분 수집
	a.collectCommits(client, res.projects, since)
	codeDaily := a.aggregateCodeDaily(users, since)

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
	for i := range pipelines {
		if p, ok := byID[pipelines[i].ProjectID]; ok {
			pipelines[i].ProjectPath = p.PathWithNamespace
		}
	}
	for _, mrs := range [][]gitlab.MergeRequest{res.openMRs, res.merged} {
		for i := range mrs {
			if p, ok := byID[mrs[i].ProjectID]; ok {
				mrs[i].ProjectPath = p.PathWithNamespace
			}
			resolveBot(&mrs[i].Author, byID, groupByID)
		}
	}

	var warnings []string
	if len(capped) > 0 {
		var paths []string
		for _, id := range capped {
			if p, ok := byID[id]; ok {
				paths = append(paths, p.PathWithNamespace)
			} else {
				paths = append(paths, "#"+strconv.Itoa(id))
			}
		}
		warnings = append(warnings, "이벤트 수집 상한("+strconv.Itoa(maxFetchPages*100)+"건)에 도달한 프로젝트: "+strings.Join(paths, ", "))
	}
	if evFails > 0 {
		warnings = append(warnings, "이벤트 수집 실패 "+strconv.Itoa(evFails)+"개 프로젝트 (이전 캐시 유지, 다음 주기 재시도)")
	}
	if pipeFails > 0 {
		warnings = append(warnings, "파이프라인 수집 실패 "+strconv.Itoa(pipeFails)+"개 프로젝트 (이전 캐시 유지, 다음 주기 재시도)")
	}
	snap.Warning = strings.Join(warnings, " · ")

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
	if pipelines == nil {
		pipelines = []gitlab.Pipeline{}
	}
	if codeDaily == nil {
		codeDaily = []CodeDay{}
	}

	snap.Version = res.version
	snap.Stats = res.stats
	snap.Events = events
	snap.Projects = res.projects
	snap.OpenMRs = res.openMRs
	snap.MergedMRs = res.merged
	snap.Pipelines = pipelines
	snap.CodeDaily = codeDaily
	if len(res.errs) > 0 {
		// 부분 실패도 전부 노출
		msgs := make([]string, len(res.errs))
		for i, e := range res.errs {
			msgs[i] = e.Error()
		}
		snap.Error = strings.Join(msgs, " · ")
	}
	if snap.Error == "" {
		a.checkNotifications(&snap)
	}
	if a.publish(snap) {
		a.saveCache() // 변경이 있을 때만 디스크에 기록
		a.saveMRCache()
		a.saveCommitsCache()
	}
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
// Returns aggregated events, the IDs of projects that hit the fetch cap, and
// the number of projects whose fetch failed (stale cache kept).
func (a *App) collectEvents(client *gitlab.Client, projects []gitlab.Project, since time.Time, afterDate string) ([]gitlab.Event, []int, int) {
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
	a.emitProgress("이벤트", 0, total)
	var (
		done      int
		fails     int
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
			} else {
				fails++
			}
			done++
			d := done
			a.mu.Unlock()
			a.emitProgress("이벤트", d, total)
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
	return all, cappedIDs, fails
}

// collectPipelines keeps a per-project pipeline cache for the stats window.
// Every cycle it polls only projects that can have changed: ones with live
// (running/pending) pipelines or whose activity moved. The remaining
// CI-enabled projects are swept on slow cycles as a safety net.
func (a *App) collectPipelines(client *gitlab.Client, projects []gitlab.Project, since time.Time, fullSweep bool) ([]gitlab.Pipeline, int) {
	type job struct {
		p     gitlab.Project
		after time.Time
	}
	a.mu.Lock()
	var jobs []job
	active := make(map[int]bool, len(projects))
	for _, p := range projects {
		if p.LastActivityAt.Before(since) {
			continue
		}
		active[p.ID] = true
		c, ok := a.pipeCache[p.ID]
		switch {
		case !ok:
			jobs = append(jobs, job{p, since}) // first sight: full window
		case p.LastActivityAt.After(c.LastActivity) && c.HasCI:
			// push 등 활동 발생 → 새 파이프라인 가능성
			jobs = append(jobs, job{p, c.LastFetch.Add(-10 * time.Minute)})
		case p.LastActivityAt.After(c.LastActivity):
			jobs = append(jobs, job{p, since}) // CI may have been enabled since
		case hasLivePipeline(c):
			// 실행 중인 파이프라인의 상태 전이 추적
			jobs = append(jobs, job{p, c.LastFetch.Add(-10 * time.Minute)})
		case fullSweep && c.HasCI:
			// 안전망: 놓친 변경을 5분마다 한 번 회수
			jobs = append(jobs, job{p, c.LastFetch.Add(-10 * time.Minute)})
		}
	}
	for id := range a.pipeCache {
		if !active[id] {
			delete(a.pipeCache, id)
		}
	}
	a.mu.Unlock()

	total := len(jobs)
	if total > 0 {
		a.emitProgress("파이프라인", 0, total)
	}
	var (
		done  int
		fails int
		sem   = make(chan struct{}, fetchWorkers)
		wg    sync.WaitGroup
	)
	now := time.Now()
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fresh, err := client.GetProjectPipelines(j.p.ID, j.after.UTC().Format(time.RFC3339), 3)

			a.mu.Lock()
			if err == nil {
				c := a.pipeCache[j.p.ID]
				if c == nil {
					c = &projPipelines{}
					a.pipeCache[j.p.ID] = c
				}
				// merge fresh over cached, dedupe by ID (fresh wins: status moved)
				seen := make(map[int]bool, len(fresh))
				for _, pl := range fresh {
					seen[pl.ID] = true
				}
				merged := fresh
				for _, pl := range c.Pipelines {
					if !seen[pl.ID] && !pl.UpdatedAt.Before(since) {
						merged = append(merged, pl)
					}
				}
				sort.Slice(merged, func(x, y int) bool { return merged[x].CreatedAt.After(merged[y].CreatedAt) })
				c.Pipelines = merged
				c.LastFetch = now
				c.LastActivity = j.p.LastActivityAt
				c.HasCI = len(merged) > 0
			} else {
				fails++
			}
			done++
			d := done
			a.mu.Unlock()
			a.emitProgress("파이프라인", d, total)
		}(j)
	}
	wg.Wait()

	a.mu.Lock()
	var all []gitlab.Pipeline
	for _, c := range a.pipeCache {
		for _, pl := range c.Pipelines {
			if !pl.UpdatedAt.Before(since) {
				all = append(all, pl)
			}
		}
	}
	a.mu.Unlock()
	sort.Slice(all, func(i, j int) bool { return all[i].CreatedAt.After(all[j].CreatedAt) })
	return all, fails
}

func hasLivePipeline(c *projPipelines) bool {
	for _, pl := range c.Pipelines {
		if pipeLive[pl.Status] {
			return true
		}
	}
	return false
}

func (a *App) emitProgress(phase string, done, total int) {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.EventsEmit(ctx, "progress", Progress{Phase: phase, Done: done, Total: total})
	}
}

// snapshotSig fingerprints the parts of a snapshot the UI cares about, so
// unchanged cycles can skip the multi-MB bridge emit and disk write.
func snapshotSig(s *Snapshot) uint64 {
	h := fnv.New64a()
	w := func(vals ...any) { fmt.Fprint(h, vals...) }
	w(len(s.Events))
	if len(s.Events) > 0 {
		w(s.Events[0].ID)
	}
	for _, m := range s.OpenMRs {
		w(m.ID, m.UpdatedAt.UnixNano(), len(m.Approvers), m.FirstReviewAt != nil)
	}
	w(len(s.MergedMRs), len(s.Pipelines), len(s.CodeDaily))
	for _, p := range s.Pipelines {
		w(p.ID, p.Status)
	}
	w(s.Error, s.Warning, s.NeedsConfig)
	if s.Version != nil {
		w(s.Version.Version)
	}
	if s.Stats != nil {
		w(s.Stats.Projects, s.Stats.Users, s.Stats.Groups)
	}
	return h.Sum64()
}

// publish stores the snapshot and notifies the frontend. Returns true when
// the data actually changed; unchanged cycles emit a lightweight "tick" with
// the refresh timestamp instead of re-sending the whole snapshot.
func (a *App) publish(snap Snapshot) bool {
	sig := snapshotSig(&snap)
	a.mu.Lock()
	changed := sig != a.lastSig || a.snap.FetchedAt.IsZero()
	a.lastSig = sig
	a.snap = snap
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		if changed {
			runtime.EventsEmit(ctx, "snapshot", snap)
		} else {
			runtime.EventsEmit(ctx, "tick", snap.FetchedAt)
		}
	}
	return changed
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
