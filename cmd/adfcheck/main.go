package main

import (
	"fmt"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/jira"
)

func main() {
	cfg := config.Load()
	c := jira.NewClient(cfg.JiraURL, cfg.JiraEmail, cfg.JiraToken)
	html, err := c.GetIssueDescription("KSHQ-20")
	if err != nil {
		fmt.Println("ERR:", err)
		return
	}
	if len(html) > 1200 {
		html = html[:1200]
	}
	fmt.Println(html)
}
