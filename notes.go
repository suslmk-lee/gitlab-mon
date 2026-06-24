package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Note is a meeting/call record stored locally (SQLite), optionally shared to
// Confluence. EntityIDs link it to 거래처/프로젝트 엔티티(다대다).
type Note struct {
	ID            int64    `json:"id"`
	Kind          string   `json:"kind"` // "meeting" | "call"
	Title         string   `json:"title"`
	OccurredAt    string   `json:"occurred_at"` // YYYY-MM-DD 또는 RFC3339
	Participants  string   `json:"participants"`
	EntityIDs     []string `json:"entity_ids"`
	Summary       string   `json:"summary"`
	Decisions     string   `json:"decisions"`
	ActionItems   string   `json:"action_items"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
	ConfluenceID  string   `json:"confluence_id"`
	ConfluenceURL string   `json:"confluence_url"`
}

// NoteResult wraps a SaveNote result (saved note + error message for the UI).
type NoteResult struct {
	Note  Note   `json:"note"`
	Error string `json:"error"`
}

const notesSchema = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'meeting',
  title TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  action_items TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  confluence_id TEXT NOT NULL DEFAULT '',
  confluence_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS note_entities (
  note_id INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (note_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_note_entities_entity ON note_entities(entity_id);
`

func notesDBPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "gitlab-mon", "quantumhub.db"), nil
}

// openNotesDB opens (creating if needed) the local SQLite store and migrates schema.
func (a *App) openNotesDB() {
	p, err := notesDBPath()
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	db, err := sql.Open("sqlite", p)
	if err != nil {
		return
	}
	db.SetMaxOpenConns(1) // SQLite는 단일 writer — 직렬화로 lock 경합 회피
	if _, err := db.Exec(notesSchema); err != nil {
		db.Close()
		return
	}
	a.mu.Lock()
	a.db = db
	a.mu.Unlock()
}

func (a *App) notesDB() *sql.DB {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.db
}

func noteEntityIDs(db *sql.DB, id int64) []string {
	rows, err := db.Query(`SELECT entity_id FROM note_entities WHERE note_id=?`, id)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var e string
		if rows.Scan(&e) == nil {
			ids = append(ids, e)
		}
	}
	return ids
}

// ListNotes returns notes (optionally filtered to one entity), newest occurrence first.
func (a *App) ListNotes(entityID string) []Note {
	db := a.notesDB()
	if db == nil {
		return []Note{}
	}
	q := `SELECT id,kind,title,occurred_at,participants,summary,decisions,action_items,created_at,updated_at,confluence_id,confluence_url FROM notes`
	var args []any
	if entityID != "" {
		q += ` WHERE id IN (SELECT note_id FROM note_entities WHERE entity_id=?)`
		args = append(args, entityID)
	}
	q += ` ORDER BY (CASE WHEN occurred_at='' THEN updated_at ELSE occurred_at END) DESC, id DESC`
	rows, err := db.Query(q, args...)
	if err != nil {
		return []Note{}
	}
	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.OccurredAt, &n.Participants, &n.Summary, &n.Decisions, &n.ActionItems, &n.CreatedAt, &n.UpdatedAt, &n.ConfluenceID, &n.ConfluenceURL); err != nil {
			continue
		}
		out = append(out, n)
	}
	rows.Close() // 단일 커넥션(MaxOpenConns=1) — 아래 per-note 조회 전에 반드시 해제
	for i := range out {
		out[i].EntityIDs = noteEntityIDs(db, out[i].ID)
	}
	return out
}

// SaveNote inserts (ID==0) or updates a note and replaces its entity links.
func (a *App) SaveNote(n Note) NoteResult {
	db := a.notesDB()
	if db == nil {
		return NoteResult{Error: "로컬 저장소가 준비되지 않았습니다"}
	}
	if n.Kind != "call" {
		n.Kind = "meeting"
	}
	now := time.Now().Format(time.RFC3339)
	n.UpdatedAt = now

	tx, err := db.Begin()
	if err != nil {
		return NoteResult{Error: err.Error()}
	}
	defer tx.Rollback()

	if n.ID == 0 {
		n.CreatedAt = now
		res, err := tx.Exec(`INSERT INTO notes(kind,title,occurred_at,participants,summary,decisions,action_items,created_at,updated_at,confluence_id,confluence_url) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			n.Kind, n.Title, n.OccurredAt, n.Participants, n.Summary, n.Decisions, n.ActionItems, n.CreatedAt, n.UpdatedAt, n.ConfluenceID, n.ConfluenceURL)
		if err != nil {
			return NoteResult{Error: err.Error()}
		}
		n.ID, _ = res.LastInsertId()
	} else {
		_ = tx.QueryRow(`SELECT created_at FROM notes WHERE id=?`, n.ID).Scan(&n.CreatedAt) // created_at 보존
		if _, err := tx.Exec(`UPDATE notes SET kind=?,title=?,occurred_at=?,participants=?,summary=?,decisions=?,action_items=?,updated_at=?,confluence_id=?,confluence_url=? WHERE id=?`,
			n.Kind, n.Title, n.OccurredAt, n.Participants, n.Summary, n.Decisions, n.ActionItems, n.UpdatedAt, n.ConfluenceID, n.ConfluenceURL, n.ID); err != nil {
			return NoteResult{Error: err.Error()}
		}
	}

	if _, err := tx.Exec(`DELETE FROM note_entities WHERE note_id=?`, n.ID); err != nil {
		return NoteResult{Error: err.Error()}
	}
	for _, eid := range n.EntityIDs {
		if eid = strings.TrimSpace(eid); eid == "" {
			continue
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO note_entities(note_id,entity_id) VALUES(?,?)`, n.ID, eid); err != nil {
			return NoteResult{Error: err.Error()}
		}
	}
	if err := tx.Commit(); err != nil {
		return NoteResult{Error: err.Error()}
	}
	return NoteResult{Note: n}
}

// DeleteNote removes a note and its entity links. Returns "" on success.
func (a *App) DeleteNote(id int64) string {
	db := a.notesDB()
	if db == nil {
		return "로컬 저장소가 준비되지 않았습니다"
	}
	if _, err := db.Exec(`DELETE FROM notes WHERE id=?`, id); err != nil {
		return err.Error()
	}
	_, _ = db.Exec(`DELETE FROM note_entities WHERE note_id=?`, id)
	return ""
}
