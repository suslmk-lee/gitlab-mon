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

// Keycloak 로그인/접속 현황 — realm events(type=LOGIN)로 일별·사용자별 로그인 횟수를,
// client-session-stats로 현재 활성 세션을 집계한다. AkashiQ/KosmosAI는 clientId로 구분.
//
// 인증: service-account client_credentials (env KEYCLOAK_CLIENT_ID/SECRET). 토큰 캐시.
// 부하 최소화: 폴링 루프 미사용, 온디맨드 + 10분 캐시. 로그인 이벤트는 드물어 1~2페이지.
const (
	kcDefaultURL   = "https://auth.quantumcns.ai"
	kcDefaultRealm = "kosmos"
	kcEventsMax    = 100  // Keycloak events 기본 페이지 크기
	kcMaxPages     = 30   // 부하 가드(최대 3k 이벤트)
)

var kcHTTP = &http.Client{Timeout: 30 * time.Second}

// clientId → 제품 라벨 (구분 표시용)
func kcProduct(clientID string) string {
	switch clientID {
	case "akashiq-platform":
		return "AkashiQ"
	case "kosmos", "kosmosai-auth-api", "kosmosai-portal":
		return "KosmosAI"
	case "":
		return "(미상)"
	default:
		return clientID
	}
}

type KCNameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type KCUserStat struct {
	User       string `json:"user"`        // username(이메일 등)
	Name       string `json:"name"`        // Keycloak 디렉터리 실명(있으면)
	Product    string `json:"product"`     // 주 사용 제품(최다 clientId)
	Count      int    `json:"count"`       // 로그인 수
	Failed     int    `json:"failed"`      // 로그인 실패 수
	ActiveDays int    `json:"active_days"` // 로그인한 고유 일수
	IPs        int    `json:"ips"`         // 고유 IP 수
	LastLogin  string `json:"last_login"`  // 마지막 로그인 (RFC3339)
}
type KCSessionStat struct {
	Product  string `json:"product"`
	ClientID string `json:"client_id"`
	Active   int    `json:"active"`
}

// KCLoginResult is everything the 로그인/접속 현황 화면 needs.
type KCLoginResult struct {
	Configured     bool            `json:"configured"`
	Error          string          `json:"error"`
	Updated        string          `json:"updated"`
	WindowDays     int             `json:"window_days"`
	Total          int             `json:"total"`        // 윈도우 내 총 로그인 수
	FailedTotal    int             `json:"failed_total"` // 로그인 실패 수
	Days           []KCNameCount   `json:"days"`         // 날짜 → 로그인 수
	Hours          []int           `json:"hours"`        // 24개: 시간대(KST)별 로그인
	Weekdays       []int           `json:"weekdays"`     // 7개: 요일(일~토)별 로그인
	Users          []KCUserStat    `json:"users"`        // 사용자별(내림차순)
	Products       []KCNameCount   `json:"products"`     // 제품(clientId)별 로그인 수
	Sessions       []KCSessionStat `json:"sessions"`     // 현재 활성 세션(클라이언트별)
	ActiveTotal    int             `json:"active_total"` // 현재 활성 세션 합계
	SessionAvgMin  float64         `json:"session_avg_min"` // 완료 세션 평균(분, LOGIN↔LOGOUT)
	SessionSamples int             `json:"session_samples"` // 페어링된 세션 수
	Truncated      bool            `json:"truncated"`
}

func (a *App) kcBase() (string, string) {
	a.mu.Lock()
	u := strings.TrimSpace(a.cfg.KeycloakURL)
	r := strings.TrimSpace(a.cfg.KeycloakRealm)
	a.mu.Unlock()
	if u == "" {
		u = kcDefaultURL
	}
	if r == "" {
		r = kcDefaultRealm
	}
	return strings.TrimRight(u, "/"), r
}

// KeycloakConfigured gates the UI tab.
func (a *App) KeycloakConfigured() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return strings.TrimSpace(a.cfg.KeycloakClientID) != "" && strings.TrimSpace(a.cfg.KeycloakClientSecret) != ""
}

