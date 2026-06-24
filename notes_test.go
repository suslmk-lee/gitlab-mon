package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestMdToStorageHTML(t *testing.T) {
	cases := map[string]string{
		"# 제목":                      "<h2>제목</h2>",
		"- a\n- b":                  "<ul><li>a</li><li>b</li></ul>",
		"1. 첫\n2. 둘":                "<ol><li>첫</li><li>둘</li></ol>",
		"**굵게** 보통":                 "<strong>굵게</strong>",
		"`code`":                    "<code>code</code>",
		"[링크](http://x)":            `<a href="http://x">링크</a>`,
		"> 인용문":                     "<blockquote>인용문</blockquote>",
		"평문 한 줄":                    "<p>평문 한 줄</p>",
		"<script>alert(1)</script>": "&lt;script&gt;", // XSS 이스케이프
	}
	for in, want := range cases {
		if got := mdToStorageHTML(in); !strings.Contains(got, want) {
			t.Errorf("mdToStorageHTML(%q)\n  got:  %q\n  want substring: %q", in, got, want)
		}
	}
	// 스크립트 태그가 살아서 나가면 안 됨
	if strings.Contains(mdToStorageHTML("<script>x</script>"), "<script>") {
		t.Error("script tag not escaped")
	}
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(notesSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return &App{db: db}
}

func TestNotesCRUD(t *testing.T) {
	a := newTestApp(t)

	// insert
	r := a.SaveNote(Note{Kind: "call", Title: "종근당 통화", OccurredAt: "2026-06-24",
		EntityIDs: []string{"akashiq", "kosmos"}, Summary: "논의", Decisions: "결정", ActionItems: "액션"})
	if r.Error != "" {
		t.Fatalf("save: %s", r.Error)
	}
	if r.Note.ID == 0 || r.Note.CreatedAt == "" {
		t.Fatalf("bad saved note: %+v", r.Note)
	}

	// list all + entity links
	all := a.ListNotes("")
	if len(all) != 1 || len(all[0].EntityIDs) != 2 {
		t.Fatalf("list all: %+v", all)
	}

	// entity filter
	if len(a.ListNotes("akashiq")) != 1 || len(a.ListNotes("kosmos")) != 1 || len(a.ListNotes("nope")) != 0 {
		t.Fatal("entity filter wrong")
	}

	// update — title + drop one entity link; created_at preserved
	upd := r.Note
	upd.Title = "수정됨"
	upd.EntityIDs = []string{"akashiq"}
	r2 := a.SaveNote(upd)
	if r2.Error != "" {
		t.Fatalf("update: %s", r2.Error)
	}
	if len(a.ListNotes("kosmos")) != 0 {
		t.Fatal("kosmos link should be removed after update")
	}
	got := a.ListNotes("")
	if len(got) != 1 || got[0].Title != "수정됨" {
		t.Fatalf("title not updated: %+v", got)
	}
	if got[0].CreatedAt != r.Note.CreatedAt {
		t.Fatalf("created_at not preserved: %q vs %q", got[0].CreatedAt, r.Note.CreatedAt)
	}

	// delete
	if e := a.DeleteNote(r.Note.ID); e != "" {
		t.Fatalf("delete: %s", e)
	}
	if len(a.ListNotes("")) != 0 {
		t.Fatal("note not deleted")
	}
}
