package main

import (
	"fmt"
	"time"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/gitlab"
)

func main() {
	cfg := config.Load()
	c := gitlab.NewClient(cfg.GitLabURL, cfg.GitLabToken)
	v, err := c.GetVersion()
	fmt.Println("version:", v.Version, err)
	pr, err := c.GetAllProjects()
	fmt.Println("projects:", len(pr), err)
	mr, err := c.GetOpenMergeRequests()
	fmt.Println("open MRs:", len(mr), err)
	since := time.Now().AddDate(0, 0, -30)
	mg, err := c.GetMergedMergeRequests(since.UTC().Format(time.RFC3339))
	fmt.Println("merged MRs (30d):", len(mg), err)
	after := since.AddDate(0, 0, -1).Format("2006-01-02")
	total := 0
	n := 0
	for _, p := range pr {
		if p.LastActivityAt.Before(since) {
			continue
		}
		n++
		evs, err := c.GetProjectEvents(p.ID, after, 5)
		if err != nil {
			fmt.Println("  err", p.PathWithNamespace, err)
			continue
		}
		fmt.Printf("  %-50s %d events\n", p.PathWithNamespace, len(evs))
		total += len(evs)
	}
	fmt.Printf("active projects (30d): %d, total events: %d\n", n, total)
}
