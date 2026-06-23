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
	fresh := map[string]*confluence.Page{}
	var firstErr error
	for _, prod := range confluenceProducts {
		cql := fmt.Sprintf(`text ~ %q AND type = page AND lastmodified >= now("-%dd") ORDER BY lastmodified DESC`, prod.Query, statsWindowDay)
		pages, err := client.Search(cql, 100)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue // 한 제품 실패가 다른 제품/기존 캐시를 버리지 않게
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
	defer a.mu.Unlock()
	// 일부라도 실패하면 기존 캐시 유지(부분 결과로 덮어쓰지 않음). 전부 성공했지만
	// 빈 결과인데 기존에 문서가 있었다면(일시적 인덱싱 공백·이름 불일치) 역시 유지 —
	// 모든 문서가 한 번에 사라지는 일은 드물고, 실제 변경 시 다음 주기에 정정된다.
	if firstErr != nil {
		return firstErr
	}
	if len(fresh) == 0 && len(a.confluenceCache) > 0 {
		return nil
	}
	a.confluenceCache = fresh
	a.confluenceFetchedAt = time.Now()
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
	// 동일 Updated일 때 ID로 안정 정렬 — 맵 순회 무작위성으로 순서가 흔들려
	// 시그니처가 매번 바뀌고 불필요하게 재발행되는 것을 방지.
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Updated.Equal(out[j].Updated) {
			return out[i].Updated.After(out[j].Updated)
		}
		return out[i].ID < out[j].ID
	})
	return out
}
