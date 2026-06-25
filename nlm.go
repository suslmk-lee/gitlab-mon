package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// nlmMinutesScript is the bundled NotebookLM helper, written to the config dir
// on demand and run with the system python3. See scripts/nlm_minutes.py.
//
//go:embed scripts/nlm_minutes.py
var nlmMinutesScript string

// pythonPath returns a usable python3 interpreter path, or "" if none found.
func pythonPath() string {
	if p, err := exec.LookPath("python3"); err == nil {
		return p
	}
	for _, p := range []string{
		"/opt/homebrew/bin/python3",
		"/usr/local/bin/python3",
		"/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
		"/usr/bin/python3",
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// HasPython reports whether a python3 interpreter is available.
func (a *App) HasPython() bool { return pythonPath() != "" }

// writeNLMScript writes the embedded helper to the config dir and returns its path.
func writeNLMScript() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, "gitlab-mon")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(d, "nlm_minutes.py")
	if err := os.WriteFile(p, []byte(nlmMinutesScript), 0o600); err != nil {
		return "", err
	}
	return p, nil
}

// GenerateMinutesFromAudio uploads the note's local recording to NotebookLM via
// the notebooklm-py helper, generates a Korean meeting minutes (transcription-
// based), and deletes the temporary notebook. The minutes markdown is returned
// for the editor to review before saving. This can take several minutes.
func (a *App) GenerateMinutesFromAudio(noteID int64) NoteAI {
	n, err := a.getNote(noteID)
	if err != nil {
		return NoteAI{Error: "기록을 찾을 수 없습니다: " + err.Error()}
	}
	if n.AudioPath == "" {
		return NoteAI{Error: "이 기록에는 녹음이 없습니다"}
	}
	if _, err := os.Stat(n.AudioPath); err != nil {
		return NoteAI{Error: "녹음 파일을 찾을 수 없습니다: " + err.Error()}
	}
	py := pythonPath()
	if py == "" {
		return NoteAI{Error: "python3을 찾을 수 없습니다 — Python 설치가 필요합니다"}
	}
	script, err := writeNLMScript()
	if err != nil {
		return NoteAI{Error: "헬퍼 스크립트 준비 실패: " + err.Error()}
	}

	name := "QuantumHub_" + fileSanitize(n.Title)

	// NotebookLM STT+분석은 길어질 수 있어 넉넉한 타임아웃(25분).
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 25*time.Minute)
	defer cancel()

	// NotebookLM은 mp3/m4a/wav만 받는다. webm/ogg 등은 mp3로 변환해 업로드.
	upload := n.AudioPath
	ext := strings.ToLower(filepath.Ext(n.AudioPath))
	accepted := ext == ".mp3" || ext == ".m4a" || ext == ".wav" || ext == ".aac"
	if !accepted {
		ff := ffmpegPath()
		if ff == "" {
			return NoteAI{Error: "NotebookLM은 " + ext + " 업로드를 지원하지 않습니다 — 변환에 ffmpeg가 필요합니다"}
		}
		tmp := filepath.Join(os.TempDir(), fmt.Sprintf("qh-nlm-%d.mp3", n.ID))
		cv := exec.CommandContext(ctx, ff, "-y", "-i", n.AudioPath,
			"-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", tmp)
		if out, err := cv.CombinedOutput(); err != nil {
			return NoteAI{Error: "업로드용 변환 실패: " + err.Error() + " — " + lastLines(string(out), 2)}
		}
		defer os.Remove(tmp)
		upload = tmp
	}

	cmd := exec.CommandContext(ctx, py, script, upload, name, "1200")
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	// 헬퍼는 성공·실패 모두 stdout에 JSON 한 줄을 낸다. 먼저 그걸 파싱.
	if line := lastJSONLine(stdout.String()); line != "" {
		var r struct {
			Content string `json:"content"`
			Error   string `json:"error"`
		}
		if json.Unmarshal([]byte(line), &r) == nil {
			if r.Error != "" {
				return NoteAI{Error: r.Error}
			}
			return NoteAI{Content: strings.TrimSpace(r.Content)}
		}
	}
	// JSON이 없으면(예: 타임아웃/크래시) stderr로 진단.
	if ctx.Err() == context.DeadlineExceeded {
		return NoteAI{Error: "시간 초과(25분) — 녹음이 너무 길거나 업로드가 지연됩니다"}
	}
	msg := lastLines(stderr.String(), 3)
	if msg == "" && runErr != nil {
		msg = runErr.Error()
	}
	if msg == "" {
		msg = "알 수 없는 오류"
	}
	return NoteAI{Error: "회의록 생성 실패: " + msg}
}

// lastJSONLine returns the last line that looks like a JSON object.
func lastJSONLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		t := strings.TrimSpace(lines[i])
		if strings.HasPrefix(t, "{") && strings.HasSuffix(t, "}") {
			return t
		}
	}
	return ""
}
