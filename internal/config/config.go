package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	GitLabURL   string `json:"gitlab_url"`
	GitLabToken string `json:"gitlab_token,omitempty"` // 디스크에는 저장하지 않음 (Keychain 사용)
}

const defaultURL = "https://ci.quantumcns.ai"

// Load resolves config in priority order:
//  1. GITLAB_URL / GITLAB_TOKEN environment variables
//  2. env.local next to the executable, then in the working directory
//  3. macOS Keychain (service "gitlab-mon", account = GitLab host)
//  4. ~/Library/Application Support/gitlab-mon/config.json
//     (URL 저장용; 구버전이 남긴 평문 토큰은 Keychain으로 자동 이전)
func Load() Config {
	cfg := Config{GitLabURL: defaultURL}

	// 4. saved config (lowest priority, loaded first so others override)
	legacyFileToken := ""
	if p, err := savedPath(); err == nil {
		if b, err := os.ReadFile(p); err == nil {
			_ = json.Unmarshal(b, &cfg)
			legacyFileToken = cfg.GitLabToken
		}
	}

	// 3. Keychain
	if keychainAvailable() {
		if t, ok := keychainGet(keychainAccount(cfg.GitLabURL)); ok {
			cfg.GitLabToken = t
		} else if legacyFileToken != "" {
			// 구버전 config.json의 평문 토큰을 Keychain으로 이전
			if keychainSet(keychainAccount(cfg.GitLabURL), legacyFileToken) == nil {
				_ = writeConfigFile(Config{GitLabURL: cfg.GitLabURL}) // 파일에서 토큰 제거
			}
		}
	}

	// 2. env.local files
	if exe, err := os.Executable(); err == nil {
		applyEnvFile(filepath.Join(filepath.Dir(exe), "env.local"), &cfg)
	}
	if wd, err := os.Getwd(); err == nil {
		applyEnvFile(filepath.Join(wd, "env.local"), &cfg)
	}

	// 1. environment variables
	if v := os.Getenv("GITLAB_URL"); v != "" {
		cfg.GitLabURL = v
	}
	if v := os.Getenv("GITLAB_TOKEN"); v != "" {
		cfg.GitLabToken = v
	}

	cfg.GitLabURL = strings.TrimRight(cfg.GitLabURL, "/")
	return cfg
}

// Save persists the URL to config.json and the token to the macOS Keychain,
// so the single binary works from anywhere without a plaintext secret on disk.
// If the Keychain is unavailable, it falls back to the legacy plaintext file.
func Save(cfg Config) error {
	if keychainAvailable() && cfg.GitLabToken != "" {
		if err := keychainSet(keychainAccount(cfg.GitLabURL), cfg.GitLabToken); err == nil {
			return writeConfigFile(Config{GitLabURL: cfg.GitLabURL})
		}
	}
	return writeConfigFile(cfg)
}

func writeConfigFile(cfg Config) error {
	p, err := savedPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

func savedPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "config.json"), nil
}

// CachePath returns the events-cache file location in the user config dir.
func CachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "events-cache.json"), nil
}

// PipelineCachePath returns the pipelines-cache file location.
func PipelineCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "pipelines-cache.json"), nil
}

func applyEnvFile(path string, cfg *Config) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "GITLAB_URL":
			cfg.GitLabURL = v
		case "GITLAB_TOKEN":
			cfg.GitLabToken = v
		}
	}
}
