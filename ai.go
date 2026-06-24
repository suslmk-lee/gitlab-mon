package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// claudeComplete sends a single user-message prompt to the Claude API and returns
// the text response. Shared by note summarization (SummarizeWeek has its own copy
// for now; consolidate if a third caller appears).
func claudeComplete(apiKey, prompt string, maxTokens int) (string, error) {
	reqBody, _ := json.Marshal(map[string]any{
		"model":      "claude-haiku-4-5-20251001",
		"max_tokens": maxTokens,
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("content-type", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("Claude API %s — %s", resp.Status, string(body[:min(len(body), 200)]))
	}
	var out struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(body, &out) != nil || len(out.Content) == 0 {
		return "", fmt.Errorf("AI 응답 파싱 실패")
	}
	return out.Content[0].Text, nil
}
