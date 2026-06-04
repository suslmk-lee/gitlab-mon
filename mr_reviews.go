package main

import (
	"sync"
	"time"

	"gitlab-mon/internal/config"
	"gitlab-mon/internal/gitlab"
)

// mrReview caches per-MR review facts derived from notes/approvals.
type mrReview struct {
	UpdatedAt     time.Time  `json:"updated_at"` // MR updated_at at fetch time
	FirstReviewAt *time.Time `json:"first_review_at"`
	FirstReviewer string     `json:"first_reviewer"`
	Approvers     []string   `json:"approvers"`
}

type mrReviewCacheFile struct {
	WindowDays int               `json:"window_days"`
	MRs        map[int]*mrReview `json:"mrs"`
}

func (a *App) loadMRCache() {
	if p, err := config.MRReviewCachePath(); err == nil {
		var f mrReviewCacheFile
		if loadJSONFile(p, &f) && f.WindowDays == statsWindowDay && f.MRs != nil {
			a.mu.Lock()
			a.mrCache = f.MRs
			a.mu.Unlock()
		}
	}
}

func (a *App) saveMRCache() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, err := config.MRReviewCachePath(); err == nil {
		saveJSONFile(p, mrReviewCacheFile{WindowDays: statsWindowDay, MRs: a.mrCache})
	}
}

// approvedNoteBody is the system note GitLab writes when someone approves.
const approvedNoteBody = "approved this merge request"

// collectMRReviews fetches notes+approvals for MRs whose updated_at moved,
// caches the derived review facts, and enriches the given MR slices in place.
func (a *App) collectMRReviews(client *gitlab.Client, mrLists ...[]gitlab.MergeRequest) {
	type job struct {
		id, projectID, iid int
		author             string
		updatedAt          time.Time
	}

	a.mu.Lock()
	var jobs []job
	current := map[int]bool{}
	for _, mrs := range mrLists {
		for _, m := range mrs {
			current[m.ID] = true
			c, ok := a.mrCache[m.ID]
			if !ok || m.UpdatedAt.After(c.UpdatedAt) {
				jobs = append(jobs, job{m.ID, m.ProjectID, m.IID, m.Author.Username, m.UpdatedAt})
			}
		}
	}
	// 윈도우를 벗어난 MR은 캐시에서 제거
	for id := range a.mrCache {
		if !current[id] {
			delete(a.mrCache, id)
		}
	}
	a.mu.Unlock()

	total := len(jobs)
	if total > 0 {
		a.emitProgress("MR 리뷰", 0, total)
	}
	var (
		done int
		sem  = make(chan struct{}, fetchWorkers)
		wg   sync.WaitGroup
	)
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			rev := &mrReview{UpdatedAt: j.updatedAt}

			if notes, err := client.GetMRNotes(j.projectID, j.iid, 3); err == nil {
				for _, n := range notes { // oldest first
					if n.Author.Username == j.author {
						continue
					}
					// 사람 댓글 또는 승인 시스템 노트만 리뷰로 인정
					if !n.System || n.Body == approvedNoteBody {
						t := n.CreatedAt
						rev.FirstReviewAt = &t
						rev.FirstReviewer = n.Author.Username
						break
					}
				}
			}
			if approvers, err := client.GetMRApprovals(j.projectID, j.iid); err == nil {
				names := make([]string, 0, len(approvers))
				for _, u := range approvers {
					names = append(names, u.Username)
				}
				rev.Approvers = names
			}

			a.mu.Lock()
			a.mrCache[j.id] = rev
			done++
			d := done
			a.mu.Unlock()
			a.emitProgress("MR 리뷰", d, total)
		}(j)
	}
	wg.Wait()

	// 캐시 → MR 슬라이스 enrich
	a.mu.Lock()
	for _, mrs := range mrLists {
		for i := range mrs {
			if c, ok := a.mrCache[mrs[i].ID]; ok {
				mrs[i].FirstReviewAt = c.FirstReviewAt
				mrs[i].FirstReviewer = c.FirstReviewer
				mrs[i].Approvers = c.Approvers
			}
		}
	}
	a.mu.Unlock()
}
