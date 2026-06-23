package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"gitlab-mon/internal/confluence"
)

// confluenceProducts maps a PoC product id to its Confluence text query. Pages
// aren't cleanly separated by space (AkashiQ/KosmosAI docs both live in the
// shared "AI 개발"·"회의록" spaces), so we attribute by product-name text match.
// Mirrors the frontend PRODUCTS registry (id ↔ name). A page mentioning both
// products is tagged with both.
var confluenceProducts = []struct{ ID, Query string }{
	{"akashiq", "AkashiQ"},
	{"kosmos", "KosmosAI"},
}

const confluenceCacheVersion = 1

type confluenceCacheFile struct {
	Version    int                         `json:"version"`
	WindowDays int                         `json:"window_days"`
	FetchedAt  time.Time                   `json:"fetched_at"`
	Pages      map[string]*confluence.Page `json:"pages"` // id → page
}

func confluenceCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "confluence-cache.json"), nil
}

func (a *App) loadConfluenceCache() {
	if p, err := confluenceCachePath(); err == nil {
		var f confluenceCacheFile
		if loadJSONFile(p, &f) && f.Version == confluenceCacheVersion && f.WindowDays == statsWindowDay && f.Pages != nil {
			a.mu.Lock()
			a.confluenceCache = f.Pages
			a.confluenceFetchedAt = f.FetchedAt
			a.mu.Unlock()
		}
	}
}

func (a *App) saveConfluenceCache() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, err := confluenceCachePath(); err == nil {
		saveJSONFile(p, confluenceCacheFile{Version: confluenceCacheVersion, WindowDays: statsWindowDay, FetchedAt: a.confluenceFetchedAt, Pages: a.confluenceCache})
	}
}

// collectConfluence does a full per-product CQL fetch of pages modified within
// the window (slow-cycle only, ~2 calls of ≤100 small results). Pages are keyed
// by id and tagged with every product whose query matched.
func (a *App) collectConfluence(client *confluence.Client, since time.Time) error {
	sinceStr := since.Format("2006-01-02")
	fresh := map[string]*confluence.Page{}
	for _, prod := range confluenceProducts {
		cql := fmt.Sprintf(`text ~ %q AND type = page AND lastmodified >= %q ORDER BY lastmodified DESC`, prod.Query, sinceStr)
		pages, err := client.Search(cql, 100)
		if err != nil {
			return err
		}
		for i := range pages {
			pg := pages[i]
			if ex, ok := fresh[pg.ID]; ok {
				ex.Products = append(ex.Products, prod.ID)
			} else {
				pg.Products = []string{prod.ID}
				fresh[pg.ID] = &pg
			}
		}
	}

	a.mu.Lock()
	a.confluenceCache = fresh
	a.confluenceFetchedAt = time.Now()
	a.mu.Unlock()
	return nil
}

// aggregateConfluence flattens the page cache, newest-updated first.
func (a *App) aggregateConfluence() []confluence.Page {
	a.mu.Lock()
	out := make([]confluence.Page, 0, len(a.confluenceCache))
	for _, p := range a.confluenceCache {
		out = append(out, *p)
	}
	a.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}
