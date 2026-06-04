package jira

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a minimal Jira Cloud REST v3 client (Basic auth: email + API token).
type Client struct {
	BaseURL string // e.g. https://quantumcns-ai.atlassian.net
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
		return fmt.Errorf("Jira GET %s: %s", path, resp.Status)
	}
	return json.Unmarshal(body, out)
}

func (c *Client) post(path string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.Email, c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("Jira POST %s: %s %s", path, resp.Status, string(msg))
	}
	return nil
}

// jiraTime parses Jira Cloud timestamps like "2026-05-18T11:43:19.089+0900".
type jiraTime struct{ time.Time }

func (t *jiraTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.999-0700", s)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, s)
		if err != nil {
			return nil // 알 수 없는 포맷은 zero time으로
		}
	}
	t.Time = parsed
	return nil
}

// Issue is the normalized form shipped to the app/frontend.
type Issue struct {
	Key            string    `json:"key"`
	Summary        string    `json:"summary"`
	ParentKey      string    `json:"parent_key"` // 하위 이슈인 경우 부모 키
	ParentSummary  string    `json:"parent_summary"`
	IsSubtask      bool      `json:"is_subtask"`
	ProjectKey     string    `json:"project_key"`
	ProjectName    string    `json:"project_name"`
	Status         string    `json:"status"`
	StatusCategory string    `json:"status_category"` // new | indeterminate | done
	Assignee       string    `json:"assignee"`        // displayName, 없으면 ""
	Priority       string    `json:"priority"`
	Type           string    `json:"type"`
	Created        time.Time `json:"created"`
	Updated        time.Time `json:"updated"`
	DueDate        string    `json:"due_date"` // YYYY-MM-DD, 없으면 ""
	Resolved       bool      `json:"resolved"`
	URL            string    `json:"url"`
}

type rawIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Project struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"project"`
		Status struct {
			Name           string `json:"name"`
			StatusCategory struct {
				Key string `json:"key"`
			} `json:"statusCategory"`
		} `json:"status"`
		Assignee *struct {
			DisplayName string `json:"displayName"`
		} `json:"assignee"`
		Priority *struct {
			Name string `json:"name"`
		} `json:"priority"`
		IssueType struct {
			Name    string `json:"name"`
			Subtask bool   `json:"subtask"`
		} `json:"issuetype"`
		Parent *struct {
			Key    string `json:"key"`
			Fields struct {
				Summary string `json:"summary"`
			} `json:"fields"`
		} `json:"parent"`
		Created        jiraTime `json:"created"`
		Updated        jiraTime `json:"updated"`
		DueDate        string   `json:"duedate"`
		ResolutionDate jiraTime `json:"resolutiondate"`
	} `json:"fields"`
}

func (c *Client) normalize(r rawIssue) Issue {
	is := Issue{
		Key:            r.Key,
		Summary:        r.Fields.Summary,
		ProjectKey:     r.Fields.Project.Key,
		ProjectName:    r.Fields.Project.Name,
		Status:         r.Fields.Status.Name,
		StatusCategory: r.Fields.Status.StatusCategory.Key,
		Type:           r.Fields.IssueType.Name,
		Created:        r.Fields.Created.Time,
		Updated:        r.Fields.Updated.Time,
		DueDate:        r.Fields.DueDate,
		Resolved:       !r.Fields.ResolutionDate.IsZero(),
		URL:            c.BaseURL + "/browse/" + r.Key,
	}
	if r.Fields.Assignee != nil {
		is.Assignee = r.Fields.Assignee.DisplayName
	}
	if r.Fields.Priority != nil {
		is.Priority = r.Fields.Priority.Name
	}
	if r.Fields.Parent != nil {
		is.ParentKey = r.Fields.Parent.Key
		is.ParentSummary = r.Fields.Parent.Fields.Summary
	}
	// team-managed 프로젝트는 subtask 플래그 대신 parent 관계만 있을 수도 있음
	is.IsSubtask = r.Fields.IssueType.Subtask || is.ParentKey != ""
	return is
}

const issueFields = "summary,status,assignee,priority,issuetype,project,created,updated,duedate,resolutiondate,parent"

// Transition is one allowed workflow move for an issue.
type Transition struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ToStatus   string `json:"to_status"`
	ToCategory string `json:"to_category"`
}

// GetTransitions returns the workflow transitions currently allowed.
func (c *Client) GetTransitions(key string) ([]Transition, error) {
	var resp struct {
		Transitions []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			To   struct {
				Name           string `json:"name"`
				StatusCategory struct {
					Key string `json:"key"`
				} `json:"statusCategory"`
			} `json:"to"`
		} `json:"transitions"`
	}
	if err := c.get("/rest/api/3/issue/"+key+"/transitions", nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Transition, 0, len(resp.Transitions))
	for _, t := range resp.Transitions {
		out = append(out, Transition{ID: t.ID, Name: t.Name, ToStatus: t.To.Name, ToCategory: t.To.StatusCategory.Key})
	}
	return out, nil
}

// Transition executes a workflow transition on an issue.
func (c *Client) Transition(key, transitionID string) error {
	return c.post("/rest/api/3/issue/"+key+"/transitions",
		map[string]any{"transition": map[string]string{"id": transitionID}})
}

// GetIssue fetches a single issue in normalized form.
func (c *Client) GetIssue(key string) (Issue, error) {
	q := url.Values{}
	q.Set("fields", issueFields)
	var r rawIssue
	if err := c.get("/rest/api/3/issue/"+key, q, &r); err != nil {
		return Issue{}, err
	}
	return c.normalize(r), nil
}

// SearchIssues runs a JQL query, following nextPageToken pagination,
// up to maxPages*100 issues.
func (c *Client) SearchIssues(jql string, maxPages int) ([]Issue, error) {
	var all []Issue
	token := ""
	for page := 1; page <= maxPages; page++ {
		q := url.Values{}
		q.Set("jql", jql)
		q.Set("maxResults", "100")
		q.Set("fields", issueFields)
		if token != "" {
			q.Set("nextPageToken", token)
		}
		var resp struct {
			Issues        []rawIssue `json:"issues"`
			NextPageToken string     `json:"nextPageToken"`
			IsLast        bool       `json:"isLast"`
		}
		if err := c.get("/rest/api/3/search/jql", q, &resp); err != nil {
			return all, err
		}
		for _, r := range resp.Issues {
			all = append(all, c.normalize(r))
		}
		if resp.IsLast || resp.NextPageToken == "" {
			break
		}
		token = resp.NextPageToken
	}
	return all, nil
}
