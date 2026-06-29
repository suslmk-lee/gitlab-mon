package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	GitLabURL    string `json:"gitlab_url"`
	GitLabToken  string `json:"gitlab_token,omitempty"` // 디스크에는 저장하지 않음 (Keychain 사용)
	JiraURL      string `json:"jira_url,omitempty"`
	JiraEmail    string `json:"jira_email,omitempty"`
	JiraToken    string `json:"jira_token,omitempty"` // 디스크에는 저장하지 않음 (Keychain 사용)
	AnthropicKey string `json:"-"`                    // 구버전 호환 (env ANTHROPIC_API_KEY / keychain "anthropic")
	// AI 제공자 설정 (provider/model/baseURL은 config.json, 키는 keychain "ai:<provider>")
	AIProvider string `json:"ai_provider,omitempty"` // anthropic|openai|gemini|minimax|custom
	AIModel    string `json:"ai_model,omitempty"`    // 비우면 제공자 기본 모델
	AIBaseURL  string `json:"ai_base_url,omitempty"` // custom(OpenAI 호환) 베이스 URL
	AIKey      string `json:"-"`                     // 선택된 제공자의 API 키 (keychain)
	// KosmosAI 플랫폼 통계용 (감사 로그 = superuser 토큰 필요). 디스크 미저장.
	KosmosAIToken string `json:"-"`                       // env KOSMOSAI_TOKEN (PAT ks_ 또는 JWT)
	KosmosAIURL   string `json:"kosmosai_url,omitempty"`  // portal-api 베이스 (비우면 기본값)
	// Keycloak 로그인/세션 통계용 (service-account client_credentials). secret 디스크 미저장.
	KeycloakURL          string `json:"keycloak_url,omitempty"`    // 비우면 기본값
	KeycloakRealm        string `json:"keycloak_realm,omitempty"`  // 비우면 kosmos
	KeycloakClientID     string `json:"keycloak_client_id,omitempty"`
	KeycloakClientSecret string `json:"-"` // env KEYCLOAK_CLIENT_SECRET
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
				cfg2 := cfg
				cfg2.GitLabToken = ""
				cfg2.JiraToken = ""
				_ = writeConfigFile(cfg2) // 파일에서 토큰 제거
			}
		}
		if cfg.JiraURL != "" {
			if t, ok := keychainGet(jiraKeychainAccount(cfg.JiraURL)); ok {
				cfg.JiraToken = t
			}
		}
		if t, ok := keychainGet("anthropic"); ok {
			cfg.AnthropicKey = t
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
	if v := os.Getenv("JIRA_URL"); v != "" {
		cfg.JiraURL = v
	}
	if v := os.Getenv("JIRA_EMAIL"); v != "" {
		cfg.JiraEmail = v
	}
	if v := os.Getenv("JIRA_TOKEN"); v != "" {
		cfg.JiraToken = v
	}
	if v := os.Getenv("ANTHROPIC_API_KEY"); v != "" {
		cfg.AnthropicKey = v
	}
	if v := os.Getenv("AI_PROVIDER"); v != "" {
		cfg.AIProvider = v
	}
	if v := os.Getenv("AI_MODEL"); v != "" {
		cfg.AIModel = v
	}
	if v := os.Getenv("AI_BASE_URL"); v != "" {
		cfg.AIBaseURL = v
	}
	if v := os.Getenv("AI_API_KEY"); v != "" {
		cfg.AIKey = v
	}
	if v := os.Getenv("KOSMOSAI_TOKEN"); v != "" {
		cfg.KosmosAIToken = v
	}
	if v := os.Getenv("KOSMOSAI_URL"); v != "" {
		cfg.KosmosAIURL = v
	}
	if v := os.Getenv("KEYCLOAK_URL"); v != "" {
		cfg.KeycloakURL = v
	}
	if v := os.Getenv("KEYCLOAK_REALM"); v != "" {
		cfg.KeycloakRealm = v
	}
	if v := os.Getenv("KEYCLOAK_CLIENT_ID"); v != "" {
		cfg.KeycloakClientID = v
	}
	if v := os.Getenv("KEYCLOAK_CLIENT_SECRET"); v != "" {
		cfg.KeycloakClientSecret = v
	}

	// AI 제공자 기본값 + 키 로드 (provider 확정 후). 키체인 계정은 "ai:<provider>".
	if cfg.AIProvider == "" {
		cfg.AIProvider = "anthropic"
	}
	if keychainAvailable() && cfg.AIKey == "" {
		if t, ok := keychainGet("ai:" + cfg.AIProvider); ok {
			cfg.AIKey = t
		}
	}
	if cfg.AIKey == "" && cfg.AIProvider == "anthropic" {
		cfg.AIKey = cfg.AnthropicKey // 구버전 anthropic 키 재사용
	}

	cfg.GitLabURL = strings.TrimRight(cfg.GitLabURL, "/")
	cfg.JiraURL = strings.TrimRight(cfg.JiraURL, "/")
	cfg.AIBaseURL = strings.TrimRight(cfg.AIBaseURL, "/")
	return cfg
}

// Save persists the URL to config.json and the token to the macOS Keychain,
// so the single binary works from anywhere without a plaintext secret on disk.
// If the Keychain is unavailable, it falls back to the legacy plaintext file.
func Save(cfg Config) error {
	onDisk := cfg
	if keychainAvailable() {
		if cfg.GitLabToken != "" && keychainSet(keychainAccount(cfg.GitLabURL), cfg.GitLabToken) == nil {
			onDisk.GitLabToken = ""
		}
		if cfg.JiraURL != "" && cfg.JiraToken != "" && keychainSet(jiraKeychainAccount(cfg.JiraURL), cfg.JiraToken) == nil {
			onDisk.JiraToken = ""
		}
		if cfg.AnthropicKey != "" {
			_ = keychainSet("anthropic", cfg.AnthropicKey)
		}
		if cfg.AIKey != "" && cfg.AIProvider != "" {
			_ = keychainSet("ai:"+cfg.AIProvider, cfg.AIKey)
		}
	}
	// AnthropicKey/AIKey는 json:"-" 라 파일에 안 써짐 (provider/model/baseURL만 저장)
	return writeConfigFile(onDisk)
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

// MRReviewCachePath returns the MR review cache file location.
func MRReviewCachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "mr-reviews-cache.json"), nil
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
		case "JIRA_URL":
			cfg.JiraURL = v
		case "JIRA_EMAIL":
			cfg.JiraEmail = v
		case "JIRA_TOKEN":
			cfg.JiraToken = v
		case "ANTHROPIC_API_KEY":
			cfg.AnthropicKey = v
		case "KOSMOSAI_TOKEN":
			cfg.KosmosAIToken = v
		case "KOSMOSAI_URL":
			cfg.KosmosAIURL = v
		case "KEYCLOAK_URL":
			cfg.KeycloakURL = v
		case "KEYCLOAK_REALM":
			cfg.KeycloakRealm = v
		case "KEYCLOAK_CLIENT_ID":
			cfg.KeycloakClientID = v
		case "KEYCLOAK_CLIENT_SECRET":
			cfg.KeycloakClientSecret = v
		}
	}
}
