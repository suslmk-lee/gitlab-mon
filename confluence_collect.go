package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"gitlab-mon/internal/confluence"
)

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
func (a *App) collectConfluence(client *confluence.Client) error {
	fresh := map[string]*confluence.Page{}
	var firstErr error
	for _, ent := range a.entitiesSnapshot() {
		if !ent.Active {
			continue
		}
		cql := fmt.Sprintf(`text ~ %q AND type = page AND lastmodified >= now("-%dd") ORDER BY lastmodified DESC`, ent.cqlQuery(), statsWindowDay)
		pages, err := client.Search(cql, 100)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue // 한 엔티티 실패가 다른 엔티티/기존 캐시를 버리지 않게
		}
		for i := range pages {
			pg := pages[i]
			if ex, ok := fresh[pg.ID]; ok {
				ex.Products = append(ex.Products, ent.ID)
			} else {
				pg.Products = []string{ent.ID}
				fresh[pg.ID] = &pg
			}
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	// 실패 시에만 기존 캐시 유지. 전부 성공한 결과는 — 빈 결과라도 — 권위 있는
	// 현재 상태로 신뢰해 그대로 교체한다(삭제·이름변경으로 매칭에서 빠진 문서가
	// 즉시 사라지도록). 일시적 빈-200은 드물고 다음 주기에 자가복구된다.
	if firstErr != nil {
		return firstErr
	}
	a.confluenceCache = fresh
	a.confluenceFetchedAt = time.Now()
	return nil
}

// ConfluenceSpaces lists available publish-target spaces for the note share UI.
func (a *App) ConfluenceSpaces() []confluence.Space {
	a.mu.Lock()
	cc := a.confluenceClient
	a.mu.Unlock()
	if cc == nil {
		return []confluence.Space{}
	}
	spaces, err := cc.ListSpaces()
	if err != nil || spaces == nil {
		return []confluence.Space{}
	}
	return spaces
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
