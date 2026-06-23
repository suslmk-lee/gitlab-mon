package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// aliasesPath returns the user-mapping config file location.
func aliasesPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "aliases.json"), nil
}

// loadAliases loads the git-author → GitLab-username map from disk. On first run
// (no file yet) it seeds from defaultAliases and persists, so the built-in
// mappings show up — and stay editable — in the 사용자 매핑 settings screen.
func (a *App) loadAliases() {
	p, err := aliasesPath()
	if err != nil {
		return
	}
	var m map[string]string
	if loadJSONFile(p, &m) && m != nil {
		a.mu.Lock()
		a.aliases = m
		a.mu.Unlock()
		return
	}
	seed := make(map[string]string, len(defaultAliases))
	for k, v := range defaultAliases {
		seed[k] = v
	}
	a.mu.Lock()
	a.aliases = seed
	a.mu.Unlock()
	a.saveAliases()
}

// saveAliases persists the current alias map to disk.
func (a *App) saveAliases() {
	p, err := aliasesPath()
	if err != nil {
		return
	}
	saveJSONFile(p, a.aliasesSnapshot())
}

// aliasesSnapshot returns a copy of the alias map for lock-free reads.
func (a *App) aliasesSnapshot() map[string]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	m := make(map[string]string, len(a.aliases))
	for k, v := range a.aliases {
		m[k] = v
	}
	return m
}

// ---- Settings screen data contracts ----

// AliasEntry is one git-author → GitLab-username mapping. Key is a lowercased git
// author email (preferred, unique) or name.
type AliasEntry struct {
	Key      string `json:"key"`
	Username string `json:"username"`
}

// UnmappedAuthor is a git commit author that doesn't resolve to a GitLab user —
// a candidate to map in the settings screen.
type UnmappedAuthor struct {
	Name    string `json:"name"`
	Email   string `json:"email"`
	Commits int    `json:"commits"`
}

// GLUserLite is a GitLab user offered as a mapping target.
type GLUserLite struct {
	Username string `json:"username"`
	Name     string `json:"name"`
}

// AuthorMappingData is everything the 사용자 매핑 screen needs.
type AuthorMappingData struct {
	Aliases  []AliasEntry     `json:"aliases"`  // 현재 매핑
	Unmapped []UnmappedAuthor `json:"unmapped"` // 매핑 안 된 git 작성자 (커밋수 내림차순)
	Users    []GLUserLite     `json:"users"`    // 매핑 대상 GitLab 사용자
}

// GetAuthorMappings returns current mappings, the unmapped commit authors worth
// mapping, and the GitLab users available as targets.
func (a *App) GetAuthorMappings() AuthorMappingData {
	a.mu.Lock()
	users := a.lastUsers
	aliases := make(map[string]string, len(a.aliases))
	for k, v := range a.aliases {
		aliases[k] = v
	}
	type id struct{ name, email string }
	counts := map[id]int{}
	for _, c := range a.commitCache {
		for _, cm := range c.Commits {
			counts[id{cm.AuthorName, cm.AuthorEmail}]++
		}
	}
	a.mu.Unlock()

	resolve := buildUserResolver(users, aliases)
	glUsers := make(map[string]bool, len(users))
	for _, u := range users {
		glUsers[u.Username] = true
	}

	var unmapped []UnmappedAuthor
	for k, n := range counts {
		r := resolve(k.name, k.email)
		// 이미 매핑됨 or 순수 자동/플레이스홀더는 제외. genericAuthors(ubuntu/claude)는
		// 실제 사람일 수 있어 후보로 남겨 연결 가능하게 한다.
		if glUsers[r] || isUnmappableNoise(r) {
			continue
		}
		unmapped = append(unmapped, UnmappedAuthor{Name: k.name, Email: k.email, Commits: n})
	}
	sort.Slice(unmapped, func(i, j int) bool { return unmapped[i].Commits > unmapped[j].Commits })
	if len(unmapped) > 100 {
		unmapped = unmapped[:100]
	}

	aliasList := make([]AliasEntry, 0, len(aliases))
	for k, v := range aliases {
		aliasList = append(aliasList, AliasEntry{Key: k, Username: v})
	}
	sort.Slice(aliasList, func(i, j int) bool {
		if aliasList[i].Username != aliasList[j].Username {
			return aliasList[i].Username < aliasList[j].Username
		}
		return aliasList[i].Key < aliasList[j].Key
	})

	glList := make([]GLUserLite, 0, len(users))
	for _, u := range users {
		if isBotUsername(u.Username) || systemAuthors[strings.ToLower(u.Username)] {
			continue
		}
		glList = append(glList, GLUserLite{Username: u.Username, Name: u.Name})
	}
	sort.Slice(glList, func(i, j int) bool {
		return strings.ToLower(glList[i].Username) < strings.ToLower(glList[j].Username)
	})

	return AuthorMappingData{Aliases: aliasList, Unmapped: unmapped, Users: glList}
}

// SaveAuthorMappings replaces the alias set with the given entries, persists it,
// and re-publishes from cache so the change flows into the report and stats
// without a network re-poll. Targets are canonicalized to the real GitLab
// username casing; returns "" on success or a warning listing unknown targets.
func (a *App) SaveAuthorMappings(entries []AliasEntry) string {
	a.mu.Lock()
	users := a.lastUsers
	a.mu.Unlock()
	canon := make(map[string]string, len(users)) // lower(username) → canonical username
	for _, u := range users {
		canon[strings.ToLower(u.Username)] = u.Username
	}

	m := make(map[string]string, len(entries))
	unknown := map[string]bool{}
	for _, e := range entries {
		k := strings.ToLower(strings.TrimSpace(e.Key))
		u := strings.TrimSpace(e.Username)
		if k == "" || u == "" {
			continue
		}
		if cu, ok := canon[strings.ToLower(u)]; ok {
			u = cu // 정규 username으로 교정 → 이벤트 author와 매칭됨
		} else if len(users) > 0 {
			unknown[u] = true // GitLab에 없는 대상 (오타/이름변경/삭제)
		}
		m[k] = u
	}

	a.mu.Lock()
	a.aliases = m
	a.mu.Unlock()
	a.saveAliases()
	go a.publishFromCache() // 네트워크 없이 통계(code_daily) 재집계·재발행

	if len(unknown) > 0 {
		names := make([]string, 0, len(unknown))
		for u := range unknown {
			names = append(names, u)
		}
		sort.Strings(names)
		return "경고: GitLab에 없는 사용자명으로 매핑됨 — " + strings.Join(names, ", ")
	}
	return ""
}
