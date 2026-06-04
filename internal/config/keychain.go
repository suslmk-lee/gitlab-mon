package config

import (
	"net/url"
	"os/exec"
	"runtime"
	"strings"
)

// macOS Keychain access via /usr/bin/security — no cgo, no extra deps.
// Items are stored as generic passwords: service "gitlab-mon",
// account = GitLab host (so multiple instances can coexist).

const keychainService = "gitlab-mon"

func keychainAvailable() bool {
	return runtime.GOOS == "darwin"
}

func keychainAccount(gitlabURL string) string {
	if u, err := url.Parse(gitlabURL); err == nil && u.Host != "" {
		return u.Host
	}
	return gitlabURL
}

func keychainSet(account, secret string) error {
	// -U: update if the item already exists
	return exec.Command("/usr/bin/security", "add-generic-password",
		"-U", "-s", keychainService, "-a", account, "-w", secret).Run()
}

func keychainGet(account string) (string, bool) {
	out, err := exec.Command("/usr/bin/security", "find-generic-password",
		"-s", keychainService, "-a", account, "-w").Output()
	if err != nil {
		return "", false
	}
	t := strings.TrimSpace(string(out))
	return t, t != ""
}

func keychainDelete(account string) {
	_ = exec.Command("/usr/bin/security", "delete-generic-password",
		"-s", keychainService, "-a", account).Run()
}
