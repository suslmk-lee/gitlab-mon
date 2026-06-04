package main

import (
	"fmt"
	"os/exec"
	"strconv"

	"gitlab-mon/internal/gitlab"
)

// notify sends a macOS notification via osascript (no extra dependencies).
func notify(title, message string) {
	script := fmt.Sprintf("display notification %q with title %q sound name \"default\"", message, title)
	go func() { _ = exec.Command("/usr/bin/osascript", "-e", script).Run() }()
}

const notifyBatchLimit = 3 // 이보다 많으면 요약 알림 1건으로

// checkNotifications diffs the new snapshot against notification state and
// fires macOS notifications for newly failed pipelines and newly opened MRs.
// The first snapshot only seeds the baseline (no notifications on app start).
func (a *App) checkNotifications(snap *Snapshot) {
	a.mu.Lock()
	base := a.notifyBaselined

	// 새로 실패한 파이프라인 (이미 알린 ID 제외)
	var newFailed []gitlab.Pipeline
	curFailed := make(map[int]bool)
	for _, p := range snap.Pipelines {
		if p.Status != "failed" {
			continue
		}
		curFailed[p.ID] = true
		if !a.notifiedPipes[p.ID] {
			newFailed = append(newFailed, p)
		}
	}
	// notified 집합을 현재 윈도우로 한정해 무한 성장 방지
	for id := range a.notifiedPipes {
		if !curFailed[id] {
			delete(a.notifiedPipes, id)
		}
	}
	for _, p := range newFailed {
		a.notifiedPipes[p.ID] = true
	}

	// 새로 열린 MR
	var newMRs []gitlab.MergeRequest
	curMRs := make(map[int]bool, len(snap.OpenMRs))
	for _, m := range snap.OpenMRs {
		curMRs[m.ID] = true
		if !a.knownMRs[m.ID] {
			newMRs = append(newMRs, m)
		}
	}
	a.knownMRs = curMRs
	a.notifyBaselined = true
	a.mu.Unlock()

	if !base {
		return // 첫 스냅샷은 기준선만
	}

	if n := len(newFailed); n > notifyBatchLimit {
		notify("GitLab 파이프라인 실패", strconv.Itoa(n)+"개 파이프라인이 실패했습니다")
	} else {
		for _, p := range newFailed {
			proj := p.ProjectPath
			if proj == "" {
				proj = "#" + strconv.Itoa(p.ProjectID)
			}
			notify("❌ 파이프라인 실패 — "+proj, p.Ref+" 브랜치")
		}
	}

	if n := len(newMRs); n > notifyBatchLimit {
		notify("GitLab 새 MR", strconv.Itoa(n)+"개의 MR이 새로 열렸습니다")
	} else {
		for _, m := range newMRs {
			proj := m.ProjectPath
			if proj == "" {
				proj = "#" + strconv.Itoa(m.ProjectID)
			}
			notify("🔀 새 MR — "+proj, "!"+strconv.Itoa(m.IID)+" "+m.Title+" ("+m.Author.Username+")")
		}
	}
}
