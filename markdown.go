package main

import (
	"fmt"
	"html"
	"regexp"
	"strings"
)

// 경량 마크다운 → Confluence storage(XHTML) 변환. 프론트 Markdown 컴포넌트와 같은
// 범위(제목·목록·인용·코드·구분선 + 인라인 강조/코드/링크). 텍스트는 항상 이스케이프.
var (
	mdReHR   = regexp.MustCompile(`^(---+|\*\*\*+)\s*$`)
	mdReHead = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	mdReUL   = regexp.MustCompile(`^\s*[-*+]\s+`)
	mdReOL   = regexp.MustCompile(`^\s*\d+\.\s+`)
	mdReCode = regexp.MustCompile("`([^`\n]+)`")
	mdReBold = regexp.MustCompile(`\*\*([^*\n]+)\*\*`)
	mdReItal = regexp.MustCompile(`\*([^*\n]+)\*`)
	mdReLink = regexp.MustCompile(`\[([^\]\n]+)\]\(([^)\n]+)\)`)
)

// mdInlineHTML escapes a span then applies inline markdown. Markers (* ` [ ]) are
// not HTML-escaped, so escaping-first is safe before running the inline regexes.
func mdInlineHTML(s string) string {
	s = html.EscapeString(s)
	s = mdReCode.ReplaceAllString(s, "<code>$1</code>")
	s = mdReBold.ReplaceAllString(s, "<strong>$1</strong>")
	s = mdReItal.ReplaceAllString(s, "<em>$1</em>")
	s = mdReLink.ReplaceAllString(s, `<a href="$2">$1</a>`)
	return s
}

func mdBlockStart(s string) bool {
	return mdReHead.MatchString(s) || strings.HasPrefix(s, "```") || strings.HasPrefix(s, ">") ||
		mdReUL.MatchString(s) || mdReOL.MatchString(s) || mdReHR.MatchString(s)
}

// mdToStorageHTML converts markdown to Confluence storage-format XHTML.
func mdToStorageHTML(md string) string {
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	var b strings.Builder
	i := 0
	for i < len(lines) {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			i++
			continue
		}
		switch {
		case strings.HasPrefix(line, "```"):
			i++
			var code []string
			for i < len(lines) && !strings.HasPrefix(lines[i], "```") {
				code = append(code, lines[i])
				i++
			}
			i++ // 닫는 펜스
			fmt.Fprintf(&b, "<pre>%s</pre>", html.EscapeString(strings.Join(code, "\n")))
		case mdReHR.MatchString(line):
			b.WriteString("<hr/>")
			i++
		case mdReHead.MatchString(line):
			m := mdReHead.FindStringSubmatch(line)
			lvl := len(m[1]) + 1 // # → h2 (페이지 제목이 h1 역할)
			if lvl > 6 {
				lvl = 6
			}
			fmt.Fprintf(&b, "<h%d>%s</h%d>", lvl, mdInlineHTML(m[2]), lvl)
			i++
		case strings.HasPrefix(line, ">"):
			var q []string
			for i < len(lines) && strings.HasPrefix(lines[i], ">") {
				q = append(q, strings.TrimPrefix(strings.TrimPrefix(lines[i], ">"), " "))
				i++
			}
			fmt.Fprintf(&b, "<blockquote>%s</blockquote>", mdInlineHTML(strings.Join(q, " ")))
		case mdReUL.MatchString(line):
			b.WriteString("<ul>")
			for i < len(lines) && mdReUL.MatchString(lines[i]) {
				fmt.Fprintf(&b, "<li>%s</li>", mdInlineHTML(mdReUL.ReplaceAllString(lines[i], "")))
				i++
			}
			b.WriteString("</ul>")
		case mdReOL.MatchString(line):
			b.WriteString("<ol>")
			for i < len(lines) && mdReOL.MatchString(lines[i]) {
				fmt.Fprintf(&b, "<li>%s</li>", mdInlineHTML(mdReOL.ReplaceAllString(lines[i], "")))
				i++
			}
			b.WriteString("</ol>")
		default:
			var p []string
			for i < len(lines) && strings.TrimSpace(lines[i]) != "" && !mdBlockStart(lines[i]) {
				p = append(p, mdInlineHTML(lines[i]))
				i++
			}
			fmt.Fprintf(&b, "<p>%s</p>", strings.Join(p, "<br/>"))
		}
	}
	return b.String()
}