// kcToken returns a cached client_credentials access token, refreshing near expiry.
func (a *App) kcAccessToken(ctx context.Context, force bool) (string, error) {
	a.mu.Lock()
	cid := strings.TrimSpace(a.cfg.KeycloakClientID)
	sec := strings.TrimSpace(a.cfg.KeycloakClientSecret)
	tok := a.kcTokenVal
	exp := a.kcTokenExp
	a.mu.Unlock()
	if cid == "" || sec == "" {
		return "", fmt.Errorf("KEYCLOAK_CLIENT_ID/SECRET 미설정 — env.local 확인")
	}
	if !force && tok != "" && time.Now().Before(exp.Add(-30*time.Second)) {
		return tok, nil
	}
	base, realm := a.kcBase()
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", cid)
	form.Set("client_secret", sec)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/realms/"+realm+"/protocol/openid-connect/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := kcHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Keycloak 토큰 발급 실패 (HTTP %d) — client_id/secret 확인", resp.StatusCode)
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
	if ttl < 60 {
		ttl = 60
	}
	a.mu.Lock()
	a.kcTokenVal = r.AccessToken
	a.kcTokenExp = time.Now().Add(time.Duration(ttl) * time.Second)
	a.mu.Unlock()
	return r.AccessToken, nil
}

// kcGET issues an authenticated GET, re-fetching the token once on 401.
func (a *App) kcGET(ctx context.Context, path string, q url.Values) ([]byte, int, error) {
	base, _ := a.kcBase()
	do := func(tok string) (*http.Response, error) {
		u := base + path
		if len(q) > 0 {
			u += "?" + q.Encode()
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Accept", "application/json")
		return kcHTTP.Do(req)
	}
	tok, err := a.kcAccessToken(ctx, false)
	if err != nil {
		return nil, 0, err
	}
	resp, err := do(tok)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		if tok, err = a.kcAccessToken(ctx, true); err != nil {
			return nil, 0, err
		}
		if resp, err = do(tok); err != nil {
			return nil, 0, err
		}
	}
	defer resp.Body.Close()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, e := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if e != nil {
			break
		}
		if len(buf) > 8<<20 { // 8MB 가드
			break
		}
	}
	return buf, resp.StatusCode, nil
}

type kcEvent struct {
	Time      int64             `json:"time"`
	Type      string            `json:"type"`
	ClientID  string            `json:"clientId"`
	UserID    string            `json:"userId"`
	SessionID string            `json:"sessionId"`
	IPAddress string            `json:"ipAddress"`
	Details   map[string]string `json:"details"`
}

// kcEventUser resolves the display identity for an event (details.username → userId).
func kcEventUser(e kcEvent) string {
	if e.Details != nil {
		if u := e.Details["username"]; u != "" {
			return u
		}
	}
	if e.UserID != "" {
		return e.UserID
	}
	return "(미상)"
}

// kcKoreanName builds a display name from Keycloak first/last (한국식: 성+이름).
func kcKoreanName(first, last string) string {
	first, last = strings.TrimSpace(first), strings.TrimSpace(last)
	if first == "" && last == "" {
		return ""
	}
	if first != "" && last != "" {
		return last + first // 전 + 성주 = 전성주
	}
	return first + last
}

// kcDirectory returns a cached email/username(lower) → 실명 map from Keycloak users.
// Small directory(수십 명) + 30분 캐시라 저부하. 미구성/오류 시 빈 맵.
func (a *App) kcDirectory(ctx context.Context) map[string]string {
	a.mu.Lock()
	dir := a.kcDir
	at := a.kcDirAt
	a.mu.Unlock()
	if dir != nil && time.Since(at) < 30*time.Minute {
		return dir
	}
	if !a.KeycloakConfigured() {
		return map[string]string{}
	}
	_, realm := a.kcBase()
	out := map[string]string{}
	for first := 0; first < 5000; first += 100 {
		q := url.Values{}
		q.Set("first", fmt.Sprint(first))
		q.Set("max", "100")
		body, status, err := a.kcGET(ctx, "/admin/realms/"+realm+"/users", q)
		if err != nil || status != http.StatusOK {
			break
		}
		var us []struct {
			Email     string `json:"email"`
			Username  string `json:"username"`
			FirstName string `json:"firstName"`
			LastName  string `json:"lastName"`
		}
		if json.Unmarshal(body, &us) != nil {
			break
		}
		for _, u := range us {
			name := kcKoreanName(u.FirstName, u.LastName)
			if name == "" {
				continue
			}
			if e := strings.ToLower(strings.TrimSpace(u.Email)); e != "" {
				out[e] = name
			}
			if un := strings.ToLower(strings.TrimSpace(u.Username)); un != "" {
				if _, ok := out[un]; !ok {
					out[un] = name
				}
			}
		}
		if len(us) < 100 {
			break
		}
	}
	a.mu.Lock()
	a.kcDir = out
	a.kcDirAt = time.Now()
	a.mu.Unlock()
	return out
}

