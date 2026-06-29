package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// KosmosAI 플랫폼 "사용량(활동) 통계" — portal-api 감사 로그(/api/v1/audit)를
// 기간 윈도우로 조회해 일별·사용자별·서비스별 작업 횟수를 집계한다.
//
// 인증: env.local의 KOSMOSAI_TOKEN(superuser PAT ks_)을 auth-api /tokens/exchange로
// JWT로 교환해 사용(캐시·만료 시 재교환). 부하 최소화: 폴링 루프에 넣지 않고
// 온디맨드로만 조회하며, 결과를 10분 캐시한다(최근 30일 ≈ 1페이지 수준).
const (
	kosmosDefaultPortalURL = "https://portal-api.quantumcns.ai"
	kosmosAuthURL          = "https://auth-api.quantumcns.ai"
	kosmosPageLimit        = 1000
	kosmosMaxPages         = 12 // 부하 가드(최대 12k건); 실제 30일은 보통 1페이지
)

var kosmosHTTP = &http.Client{Timeout: 30 * time.Second}

type KosmosNameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type KosmosUserStat struct {
	Email      string `json:"email"`
	Count      int    `json:"count"`
	Failed     int    `json:"failed"`      // 비성공(FAILURE/DENIED/ERROR) 작업 수
	ActiveDays int    `json:"active_days"` // 활동한 고유 일수
	IPs        int    `json:"ips"`         // 고유 IP 수
	LastAt     string `json:"last_at"`     // 마지막 활동 (RFC3339)
}

// KosmosUsageResult is everything the 사용량 화면 needs.
type KosmosUsageResult struct {
	Configured    bool                      `json:"configured"`
	Error         string                    `json:"error"`
	Updated       string                    `json:"updated"`
	WindowDays    int                       `json:"window_days"`
	Total         int                       `json:"total"`
	FailedTotal   int                       `json:"failed_total"` // 비성공 작업 수
	Days          []KosmosNameCount         `json:"days"`         // 날짜 → 건수 (오름차순)
	Hours         []int                     `json:"hours"`        // 24: 시간대(KST)별
	Weekdays      []int                     `json:"weekdays"`     // 7: 요일(일~토)별
	Users         []KosmosUserStat          `json:"users"`        // 사용자별 (내림차순)
	Services      []KosmosNameCount         `json:"services"`     // 서비스 → 건수
	Actions       []KosmosNameCount         `json:"actions"`      // 액션 → 건수
	Resources     []KosmosNameCount         `json:"resources"`    // 리소스 타입 → 건수
	Results       []KosmosNameCount         `json:"results"`      // 결과(SUCCESS/FAILURE/…) → 건수
	UserDays      map[string]map[string]int `json:"user_days"`    // email → 날짜 → 건수
	Truncated     bool                      `json:"truncated"`
}

func (a *App) kosmosBaseURL() string {
	a.mu.Lock()
	u := strings.TrimSpace(a.cfg.KosmosAIURL)
	a.mu.Unlock()
	if u == "" {
		return kosmosDefaultPortalURL
	}
	return strings.TrimRight(u, "/")
}

// KosmosAIConfigured reports whether a token is configured (gates the UI tab).
func (a *App) KosmosAIConfigured() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return strings.TrimSpace(a.cfg.KosmosAIToken) != ""
}

