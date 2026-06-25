package main

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gitlab-mon/internal/confluence"

	"github.com/wailsapp/wails/v2/pkg/runtime"

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
	AudioPath     string   `json:"audio_path"` // 녹음 파일 경로 (있으면)
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
  confluence_url TEXT NOT NULL DEFAULT '',
  audio_path TEXT NOT NULL DEFAULT ''
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
	// 마이그레이션: 구버전 테이블에 audio_path 추가 (이미 있으면 에러 무시)
	_, _ = db.Exec(`ALTER TABLE notes ADD COLUMN audio_path TEXT NOT NULL DEFAULT ''`)
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
	ids := []string{} // 엔티티가 없어도 nil 대신 빈 배열 반환 (프론트 .includes/.map 보호)
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
	q := `SELECT id,kind,title,occurred_at,participants,summary,decisions,action_items,created_at,updated_at,confluence_id,confluence_url,audio_path FROM notes`
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
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.OccurredAt, &n.Participants, &n.Summary, &n.Decisions, &n.ActionItems, &n.CreatedAt, &n.UpdatedAt, &n.ConfluenceID, &n.ConfluenceURL, &n.AudioPath); err != nil {
			continue
		}
		n.EntityIDs = []string{}
		out = append(out, n)
	}
	rows.Close() // 단일 커넥션(MaxOpenConns=1) — 아래 링크 조회 전에 반드시 해제
	if len(out) == 0 {
		return out
	}
	// 엔티티 링크를 한 번의 쿼리로 일괄 로드 (N+1 방지)
	ph := make([]string, len(out))
	args2 := make([]any, len(out))
	idx := make(map[int64]int, len(out))
	for i := range out {
		ph[i] = "?"
		args2[i] = out[i].ID
		idx[out[i].ID] = i
	}
	if lrows, err := db.Query(`SELECT note_id, entity_id FROM note_entities WHERE note_id IN (`+strings.Join(ph, ",")+`)`, args2...); err == nil {
		for lrows.Next() {
			var nid int64
			var eid string
			if lrows.Scan(&nid, &eid) == nil {
				if i, ok := idx[nid]; ok {
					out[i].EntityIDs = append(out[i].EntityIDs, eid)
				}
			}
		}
		lrows.Close()
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
		res, err := tx.Exec(`INSERT INTO notes(kind,title,occurred_at,participants,summary,decisions,action_items,created_at,updated_at,confluence_id,confluence_url,audio_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			n.Kind, n.Title, n.OccurredAt, n.Participants, n.Summary, n.Decisions, n.ActionItems, n.CreatedAt, n.UpdatedAt, n.ConfluenceID, n.ConfluenceURL, n.AudioPath)
		if err != nil {
			return NoteResult{Error: err.Error()}
		}
		n.ID, _ = res.LastInsertId()
	} else {
		_ = tx.QueryRow(`SELECT created_at FROM notes WHERE id=?`, n.ID).Scan(&n.CreatedAt) // created_at 보존
		if _, err := tx.Exec(`UPDATE notes SET kind=?,title=?,occurred_at=?,participants=?,summary=?,decisions=?,action_items=?,updated_at=?,confluence_id=?,confluence_url=?,audio_path=? WHERE id=?`,
			n.Kind, n.Title, n.OccurredAt, n.Participants, n.Summary, n.Decisions, n.ActionItems, n.UpdatedAt, n.ConfluenceID, n.ConfluenceURL, n.AudioPath, n.ID); err != nil {
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

// getNote loads a single note (with entity links) by id.
func (a *App) getNote(id int64) (Note, error) {
	db := a.notesDB()
	if db == nil {
		return Note{}, fmt.Errorf("로컬 저장소가 준비되지 않았습니다")
	}
	var n Note
	err := db.QueryRow(`SELECT id,kind,title,occurred_at,participants,summary,decisions,action_items,created_at,updated_at,confluence_id,confluence_url,audio_path FROM notes WHERE id=?`, id).
		Scan(&n.ID, &n.Kind, &n.Title, &n.OccurredAt, &n.Participants, &n.Summary, &n.Decisions, &n.ActionItems, &n.CreatedAt, &n.UpdatedAt, &n.ConfluenceID, &n.ConfluenceURL, &n.AudioPath)
	if err != nil {
		return Note{}, err
	}
	n.EntityIDs = noteEntityIDs(db, n.ID)
	return n, nil
}

// noteConfluenceTitle builds the page title (date helps uniqueness within a space).
func noteConfluenceTitle(n Note) string {
	t := strings.TrimSpace(n.Title)
	if t == "" {
		t = "기록"
	}
	if d := n.OccurredAt; len(d) >= 10 {
		return fmt.Sprintf("%s (%s)", t, d[:10])
	}
	return t
}

// noteStorageHTML renders a note to Confluence storage-format XHTML.
func noteStorageHTML(n Note, entities []Entity) string {
	esc := html.EscapeString
	para := func(s string) string { return strings.ReplaceAll(esc(s), "\n", "<br/>") }
	var names []string
	for _, id := range n.EntityIDs {
		nm := id
		for _, e := range entities {
			if e.ID == id {
				nm = e.Name
				break
			}
		}
		names = append(names, esc(nm))
	}
	kind := "회의"
	if n.Kind == "call" {
		kind = "통화"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "<p><strong>종류</strong> %s · <strong>일시</strong> %s", kind, esc(n.OccurredAt))
	if n.Participants != "" {
		fmt.Fprintf(&b, " · <strong>참석자</strong> %s", esc(n.Participants))
	}
	b.WriteString("</p>")
	if len(names) > 0 {
		fmt.Fprintf(&b, "<p><strong>관련</strong> %s</p>", strings.Join(names, ", "))
	}
	section := func(title, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		fmt.Fprintf(&b, "<h2>%s</h2><p>%s</p>", esc(title), para(body))
	}
	if strings.TrimSpace(n.Summary) != "" {
		fmt.Fprintf(&b, "<h2>내용</h2>%s", mdToStorageHTML(n.Summary)) // 내용은 마크다운 렌더
	}
	section("결정 사항", n.Decisions) // 구버전 노트 호환 (비어 있으면 생략)
	section("액션 아이템", n.ActionItems)
	b.WriteString("<hr/><p><em>Quantum Hub에서 작성된 기록</em></p>")
	return b.String()
}

// ShareNote publishes a note to Confluence — creates a new page (in spaceKey) the
// first time, then updates that page on subsequent shares. Stores the page
// id/url back on the note. Returns the updated note or an error.
func (a *App) ShareNote(id int64, spaceKey string) NoteResult {
	a.mu.Lock()
	cc := a.confluenceClient
	a.mu.Unlock()
	if cc == nil {
		return NoteResult{Error: "Confluence가 설정되지 않았습니다"}
	}
	n, err := a.getNote(id)
	if err != nil {
		return NoteResult{Error: "기록을 찾을 수 없습니다: " + err.Error()}
	}
	title := noteConfluenceTitle(n)
	body := noteStorageHTML(n, a.entitiesSnapshot())

	var ref confluence.PageRef
	if n.ConfluenceID == "" {
		if strings.TrimSpace(spaceKey) == "" {
			return NoteResult{Error: "공유할 스페이스를 선택하세요"}
		}
		ref, err = cc.CreatePage(spaceKey, title, body)
	} else {
		ref, err = cc.UpdatePage(n.ConfluenceID, title, body)
	}
	if err != nil {
		return NoteResult{Error: err.Error()}
	}
	n.ConfluenceID = ref.ID
	n.ConfluenceURL = ref.URL
	return a.SaveNote(n) // confluence_id/url 영속화
}

// NoteAI is the result of AI tidy-up — a single cleaned content text.
type NoteAI struct {
	Content string `json:"content"`
	Error   string `json:"error"`
}

// SummarizeNote sends the note's raw content to Claude and returns one cleaned,
// structured Korean text for the editor to review (single content box).
func (a *App) SummarizeNote(n Note) NoteAI {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	if cfg.AIKey == "" {
		return NoteAI{Error: "AI API 키가 없습니다 — 설정 → AI에서 등록하세요"}
	}
	raw := strings.TrimSpace(n.Summary)
	if raw == "" {
		return NoteAI{Error: "정리할 내용이 없습니다 — 내용 칸에 메모를 입력하세요"}
	}
	kind := "회의"
	if n.Kind == "call" {
		kind = "통화"
	}
	ctx := ""
	if n.Participants != "" {
		ctx = " (참석자: " + n.Participants + ")"
	}
	prompt := fmt.Sprintf("다음은 %s 메모입니다%s. 한국어로 깔끔하게 정리해서 하나의 텍스트로만 출력하세요"+
		"(JSON·코드펜스·머리말 금지). 핵심 요약을 먼저 2~4문장으로 쓰고, 결정 사항과 액션 아이템이 "+
		"있으면 '결정 사항', '액션 아이템' 소제목과 '- ' 불릿으로 이어서 정리하세요. 원문에 없는 내용은 만들지 마세요.\n\n메모:\n%s",
		kind, ctx, raw)

	txt, err := aiComplete(cfg.AIProvider, cfg.AIModel, cfg.AIBaseURL, cfg.AIKey, prompt, 1200)
	if err != nil {
		return NoteAI{Error: err.Error()}
	}
	return NoteAI{Content: strings.TrimSpace(txt)}
}

// DeleteNote removes a note, its entity links, and its audio file. Returns "" on success.
func (a *App) DeleteNote(id int64) string {
	db := a.notesDB()
	if db == nil {
		return "로컬 저장소가 준비되지 않았습니다"
	}
	var audio string
	_ = db.QueryRow(`SELECT audio_path FROM notes WHERE id=?`, id).Scan(&audio)
	if _, err := db.Exec(`DELETE FROM notes WHERE id=?`, id); err != nil {
		return err.Error()
	}
	_, _ = db.Exec(`DELETE FROM note_entities WHERE note_id=?`, id)
	if audio != "" {
		_ = os.Remove(audio)
	}
	return ""
}

// audioDir returns (creating) the local recordings directory.
func audioDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, "gitlab-mon", "audio")
	return d, os.MkdirAll(d, 0o700)
}

// SaveNoteAudio writes a base64 recording to a file and links it to the note.
// ext is the extension without dot (webm/m4a/mp4/wav...).
func (a *App) SaveNoteAudio(noteID int64, b64, ext string) NoteResult {
	n, err := a.getNote(noteID)
	if err != nil {
		return NoteResult{Error: "기록을 찾을 수 없습니다: " + err.Error()}
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return NoteResult{Error: "오디오 디코드 실패: " + err.Error()}
	}
	if len(data) == 0 {
		return NoteResult{Error: "녹음 데이터가 비었습니다"}
	}
	dir, err := audioDir()
	if err != nil {
		return NoteResult{Error: err.Error()}
	}
	ext = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(ext)), ".")
	if ext == "" {
		ext = "webm"
	}
	path := filepath.Join(dir, fmt.Sprintf("note-%d-%d.%s", noteID, time.Now().Unix(), ext))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return NoteResult{Error: err.Error()}
	}
	if n.AudioPath != "" && n.AudioPath != path {
		_ = os.Remove(n.AudioPath) // 교체 시 이전 파일 정리
	}
	n.AudioPath = path
	return a.SaveNote(n)
}

// ReadAudioBase64 returns an audio file's bytes as base64 for in-app playback.
func (a *App) ReadAudioBase64(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

// AudioDownloadResult is the outcome of DownloadNoteAudio.
type AudioDownloadResult struct {
	Path     string `json:"path"`     // 저장된 경로 (성공 시)
	Error    string `json:"error"`    // 오류 메시지
	Canceled bool   `json:"canceled"` // 사용자가 대화상자를 취소함
}

// fileSanitize replaces filesystem-unsafe characters for a default filename.
func fileSanitize(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t':
			return '_'
		}
		return r
	}, s)
	if s == "" {
		s = "녹음"
	}
	return s
}

// DownloadNoteAudio opens a native Save dialog and copies the note's recording
// to the chosen location (streamed — handles large files without base64).
func (a *App) DownloadNoteAudio(noteID int64) AudioDownloadResult {
	n, err := a.getNote(noteID)
	if err != nil {
		return AudioDownloadResult{Error: "기록을 찾을 수 없습니다: " + err.Error()}
	}
	if n.AudioPath == "" {
		return AudioDownloadResult{Error: "이 기록에는 녹음이 없습니다"}
	}
	if _, err := os.Stat(n.AudioPath); err != nil {
		return AudioDownloadResult{Error: "녹음 파일을 찾을 수 없습니다: " + err.Error()}
	}
	ext := filepath.Ext(n.AudioPath) // 점 포함 (".webm")
	defName := fileSanitize(n.Title) + ext
	if a.ctx == nil {
		return AudioDownloadResult{Error: "앱 컨텍스트가 준비되지 않았습니다"}
	}
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "녹음 저장",
		DefaultFilename: defName,
	})
	if err != nil {
		return AudioDownloadResult{Error: err.Error()}
	}
	if dest == "" {
		return AudioDownloadResult{Canceled: true} // 사용자가 취소
	}
	in, err := os.Open(n.AudioPath)
	if err != nil {
		return AudioDownloadResult{Error: err.Error()}
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return AudioDownloadResult{Error: err.Error()}
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return AudioDownloadResult{Error: err.Error()}
	}
	if err := out.Close(); err != nil {
		return AudioDownloadResult{Error: err.Error()}
	}
	return AudioDownloadResult{Path: dest}
}