// kcFetchEvents pages all events of a type since dateFrom (YYYY-MM-DD).
func (a *App) kcFetchEvents(ctx context.Context, realm, etype, dateFrom string) ([]kcEvent, bool, error) {
	var all []kcEvent
	truncated := false
	for pageNo := 0; pageNo < kcMaxPages; pageNo++ {
		q := url.Values{}
		q.Set("type", etype)
		q.Set("dateFrom", dateFrom)
		q.Set("max", fmt.Sprint(kcEventsMax))
		q.Set("first", fmt.Sprint(pageNo*kcEventsMax))
		body, status, err := a.kcGET(ctx, "/admin/realms/"+realm+"/events", q)
		if err != nil {
			return nil, false, err
		}
		if status == http.StatusForbidden {
			return nil, false, fmt.Errorf("권한 없음 — 서비스계정에 view-events role이 필요합니다")
		}
		if status != http.StatusOK {
			return nil, false, fmt.Errorf("이벤트 조회 실패 (HTTP %d)", status)
		}
		var evs []kcEvent
		if err := json.Unmarshal(body, &evs); err != nil {
			return nil, false, fmt.Errorf("이벤트 파싱 실패: %w", err)
		}
		all = append(all, evs...)
		if len(evs) < kcEventsMax {
			break
		}
		if pageNo == kcMaxPages-1 {
			truncated = true
		}
	}
	return all, truncated, nil
}

type kcUserAgg struct {
	count   int
	failed  int
	product map[string]int
	days    map[string]bool
	ips     map[string]bool
	last    int64
}