// kosmosJWT returns a valid Bearer JWT. If the configured token is a PAT (ks_),
// it is exchanged via auth-api and cached until shortly before expiry.
func (a *App) kosmosJWT(ctx context.Context, force bool) (string, error) {
	a.mu.Lock()
	tok := strings.TrimSpace(a.cfg.KosmosAIToken)
	jwt := a.kosmosJWTVal
	exp := a.kosmosJWTExp
	a.mu.Unlock()

	if tok == "" {
		return "", fmt.Errorf("KOSMOSAI_TOKEN 미설정 — env.local에 추가하세요")
	}
	if !strings.HasPrefix(tok, "ks_") {
		return tok, nil // 이미 JWT로 간주
	}
	if !force && jwt != "" && time.Now().Before(exp.Add(-1*time.Minute)) {
		return jwt, nil
	}

	body, _ := json.Marshal(map[string]string{"token": tok})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, kosmosAuthURL+"/api/v1/tokens/exchange", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := kosmosHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("토큰 교환 실패 (HTTP %d) — 토큰/권한 확인", resp.StatusCode)
	}
	var r struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	if r.AccessToken == "" {
		return "", fmt.Errorf("access_token 없음")
	}
	ttl := r.ExpiresIn
	if ttl < 300 {
		ttl = 300
	}
	a.mu.Lock()
	a.kosmosJWTVal = r.AccessToken
	a.kosmosJWTExp = time.Now().Add(time.Duration(ttl) * time.Second)
	a.mu.Unlock()
	return r.AccessToken, nil
}

type kosmosAuditItem struct {
	ActorEmail   string `json:"actor_email"`
	ActorIP      string `json:"actor_ip"`
	Action       string `json:"action"`
	Result       string `json:"result"`
	Service      string `json:"service"`
	ResourceType string `json:"resource_type"`
	Timestamp    string `json:"timestamp"`
}
type kosmosAuditPage struct {
	Total int               `json:"total"`
	Items []kosmosAuditItem `json:"items"`
}

func (a *App) kosmosAuditPage(ctx context.Context, jwt string, q url.Values) (kosmosAuditPage, int, error) {
	var page kosmosAuditPage
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.kosmosBaseURL()+"/api/v1/audit?"+q.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/json")
	resp, err := kosmosHTTP.Do(req)
	if err != nil {
		return page, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return page, resp.StatusCode, nil
	}
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return page, resp.StatusCode, err
	}
	return page, resp.StatusCode, nil
}

