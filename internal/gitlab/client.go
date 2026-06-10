package gitlab

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Client is a minimal GitLab REST v4 API client.
type Client struct {
	BaseURL string // e.g. https://ci.quantumcns.ai
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *Client) get(path string, query url.Values, out any) (http.Header, error) {
	u := c.BaseURL + "/api/v4" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("PRIVATE-TOKEN", c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return resp.Header, fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return resp.Header, fmt.Errorf("GET %s: decode: %w", path, err)
		}
	}
	return resp.Header, nil
}

// ---- Types ----

type Version struct {
	Version  string `json:"version"`
	Revision string `json:"revision"`
}

type Statistics struct {
	Forks         string `json:"forks"`
	Issues        string `json:"issues"`
	MergeRequests string `json:"merge_requests"`
	Users         string `json:"users"`
	Projects      string `json:"projects"`
	Groups        string `json:"groups"`
	ActiveUsers   string `json:"active_users"`
}

type Author struct {
	ID        int    `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	IsBot     bool   `json:"is_bot"` // set locally for access-token bot users
}

type Group struct {
	ID       int    `json:"id"`
	FullPath string `json:"full_path"`
}

type PushData struct {
	CommitCount int    `json:"commit_count"`
	Action      string `json:"action"`
	RefType     string `json:"ref_type"`
	Ref         string `json:"ref"`
	CommitTitle string `json:"commit_title"`
}

type Event struct {
	ID          int       `json:"id"`
	ProjectID   int       `json:"project_id"`
	ActionName  string    `json:"action_name"`
	TargetType  string    `json:"target_type"`
	TargetTitle string    `json:"target_title"`
	TargetIID   int       `json:"target_iid"`
	Author      Author    `json:"author"`
	PushData    *PushData `json:"push_data"`
	CreatedAt   time.Time `json:"created_at"`
	// Enriched locally
	ProjectPath string `json:"project_path"`
	ProjectURL  string `json:"project_url"`
}

type Project struct {
	ID                int       `json:"id"`
	PathWithNamespace string    `json:"path_with_namespace"`
	Name              string    `json:"name"`
	WebURL            string    `json:"web_url"`
	LastActivityAt    time.Time `json:"last_activity_at"`
}

type MergeRequest struct {
	ID           int       `json:"id"`
	IID          int       `json:"iid"`
	ProjectID    int       `json:"project_id"`
	Title        string    `json:"title"`
	State        string    `json:"state"`
	Draft        bool      `json:"draft"`
	Author       Author    `json:"author"`
	SourceBranch string    `json:"source_branch"`
	TargetBranch string    `json:"target_branch"`
	WebURL       string     `json:"web_url"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	MergedAt     *time.Time `json:"merged_at"`
	// Enriched locally
	ProjectPath   string     `json:"project_path"`
	FirstReviewAt *time.Time `json:"first_review_at"` // 작성자 외 첫 댓글/승인 시각
	FirstReviewer string     `json:"first_reviewer"`
	Approvers     []string   `json:"approvers"` // 현재 승인자 username 목록
}

type Commit struct {
	ID          string    `json:"id"`
	AuthorName  string    `json:"author_name"`
	AuthorEmail string    `json:"author_email"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"created_at"`
	Stats       *struct {
		Additions int `json:"additions"`
		Deletions int `json:"deletions"`
	} `json:"stats"`
}

type User struct {
	ID          int    `json:"id"`
	Username    string `json:"username"`
	Name        string `json:"name"`
	Email       string `json:"email"`        // admin only
	PublicEmail string `json:"public_email"`
}

type Note struct {
	ID        int       `json:"id"`
	Body      string    `json:"body"`
	System    bool      `json:"system"`
	Author    Author    `json:"author"`
	CreatedAt time.Time `json:"created_at"`
}

