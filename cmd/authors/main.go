package main

import (
	"fmt"
	"sort"
	"time"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/gitlab"
)

func main() {
	cfg := config.Load()
	c := gitlab.NewClient(cfg.GitLabURL, cfg.GitLabToken)
	pr, _ := c.GetAllProjects()
	since := time.Now().AddDate(0, 0, -30)
	after := since.AddDate(0, 0, -1).Format("2006-01-02")
	type key struct{ user, name string }
	counts := map[key]int{}
	for _, p := range pr {
		if p.LastActivityAt.Before(since) {
			continue
		}
		evs, err := c.GetProjectEvents(p.ID, after, 5)
		if err != nil {
			fmt.Println("err:", p.PathWithNamespace, err)
			continue
		}
		for _, e := range evs {
			counts[key{e.Author.Username, e.Author.Name}]++
		}
	}
	type row struct {
		k key
		n int
	}
	var rows []row
	for k, n := range counts {
		rows = append(rows, row{k, n})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].n > rows[j].n })
	for _, r := range rows {
		fmt.Printf("%5d  username=%-22q name=%q\n", r.n, r.k.user, r.k.name)
	}
}