// KeycloakLoginStats aggregates LOGIN/LOGIN_ERROR/LOGOUT events over the last `days`
// plus current active sessions. Adds time-of-day/weekday distribution, per-user
// active-days/IPs/last-login, failed logins, and completed-session avg duration.
func (a *App) KeycloakLoginStats(days int, force bool) KCLoginResult {
	if !a.KeycloakConfigured() {
		return KCLoginResult{Configured: false, Error: "KEYCLOAK_CLIENT_ID/SECRET 미설정 — env.local에 추가 후 재시작하세요"}
	}
	if days <= 0 {
		days = 30
	}
	a.mu.Lock()
	cache := a.kcCache
	cacheAt := a.kcCacheAt
	a.mu.Unlock()
	if !force && cache != nil && cache.WindowDays == days && time.Since(cacheAt) < 10*time.Minute {
		return *cache
	}

	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 90*time.Second)
	defer cancel()
	_, realm := a.kcBase()

	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		loc = time.FixedZone("KST", 9*3600)
	}

	res := KCLoginResult{Configured: true, WindowDays: days, Hours: make([]int, 24), Weekdays: make([]int, 7)}
	byDay, byProduct := map[string]int{}, map[string]int{}
	users := map[string]*kcUserAgg{}
	loginStart := map[string]int64{} // sessionId → 최초 LOGIN time
	getu := func(u string) *kcUserAgg {
		if users[u] == nil {
			users[u] = &kcUserAgg{product: map[string]int{}, days: map[string]bool{}, ips: map[string]bool{}}
		}
		return users[u]
	}

	dateFrom := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02")

	logins, trunc, err := a.kcFetchEvents(ctx, realm, "LOGIN", dateFrom)
	if err != nil {
		return KCLoginResult{Configured: true, Error: err.Error()}
	}
	res.Truncated = trunc
	for _, e := range logins {
		user := kcEventUser(e)
		t := time.UnixMilli(e.Time)
		date := t.UTC().Format("2006-01-02")
		kt := t.In(loc)
		prod := kcProduct(e.ClientID)
		res.Total++
		byDay[date]++
		byProduct[prod]++
		res.Hours[kt.Hour()]++
		res.Weekdays[int(kt.Weekday())]++
		u := getu(user)
		u.count++
		u.product[prod]++
		u.days[date] = true
		if e.IPAddress != "" {
			u.ips[e.IPAddress] = true
		}
		if e.Time > u.last {
			u.last = e.Time
		}
		if e.SessionID != "" {
			if _, ok := loginStart[e.SessionID]; !ok {
				loginStart[e.SessionID] = e.Time
			}
		}
	}

	// 로그인 실패 (LOGIN_ERROR)
	if errs, _, e2 := a.kcFetchEvents(ctx, realm, "LOGIN_ERROR", dateFrom); e2 == nil {
		for _, e := range errs {
			res.FailedTotal++
			getu(kcEventUser(e)).failed++
		}
	}

	// 세션 지속시간 — LOGOUT을 sessionId로 LOGIN과 페어링 (명시적 로그아웃만)
	if logouts, _, e2 := a.kcFetchEvents(ctx, realm, "LOGOUT", dateFrom); e2 == nil {
		var totalMs int64
		n := 0
		for _, e := range logouts {
			if e.SessionID == "" {
				continue
			}
			if st, ok := loginStart[e.SessionID]; ok && e.Time > st {
				totalMs += e.Time - st
				n++
			}
		}
		if n > 0 {
			res.SessionAvgMin = float64(totalMs) / float64(n) / 60000.0
			res.SessionSamples = n
		}
	}

	// 현재 활성 세션(클라이언트별)
	if body, status, e2 := a.kcGET(ctx, "/admin/realms/"+realm+"/client-session-stats", nil); e2 == nil && status == http.StatusOK {
		var stats []struct {
			ClientID string `json:"clientId"`
			Active   string `json:"active"`
		}
		if json.Unmarshal(body, &stats) == nil {
			for _, s := range stats {
				n := 0
				fmt.Sscanf(s.Active, "%d", &n)
				if n <= 0 {
					continue
				}
				res.Sessions = append(res.Sessions, KCSessionStat{Product: kcProduct(s.ClientID), ClientID: s.ClientID, Active: n})
				res.ActiveTotal += n
			}
			sort.Slice(res.Sessions, func(i, j int) bool { return res.Sessions[i].Active > res.Sessions[j].Active })
		}
	}

	dir := a.kcDirectory(ctx) // email/username → 실명
	res.Days = kcSortByName(byDay)
	res.Products = kcSortByCount(byProduct)
	res.Users = make([]KCUserStat, 0, len(users))
	for u, s := range users {
		last := ""
		if s.last > 0 {
			last = time.UnixMilli(s.last).Format(time.RFC3339)
		}
		res.Users = append(res.Users, KCUserStat{
			User: u, Name: dir[strings.ToLower(u)], Product: kcTopKey(s.product), Count: s.count, Failed: s.failed,
			ActiveDays: len(s.days), IPs: len(s.ips), LastLogin: last,
		})
	}
	sort.Slice(res.Users, func(i, j int) bool {
		if res.Users[i].Count != res.Users[j].Count {
			return res.Users[i].Count > res.Users[j].Count
		}
		return res.Users[i].User < res.Users[j].User
	})
	res.Updated = time.Now().Format(time.RFC3339)

	a.mu.Lock()
	c := res
	a.kcCache = &c
	a.kcCacheAt = time.Now()
	a.mu.Unlock()
	return res
}

func kcSortByName(m map[string]int) []KCNameCount {
	out := make([]KCNameCount, 0, len(m))
	for k, v := range m {
		out = append(out, KCNameCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
func kcSortByCount(m map[string]int) []KCNameCount {
	out := make([]KCNameCount, 0, len(m))
	for k, v := range m {
		out = append(out, KCNameCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}
func kcTopKey(m map[string]int) string {
	best, bestN := "", -1
	for k, v := range m {
		if v > bestN {
			best, bestN = k, v
		}
	}
	return best
}