type Pipeline struct {
	ID        int       `json:"id"`
	ProjectID int       `json:"project_id"`
	Status    string    `json:"status"`
	Source    string    `json:"source"`
	Ref       string    `json:"ref"`
	SHA       string    `json:"sha"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	WebURL    string    `json:"web_url"`
	// Enriched locally
	ProjectPath string `json:"project_path"`
}

// ---- API calls ----

func (c *Client) GetVersion() (*Version, error) {
	var v Version
	_, err := c.get("/version", nil, &v)
	return &v, err
}

func (c *Client) GetStatistics() (*Statistics, error) {
	var s Statistics
	_, err := c.get("/application/statistics", nil, &s)
	return &s, err
}

// GetAllProjects pages through every project visible to the token (admin: all).
func (c *Client) GetAllProjects() ([]Project, error) {
	var all []Project
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		q.Set("order_by", "last_activity_at")
		q.Set("sort", "desc")
		q.Set("simple", "true")
		var batch []Project
		h, err := c.get("/projects", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetProjectEventsPage returns one page of a project's events after the given
// date (YYYY-MM-DD), newest first, and whether more pages exist.
// Note: the instance-wide /events?scope=all endpoint only returns the current
// user's dashboard events, so per-project collection is the reliable path.
func (c *Client) GetProjectEventsPage(projectID int, after string, page int) ([]Event, bool, error) {
	q := url.Values{}
	q.Set("per_page", "100")
	q.Set("page", strconv.Itoa(page))
	if after != "" {
		q.Set("after", after)
	}
	var batch []Event
	h, err := c.get("/projects/"+strconv.Itoa(projectID)+"/events", q, &batch)
	if err != nil {
		return nil, false, err
	}
	next := h.Get("x-next-page")
	return batch, next != "" && next != "0" && len(batch) > 0, nil
}

// GetProjectEvents returns a project's events after the given date (YYYY-MM-DD),
// newest first, up to maxPages*100 events.
func (c *Client) GetProjectEvents(projectID int, after string, maxPages int) ([]Event, error) {
	var all []Event
	for page := 1; page <= maxPages; page++ {
		batch, hasNext, err := c.GetProjectEventsPage(projectID, after, page)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		if !hasNext {
			break
		}
	}
	return all, nil
}

// GetAllGroups pages through every group visible to the token.
func (c *Client) GetAllGroups() ([]Group, error) {
	var all []Group
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		var batch []Group
		h, err := c.get("/groups", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetProjectPipelines returns a project's pipelines updated after the given
// RFC3339 time, newest first, up to maxPages*100.
func (c *Client) GetProjectPipelines(projectID int, updatedAfter string, maxPages int) ([]Pipeline, error) {
	var all []Pipeline
	for page := 1; page <= maxPages; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		if updatedAfter != "" {
			q.Set("updated_after", updatedAfter)
		}
		var batch []Pipeline
		h, err := c.get("/projects/"+strconv.Itoa(projectID)+"/pipelines", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetProjectCommits returns default-branch commits since the given RFC3339
// time with line stats included (with_stats), newest first, up to maxPages*100.
func (c *Client) GetProjectCommits(projectID int, since string, maxPages int) ([]Commit, error) {
	var all []Commit
	for page := 1; page <= maxPages; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		q.Set("with_stats", "true")
		if since != "" {
			q.Set("since", since)
		}
		var batch []Commit
		h, err := c.get("/projects/"+strconv.Itoa(projectID)+"/repository/commits", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetAllUsers pages through every user (admin sees emails).
func (c *Client) GetAllUsers() ([]User, error) {
	var all []User
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		var batch []User
		h, err := c.get("/users", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetMRNotes returns an MR's notes oldest-first, up to maxPages*100.
func (c *Client) GetMRNotes(projectID, iid, maxPages int) ([]Note, error) {
	var all []Note
	base := "/projects/" + strconv.Itoa(projectID) + "/merge_requests/" + strconv.Itoa(iid) + "/notes"
	for page := 1; page <= maxPages; page++ {
		q := url.Values{}
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		q.Set("order_by", "created_at")
		q.Set("sort", "asc")
		var batch []Note
		h, err := c.get(base, q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetMRApprovals returns usernames that currently approve the MR.
func (c *Client) GetMRApprovals(projectID, iid int) ([]Author, error) {
	var resp struct {
		ApprovedBy []struct {
			User Author `json:"user"`
		} `json:"approved_by"`
	}
	_, err := c.get("/projects/"+strconv.Itoa(projectID)+"/merge_requests/"+strconv.Itoa(iid)+"/approvals", nil, &resp)
	if err != nil {
		return nil, err
	}
	users := make([]Author, 0, len(resp.ApprovedBy))
	for _, a := range resp.ApprovedBy {
		users = append(users, a.User)
	}
	return users, nil
}

// GetMergedMergeRequests returns MRs merged/updated after the given time.
func (c *Client) GetMergedMergeRequests(updatedAfter string) ([]MergeRequest, error) {
	var all []MergeRequest
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("scope", "all")
		q.Set("state", "merged")
		q.Set("updated_after", updatedAfter)
		q.Set("order_by", "updated_at")
		q.Set("sort", "desc")
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		var batch []MergeRequest
		h, err := c.get("/merge_requests", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}

// GetOpenMergeRequests returns all open MRs across the instance.
func (c *Client) GetOpenMergeRequests() ([]MergeRequest, error) {
	var all []MergeRequest
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("scope", "all")
		q.Set("state", "opened")
		q.Set("order_by", "updated_at")
		q.Set("sort", "desc")
		q.Set("per_page", "100")
		q.Set("page", strconv.Itoa(page))
		var batch []MergeRequest
		h, err := c.get("/merge_requests", q, &batch)
		if err != nil {
			return all, err
		}
		all = append(all, batch...)
		next := h.Get("x-next-page")
		if next == "" || next == "0" || len(batch) == 0 {
			break
		}
	}
	return all, nil
}