// KosmosUsage returns per-day/per-user/per-service activity over the last `days`.
// On-demand + 10분 캐시(부하 최소). force=true면 캐시 무시하고 새로 조회.
func (a *App) KosmosUsage(days int, force bool) KosmosUsageResult {
	if !a.KosmosAIConfigured() {
		return KosmosUsageResult{Configured: false, Error: "KOSMOSAI_TOKEN 미설정 — env.local에 추가 후 재시작하세요"}
	}
	if days <= 0 {
		days = 30
	}
	a.mu.Lock()
	cache := a.kosmosCache
	cacheAt := a.kosmosCacheAt
	a.mu.Unlock()
	if !force && cache != nil && cache.WindowDays == days && time.Since(cacheAt) < 10*time.Minute {
		return *cache
	}

	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 60*time.Second)
	defer cancel()

	jwt, err := a.kosmosJWT(ctx, false)
	if err != nil {
		return KosmosUsageResult{Configured: true, Error: err.Error()}
	}

	loc, lerr := time.LoadLocation("Asia/Seoul")
	if lerr != nil {
		loc = time.FixedZone("KST", 9*3600)
	}
	startTime := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339)
	res := KosmosUsageResult{Configured: true, WindowDays: days, UserDays: map[string]map[string]int{}, Hours: make([]int, 24), Weekdays: make([]int, 7)}
	byService, byAction, byDay := map[string]int{}, map[string]int{}, map[string]int{}
	byResource, byResult := map[string]int{}, map[string]int{}
	uAgg := map[string]*kosmosUserAgg{}
	getu := func(e string) *kosmosUserAgg {
		if uAgg[e] == nil {
			uAgg[e] = &kosmosUserAgg{days: map[string]bool{}, ips: map[string]bool{}}
		}
		return uAgg[e]
	}

	for pageNo := 0; pageNo < kosmosMaxPages; pageNo++ {
		q := url.Values{}
		q.Set("start_time", startTime)
		q.Set("limit", fmt.Sprint(kosmosPageLimit))
		q.Set("offset", fmt.Sprint(pageNo*kosmosPageLimit))
		page, status, err := a.kosmosAuditPage(ctx, jwt, q)
		if status == http.StatusUnauthorized { // JWT 만료 → 재교환 1회 재시도
			if jwt, err = a.kosmosJWT(ctx, true); err != nil {
				return KosmosUsageResult{Configured: true, Error: err.Error()}
			}
			page, status, err = a.kosmosAuditPage(ctx, jwt, q)
		}
		if err != nil {
			return KosmosUsageResult{Configured: true, Error: err.Error()}
		}
		if status == http.StatusForbidden {
			return KosmosUsageResult{Configured: true, Error: "권한 없음 (superuser 토큰 필요)"}
		}
		if status != http.StatusOK {
			return KosmosUsageResult{Configured: true, Error: fmt.Sprintf("감사 로그 조회 실패 (HTTP %d)", status)}
		}
		for _, it := range page.Items {
			email := it.ActorEmail
			if email == "" {
				email = "(미상)"
			}
			date := it.Timestamp
			if len(date) >= 10 {
				date = date[:10]
			}
			res.Total++
			byDay[date]++
			if it.Service != "" {
				byService[it.Service]++
			}
			if it.Action != "" {
				byAction[it.Action]++
			}
			if it.ResourceType != "" {
				byResource[it.ResourceType]++
			}
			if it.Result != "" {
				byResult[it.Result]++
			}
			if it.Result != "" && it.Result != "SUCCESS" {
				res.FailedTotal++
			}
			if t, e := time.Parse(time.RFC3339, it.Timestamp); e == nil {
				kt := t.In(loc)
				res.Hours[kt.Hour()]++
				res.Weekdays[int(kt.Weekday())]++
			}
			u := getu(email)
			u.count++
			u.days[date] = true
			if it.ActorIP != "" {
				u.ips[it.ActorIP] = true
			}
			if it.Result != "" && it.Result != "SUCCESS" {
				u.failed++
			}
			if it.Timestamp > u.last {
				u.last = it.Timestamp
			}
			if res.UserDays[email] == nil {
				res.UserDays[email] = map[string]int{}
			}
			res.UserDays[email][date]++
		}
		if len(page.Items) < kosmosPageLimit {
			break
		}
		if pageNo == kosmosMaxPages-1 {
			res.Truncated = true
		}
	}

	res.Days = kosmosByDate(byDay)
	res.Services = kosmosByCountDesc(byService)
	res.Actions = kosmosByCountDesc(byAction)
	res.Resources = kosmosByCountDesc(byResource)
	res.Results = kosmosByCountDesc(byResult)
	res.Users = make([]KosmosUserStat, 0, len(uAgg))
	for e, s := range uAgg {
		res.Users = append(res.Users, KosmosUserStat{Email: e, Count: s.count, Failed: s.failed, ActiveDays: len(s.days), IPs: len(s.ips), LastAt: s.last})
	}
	sort.Slice(res.Users, func(i, j int) bool {
		if res.Users[i].Count != res.Users[j].Count {
			return res.Users[i].Count > res.Users[j].Count
		}
		return res.Users[i].Email < res.Users[j].Email
	})
	res.Updated = time.Now().Format(time.RFC3339)

	a.mu.Lock()
	c := res
	a.kosmosCache = &c
	a.kosmosCacheAt = time.Now()
	a.mu.Unlock()
	return res
}

func kosmosByDate(m map[string]int) []KosmosNameCount {
	out := make([]KosmosNameCount, 0, len(m))
	for k, v := range m {
		out = append(out, KosmosNameCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
func kosmosByCountDesc(m map[string]int) []KosmosNameCount {
	out := make([]KosmosNameCount, 0, len(m))
	for k, v := range m {
		out = append(out, KosmosNameCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}
type kosmosUserAgg struct {
	count  int
	failed int
	days   map[string]bool
	ips    map[string]bool
	last   string // 마지막 timestamp(RFC3339) — 동일 포맷이라 문자열 비교 가능
}
