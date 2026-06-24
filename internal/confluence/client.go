package confluence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a minimal Confluence Cloud client (Basic auth: email + API token).
// BaseURL is the Atlassian site root (e.g. https://quantumcns-ai.atlassian.net);
// the wiki REST path is appended internally. Shares Jira credentials.
type Client struct {
	BaseURL string
	Email   string
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, email, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Email:   email,
		Token:   token,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) get(path string, query url.Values, out any) error {
	u := c.BaseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.Email, c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Confluence GET %s: %s", path, resp.Status)
	}
	return json.Unmarshal(body, out)
}

// cfTime parses Confluence timestamps (RFC3339, with ms and ±hh:mm or ±hhmm tz).
type cfTime struct{ time.Time }

func (t *cfTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	// Atlassian이 쓰는 실제 포맷만 — date-only는 자정 UTC로 왜곡되므로 제외.
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999-0700", "2006-01-02T15:04:05Z0700"} {
		if parsed, err := time.Parse(layout, s); err == nil {
			t.Time = parsed
			return nil
		}
	}
	return nil // 알 수 없는 포맷은 zero time으로 (frontend가 너무 오래된 것으로 처리)
}

// Page is the normalized form shipped to the app/frontend.
type Page struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	SpaceKey  string    `json:"space_key"`
	SpaceName string    `json:"space_name"`
	Author    string    `json:"author"` // 마지막 편집자
	Created   time.Time `json:"created"`
	Updated   time.Time `json:"updated"`
	URL       string    `json:"url"`
	Products  []string  `json:"products"` // 귀속 제품 id (app이 채움)
}

// Search runs a CQL query and returns matching pages (newest-updated first per
// the caller's ORDER BY). limit caps results (Confluence max 250).
func (c *Client) Search(cql string, limit int) ([]Page, error) {
	q := url.Values{}
	q.Set("cql", cql)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("expand", "space,version,history")

	var raw struct {
		Results []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
			Space struct {
				Key  string `json:"key"`
				Name string `json:"name"`
			} `json:"space"`
			History struct {
				CreatedDate cfTime `json:"createdDate"`
			} `json:"history"`
			Version struct {
				When cfTime `json:"when"`
				By   struct {
					DisplayName string `json:"displayName"`
				} `json:"by"`
			} `json:"version"`
			Links struct {
				WebUI string `json:"webui"`
			} `json:"_links"`
		} `json:"results"`
		Links struct {
			Base string `json:"base"`
		} `json:"_links"`
	}
	if err := c.get("/wiki/rest/api/content/search", q, &raw); err != nil {
		return nil, err
	}

	pages := make([]Page, 0, len(raw.Results))
	for _, r := range raw.Results {
		pages = append(pages, Page{
			ID:        r.ID,
			Title:     r.Title,
			SpaceKey:  r.Space.Key,
			SpaceName: r.Space.Name,
			Author:    r.Version.By.DisplayName,
			Created:   r.History.CreatedDate.Time,
			Updated:   r.Version.When.Time,
			URL:       raw.Links.Base + r.Links.WebUI,
		})
	}
	return pages, nil
}

// send issues a JSON request and decodes the response (status < 300 = ok).
func (c *Client) send(method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.Email, c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("Confluence %s %s: %s %s", method, path, resp.Status, string(respBody[:min(len(respBody), 200)]))
	}
	if out != nil {
		return json.Unmarshal(respBody, out)
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Space is a Confluence space offered as a publish target.
type Space struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// ListSpaces returns current global spaces (publish targets).
func (c *Client) ListSpaces() ([]Space, error) {
	q := url.Values{"type": {"global"}, "status": {"current"}, "limit": {"200"}}
	var raw struct {
		Results []Space `json:"results"`
	}
	if err := c.get("/wiki/rest/api/space", q, &raw); err != nil {
		return nil, err
	}
	return raw.Results, nil
}

// PageRef identifies a created/updated page.
type PageRef struct {
	ID  string
	URL string
}

func storageBody(html string) map[string]any {
	return map[string]any{"storage": map[string]string{"value": html, "representation": "storage"}}
}

// CreatePage creates a new page in spaceKey with storage-format HTML.
func (c *Client) CreatePage(spaceKey, title, html string) (PageRef, error) {
	payload := map[string]any{
		"type": "page", "title": title,
		"space": map[string]string{"key": spaceKey},
		"body":  storageBody(html),
	}
	var r struct {
		ID    string `json:"id"`
		Links struct {
			Base  string `json:"base"`
			WebUI string `json:"webui"`
		} `json:"_links"`
	}
	if err := c.send(http.MethodPost, "/wiki/rest/api/content", payload, &r); err != nil {
		return PageRef{}, err
	}
	return PageRef{ID: r.ID, URL: r.Links.Base + r.Links.WebUI}, nil
}

// UpdatePage replaces an existing page's title/body (auto-increments version).
func (c *Client) UpdatePage(id, title, html string) (PageRef, error) {
	var cur struct {
		Version struct {
			Number int `json:"number"`
		} `json:"version"`
	}
	if err := c.get("/wiki/rest/api/content/"+id, url.Values{"expand": {"version"}}, &cur); err != nil {
		return PageRef{}, err
	}
	payload := map[string]any{
		"type": "page", "title": title,
		"version": map[string]int{"number": cur.Version.Number + 1},
		"body":    storageBody(html),
	}
	var r struct {
		ID    string `json:"id"`
		Links struct {
			Base  string `json:"base"`
			WebUI string `json:"webui"`
		} `json:"_links"`
	}
	if err := c.send(http.MethodPut, "/wiki/rest/api/content/"+id, payload, &r); err != nil {
		return PageRef{}, err
	}
	return PageRef{ID: id, URL: r.Links.Base + r.Links.WebUI}, nil
}
