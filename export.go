package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

// SaveCSV writes the given content to ~/Downloads and reveals it in Finder.
// Returns the saved path, or "ERR:<message>" on failure.
func (a *App) SaveCSV(name, content string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "ERR:" + err.Error()
	}
	p := filepath.Join(home, "Downloads", filepath.Base(name)) // path traversal 방지
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		return "ERR:" + err.Error()
	}
	_ = exec.Command("/usr/bin/open", "-R", p).Run() // Finder에서 선택 표시
	return p
}
