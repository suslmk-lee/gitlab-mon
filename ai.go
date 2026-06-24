package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"gitlab-mon/internal/config"
)

var aiHTTP = &http.Client{Timeout: 90 * time.Second}

func aiModelDefault(provider string) string {
	switch provider {
	case "openai":
		return "gpt-4o-mini"
	case "gemini":
		return "gemini-2.0-flash"
	case "minimax":
		return "MiniMax-Text-01"
	default: // anthropic
		return "claude-haiku-4-5-20251001"
	}
}

func aiBaseDefault(provider string) string {
	switch provider {
	case "openai":
		return "https://api.openai.com/v1"
	case "minimax":
		return "https://api.minimax.io/v1"
	default:
		return ""
	}
}

// aiComplete routes a single-prompt completion to the configured provider and
// returns the text. provider: anthropic|openai|gemini|minimax|custom.
func aiComplete(provider, model, baseURL, key, prompt string, maxTokens int) (string, error) {
	if key == "" {
		return "", fmt.Errorf("AI API 키가 없습니다 — 설정 → AI에서 등록하세요")
	}
	if model == "" {
		model = aiModelDefault(provider)
	}
	switch provider {
	case "gemini":
		return geminiComplete(key, model, prompt, maxTokens)
	case "openai", "minimax", "custom":
		base := baseURL
		if base == "" {
			base = aiBaseDefault(provider)
		}
		if base == "" {
			return "", fmt.Errorf("%s: API Base URL이 필요합니다 (설정 → AI)", provider)
		}
		return openaiComplete(base, key, model, prompt, maxTokens)
	default: // anthropic
		return claudeComplete(key, model, prompt, maxTokens)
	}
}

func aiPost(req *http.Request, out any) error {
	resp, err := aiHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("AI API %s — %s", resp.Status, string(body[:min(len(body), 200)]))
	}
	return json.Unmarshal(body, out)
}

// claudeComplete — Anthropic /v1/messages.
func claudeComplete(key, model, prompt string, maxTokens int) (string, error) {
	b, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	var out struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := aiPost(req, &out); err != nil {
		return "", err
	}
	if len(out.Content) == 0 {
		return "", fmt.Errorf("AI 응답이 비었습니다")
	}
	return out.Content[0].Text, nil
}

// openaiComplete — OpenAI-compatible /chat/completions (OpenAI·MiniMax·custom).
func openaiComplete(base, key, model, prompt string, maxTokens int) (string, error) {
	b, _ := json.Marshal(map[string]any{
		"model": model, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequest(http.MethodPost, base+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := aiPost(req, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("AI 응답이 비었습니다")
	}
	return out.Choices[0].Message.Content, nil
}

// geminiComplete — Google Generative Language generateContent.
func geminiComplete(key, model, prompt string, maxTokens int) (string, error) {
	b, _ := json.Marshal(map[string]any{
		"contents":         []map[string]any{{"parts": []map[string]string{{"text": prompt}}}},
		"generationConfig": map[string]any{"maxOutputTokens": maxTokens},
	})
	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	var out struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := aiPost(req, &out); err != nil {
		return "", err
	}
	if len(out.Candidates) == 0 || len(out.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("AI 응답이 비었습니다")
	}
	return out.Candidates[0].Content.Parts[0].Text, nil
}

// ---- 설정 화면용 AI 구성 ----

// AIConfig is the AI settings surface for the frontend (key never returned).
type AIConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"base_url"`
	HasKey   bool   `json:"has_key"`
}

func (a *App) GetAIConfig() AIConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	return AIConfig{
		Provider: a.cfg.AIProvider,
		Model:    a.cfg.AIModel,
		BaseURL:  a.cfg.AIBaseURL,
		HasKey:   a.cfg.AIKey != "",
	}
}

// SaveAIConfig updates the AI provider/model/base/key and persists (key→keychain).
// An empty key keeps the existing one (so editing model alone doesn't wipe it).
func (a *App) SaveAIConfig(provider, model, baseURL, key string) string {
	a.mu.Lock()
	a.cfg.AIProvider = provider
	a.cfg.AIModel = model
	a.cfg.AIBaseURL = baseURL
	if key != "" {
		a.cfg.AIKey = key
	}
	cfg := a.cfg
	a.mu.Unlock()
	if err := config.Save(cfg); err != nil {
		return err.Error()
	}
	return ""
}
