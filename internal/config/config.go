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
	GitLabToken string `json:"gitlab_token"`
}

const defaultURL = "https://ci.quantumcns.ai"

// Load resolves config in priority order:
//  1. GITLAB_URL / GITLAB_TOKEN environment variables
//  2. env.local next to the executable, then in the working directory
//  3. ~/Library/Application Support/gitlab-mon/config.json (saved via UI)
func Load() Config {
	cfg := Config{GitLabURL: defaultURL}

	// 3. saved config (lowest priority, loaded first so others override)
	if p, err := savedPath(); err == nil {
		if b, err := os.ReadFile(p); err == nil {
			_ = json.Unmarshal(b, &cfg)
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

// Save persists config to the user config dir so the single binary
// works from anywhere after first-run setup.
func Save(cfg Config) error {
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
