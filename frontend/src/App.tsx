import {useEffect, useMemo, useRef, useState} from 'react';
import './App.css';
import {GetSnapshot, Refresh, SaveConfig, OpenURL, SaveCSV, JiraMove, JiraDetail, WeeklyReport, WeeklyReportUsers, SummarizeWeek, GetAuthorMappings, SaveAuthorMappings, GetEntities, SaveEntities, GetTeams, SaveTeams, GetMembers, SaveMembers, ListNotes, SaveNote, DeleteNote, ShareNote, ConfluenceSpaces, SummarizeNote, GetAIConfig, SaveAIConfig, SaveNoteAudio, ReadAudioBase64, DownloadNoteAudio, HasFFmpeg, GenerateMinutesFromAudio, HasPython} from "../wailsjs/go/main/App";
import {EventsOn} from "../wailsjs/runtime/runtime";

// ---- Types mirroring the Go Snapshot ----
interface Author { id: number; username: string; name: string; avatar_url: string; is_bot: boolean }
interface PushData { commit_count: number; action: string; ref_type: string; ref: string; commit_title: string }
interface GLEvent {
    id: number; project_id: number; action_name: string; target_type: string;
    target_title: string; target_iid: number; author: Author; push_data: PushData | null;
    created_at: string; project_path: string; project_url: string;
}
interface Project { id: number; path_with_namespace: string; name: string; web_url: string; last_activity_at: string }
interface MR {
    id: number; iid: number; project_id: number; title: string; draft: boolean;
    author: Author; source_branch: string; target_branch: string; web_url: string;
    created_at: string; updated_at: string; merged_at: string | null; project_path: string;
    first_review_at: string | null; first_reviewer: string; approvers: string[] | null;
}
interface Stats {
    forks: string; issues: string; merge_requests: string; users: string;
    projects: string; groups: string; active_users: string;
}
interface Pipeline {
    id: number; project_id: number; status: string; source: string; ref: string; sha: string;
    created_at: string; updated_at: string; web_url: string; project_path: string;
}
interface CodeDay { user: string; day: string; add: number; del: number; commits: number }
interface JiraIssue {
    key: string; summary: string; parent_key: string; parent_summary: string;
    is_subtask: boolean; project_key: string; project_name: string;
    status: string; status_category: string; assignee: string; priority: string;
    type: string; created: string; updated: string; due_date: string;
    resolved: boolean; url: string;
}
interface ConfluencePage {
    id: string; title: string; space_key: string; space_name: string;
    author: string; created: string; updated: string; url: string; products: string[];
}
interface Note {
    id: number; kind: string; title: string; occurred_at: string;
    participants: string; entity_ids: string[]; summary: string;
    decisions: string; action_items: string;
    created_at: string; updated_at: string; confluence_id: string; confluence_url: string; audio_path: string;
}
interface CfSpace { key: string; name: string }
const audioMime = (p: string) => {
    const e = p.toLowerCase().split('.').pop();
    return e === 'mp4' || e === 'm4a' ? 'audio/mp4' : e === 'ogg' ? 'audio/ogg' : e === 'wav' ? 'audio/wav' : 'audio/webm';
};
const fmtRec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
interface Snapshot {
    fetched_at: string; gitlab_url: string;
    version: { version: string } | null; stats: Stats | null;
    events: GLEvent[]; projects: Project[]; open_mrs: MR[]; merged_mrs: MR[];
    pipelines: Pipeline[]; code_daily: CodeDay[];
    jira_issues: JiraIssue[]; jira_url: string; confluence_pages: ConfluencePage[];
    entities: Entity[];
    error: string; warning: string; needs_config: boolean;
}

interface Progress { phase: string; done: number; total: number }

type Period = 7 | 30 | 90;
const PERIODS: Period[] = [7, 30, 90];

type Tab = 'home' | 'feed' | 'stats' | 'ci' | 'jira' | 'weekly' | 'poc' | 'records' | 'search' | 'settings';
// 사이드바 IA — 그룹별 메뉴. 향후 기록/거래처/설정 등 확장 지점.
const NAV_GROUPS: { label: string; items: { tab: Tab; label: string; icon: string }[] }[] = [
    {label: '개발', items: [
        {tab: 'feed', label: '활동 피드', icon: 'other'},
        {tab: 'stats', label: '통계', icon: 'chart'},
        {tab: 'ci', label: '파이프라인', icon: 'merge'},
    ]},
    {label: '업무', items: [
        {tab: 'jira', label: 'Jira', icon: 'jira'},
        {tab: 'weekly', label: '주간 리포트', icon: 'calendar'},
    ]},
    {label: '기록', items: [
        {tab: 'records', label: '회의·통화', icon: 'note'},
    ]},
    // 거래처/프로젝트 그룹은 엔티티 레지스트리(snap.entities)로 동적 생성됨.
];
const periodCutoff = (p: Period) => Date.now() - p * 86_400_000;
// 천 단위 쉼표 (예: 1323 → "1,323")
const comma = (n: number) => n.toLocaleString('en-US');

// ---- Helpers ----
function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return '방금 전';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
}

function dayKey(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastNDays(n: number): string[] {
    const out: string[] = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        out.push(dayKey(d.toISOString()));
    }
    return out;
}

type Kind = 'push' | 'merge' | 'mr' | 'comment' | 'other';

function eventKind(e: GLEvent): Kind {
    const a = e.action_name;
    if (a.startsWith('pushed')) return 'push';
    if (e.push_data) return 'push'; // 브랜치/태그 생성·삭제 등도 push_data 보유
    if (a === 'accepted') return 'merge';
    if (e.target_type === 'MergeRequest') return 'mr';
    if (a.startsWith('commented')) return 'comment';
    return 'other';
}

// Lucide 아이콘(ISC 라이선스, 출처표기 불필요)을 인라인 SVG로 — 외부 의존성 없음
const ICON_PATHS: Record<string, JSX.Element> = {
    push: <><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></>,                                  // arrow-up
    merge: <><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></>, // git-merge
    mr: <><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/></>, // git-pull-request
    comment: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>,                                        // message-circle
    other: <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>,                                              // activity
    repo: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>, // folder
    external: <><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></>, // external-link
    bot: <><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></>, // bot
    jira: <><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></>, // square-check (Jira 이슈)
    confluence: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></>, // file-text (Confluence 문서)
    chart: <><path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect x="7" y="10" width="3" height="7" rx="1"/><rect x="12" y="6" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="4" rx="1"/></>, // bar-chart (통계)
    calendar: <><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/></>, // calendar (주간 리포트)
    box: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></>, // box (프로젝트)
    gear: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></>, // settings (설정)
    note: <><path d="M2 6h3"/><path d="M2 10h3"/><path d="M2 14h3"/><path d="M2 18h3"/><rect width="16" height="20" x="5" y="2" rx="2"/><path d="M9.5 8h5"/><path d="M9.5 12h5"/><path d="M9.5 16H14"/></>, // notebook (기록)
    search: <><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></>, // 검색
    home: <><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></>, // layout-dashboard (대시보드)
};

function Icon({name, size = 16, className}: { name: string; size?: number; className?: string }) {
    return (
        <svg className={`icon${className ? ' ' + className : ''}`} width={size} height={size}
             viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {ICON_PATHS[name]}
        </svg>
    );
}

const KIND_META: Record<Kind, { label: string; color: string }> = {
    push:    {label: 'Push',  color: 'var(--green)'},
    merge:   {label: 'Merge', color: 'var(--purple)'},
    mr:      {label: 'MR',    color: 'var(--accent)'},
    comment: {label: '댓글',   color: 'var(--orange)'},
    other:   {label: '기타',   color: 'var(--muted)'},
};
const KINDS = Object.keys(KIND_META) as Kind[];

function describeEvent(e: GLEvent): string {
    const k = eventKind(e);
    if (k === 'push' && e.push_data) {
        const pd = e.push_data;
        const what = pd.ref_type === 'tag' ? '태그' : '브랜치';
        if (pd.action === 'created') return `${what} 생성: ${pd.ref}`;
        if (pd.action === 'removed') return `${what} 삭제: ${pd.ref}`;
        return `${pd.ref} 에 ${pd.commit_count}개 커밋 push${pd.commit_title ? ` — ${pd.commit_title}` : ''}`;
    }
    if (e.action_name === 'deleted') return `${e.target_type || '항목'} 삭제${e.target_title ? `: ${e.target_title}` : ''}`;
    if (k === 'merge') return `MR !${e.target_iid} 머지: ${e.target_title}`;
    if (k === 'mr') return `MR !${e.target_iid} ${e.action_name === 'opened' ? '생성' : e.action_name}: ${e.target_title}`;
    if (k === 'comment') return `댓글: ${e.target_title || ''}`;
    return `${e.action_name} ${e.target_type || ''} ${e.target_title || ''}`.trim();
}

// ---- 활동 지수 가중치 (통계 탭 ⚙에서 조정, localStorage에 저장) ----
interface Weights {
    commit: number;    // 커밋 1개당
    commitCap: number; // push 1건당 커밋 인정 상한
    mrOpen: number;    // MR 생성
    mrOther: number;   // MR 기타 액션 (업데이트/클로즈 등)
    merge: number;     // 머지
    comment: number;   // 댓글
    other: number;     // 기타 이벤트
}
const DEFAULT_WEIGHTS: Weights = {commit: 1, commitCap: 20, mrOpen: 4, mrOther: 2, merge: 6, comment: 1, other: 0.5};
const WEIGHTS_KEY = 'activity-weights';

function loadWeights(): Weights {
    try {
        return {...DEFAULT_WEIGHTS, ...JSON.parse(localStorage.getItem(WEIGHTS_KEY) || '{}')};
    } catch {
        return {...DEFAULT_WEIGHTS};
    }
}

function eventScore(e: GLEvent, w: Weights): number {
    const k = eventKind(e);
    if (k === 'push') return Math.max(1, Math.min(e.push_data?.commit_count ?? 1, w.commitCap)) * w.commit;
    if (k === 'mr') return e.action_name === 'opened' ? w.mrOpen : w.mrOther;
    if (k === 'merge') return w.merge;
    if (k === 'comment') return w.comment;
    return w.other;
}

function authorLabel(a: Author | undefined): string {
    if (!a) return '?';
    return a.name || a.username;
}

// 이름 앞에 봇 아이콘(봇 계정일 때)을 붙여 렌더
function AuthorName({a}: { a: Author | undefined }) {
    return <>{a?.is_bot && <Icon name="bot" size={13} className="bot-ico"/>}{authorLabel(a)}</>;
}

// ---- Per-user aggregation ----
interface UserStat {
    username: string; name: string; isBot: boolean;
    score: number; commits: number; pushes: number; mrs: number; merges: number; comments: number;
    byDay: Map<string, number>; // day → score
}

function aggregateUsers(events: GLEvent[], w: Weights): UserStat[] {
    const map = new Map<string, UserStat>();
    for (const e of events) {
        const u = e.author?.username || '?';
        let s = map.get(u);
        if (!s) {
            s = {username: u, name: authorLabel(e.author), isBot: !!e.author?.is_bot, score: 0, commits: 0, pushes: 0, mrs: 0, merges: 0, comments: 0, byDay: new Map()};
            map.set(u, s);
        }
        const k = eventKind(e);
        const sc = eventScore(e, w);
        s.score += sc;
        s.byDay.set(dayKey(e.created_at), (s.byDay.get(dayKey(e.created_at)) ?? 0) + sc);
        if (k === 'push') { s.pushes++; s.commits += e.push_data?.commit_count ?? 0; }
        else if (k === 'mr' && e.action_name === 'opened') s.mrs++;
        else if (k === 'merge') s.merges++;
        else if (k === 'comment') s.comments++;
    }
    return [...map.values()].sort((a, b) => b.score - a.score);
}

// ---- Small components ----
function StatChip({label, value}: { label: string; value: string }) {
    const v = value.replace(/\d{4,}/g, m => Number(m).toLocaleString('en-US')); // 천 단위 쉼표
    return <div className="chip"><span className="chip-value">{v}</span><span className="chip-label">{label}</span></div>;
}

// 초 단위 갱신 표시 — 이 컴포넌트만 1초마다 리렌더
function LastUpdated({ts}: { ts: string }) {
    const [, setT] = useState(0);
    useEffect(() => {
        const i = setInterval(() => setT(n => n + 1), 1000);
        return () => clearInterval(i);
    }, []);
    const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
    const txt = s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 ${s % 60}초 전` : timeAgo(ts);
    return <span className="fetched" title="30초 주기로 자동 갱신됩니다">{txt} 갱신</span>;
}

function SetupView({onSaved}: { onSaved: () => void }) {
    const [url, setUrl] = useState('https://ci.quantumcns.ai');
    const [token, setToken] = useState('');
    const [err, setErr] = useState('');
    const save = async () => {
        const e = await SaveConfig(url, token);
        if (e) setErr(e); else onSaved();
    };
    return (
        <div className="setup">
            <h2>GitLab 연결 설정</h2>
            <p>admin 계정의 Personal Access Token(<code>read_api</code>)이 필요합니다.</p>
            <label>GitLab URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)}/>
            <label>Access Token</label>
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="glpat-..."/>
            {err && <div className="error-banner">{err}</div>}
            <button className="btn" onClick={save} disabled={!token}>저장 후 연결</button>
        </div>
    );
}

// ---- Jira kanban board ----
const CAT_ORDER: Record<string, number> = {new: 0, indeterminate: 1, done: 2};

interface JiraTransition { id: string; name: string; to_status: string; to_category: string }

// ---- 이슈 상세 팝업 ----
function IssueModal({issueKey, issues, onClose, onSelect}: {
    issueKey: string; issues: JiraIssue[]; onClose: () => void; onSelect: (k: string) => void;
}) {
    const issue = issues.find(i => i.key === issueKey);
    const [detail, setDetail] = useState<{description: string; transitions: JiraTransition[]; comments: {author: string; created: string; updated: string; body_html: string}[]; error: string} | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    useEffect(() => {
        setDetail(null);
        setErr('');
        JiraDetail(issueKey).then((d: any) => setDetail(d)).catch(() => {});
    }, [issueKey, issue?.status]);

    if (!issue) return null;
    const kids = issues.filter(i => i.parent_key === issue.key)
        .sort((a, b) => (CAT_ORDER[a.status_category] ?? 9) - (CAT_ORDER[b.status_category] ?? 9) || a.key.localeCompare(b.key));
    const today = new Date().toISOString().slice(0, 10);
    const late = issue.status_category !== 'done' && issue.due_date && issue.due_date < today;

    const move = async (to: string) => {
        if (to === issue.status || busy) return;
        setBusy(true);
        setErr('');
        const r = await JiraMove(issue.key, to);
        setBusy(false);
        if (r) setErr(r);
    };

    // 전환 목록에서 중복 to_status 제거
    const targets = (detail?.transitions ?? []).filter((t, idx, arr) =>
        arr.findIndex(x => x.to_status === t.to_status) === idx);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <span className={`jira-status jira-${issue.status_category}`}>{issue.status}</span>
                    <span className="jira-key">{issue.key}</span>
                    <span className="hint">{issue.type} · {issue.project_name}</span>
                    <button className="modal-x" onClick={onClose}>✕</button>
                </div>
                <h2 className="modal-title">{issue.summary}</h2>

                {issue.parent_key && (
                    <div className="modal-parent drill" onClick={() => onSelect(issue.parent_key)}>
                        ↳ 상위: <b>{issue.parent_key}</b> {issue.parent_summary}
                    </div>
                )}

                <div className="modal-meta">
                    <div><span>담당자</span>{issue.assignee || '미지정'}</div>
                    <div><span>우선순위</span>{issue.priority || '—'}</div>
                    <div><span>마감일</span><i className={late ? 'jira-due' : ''}>{issue.due_date || '—'}</i></div>
                    <div><span>생성</span>{timeAgo(issue.created)}</div>
                    <div><span>업데이트</span>{timeAgo(issue.updated)}</div>
                </div>

                <div className="modal-section">
                    <h4>상태 변경</h4>
                    <div className="modal-trans">
                        {detail === null && <span className="hint">불러오는 중…</span>}
                        {targets.map(t => (
                            <button key={t.id}
                                    className={`pill pill-on pill-${t.to_category === 'done' ? 'push' : t.to_category === 'indeterminate' ? 'comment' : 'mr'} ${t.to_status === issue.status ? 'pill-cur' : ''}`}
                                    disabled={busy || t.to_status === issue.status}
                                    onClick={() => move(t.to_status)}>
                                {t.to_status === issue.status ? '● ' : ''}{t.to_status}
                            </button>
                        ))}
                        {busy && <span className="hint">변경 중…</span>}
                    </div>
                    {err && <div className="error-banner">⚠ {err}</div>}
                </div>

                {detail?.description && (
                    <div className="modal-section">
                        <h4>설명</h4>
                        <div className="modal-desc adf"
                             onClick={e => {
                                 // 링크는 webview 이탈 대신 외부 브라우저로
                                 const a = (e.target as HTMLElement).closest('a');
                                 if (a) { e.preventDefault(); a.href && OpenURL(a.href); }
                             }}
                             dangerouslySetInnerHTML={{__html: detail.description}}/>
                    </div>
                )}

                {kids.length > 0 && (
                    <div className="modal-section">
                        <h4>하위 이슈 <span className="count">{kids.filter(k => k.status_category === 'done').length}/{kids.length} 완료</span></h4>
                        {kids.map(k => (
                            <div key={k.key} className="jchild" onClick={() => onSelect(k.key)}>
                                <span className={`jira-status jira-${k.status_category}`}>{k.status}</span>
                                <span className="jghost-key">{k.key}</span>
                                <span className="jghost-sum">{k.summary}</span>
                            </div>
                        ))}
                    </div>
                )}

                {detail && detail.comments && detail.comments.length > 0 && (
                    <div className="modal-section">
                        <h4>댓글 <span className="count">{detail.comments.length}</span></h4>
                        <div className="modal-comments">
                            {detail.comments.map((c, idx) => (
                                <div key={idx} className="jcomment">
                                    <div className="jcomment-head">
                                        <b>{c.author}</b>
                                        <span className="time">{timeAgo(c.created)}</span>
                                    </div>
                                    <div className="adf jcomment-body"
                                         onClick={e => {
                                             const a = (e.target as HTMLElement).closest('a');
                                             if (a) { e.preventDefault(); a.href && OpenURL(a.href); }
                                         }}
                                         dangerouslySetInnerHTML={{__html: c.body_html}}/>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="modal-foot">
                    <button className="btn btn-sm" onClick={() => OpenURL(issue.url)}>Jira에서 열기 ↗</button>
                </div>
            </div>
        </div>
    );
}

function JiraBoard({issues, projectKey, onBack, onSelect}: {
    issues: JiraIssue[]; projectKey: string; onBack: () => void; onSelect: (k: string) => void;
}) {
    const [moving, setMoving] = useState<string | null>(null);
    const [err, setErr] = useState('');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const projIssues = useMemo(() => issues.filter(i => i.project_key === projectKey), [issues, projectKey]);
    const projectName = projIssues[0]?.project_name || projectKey;

    const keysInProject = useMemo(() => new Set(projIssues.map(i => i.key)), [projIssues]);
    // 카드 = 최상위 이슈 + 부모가 캐시에 없는 하위 이슈 (고아)
    const tops = useMemo(() =>
        projIssues.filter(i => !i.parent_key || !keysInProject.has(i.parent_key)),
    [projIssues, keysInProject]);
    const childrenByParent = useMemo(() => {
        const m = new Map<string, JiraIssue[]>();
        for (const i of projIssues) {
            if (!i.parent_key || !keysInProject.has(i.parent_key)) continue;
            const arr = m.get(i.parent_key) ?? [];
            arr.push(i);
            m.set(i.parent_key, arr);
        }
        // 자식은 상태 카테고리 → 키 순으로 정렬
        for (const arr of m.values()) {
            arr.sort((a, b) => (CAT_ORDER[a.status_category] ?? 9) - (CAT_ORDER[b.status_category] ?? 9) || a.key.localeCompare(b.key));
        }
        return m;
    }, [projIssues, keysInProject]);

    // 컬럼 = 카드(최상위) 이슈들이 가진 상태
    const columns = useMemo(() => {
        const seen = new Map<string, string>();
        for (const i of tops) seen.set(i.status, i.status_category);
        return [...seen.entries()].sort((a, b) =>
            (CAT_ORDER[a[1]] ?? 9) - (CAT_ORDER[b[1]] ?? 9) || a[0].localeCompare(b[0]));
    }, [tops]);

    const parentKeys = useMemo(() => [...childrenByParent.keys()], [childrenByParent]);
    const allCollapsed = parentKeys.length > 0 && parentKeys.every(k => collapsed.has(k));

    const toggle = (key: string) => setCollapsed(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });

    const drop = async (e: React.DragEvent, status: string) => {
        e.preventDefault();
        const key = e.dataTransfer.getData('text/plain');
        if (!key) return;
        const issue = projIssues.find(i => i.key === key);
        if (!issue || issue.status === status) return;
        setMoving(key);
        setErr('');
        const res = await JiraMove(key, status);
        setMoving(null);
        if (res) {
            setErr(res);
            setTimeout(() => setErr(''), 6000);
        }
    };

    const today = new Date().toISOString().slice(0, 10);
    return (
        <div className="stats scroll">
            <div className="board-head">
                <button className="btn btn-sm" onClick={onBack}>← 전체 현황</button>
                <h2>{projectKey} <span className="hint">{projectName} · 드래그: 상태 변경 · 클릭: 상세</span></h2>
                {parentKeys.length > 0 && (
                    <button className="btn btn-sm" onClick={() =>
                        setCollapsed(allCollapsed ? new Set() : new Set(parentKeys))}>
                        {allCollapsed ? '▾ 전체 펼치기' : '▸ 전체 접기'}
                    </button>
                )}
            </div>
            {err && <div className="error-banner">⚠ {err}</div>}
            <div className="board">
                {columns.map(([status, cat]) => {
                    const cards = tops.filter(i => i.status === status)
                        .sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
                    const shown = cat === 'done' ? cards.slice(0, 15) : cards;
                    return (
                        <div key={status} className={`col col-${cat}`}
                             onDragOver={e => e.preventDefault()}
                             onDrop={e => drop(e, status)}>
                            <div className="col-head">
                                <span className={`jira-status jira-${cat}`}>{status}</span>
                                <span className="count">{cards.length}</span>
                            </div>
                            <div className="col-cards">
                                {shown.map(i => {
                                    const late = i.status_category !== 'done' && i.due_date && i.due_date < today;
                                    const kids = childrenByParent.get(i.key) ?? [];
                                    const kidsDone = kids.filter(k => k.status_category === 'done').length;
                                    const isCollapsed = collapsed.has(i.key);
                                    return (
                                        <div key={i.key}
                                             className={`jcard ${moving === i.key ? 'jcard-moving' : ''}`}
                                             draggable
                                             onDragStart={e => e.dataTransfer.setData('text/plain', i.key)}
                                             onClick={() => onSelect(i.key)}
                                             title="클릭: 상세 보기 / 드래그: 상태 변경">
                                            <div className="jcard-top">
                                                {kids.length > 0 && (
                                                    <button className="jfold"
                                                            onClick={e => { e.stopPropagation(); toggle(i.key); }}
                                                            title={isCollapsed ? '하위 이슈 펼치기' : '하위 이슈 접기'}>
                                                        {isCollapsed ? '▸' : '▾'}
                                                    </button>
                                                )}
                                                <span className="jira-key">{i.key}</span>
                                                {kids.length > 0 &&
                                                    <span className="jkids" title={`하위 이슈 ${kids.length}개 중 ${kidsDone}개 완료`}>하위 {kidsDone}/{kids.length}</span>}
                                                {i.parent_key &&
                                                    <span className="jparent" title={i.parent_summary}>↳ {i.parent_key}</span>}
                                                {i.priority && <span className={`jprio jprio-${i.priority.toLowerCase()}`}>{i.priority}</span>}
                                            </div>
                                            <div className="jcard-summary">{i.summary}</div>
                                            <div className="jcard-meta">
                                                <span>{i.assignee || '미지정'}</span>
                                                {i.due_date && <span className={late ? 'jira-due' : ''}>~{i.due_date}</span>}
                                            </div>
                                            {!isCollapsed && kids.length > 0 && (
                                                <div className="jghosts">
                                                    {kids.map(k => (
                                                        <div key={k.key} className="jchild"
                                                             onClick={e => { e.stopPropagation(); onSelect(k.key); }}
                                                             title={`${k.summary} — 클릭: 상세 보기`}>
                                                            <span className={`jira-status jira-${k.status_category}`}>{k.status}</span>
                                                            <span className="jghost-key">{k.key}</span>
                                                            <span className="jghost-sum">{k.summary}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {cat === 'done' && cards.length > 15 &&
                                    <div className="empty" style={{padding: '8px'}}>+{cards.length - 15}건 더 (최근 15건만 표시)</div>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---- Jira view ----
function JiraView({snap, period}: { snap: Snapshot; period: Period }) {
    const [board, setBoard] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const issues = snap.jira_issues;
    const modal = selected &&
        <IssueModal issueKey={selected} issues={issues} onClose={() => setSelected(null)} onSelect={setSelected}/>;
    const today = new Date().toISOString().slice(0, 10);
    const cut = periodCutoff(period);

    const open = issues.filter(i => i.status_category !== 'done');
    const inProgress = open.filter(i => i.status_category === 'indeterminate');
    const createdInPeriod = issues.filter(i => new Date(i.created).getTime() >= cut);
    const doneInPeriod = issues.filter(i => i.status_category === 'done' && new Date(i.updated).getTime() >= cut);
    const overdue = open.filter(i => i.due_date && i.due_date < today)
        .sort((a, b) => a.due_date.localeCompare(b.due_date));

    const byAssignee = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of open) {
            const a = i.assignee || '미지정';
            m.set(a, (m.get(a) ?? 0) + 1);
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    }, [issues]);
    const assigneeMax = Math.max(1, ...byAssignee.map(([, n]) => n));

    const byProject = useMemo(() => {
        const m = new Map<string, { name: string; n: number }>();
        for (const i of open) {
            let r = m.get(i.project_key);
            if (!r) { r = {name: i.project_name, n: 0}; m.set(i.project_key, r); }
            r.n++;
        }
        return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    }, [issues]);
    const projectMax = Math.max(1, ...byProject.map(([, r]) => r.n));

    const recent = issues.slice(0, 25);

    if (issues.length === 0) {
        return (
            <div className="stats scroll">
                <section className="stat-block">
                    <div className="empty">
                        Jira 데이터가 없습니다. env.local 또는 환경변수에 JIRA_URL / JIRA_EMAIL / JIRA_TOKEN을
                        설정하면 5분 주기로 동기화됩니다.
                    </div>
                </section>
            </div>
        );
    }

    if (board) return <>
        <JiraBoard issues={issues} projectKey={board} onBack={() => setBoard(null)} onSelect={setSelected}/>
        {modal}
    </>;

    const allProjects = [...new Map(issues.map(i => [i.project_key, i.project_name])).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]));

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>Jira 현황</h2>
                <select className="jselect" value="" onChange={e => e.target.value && setBoard(e.target.value)}>
                    <option value="">칸반보드 열기…</option>
                    {allProjects.map(([k, n]) => <option key={k} value={k}>{k} — {n}</option>)}
                </select>
            </div>
            <div className="cards">
                <div className="card"><div className="card-v">{comma(open.length)}</div><div className="card-l">열린 이슈</div></div>
                <div className="card"><div className="card-v">{comma(inProgress.length)}</div><div className="card-l">진행 중</div></div>
                <div className="card"><div className="card-v">{comma(createdInPeriod.length)}</div><div className="card-l">생성 ({period}일)</div></div>
                <div className="card"><div className="card-v">{comma(doneInPeriod.length)}</div><div className="card-l">완료 ({period}일)</div></div>
                <div className="card">
                    <div className="card-v" style={{WebkitTextFillColor: overdue.length > 0 ? 'var(--red)' : undefined}}>{comma(overdue.length)}</div>
                    <div className="card-l">기한 초과</div>
                </div>
            </div>

            {overdue.length > 0 && (
                <section className="stat-block">
                    <h3>기한 초과 <span className="count">{overdue.length}</span></h3>
                    {overdue.map(i => (
                        <div key={i.key} className="pipe" onClick={() => setSelected(i.key)}>
                            <span className="jira-key">{i.key}</span>
                            <span className="pipe-proj">{i.summary}</span>
                            <span className="jira-assignee">{i.assignee || '미지정'}</span>
                            <span className="jira-due">~{i.due_date}</span>
                        </div>
                    ))}
                </section>
            )}

            <div className="stat-cols">
                <section className="stat-block">
                    <h3>담당자별 열린 이슈</h3>
                    {byAssignee.map(([name, n]) => (
                        <div key={name} className="lb-row">
                            <span className="lb-name">{name}</span>
                            <div className="lb-bar-wrap">
                                <div className="lb-bar" style={{width: `${(n / assigneeMax) * 100}%`}}/>
                            </div>
                            <span className="lb-score">{n}</span>
                        </div>
                    ))}
                </section>
                <section className="stat-block">
                    <h3>프로젝트별 열린 이슈</h3>
                    {byProject.map(([key, r]) => (
                        <div key={key} className="lb-row">
                            <span className="lb-name drill" title={`${r.name} — 클릭하면 칸반보드`} onClick={() => setBoard(key)}>{key}</span>
                            <div className="lb-bar-wrap">
                                <div className="lb-bar lb-bar-repo" style={{width: `${(r.n / projectMax) * 100}%`}}/>
                            </div>
                            <span className="lb-score">{r.n}</span>
                            <span className="lb-detail">{r.name}</span>
                        </div>
                    ))}
                </section>
            </div>

            <section className="stat-block">
                <h3>최근 업데이트 <span className="count">{recent.length}</span></h3>
                {recent.map(i => (
                    <div key={i.key} className="pipe" onClick={() => setSelected(i.key)}>
                        <span className={`jira-status jira-${i.status_category}`}>{i.status}</span>
                        <span className="jira-key">{i.key}</span>
                        <span className="pipe-proj">{i.summary}</span>
                        <span className="jira-assignee">{i.assignee || '미지정'}</span>
                        <span className="time">{timeAgo(i.updated)}</span>
                    </div>
                ))}
            </section>
            {modal}
        </div>
    );
}

// ---- PoC(제품 타임라인) view ----
// 제품 = GitLab 그룹 + Jira 프로젝트 묶음. PoC 진행 현황을 한 화면에 통합.
// Entity는 백엔드 레지스트리(entities.json) 미러 — snapshot.entities로 전달됨.
interface Entity {
    id: string; name: string; kind: string;
    gitlab_groups: string[]; jira_keys: string[]; confluence_query: string;
    aliases: string[]; accent: string; active: boolean;
}
interface Member {
    id: string; name: string; team_id: string; role: string; email: string;
    gitlab_username: string; git_aliases: string[]; active: boolean;
}
interface Team { id: string; name: string; accent: string; active: boolean; }
const teamNameOf = (teams: Team[], id: string) => teams.find(t => t.id === id)?.name || '';
const entAccent = (e: Entity) => e.accent || 'var(--accent)';
const glInEntity = (e: Entity, path: string) => {
    const x = (path || '').toLowerCase();
    return (e.gitlab_groups || []).some(g => {
        const gl = g.toLowerCase();
        return x === gl || x.startsWith(gl + '/');
    });
};

interface ProductProgress { total: number; done: number; inprog: number; todo: number; epicTotal: number; epicDone: number }
const isEpicType = (t: string) => t === '에픽' || t.toLowerCase() === 'epic';
function jiraProgress(issues: JiraIssue[], e: Entity): ProductProgress {
    let total = 0, done = 0, inprog = 0, todo = 0, epicTotal = 0, epicDone = 0;
    for (const i of issues) {
        if (!(e.jira_keys || []).includes(i.project_key)) continue;
        total++;
        const isDone = i.status_category === 'done';
        if (isEpicType(i.type || '')) { epicTotal++; if (isDone) epicDone++; }
        if (isDone) done++;
        else if (i.status_category === 'indeterminate') inprog++;
        else todo++;
    }
    return {total, done, inprog, todo, epicTotal, epicDone};
}

// 엔티티의 열린 이슈를 진행 중 / 남은 일(대기)로 분리, 최근 업데이트 순 정렬.
function entityOpenIssues(issues: JiraIssue[], e: Entity): { inprog: JiraIssue[]; todo: JiraIssue[] } {
    const inprog: JiraIssue[] = [], todo: JiraIssue[] = [];
    for (const i of issues) {
        if (!(e.jira_keys || []).includes(i.project_key)) continue;
        if (i.status_category === 'indeterminate') inprog.push(i);
        else if (i.status_category === 'new') todo.push(i);
    }
    const recent = (a: JiraIssue, b: JiraIssue) => new Date(b.updated).getTime() - new Date(a.updated).getTime();
    return {inprog: inprog.sort(recent), todo: todo.sort(recent)};
}

// 준비도 % → 한눈에 읽히는 단계 라벨.
function readinessLabel(pct: number): string {
    if (pct >= 90) return '마무리 단계';
    if (pct >= 60) return '막바지';
    if (pct >= 30) return '진행 중';
    if (pct > 0) return '초기 단계';
    return '시작 전';
}

type TLSource = 'gitlab' | 'jira' | 'confluence' | 'note';
interface TLItem {
    id: string; ts: number; iso: string; product: Entity; source: TLSource;
    event?: GLEvent; issue?: JiraIssue; jiraAction?: string; page?: ConfluencePage; note?: Note;
}
const noteTime = (n: Note) => new Date((n.occurred_at && n.occurred_at.length >= 10 ? n.occurred_at.slice(0, 10) : n.updated_at) || n.updated_at).getTime();

// 엔티티 허브 — 사이드바에서 고른 거래처/프로젝트(focus) 또는 전체의 준비도·타임라인.
function HubView({snap, period, focus}: { snap: Snapshot; period: Period; focus: 'all' | string }) {
    const [sources, setSources] = useState<Set<TLSource>>(new Set(['gitlab', 'jira', 'confluence', 'note']));
    const [showBots, setShowBots] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [notes, setNotes] = useState<Note[]>([]);
    useEffect(() => { ListNotes('').then((ns: any) => setNotes(ns || [])); }, []);

    const entities = snap.entities.filter(e => e.active);
    const activeProducts = focus === 'all' ? entities : entities.filter(e => e.id === focus);
    const toggleSource = (s: TLSource) => setSources(prev => {
        const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n;
    });

    const items = useMemo(() => {
        const cut = periodCutoff(period);
        const out: TLItem[] = [];
        const seenCf = new Set<string>(); // 두 제품에 걸친 문서 중복 방지
        const seenNote = new Set<number>(); // 여러 엔티티에 걸친 노트 중복 방지
        for (const p of activeProducts) {
            if (sources.has('gitlab')) {
                for (const e of snap.events) {
                    if (!showBots && e.author?.is_bot) continue;
                    if (!glInEntity(p, e.project_path)) continue;
                    const t = new Date(e.created_at).getTime();
                    if (t < cut) continue;
                    out.push({id: `gl-${e.id}`, ts: t, iso: e.created_at, product: p, source: 'gitlab', event: e});
                }
            }
            if (sources.has('jira')) {
                for (const i of snap.jira_issues) {
                    if (!(p.jira_keys || []).includes(i.project_key)) continue;
                    const ct = new Date(i.created).getTime(), ut = new Date(i.updated).getTime();
                    if (ct >= cut) out.push({id: `jc-${i.key}`, ts: ct, iso: i.created, product: p, source: 'jira', issue: i, jiraAction: '생성'});
                    if (ut >= cut && ut - ct > 60_000) {
                        const act = i.status_category === 'done' ? '완료' : '상태 변경';
                        out.push({id: `ju-${i.key}`, ts: ut, iso: i.updated, product: p, source: 'jira', issue: i, jiraAction: act});
                    }
                }
            }
            if (sources.has('confluence')) {
                for (const pg of snap.confluence_pages) {
                    if (!pg.products?.includes(p.id) || seenCf.has(pg.id)) continue;
                    const t = new Date(pg.updated).getTime();
                    if (t < cut) continue;
                    seenCf.add(pg.id);
                    out.push({id: `cf-${pg.id}`, ts: t, iso: pg.updated, product: p, source: 'confluence', page: pg});
                }
            }
            if (sources.has('note')) {
                for (const nt of notes) {
                    if (!(nt.entity_ids || []).includes(p.id) || seenNote.has(nt.id)) continue;
                    const t = noteTime(nt);
                    if (isNaN(t) || t < cut) continue;
                    seenNote.add(nt.id);
                    out.push({id: `nt-${nt.id}`, ts: t, iso: (nt.occurred_at || nt.updated_at), product: p, source: 'note', note: nt});
                }
            }
        }
        out.sort((a, b) => b.ts - a.ts);
        return out.slice(0, 300);
    }, [snap, period, focus, sources, showBots, notes]);

    const byDay = useMemo(() => {
        const groups: { day: string; items: TLItem[] }[] = [];
        let cur: { day: string; items: TLItem[] } | null = null;
        for (const it of items) {
            const d = dayKey(it.iso);
            if (!cur || cur.day !== d) { cur = {day: d, items: []}; groups.push(cur); }
            cur.items.push(it);
        }
        return groups;
    }, [items]);

    // 제품별 최근 문서 — 렌더마다 재계산하지 않도록 메모이즈 (period 내, 최신순)
    const docsByProduct = useMemo(() => {
        const cut = periodCutoff(period);
        const m = new Map<string, ConfluencePage[]>();
        for (const p of snap.entities) {
            m.set(p.id, snap.confluence_pages
                .filter(pg => (pg.products || []).includes(p.id) && new Date(pg.updated).getTime() >= cut)
                .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()));
        }
        return m;
    }, [snap.confluence_pages, snap.entities, period]);

    const modal = selected &&
        <IssueModal issueKey={selected} issues={snap.jira_issues} onClose={() => setSelected(null)} onSelect={setSelected}/>;
    const showPTag = activeProducts.length > 1;

    const issueRow = (i: JiraIssue) => (
        <div key={i.key} className="poc-irow" onClick={() => setSelected(i.key)}>
            <span className="jira-key">{i.key}</span>
            <span className="poc-isum">{i.summary}</span>
            <span className="poc-iass">{i.assignee || '미지정'}</span>
        </div>
    );
    const LIST_CAP = 8;
    const issueList = (label: string, kind: string, list: JiraIssue[]) => (
        <div className="poc-list">
            <h4 className={`poc-list-h poc-list-${kind}`}>{label} <span className="count">{list.length}</span></h4>
            {list.length === 0 && <div className="poc-list-empty">없음</div>}
            {list.slice(0, LIST_CAP).map(issueRow)}
            {list.length > LIST_CAP && <div className="poc-more">+{list.length - LIST_CAP}개 더</div>}
        </div>
    );
    const docList = (docs: ConfluencePage[]) => (
        <div className="poc-list">
            <h4 className="poc-list-h poc-list-doc">최근 문서 <span className="count">{docs.length}</span></h4>
            {docs.length === 0 && <div className="poc-list-empty">없음</div>}
            {docs.slice(0, LIST_CAP).map(pg => (
                <div key={pg.id} className="poc-irow" onClick={() => OpenURL(pg.url)}>
                    <span className="poc-cfspace">{pg.space_key}</span>
                    <span className="poc-isum">{pg.title}</span>
                    <span className="poc-iass">{timeAgo(pg.updated)}</span>
                </div>
            ))}
            {docs.length > LIST_CAP && <div className="poc-more">+{docs.length - LIST_CAP}개 더</div>}
        </div>
    );
    const notesFor = (id: string) => notes.filter(nt => (nt.entity_ids || []).includes(id)).sort((a, b) => noteTime(b) - noteTime(a));
    const noteList = (ns: Note[]) => (
        <div className="poc-list">
            <h4 className="poc-list-h poc-list-note">최근 기록 <span className="count">{ns.length}</span></h4>
            {ns.length === 0 && <div className="poc-list-empty">없음</div>}
            {ns.slice(0, LIST_CAP).map(nt => (
                <div key={nt.id} className="poc-irow" onClick={() => nt.confluence_url && OpenURL(nt.confluence_url)}>
                    <span className={`note-kind note-${nt.kind}`}>{nt.kind === 'call' ? '통화' : '회의'}</span>
                    <span className="poc-isum">{nt.title || '(제목 없음)'}</span>
                    <span className="poc-iass">{(nt.occurred_at || '').slice(0, 10)}</span>
                </div>
            ))}
            {ns.length > LIST_CAP && <div className="poc-more">+{ns.length - LIST_CAP}개 더</div>}
        </div>
    );

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>{focus === 'all' ? '전체 현황' : (activeProducts[0]?.name ?? '현황')}</h2>
                <span className="poc-sub">
                    {focus === 'all' ? '등록된 거래처·프로젝트 통합' : (activeProducts[0]?.kind === 'company' ? '거래처' : '프로젝트')} · GitLab·Jira·Confluence
                </span>
            </div>

            {activeProducts.length === 0 && (
                <section className="stat-block"><div className="empty">등록된 엔티티가 없습니다 — 설정에서 거래처/프로젝트를 추가하세요</div></section>
            )}

            {activeProducts.map(p => {
                const pr = jiraProgress(snap.jira_issues, p);
                const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
                const {inprog, todo} = entityOpenIssues(snap.jira_issues, p);
                const w = (n: number) => pr.total ? `${(n / pr.total) * 100}%` : '0%';
                const docs = docsByProduct.get(p.id) ?? [];
                const accent = entAccent(p);
                return (
                    <section key={p.id} className="stat-block poc-dash" style={{borderLeft: `3px solid ${accent}`}}>
                        <div className="poc-dash-head">
                            <span className="poc-dot" style={{background: accent}}/>
                            <h3 style={{color: accent}}>{p.name}</h3>
                            <span className="poc-badge" style={{borderColor: accent, color: accent}}>{p.kind === 'company' ? '거래처' : '프로젝트'}</span>
                            <span className="poc-pct" style={{color: accent}}>{pct}%</span>
                            <span className="poc-rlabel">{readinessLabel(pct)}</span>
                        </div>
                        <div className="poc-funnel" title={`완료 ${pr.done} · 진행 ${pr.inprog} · 대기 ${pr.todo}`}>
                            <div className="poc-seg seg-done" style={{width: w(pr.done)}}/>
                            <div className="poc-seg seg-prog" style={{width: w(pr.inprog)}}/>
                            <div className="poc-seg seg-todo" style={{width: w(pr.todo)}}/>
                        </div>
                        <div className="poc-counts">
                            <span><b className="c-done">{pr.done}</b> 완료</span>
                            <span><b className="c-prog">{pr.inprog}</b> 진행</span>
                            <span><b className="c-todo">{pr.todo}</b> 대기</span>
                            <span className="poc-total">총 {pr.total}</span>
                            {pr.epicTotal > 0 && <span className="poc-epic">에픽 {pr.epicDone}/{pr.epicTotal}</span>}
                            <span className="poc-docs"><b className="c-doc">{docs.length}</b> 문서 ({period}일)</span>
                        </div>
                        <div className="poc-lists">
                            {issueList('지금 진행 중', 'prog', inprog)}
                            {issueList('남은 일', 'todo', todo)}
                            {docList(docs)}
                            {noteList(notesFor(p.id))}
                        </div>
                    </section>
                );
            })}

            <section className="stat-block poc-timeline">
                <div className="poc-tl-head">
                    <h3>최근 활동 <span className="count">{items.length}{items.length === 300 ? '+' : ''} / {period}일</span></h3>
                    <div className="poc-pills">
                        <button className={`pill pill-mr ${sources.has('gitlab') ? 'pill-on' : ''}`}
                                onClick={() => toggleSource('gitlab')}><Icon name="merge" size={12}/> GitLab</button>
                        <button className={`pill pill-comment ${sources.has('jira') ? 'pill-on' : ''}`}
                                onClick={() => toggleSource('jira')}><Icon name="jira" size={12}/> Jira</button>
                        <button className={`pill pill-cf ${sources.has('confluence') ? 'pill-on' : ''}`}
                                onClick={() => toggleSource('confluence')}><Icon name="confluence" size={12}/> Confluence</button>
                        <button className={`pill pill-note ${sources.has('note') ? 'pill-on' : ''}`}
                                onClick={() => toggleSource('note')}><Icon name="note" size={12}/> 기록</button>
                        <button className={`pill pill-bot ${showBots ? 'pill-on' : ''}`}
                                title="CI/토큰봇 활동 표시" onClick={() => setShowBots(v => !v)}><Icon name="bot" size={12}/> 봇</button>
                    </div>
                </div>
                {byDay.map(g => (
                    <div key={g.day} className="poc-day">
                        <div className="poc-day-head"><span>{g.day}</span></div>
                        {g.items.map(it => {
                            const tag = showPTag &&
                                <span className="poc-ptag" style={{borderColor: entAccent(it.product), color: entAccent(it.product)}}>{it.product.name}</span>;
                            if (it.source === 'gitlab') {
                                const e = it.event!;
                                const k = eventKind(e);
                                return (
                                    <div key={it.id} className={`event poc-row event-${k}`}>
                                        <span className={`badge badge-${k}`}><Icon name={k} size={14}/></span>
                                        <div className="event-body">
                                            <div className="event-top">
                                                {tag}
                                                <b><AuthorName a={e.author}/></b>
                                                <a className="proj" onClick={() => e.project_url && OpenURL(e.project_url)}>{e.project_path}</a>
                                                <span className="time">{timeAgo(e.created_at)}</span>
                                            </div>
                                            <div className="event-desc">{describeEvent(e)}</div>
                                        </div>
                                    </div>
                                );
                            }
                            if (it.source === 'note') {
                                const nt = it.note!;
                                return (
                                    <div key={it.id} className="event poc-row poc-ntrow" onClick={() => nt.confluence_url && OpenURL(nt.confluence_url)}>
                                        <span className="badge poc-ntbadge"><Icon name="note" size={14}/></span>
                                        <div className="event-body">
                                            <div className="event-top">
                                                {tag}
                                                <span className={`note-kind note-${nt.kind}`}>{nt.kind === 'call' ? '통화' : '회의'}</span>
                                                {nt.participants && <span className="poc-ntparts">{nt.participants}</span>}
                                                {nt.confluence_url && <Icon name="confluence" size={11} className="poc-ntshared"/>}
                                                <span className="time">{(nt.occurred_at || '').slice(0, 10)}</span>
                                            </div>
                                            <div className="event-desc">{nt.title || '(제목 없음)'}</div>
                                        </div>
                                    </div>
                                );
                            }
                            if (it.source === 'confluence') {
                                const pg = it.page!;
                                // 문서는 두 제품에 걸칠 수 있으므로 매칭된 제품을 모두 태그로 표시
                                const cfTags = showPTag && (pg.products || [])
                                    .map(pid => entities.find(x => x.id === pid))
                                    .filter((x): x is Entity => !!x)
                                    .map(prod => <span key={prod.id} className="poc-ptag" style={{borderColor: entAccent(prod), color: entAccent(prod)}}>{prod.name}</span>);
                                return (
                                    <div key={it.id} className="event poc-row poc-cfrow" onClick={() => OpenURL(pg.url)}>
                                        <span className="badge poc-cfbadge"><Icon name="confluence" size={14}/></span>
                                        <div className="event-body">
                                            <div className="event-top">
                                                {cfTags}
                                                <span className="poc-cfspace">{pg.space_name}</span>
                                                <b>{pg.author}</b>
                                                <span className="time">{timeAgo(it.iso)}</span>
                                            </div>
                                            <div className="event-desc">{pg.title}</div>
                                        </div>
                                    </div>
                                );
                            }
                            const i = it.issue!;
                            return (
                                <div key={it.id} className="event poc-row poc-jrow" onClick={() => setSelected(i.key)}>
                                    <span className="badge poc-jbadge"><Icon name="jira" size={14}/></span>
                                    <div className="event-body">
                                        <div className="event-top">
                                            {tag}
                                            <span className={`jira-status jira-${i.status_category}`}>{i.status}</span>
                                            <span className="jira-key">{i.key}</span>
                                            <span className="poc-jact">{it.jiraAction}</span>
                                            <span className="time">{timeAgo(it.iso)}</span>
                                        </div>
                                        <div className="event-desc">{i.summary}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
                {items.length === 0 && <div className="empty">표시할 항목이 없습니다 — 소스 필터 또는 기간을 확인하세요</div>}
            </section>
            {modal}
        </div>
    );
}

// ---- Pipeline view ----
const PIPE_RUNNING = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled']);

const PIPE_META: Record<string, { label: string; color: string }> = {
    success:  {label: '성공',   color: 'var(--green)'},
    failed:   {label: '실패',   color: 'var(--red)'},
    running:  {label: '실행 중', color: 'var(--accent)'},
    pending:  {label: '대기',   color: 'var(--orange)'},
    canceled: {label: '취소',   color: 'var(--muted)'},
    skipped:  {label: '건너뜀',  color: 'var(--muted)'},
};
const pipeMeta = (s: string) =>
    PIPE_META[s] ?? (PIPE_RUNNING.has(s) ? PIPE_META.running : {label: s, color: 'var(--muted)'});

function fmtDur(ms: number): string {
    const h = ms / 3600_000;
    if (h < 1) return `${Math.round(ms / 60_000)}분`;
    if (h < 48) return `${h.toFixed(1)}시간`;
    return `${(h / 24).toFixed(1)}일`;
}

function CIView({snap, period, onDrill}: { snap: Snapshot; period: Period; onDrill: (q: string) => void }) {
    const pipes = useMemo(() => {
        const cut = periodCutoff(period);
        return snap.pipelines.filter(p => new Date(p.created_at).getTime() >= cut);
    }, [snap.pipelines, period]);
    const days = useMemo(() => lastNDays(period), [snap.fetched_at, period]);
    const xEvery = period === 90 ? 10 : period === 30 ? 5 : 1;

    const finished = pipes.filter(p => p.status === 'success' || p.status === 'failed');
    const success = pipes.filter(p => p.status === 'success').length;
    const failed = pipes.filter(p => p.status === 'failed');
    const running = pipes.filter(p => PIPE_RUNNING.has(p.status));
    const rate = finished.length ? Math.round((success / finished.length) * 100) : null;
    // 소요시간은 created→updated 근사치 (대기시간 포함)
    const durs = finished.map(p => new Date(p.updated_at).getTime() - new Date(p.created_at).getTime()).filter(d => d > 0);
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;

    // 프로젝트별 성공률
    const byProj = useMemo(() => {
        const m = new Map<string, { total: number; ok: number; fail: number }>();
        for (const p of pipes) {
            const k = p.project_path || `#${p.project_id}`;
            let r = m.get(k);
            if (!r) { r = {total: 0, ok: 0, fail: 0}; m.set(k, r); }
            r.total++;
            if (p.status === 'success') r.ok++;
            if (p.status === 'failed') r.fail++;
        }
        return [...m.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12);
    }, [pipes]);
    const projMax = Math.max(1, ...byProj.map(([, r]) => r.total));

    // 날짜별 결과 스택
    const daily = useMemo(() => {
        const m = new Map<string, { ok: number; fail: number; other: number }>();
        for (const d of days) m.set(d, {ok: 0, fail: 0, other: 0});
        for (const p of pipes) {
            const row = m.get(dayKey(p.created_at));
            if (!row) continue;
            if (p.status === 'success') row.ok++;
            else if (p.status === 'failed') row.fail++;
            else row.other++;
        }
        return m;
    }, [pipes, days]);
    const dailyMax = Math.max(1, ...[...daily.values()].map(r => r.ok + r.fail + r.other));

    const recentFailed = failed.slice(0, 20);

    return (
        <div className="stats scroll">
            <div className="cards">
                <div className="card"><div className="card-v">{comma(pipes.length)}</div><div className="card-l">파이프라인 ({period}일)</div></div>
                <div className="card"><div className="card-v" style={{WebkitTextFillColor: rate !== null && rate < 70 ? 'var(--red)' : undefined}}>{rate !== null ? `${rate}%` : '—'}</div><div className="card-l">성공률</div></div>
                <div className="card"><div className="card-v">{comma(failed.length)}</div><div className="card-l">실패</div></div>
                <div className="card"><div className="card-v">{comma(running.length)}</div><div className="card-l">실행/대기 중</div></div>
                <div className="card"><div className="card-v">{durs.length ? fmtDur(avgDur) : '—'}</div><div className="card-l">평균 소요 (근사)</div></div>
            </div>

            {pipes.length === 0 && (
                <section className="stat-block">
                    <div className="empty">최근 {period}일 내 파이프라인이 없습니다. CI를 사용하는 프로젝트가 활동하면 여기에 표시됩니다.</div>
                </section>
            )}

            {running.length > 0 && (
                <section className="stat-block">
                    <h3>실행/대기 중 <span className="count">{running.length}</span></h3>
                    {running.map(p => <PipeRow key={p.id} p={p}/>)}
                </section>
            )}

            <div className="stat-cols">
                <section className="stat-block">
                    <h3>날짜별 파이프라인 결과</h3>
                    <div className={`bars ${period === 90 ? 'bars-dense' : ''}`}>
                        {days.map((d, i) => {
                            const row = daily.get(d)!;
                            return (
                                <div key={d} className="bar-col" title={`${d} · 성공 ${row.ok}, 실패 ${row.fail}, 기타 ${row.other}`}>
                                    <div className="bar-stack">
                                        {row.ok > 0 && <div style={{height: `${(row.ok / dailyMax) * 100}%`, background: 'var(--green)'}}/>}
                                        {row.fail > 0 && <div style={{height: `${(row.fail / dailyMax) * 100}%`, background: 'var(--red)'}}/>}
                                        {row.other > 0 && <div style={{height: `${(row.other / dailyMax) * 100}%`, background: 'var(--muted)'}}/>}
                                    </div>
                                    <span className="bar-x">{i % xEvery === 0 ? d.slice(8) : ''}</span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="legend">
                        <span><i style={{background: 'var(--green)'}}/>성공</span>
                        <span><i style={{background: 'var(--red)'}}/>실패</span>
                        <span><i style={{background: 'var(--muted)'}}/>기타</span>
                    </div>
                </section>

                <section className="stat-block">
                    <h3>프로젝트별 성공률 <span className="hint">파이프라인 수 기준 Top 12</span></h3>
                    {byProj.map(([path, r]) => {
                        const pr = r.ok + r.fail > 0 ? Math.round((r.ok / (r.ok + r.fail)) * 100) : null;
                        return (
                            <div key={path} className="lb-row">
                                <span className="lb-name lb-name-wide drill" title={`${path} — 클릭하면 피드에서 필터`} onClick={() => onDrill(path)}>{path}</span>
                                <div className="lb-bar-wrap">
                                    <div className="lb-bar" style={{
                                        width: `${(r.total / projMax) * 100}%`,
                                        background: pr !== null && pr < 70
                                            ? 'linear-gradient(90deg, rgba(220,38,38,0.85), rgba(248,113,113,0.95))'
                                            : undefined,
                                    }}/>
                                </div>
                                <span className="lb-score">{r.total}</span>
                                <span className="lb-detail">{pr !== null ? `성공률 ${pr}%` : '—'} · 실패 {r.fail}</span>
                            </div>
                        );
                    })}
                    {byProj.length === 0 && <div className="empty">데이터 없음</div>}
                </section>
            </div>

            {recentFailed.length > 0 && (
                <section className="stat-block">
                    <h3>최근 실패 <span className="count">{failed.length}</span></h3>
                    {recentFailed.map(p => <PipeRow key={p.id} p={p}/>)}
                </section>
            )}
        </div>
    );
}

function PipeRow({p}: { p: Pipeline }) {
    const m = pipeMeta(p.status);
    return (
        <div className="pipe" onClick={() => OpenURL(p.web_url)}>
            <span className={`pipe-dot ${PIPE_RUNNING.has(p.status) ? 'pipe-pulse' : ''}`} style={{background: m.color}}/>
            <span className="pipe-status" style={{color: m.color}}>{m.label}</span>
            <span className="pipe-proj">{p.project_path || `#${p.project_id}`}</span>
            <span className="pipe-ref" title={p.sha}>{p.ref}</span>
            <span className="time">{timeAgo(p.created_at)}</span>
        </div>
    );
}

// ---- Stats view ----
function StatsView({snap, period, onDrill}: { snap: Snapshot; period: Period; onDrill: (q: string) => void }) {
    const [includeBots, setIncludeBots] = useState(false);
    const [weights, setWeights] = useState<Weights>(loadWeights);
    const [showCfg, setShowCfg] = useState(false);
    const updateWeight = (k: keyof Weights, v: number) => {
        setWeights(prev => {
            const next = {...prev, [k]: isNaN(v) ? 0 : v};
            localStorage.setItem(WEIGHTS_KEY, JSON.stringify(next));
            return next;
        });
    };
    const resetWeights = () => {
        localStorage.removeItem(WEIGHTS_KEY);
        setWeights({...DEFAULT_WEIGHTS});
    };
    const days = useMemo(() => lastNDays(period), [snap.fetched_at, period]);
    const xEvery = period === 90 ? 10 : 5;
    const events = useMemo(() => {
        const cut = periodCutoff(period);
        return snap.events.filter(e => new Date(e.created_at).getTime() >= cut);
    }, [snap.events, period]);
    const mergedMRs = useMemo(() => {
        const cut = periodCutoff(period);
        return snap.merged_mrs.filter(m => m.merged_at && new Date(m.merged_at).getTime() >= cut);
    }, [snap.merged_mrs, period]);
    const users = useMemo(() => {
        const all = aggregateUsers(events, weights);
        return includeBots ? all : all.filter(u => !u.isBot);
    }, [events, includeBots, weights]);

    // 날짜별 kind 스택
    const daily = useMemo(() => {
        const m = new Map<string, Record<Kind, number>>();
        for (const d of days) m.set(d, {push: 0, merge: 0, mr: 0, comment: 0, other: 0});
        for (const e of events) {
            const row = m.get(dayKey(e.created_at));
            if (row) row[eventKind(e)]++;
        }
        return m;
    }, [events, days]);
    const dailyMax = Math.max(1, ...[...daily.values()].map(r => KINDS.reduce((s, k) => s + r[k], 0)));

    // 레포별 활동
    const repos = useMemo(() => {
        const m = new Map<string, number>();
        for (const e of events) {
            const p = e.project_path || `#${e.project_id}`;
            m.set(p, (m.get(p) ?? 0) + 1);
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    }, [events]);
    const repoMax = Math.max(1, ...repos.map(r => r[1]));

    // 시간대별
    const hours = useMemo(() => {
        const h = new Array(24).fill(0);
        for (const e of events) h[new Date(e.created_at).getHours()]++;
        return h;
    }, [events]);
    const hourMax = Math.max(1, ...hours);

    // MR 지표
    const leadTimes = mergedMRs
        .filter(m => m.merged_at)
        .map(m => new Date(m.merged_at!).getTime() - new Date(m.created_at).getTime());
    const avgLead = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : 0;
    const openAges = snap.open_mrs.map(m => Date.now() - new Date(m.created_at).getTime());
    const avgOpenAge = openAges.length ? openAges.reduce((a, b) => a + b, 0) / openAges.length : 0;
    const mrOpened = events.filter(e => eventKind(e) === 'mr' && e.action_name === 'opened').length;

    // 리뷰 지표
    const reviewTimes = mergedMRs
        .filter(m => m.first_review_at)
        .map(m => new Date(m.first_review_at!).getTime() - new Date(m.created_at).getTime())
        .filter(t => t > 0);
    const avgFirstReview = reviewTimes.length ? reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length : 0;
    const mergedNoReview = mergedMRs.filter(m => !m.first_review_at && !(m.approvers?.length)).length;
    const reviewers = useMemo(() => {
        // 승인 수: 기간 내 머지 MR + 현재 열린 MR의 approvers 집계
        const appr = new Map<string, number>();
        for (const m of [...mergedMRs, ...snap.open_mrs]) {
            for (const u of m.approvers ?? []) appr.set(u, (appr.get(u) ?? 0) + 1);
        }
        // MR 댓글 수: 이벤트에서 (작성자 무관 MR 대상 댓글)
        const cmt = new Map<string, number>();
        for (const e of events) {
            if (eventKind(e) === 'comment' && e.target_type?.includes('MergeRequest')) {
                const u = e.author?.username || '?';
                cmt.set(u, (cmt.get(u) ?? 0) + 1);
            }
        }
        const names = new Set([...appr.keys(), ...cmt.keys()]);
        return [...names]
            .map(u => ({user: u, approvals: appr.get(u) ?? 0, comments: cmt.get(u) ?? 0}))
            .sort((a, b) => (b.approvals * 2 + b.comments) - (a.approvals * 2 + a.comments))
            .slice(0, 10);
    }, [mergedMRs, snap.open_mrs, events]);
    const reviewerMax = Math.max(1, ...reviewers.map(r => r.approvals * 2 + r.comments));

    // 코드 변경량 (기본 브랜치 커밋, 사용자×날짜 → 기간 집계)
    const codeAgg = useMemo(() => {
        const cutDay = new Date(periodCutoff(period));
        const cut = `${cutDay.getFullYear()}-${String(cutDay.getMonth() + 1).padStart(2, '0')}-${String(cutDay.getDate()).padStart(2, '0')}`;
        const m = new Map<string, { add: number; del: number; commits: number }>();
        for (const r of snap.code_daily) {
            if (r.day < cut) continue;
            let row = m.get(r.user);
            if (!row) { row = {add: 0, del: 0, commits: 0}; m.set(r.user, row); }
            row.add += r.add; row.del += r.del; row.commits += r.commits;
        }
        return m;
    }, [snap.code_daily, period]);
    const codeByUser = useMemo(() =>
        [...codeAgg.entries()]
            .sort((a, b) => (b[1].add + b[1].del) - (a[1].add + a[1].del))
            .slice(0, 10),
    [codeAgg]);
    const codeMax = Math.max(1, ...codeByUser.map(([, r]) => r.add + r.del));
    const codeTotals = codeByUser.reduce((acc, [, r]) => ({add: acc.add + r.add, del: acc.del + r.del}), {add: 0, del: 0});
    const fmtN = comma;

    // 유휴 레포: 기간 내 활동 없음
    const idleRepos = useMemo(() => {
        const cut = periodCutoff(period);
        return snap.projects.filter(p => new Date(p.last_activity_at).getTime() < cut);
    }, [snap.projects, period]);

    // CSV 내보내기 (현재 기간·가중치 기준 사용자 요약)
    const [toast, setToast] = useState('');
    const exportCSV = async () => {
        const q = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
        const head = ['순위', 'username', '이름', '활동지수', '커밋', 'push', 'MR생성', '머지', '댓글', '추가라인', '삭제라인'];
        const rows = users.map((u, i) => {
            const c = codeAgg.get(u.username);
            return [i + 1, u.username, u.name, Math.round(u.score), u.commits, u.pushes, u.mrs, u.merges, u.comments, c?.add ?? '', c?.del ?? ''];
        });
        const csv = '\uFEFF' + [head, ...rows].map(r => r.map(q).join(',')).join('\n');
        const name = `gitlab-mon-활동-${period}일-${new Date().toISOString().slice(0, 10)}.csv`;
        const res = await SaveCSV(name, csv);
        setToast(res.startsWith('ERR:') ? `저장 실패: ${res.slice(4)}` : `저장됨: ${res}`);
        setTimeout(() => setToast(''), 6000);
    };

    const top = users.slice(0, 10);
    const scoreMax = Math.max(1, ...top.map(u => u.score));
    const heatMax = Math.max(1, ...top.flatMap(u => [...u.byDay.values()]));
    const level = (v: number) => v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / heatMax) * 3.999));

    return (
        <div className="stats scroll">
            {/* MR 지표 카드 */}
            <div className="cards">
                <div className="card"><div className="card-v">{comma(mrOpened)}</div><div className="card-l">MR 생성 ({period}일)</div></div>
                <div className="card"><div className="card-v">{comma(mergedMRs.length)}</div><div className="card-l">머지 완료 ({period}일)</div></div>
                <div className="card"><div className="card-v">{leadTimes.length ? fmtDur(avgLead) : '—'}</div><div className="card-l">평균 머지 리드타임</div></div>
                <div className="card"><div className="card-v">{comma(snap.open_mrs.length)}</div><div className="card-l">열린 MR</div></div>
                <div className="card"><div className="card-v">{openAges.length ? fmtDur(avgOpenAge) : '—'}</div><div className="card-l">열린 MR 평균 나이</div></div>
                <div className="card"><div className="card-v">{comma(events.length)}</div><div className="card-l">전체 이벤트 ({period}일)</div></div>
                <div className="card"><div className="card-v">{reviewTimes.length ? fmtDur(avgFirstReview) : '—'}</div><div className="card-l">평균 첫 리뷰 시간</div></div>
                <div className="card">
                    <div className="card-v" style={{WebkitTextFillColor: mergedMRs.length > 0 && mergedNoReview / mergedMRs.length > 0.5 ? 'var(--orange)' : undefined}}>
                        {mergedMRs.length ? `${mergedNoReview}/${mergedMRs.length}` : '—'}
                    </div>
                    <div className="card-l">리뷰 없는 머지</div>
                </div>
            </div>

            {/* 사용자 리더보드 */}
            <section className="stat-block">
                <h3>
                    사용자별 활동 지수
                    <span className="hint">커밋 {weights.commit} · MR {weights.mrOpen} · 머지 {weights.merge} · 댓글 {weights.comment}</span>
                    <button className="gear" title="가중치 설정" onClick={() => setShowCfg(v => !v)}>⚙</button>
                    <button className="btn btn-sm csv-btn" onClick={exportCSV}>CSV 내보내기</button>
                    {toast && <span className="toast">{toast}</span>}
                    <label className="toggle">
                        <input type="checkbox" checked={includeBots} onChange={e => setIncludeBots(e.target.checked)}/>
                        토큰봇 포함
                    </label>
                </h3>
                {showCfg && (
                    <div className="wcfg">
                        {([
                            ['commit', '커밋 1개당'],
                            ['commitCap', 'push당 커밋 상한'],
                            ['mrOpen', 'MR 생성'],
                            ['mrOther', 'MR 기타'],
                            ['merge', '머지'],
                            ['comment', '댓글'],
                            ['other', '기타 이벤트'],
                        ] as [keyof Weights, string][]).map(([k, label]) => (
                            <label key={k} className="wcfg-item">
                                <span>{label}</span>
                                <input type="number" step={k === 'commitCap' ? 1 : 0.5} min={0}
                                       value={weights[k]}
                                       onChange={e => updateWeight(k, parseFloat(e.target.value))}/>
                            </label>
                        ))}
                        <button className="btn btn-sm" onClick={resetWeights}>기본값 복원</button>
                    </div>
                )}
                {top.map((u, i) => (
                    <div key={u.username} className="lb-row">
                        <span className="lb-rank">{i + 1}</span>
                        <span className="lb-name drill" title={`${u.username} — 클릭하면 피드에서 필터`} onClick={() => onDrill(u.username)}>{u.isBot && <Icon name="bot" size={13} className="bot-ico"/>}{u.name}</span>
                        <div className="lb-bar-wrap">
                            <div className="lb-bar" style={{width: `${(u.score / scoreMax) * 100}%`}}/>
                        </div>
                        <span className="lb-score">{Math.round(u.score)}</span>
                        <span className="lb-detail">커밋 {u.commits} · push {u.pushes} · MR {u.mrs} · 머지 {u.merges} · 댓글 {u.comments}</span>
                    </div>
                ))}
                {top.length === 0 && <div className="empty">데이터 없음</div>}
            </section>

            {/* 사용자 × 날짜 히트맵 */}
            <section className="stat-block">
                <h3>사용자 × 날짜 활동 히트맵 <span className="hint">최근 {period}일, 진할수록 활동 많음</span></h3>
                <div className={`heat ${period === 90 ? 'heat-sm' : ''}`}>
                    {top.map(u => (
                        <div key={u.username} className="heat-row">
                            <span className="heat-name drill" title={`${u.username} — 클릭하면 피드에서 필터`} onClick={() => onDrill(u.username)}>{u.isBot && <Icon name="bot" size={12} className="bot-ico"/>}{u.name}</span>
                            {days.map(d => {
                                const v = u.byDay.get(d) ?? 0;
                                return <span key={d} className={`cell cell-${level(v)}`} title={`${u.name} · ${d} · ${Math.round(v)}점`}/>;
                            })}
                        </div>
                    ))}
                    <div className="heat-row heat-axis">
                        <span className="heat-name"/>
                        {days.map((d, i) => (
                            <span key={d} className="cell axis">{i % xEvery === 0 ? d.slice(8) : ''}</span>
                        ))}
                    </div>
                </div>
            </section>

            <div className="stat-cols">
                {/* 날짜별 액션 스택 */}
                <section className="stat-block">
                    <h3>날짜별 활동 (액션 종류)</h3>
                    <div className={`bars ${period === 90 ? 'bars-dense' : ''}`}>
                        {days.map((d, i) => {
                            const row = daily.get(d)!;
                            const total = KINDS.reduce((s, k) => s + row[k], 0);
                            return (
                                <div key={d} className="bar-col" title={`${d} · 총 ${total}\n` + KINDS.map(k => `${KIND_META[k].label} ${row[k]}`).join(', ')}>
                                    <div className="bar-stack">
                                        {KINDS.map(k => row[k] > 0 && (
                                            <div key={k} style={{height: `${(row[k] / dailyMax) * 100}%`, background: KIND_META[k].color}}/>
                                        ))}
                                    </div>
                                    <span className="bar-x">{i % xEvery === 0 ? d.slice(8) : ''}</span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="legend">
                        {KINDS.map(k => <span key={k}><i style={{background: KIND_META[k].color}}/>{KIND_META[k].label}</span>)}
                    </div>
                </section>

                {/* 시간대별 분포 */}
                <section className="stat-block">
                    <h3>시간대별 활동 분포</h3>
                    <div className="bars">
                        {hours.map((v, h) => (
                            <div key={h} className="bar-col" title={`${h}시 · ${v}건`}>
                                <div className="bar-stack">
                                    <div style={{height: `${(v / hourMax) * 100}%`, background: 'var(--accent)'}}/>
                                </div>
                                <span className="bar-x">{h % 3 === 0 ? h : ''}</span>
                            </div>
                        ))}
                    </div>
                </section>
            </div>

            {/* 코드 변경량 */}
            <section className="stat-block">
                <h3>코드 변경량 Top 10
                    <span className="hint">기본 브랜치 커밋 기준 · 기간 합계 +{fmtN(codeTotals.add)} / -{fmtN(codeTotals.del)}</span>
                </h3>
                {codeByUser.map(([user, r]) => (
                    <div key={user} className="lb-row">
                        <span className="lb-name drill" title={`${user} — 클릭하면 피드에서 필터`} onClick={() => onDrill(user)}>{user}</span>
                        <div className="lb-bar-wrap code-bar-wrap">
                            <div className="code-bar-add" style={{width: `${(r.add / codeMax) * 100}%`}}/>
                            <div className="code-bar-del" style={{width: `${(r.del / codeMax) * 100}%`}}/>
                        </div>
                        <span className="lb-score code-add">+{fmtN(r.add)}</span>
                        <span className="lb-score code-del">-{fmtN(r.del)}</span>
                        <span className="lb-detail">커밋 {r.commits}</span>
                    </div>
                ))}
                {codeByUser.length === 0 && <div className="empty">기간 내 커밋 없음</div>}
            </section>

            {/* 리뷰어 리더보드 */}
            <section className="stat-block">
                <h3>리뷰어 활동 Top 10 <span className="hint">승인 ×2 + MR 댓글 기준 · 승인은 현재 시점 집계</span></h3>
                {reviewers.map(r => (
                    <div key={r.user} className="lb-row">
                        <span className="lb-name drill" title={`${r.user} — 클릭하면 피드에서 필터`} onClick={() => onDrill(r.user)}>{r.user}</span>
                        <div className="lb-bar-wrap">
                            <div className="lb-bar lb-bar-review" style={{width: `${((r.approvals * 2 + r.comments) / reviewerMax) * 100}%`}}/>
                        </div>
                        <span className="lb-score">{r.approvals * 2 + r.comments}</span>
                        <span className="lb-detail">승인 {r.approvals} · MR 댓글 {r.comments}</span>
                    </div>
                ))}
                {reviewers.length === 0 && <div className="empty">기간 내 리뷰 활동 없음</div>}
            </section>

            {/* 레포별 활동 */}
            <section className="stat-block">
                <h3>레포별 활동 Top 10 <span className="hint">이벤트 수 기준</span></h3>
                {repos.map(([path, n]) => (
                    <div key={path} className="lb-row">
                        <span className="lb-name lb-name-wide drill" title="클릭하면 피드에서 필터" onClick={() => onDrill(path)}>{path}</span>
                        <div className="lb-bar-wrap">
                            <div className="lb-bar lb-bar-repo" style={{width: `${(n / repoMax) * 100}%`}}/>
                        </div>
                        <span className="lb-score">{n}</span>
                    </div>
                ))}
            </section>

            {/* 유휴 레포 */}
            <section className="stat-block">
                <h3>유휴 레포 <span className="hint">{period}일 내 활동 없음 · {idleRepos.length}개 / 전체 {snap.projects.length}개</span></h3>
                <div className="idle-list">
                    {idleRepos.map(p => (
                        <div key={p.id} className="repo" onClick={() => OpenURL(p.web_url)}>
                            <span className="repo-name">{p.path_with_namespace}</span>
                            <span className="time">{timeAgo(p.last_activity_at)}</span>
                        </div>
                    ))}
                    {idleRepos.length === 0 && <div className="empty">유휴 레포 없음 — 모든 레포가 활동 중</div>}
                </div>
            </section>
        </div>
    );
}

// ---- Weekly report ----
interface WeekProjectWork {
    path: string; web_url: string; commit_count: number; add: number; del: number;
    commit_msgs: string[] | null; merged_mrs: string[] | null; opened_mrs: string[] | null; branches: string[] | null;
}
interface WeekDay { day: string; commits: number; add: number; del: number }
interface WeekReportData {
    username: string; week_start: string; week_end: string; week_offset: number;
    total_commits: number; total_add: number; total_del: number;
    merged_count: number; opened_count: number;
    projects: WeekProjectWork[] | null; days: WeekDay[] | null;
    has_ai_key: boolean; error: string;
}

// ---- 사용자 매핑(git author → GitLab user) 설정 모달 ----
interface AliasEntry { key: string; username: string }
interface UnmappedAuthor { name: string; email: string; commits: number }
interface GLUserLite { username: string; name: string }

function AuthorMappingModal({onClose, onSaved}: { onClose: () => void; onSaved: () => void }) {
    const [data, setData] = useState<{ aliases: AliasEntry[]; unmapped: UnmappedAuthor[]; users: GLUserLite[] } | null>(null);
    const [aliases, setAliases] = useState<Map<string, string>>(new Map()); // key(email/name) → username
    const [members, setMembers] = useState<Member[]>([]);
    const [teams, setTeams] = useState<Team[]>([]);
    const [saving, setSaving] = useState(false);
    const [warn, setWarn] = useState('');

    useEffect(() => {
        GetAuthorMappings().then((d: any) => {
            setData(d);
            const m = new Map<string, string>();
            (d.aliases ?? []).forEach((a: AliasEntry) => m.set(a.key, a.username));
            setAliases(m);
        });
        GetMembers().then((ms: any) => setMembers(ms || []));
        GetTeams().then((ts: any) => setTeams(ts || []));
    }, []);

    const keyOf = (au: UnmappedAuthor) => (au.email || au.name).toLowerCase();
    const assign = (au: UnmappedAuthor, username: string) => setAliases(prev => {
        const n = new Map(prev);
        if (username) n.set(keyOf(au), username); else n.delete(keyOf(au));
        return n;
    });
    const removeAlias = (key: string) => setAliases(prev => { const n = new Map(prev); n.delete(key); return n; });

    const save = async () => {
        setSaving(true);
        setWarn('');
        const entries = [...aliases.entries()].map(([key, username]) => ({key, username}));
        const r = await SaveAuthorMappings(entries);
        setSaving(false);
        onSaved(); // 저장은 완료됨 — picker 갱신
        if (r) { setWarn(r); return; } // 경고 시 모달 유지하고 표시
        onClose();
    };

    if (!data) {
        return <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}><div className="empty">불러오는 중…</div></div>
        </div>;
    }

    const users = data.users;
    const memberTargets = members.filter(m => m.active && m.gitlab_username.trim())
        .sort((a, b) => teamNameOf(teams, a.team_id).localeCompare(teamNameOf(teams, b.team_id), 'ko') || a.name.localeCompare(b.name, 'ko'));
    const currentRows = [...aliases.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <h2 className="modal-title">사용자 매핑</h2>
                    <span className="hint">git 작성자 → GitLab 사용자</span>
                    <button className="modal-x" onClick={onClose}>✕</button>
                </div>

                <div className="modal-section">
                    <h3>매핑 필요 <span className="count">{data.unmapped.length}</span></h3>
                    <p className="hint">GitLab 계정과 연결되지 않은 커밋 작성자입니다. 본인 계정을 고르면 커밋이 합쳐집니다.</p>
                    {data.unmapped.length === 0 && <div className="empty">모두 매핑되었습니다 🎉</div>}
                    {data.unmapped.map(au => (
                        <div key={au.name + '|' + au.email} className="map-row">
                            <div className="map-id">
                                <b>{au.name || '(이름 없음)'}</b>
                                <span className="map-email">{au.email}</span>
                            </div>
                            <span className="map-commits">{au.commits} 커밋</span>
                            <select className="jselect" value={aliases.get(keyOf(au)) ?? ''} onChange={e => assign(au, e.target.value)}>
                                <option value="">— 그대로 두기 —</option>
                                {memberTargets.length > 0 && <optgroup label="팀원">
                                    {memberTargets.map(m => <option key={'m-' + m.id} value={m.gitlab_username}>{m.name}{teamNameOf(teams, m.team_id) ? ` · ${teamNameOf(teams, m.team_id)}` : ''} → {m.gitlab_username}</option>)}
                                </optgroup>}
                                <optgroup label="GitLab 사용자">
                                    {users.map(u => <option key={u.username} value={u.username}>{u.username}{u.name ? ` (${u.name})` : ''}</option>)}
                                </optgroup>
                            </select>
                        </div>
                    ))}
                </div>

                <div className="modal-section">
                    <h3>현재 매핑 <span className="count">{currentRows.length}</span></h3>
                    {currentRows.length === 0 && <div className="empty">매핑 없음</div>}
                    {currentRows.map(([key, username]) => (
                        <div key={key} className="map-row">
                            <span className="map-email">{key}</span>
                            <span className="map-arrow">→</span>
                            <b className="map-target">{username}</b>
                            <button className="map-del" title="삭제" onClick={() => removeAlias(key)}>✕</button>
                        </div>
                    ))}
                </div>

                {warn && <div className="warn-banner">⚠ {warn}</div>}
                <div className="modal-actions">
                    <button className="btn" onClick={onClose}>취소</button>
                    <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
                </div>
            </div>
        </div>
    );
}

function WeeklyView({onDrill}: { onDrill: (q: string) => void }) {
    const [users, setUsers] = useState<string[]>([]);
    const [user, setUser] = useState('');
    const [offset, setOffset] = useState(1); // 1 = 지난주
    const [rep, setRep] = useState<WeekReportData | null>(null);
    const [loading, setLoading] = useState(false);
    const [summary, setSummary] = useState('');
    const [summarizing, setSummarizing] = useState(false);
    const [mapping, setMapping] = useState(false);

    const reloadUsers = () => WeeklyReportUsers().then((u: string[]) => setUsers(u || []));
    useEffect(() => { reloadUsers(); }, []);

    useEffect(() => {
        if (!user) { setRep(null); return; }
        setLoading(true);
        setSummary('');
        WeeklyReport(user, offset).then((r: any) => { setRep(r); setLoading(false); });
    }, [user, offset]);

    const runSummary = async () => {
        setSummarizing(true);
        const r = await SummarizeWeek(user, offset);
        setSummarizing(false);
        setSummary(r);
    };

    const copyText = () => {
        if (!rep) return;
        const lines: string[] = [`# ${rep.username} 주간 보고 (${rep.week_start} ~ ${rep.week_end})`,
            `커밋 ${rep.total_commits} · +${rep.total_add}/-${rep.total_del} · 머지 ${rep.merged_count} · MR생성 ${rep.opened_count}`, ''];
        for (const p of rep.projects ?? []) {
            lines.push(`## ${p.path} (커밋 ${p.commit_count}, +${p.add}/-${p.del})`);
            (p.merged_mrs ?? []).forEach(m => lines.push(`- [머지] ${m}`));
            (p.opened_mrs ?? []).forEach(m => lines.push(`- [MR] ${m}`));
            (p.commit_msgs ?? []).forEach(c => lines.push(`- ${c}`));
            lines.push('');
        }
        navigator.clipboard.writeText(lines.join('\n'));
    };

    const dayMax = Math.max(1, ...(rep?.days ?? []).map(d => d.commits));
    const offLabel = offset === 0 ? '이번 주' : offset === 1 ? '지난 주' : `${offset}주 전`;

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>주간 리포트</h2>
                <select className="jselect" value={user} onChange={e => setUser(e.target.value)}>
                    <option value="">사용자 선택…</option>
                    {users.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <div className="tabs">
                    {[0, 1, 2, 3].map(o => (
                        <button key={o} className={offset === o ? 'tab tab-on' : 'tab'} onClick={() => setOffset(o)}>
                            {o === 0 ? '이번 주' : o === 1 ? '지난 주' : `${o}주 전`}
                        </button>
                    ))}
                </div>
                {rep && !rep.error && <button className="btn btn-sm" onClick={copyText}>복사</button>}
                {rep && !rep.error && rep.has_ai_key &&
                    <button className="refresh-btn" onClick={runSummary} disabled={summarizing}>
                        {summarizing ? 'AI 요약 중…' : '✨ AI 요약'}
                    </button>}
                <button className="btn btn-sm" onClick={() => setMapping(true)} title="git 작성자 ↔ GitLab 사용자 매핑">⚙ 사용자 매핑</button>
            </div>

            {mapping && <AuthorMappingModal onClose={() => setMapping(false)} onSaved={reloadUsers}/>}

            {!user && <section className="stat-block"><div className="empty">사용자를 선택하면 {offLabel} 활동을 정리합니다</div></section>}
            {loading && <section className="stat-block"><div className="empty">불러오는 중…</div></section>}
            {rep?.error && <div className="error-banner">⚠ {rep.error}</div>}

            {rep && !rep.error && !loading && (
                <>
                    <div className="cards">
                        <div className="card"><div className="card-v">{comma(rep.total_commits)}</div><div className="card-l">커밋</div></div>
                        <div className="card"><div className="card-v code-add">+{comma(rep.total_add)}</div><div className="card-l">추가 라인</div></div>
                        <div className="card"><div className="card-v code-del">-{comma(rep.total_del)}</div><div className="card-l">삭제 라인</div></div>
                        <div className="card"><div className="card-v">{comma(rep.merged_count)}</div><div className="card-l">머지</div></div>
                        <div className="card"><div className="card-v">{comma(rep.opened_count)}</div><div className="card-l">MR 생성</div></div>
                    </div>

                    {summary && (
                        <section className="stat-block">
                            <h3>✨ AI 요약</h3>
                            {summary.startsWith('ERR:')
                                ? <div className="error-banner">{summary.slice(4)}</div>
                                : <div className="ai-summary"><Markdown text={summary}/></div>}
                        </section>
                    )}

                    <section className="stat-block">
                        <h3>일별 커밋 <span className="hint">{rep.week_start} ~ {rep.week_end}</span></h3>
                        <div className="bars">
                            {(rep.days ?? []).map(d => (
                                <div key={d.day} className="bar-col" title={`${d.day} · 커밋 ${d.commits}, +${d.add}/-${d.del}`}>
                                    <div className="bar-stack">
                                        {d.commits > 0 && <div style={{height: `${(d.commits / dayMax) * 100}%`, background: 'var(--accent)'}}/>}
                                    </div>
                                    <span className="bar-x">{['월','화','수','목','금','토','일'][(new Date(d.day).getDay()+6)%7]}</span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {(rep.projects ?? []).length === 0
                        ? <section className="stat-block"><div className="empty">이 주에 기록된 활동이 없습니다</div></section>
                        : (rep.projects ?? []).map(p => (
                            <section key={p.path} className="stat-block">
                                <h3>
                                    <span className="drill" onClick={() => onDrill(p.path)}>{p.path}</span>
                                    <span className="hint">커밋 {p.commit_count} · <i className="code-add">+{p.add}</i>/<i className="code-del">-{p.del}</i>
                                        {p.web_url && <> · <a className="instance" onClick={() => OpenURL(p.web_url)}>레포 ↗</a></>}</span>
                                </h3>
                                {(p.merged_mrs ?? []).length > 0 && (
                                    <div className="wk-group"><b>머지된 MR</b>
                                        {(p.merged_mrs ?? []).map((m, i) => <div key={i} className="wk-item wk-merge">⛙ {m}</div>)}
                                    </div>
                                )}
                                {(p.opened_mrs ?? []).length > 0 && (
                                    <div className="wk-group"><b>생성한 MR</b>
                                        {(p.opened_mrs ?? []).map((m, i) => <div key={i} className="wk-item wk-mr">⎇ {m}</div>)}
                                    </div>
                                )}
                                {(p.commit_msgs ?? []).length > 0 && (
                                    <div className="wk-group"><b>커밋 {(p.commit_msgs ?? []).length}건</b>
                                        {(p.commit_msgs ?? []).map((c, i) => <div key={i} className="wk-item wk-commit">{c}</div>)}
                                    </div>
                                )}
                            </section>
                        ))}
                </>
            )}
        </div>
    );
}

// ---- 경량 마크다운 렌더러 (자체 구현 — 의존성·innerHTML 없이 React 요소로 안전 렌더) ----
function mdInline(text: string): (string | JSX.Element)[] {
    const out: (string | JSX.Element)[] = [];
    const re = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\n]+\))/;
    let rest = text, k = 0;
    for (;;) {
        const m = re.exec(rest);
        if (!m) { if (rest) out.push(rest); break; }
        if (m.index > 0) out.push(rest.slice(0, m.index));
        const t = m[0];
        if (t[0] === '`') out.push(<code key={k++}>{t.slice(1, -1)}</code>);
        else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
        else if (t[0] === '*') out.push(<em key={k++}>{t.slice(1, -1)}</em>);
        else {
            const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
            out.push(<a key={k++} className="md-a" onClick={() => OpenURL(lm[2])}>{lm[1]}</a>);
        }
        rest = rest.slice(m.index + t.length);
    }
    return out;
}

const MD_BREAK = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|---+\s*$|\*\*\*+\s*$)/;

function Markdown({text}: { text: string }) {
    const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
    const blocks: JSX.Element[] = [];
    let i = 0, k = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) { i++; continue; }
        if (/^```/.test(line)) {
            const buf: string[] = []; i++;
            while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            blocks.push(<pre key={k++} className="md-pre">{buf.join('\n')}</pre>);
            continue;
        }
        if (/^(---+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={k++} className="md-hr"/>); i++; continue; }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) { blocks.push(<div key={k++} className={`md-h md-h${Math.min(h[1].length, 4)}`}>{mdInline(h[2])}</div>); i++; continue; }
        if (/^>\s?/.test(line)) {
            const buf: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
            blocks.push(<blockquote key={k++} className="md-quote">{mdInline(buf.join(' '))}</blockquote>);
            continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
            blocks.push(<ul key={k++} className="md-ul">{items.map((it, j) => <li key={j}>{mdInline(it)}</li>)}</ul>);
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
            blocks.push(<ol key={k++} className="md-ol">{items.map((it, j) => <li key={j}>{mdInline(it)}</li>)}</ol>);
            continue;
        }
        const buf: string[] = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !MD_BREAK.test(lines[i])) { buf.push(lines[i]); i++; }
        blocks.push(<p key={k++} className="md-p">{buf.map((b, j) => <span key={j}>{mdInline(b)}{j < buf.length - 1 ? <br/> : null}</span>)}</p>);
    }
    return <div className="md">{blocks}</div>;
}

// ---- 기록: 회의/통화 노트 ----
function blankNote(): Note {
    return {id: 0, kind: 'meeting', title: '', occurred_at: new Date().toISOString().slice(0, 10),
        participants: '', entity_ids: [], summary: '', decisions: '', action_items: '',
        created_at: '', updated_at: '', confluence_id: '', confluence_url: '', audio_path: ''};
}

function NoteEditor({note, entities, onClose, onReload}: {
    note: Note; entities: Entity[]; onClose: () => void; onReload: () => void;
}) {
    const [n, setN] = useState<Note>(note);
    const [saving, setSaving] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [err, setErr] = useState('');
    const [ok, setOk] = useState('');
    const [spaces, setSpaces] = useState<CfSpace[]>([]);
    const [space, setSpace] = useState('');
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    // 녹음 상태
    const [recState, setRecState] = useState<'idle' | 'recording' | 'paused'>('idle');
    const [recBlob, setRecBlob] = useState<Blob | null>(null);
    const [recURL, setRecURL] = useState('');
    const [recExt, setRecExt] = useState('webm');
    const [recSecs, setRecSecs] = useState(0);
    const [audioSrc, setAudioSrc] = useState(''); // 저장된 녹음 재생용 data URL
    const [confirmDel, setConfirmDel] = useState(false); // 녹음 삭제 확인
    const mrRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | undefined>(undefined);
    useEffect(() => () => { // 언마운트 정리
        try { mrRef.current?.state !== 'inactive' && mrRef.current?.stop(); } catch {}
        streamRef.current?.getTracks().forEach(t => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
    }, []);
    const tick = () => { timerRef.current = window.setInterval(() => setRecSecs(s => s + 1), 1000); };
    const startRec = async () => {
        setErr('');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            streamRef.current = stream;
            const mime = (window as any).MediaRecorder?.isTypeSupported?.('audio/webm') ? 'audio/webm'
                : (window as any).MediaRecorder?.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '';
            const mr = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
            chunksRef.current = [];
            mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
            mr.onstop = () => {
                const type = mr.mimeType || mime || 'audio/webm';
                const blob = new Blob(chunksRef.current, {type});
                setRecBlob(blob);
                setRecURL(URL.createObjectURL(blob));
                setRecExt(type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm');
                streamRef.current?.getTracks().forEach(t => t.stop());
            };
            mrRef.current = mr;
            mr.start();
            setRecSecs(0); setRecState('recording'); setAudioSrc(''); setConfirmDel(false); tick();
        } catch (e: any) {
            setErr('마이크를 사용할 수 없습니다 — 권한을 확인하세요 (' + (e?.message || e) + ')');
        }
    };
    const pauseRec = () => { try { mrRef.current?.pause(); } catch {} setRecState('paused'); if (timerRef.current) clearInterval(timerRef.current); };
    const resumeRec = () => { try { mrRef.current?.resume(); } catch {} setRecState('recording'); tick(); };
    const stopRec = () => { try { mrRef.current?.stop(); } catch {} setRecState('idle'); if (timerRef.current) clearInterval(timerRef.current); };
    const discardRec = () => { try { if (recURL) URL.revokeObjectURL(recURL); } catch {} setRecBlob(null); setRecURL(''); setConfirmDel(false); };
    const loadAudio = async () => {
        const b64: string = await ReadAudioBase64(n.audio_path);
        if (b64) setAudioSrc(`data:${audioMime(n.audio_path)};base64,${b64}`);
    };
    const [dlBusy, setDlBusy] = useState(false);
    const [hasFf, setHasFf] = useState(false);
    const [hasPy, setHasPy] = useState(false);
    const [nlmBusy, setNlmBusy] = useState(false);
    useEffect(() => {
        HasFFmpeg().then(setHasFf).catch(() => setHasFf(false));
        HasPython().then(setHasPy).catch(() => setHasPy(false));
    }, []);
    const downloadAudio = async (convert: boolean) => {
        if (!n.id) { setErr('먼저 저장하세요'); return; }
        setDlBusy(true); setErr(''); setOk('');
        try {
            const r: any = await DownloadNoteAudio(n.id, convert);
            if (r?.error) setErr(r.error);
            else if (!r?.canceled) setOk('녹음을 저장했습니다 ✓');
        } catch (e: any) { setErr('다운로드 실패: ' + (e?.message || e)); }
        setDlBusy(false);
    };
    const [nlmPanel, setNlmPanel] = useState(false);
    const [bgText, setBgText] = useState('');
    // 회의록 생성 시 항상 함께 전달되는 노트 메타데이터
    const metaBlock = () => {
        const parts: string[] = [`종류: ${n.kind === 'call' ? '통화' : '회의'}`];
        if (n.title.trim()) parts.push(`제목: ${n.title.trim()}`);
        const d = (n.occurred_at || '').slice(0, 10);
        if (d) parts.push(`일시: ${d}`);
        if (n.participants.trim()) parts.push(`참석자/상대: ${n.participants.trim()}`);
        const ents = (n.entity_ids || []).map(id => entities.find(e => e.id === id)?.name).filter(Boolean);
        if (ents.length) parts.push(`거래처/프로젝트: ${ents.join(', ')}`);
        return parts.join('\n');
    };
    const openNlmPanel = () => { setNlmPanel(true); setErr(''); setOk(''); };
    const genMinutes = async () => {
        if (!n.id) { setErr('먼저 저장하세요'); return; }
        setNlmBusy(true); setErr(''); setOk('');
        const extra = bgText.trim();
        const full = extra ? metaBlock() + '\n\n[추가 배경]\n' + extra : metaBlock();
        try {
            const r: any = await GenerateMinutesFromAudio(n.id, full);
            if (r?.error) setErr(r.error);
            else if (r?.content) {
                set({summary: n.summary.trim() ? n.summary + '\n\n---\n\n' + r.content : r.content});
                setOk('회의록 생성 완료 — 검토 후 저장하세요');
                setNlmPanel(false);
            }
        } catch (e: any) { setErr('회의록 생성 실패: ' + (e?.message || e)); }
        setNlmBusy(false);
    };
    const blobToB64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
    const set = (patch: Partial<Note>) => { setN(prev => ({...prev, ...patch})); setOk(''); };
    const toggleEntity = (id: string) => { const cur = n.entity_ids || []; set({entity_ids: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]}); };

    useEffect(() => { ConfluenceSpaces().then((s: any) => setSpaces(s || [])); }, []);
    const [members, setMembers] = useState<Member[]>([]);
    const [teams, setTeams] = useState<Team[]>([]);
    useEffect(() => {
        GetMembers().then((ms: any) => setMembers(ms || []));
        GetTeams().then((ts: any) => setTeams(ts || []));
    }, []);
    const partList = () => n.participants.split(',').map(s => s.trim()).filter(Boolean);
    const toggleParticipant = (name: string) => {
        const cur = partList();
        set({participants: (cur.includes(name) ? cur.filter(x => x !== name) : [...cur, name]).join(', ')});
    };
    // 활성 팀원을 팀별로 묶음 (팀 레지스트리 순서, 미배정은 마지막)
    const partGroups = teams
        .map(t => ({name: t.name, ms: members.filter(m => m.active && m.team_id === t.id)}))
        .filter(g => g.ms.length > 0);
    const partUnassigned = members.filter(m => m.active && !teams.find(t => t.id === m.team_id));
    if (partUnassigned.length) partGroups.push({name: '(미배정)', ms: partUnassigned});

    const save = async () => {
        if (!n.title.trim()) { setErr('제목을 입력하세요'); return; }
        setSaving(true); setErr('');
        const r: any = await SaveNote(n);
        if (r?.error) { setSaving(false); setErr(r.error); return; }
        let saved: Note = r?.note || n;
        if (recBlob) { // 대기 중인 녹음을 노트에 첨부
            try {
                const b64 = await blobToB64(recBlob);
                const ar: any = await SaveNoteAudio(saved.id, b64, recExt);
                if (ar?.error) { setErr(ar.error); }
                else { if (ar?.note) saved = ar.note; setRecBlob(null); setRecURL(''); }
            } catch (e: any) { setErr('녹음 첨부 실패: ' + (e?.message || e)); }
        }
        setSaving(false);
        setN(saved);
        setOk('저장됨 ✓');
        onReload();
    };
    const share = async () => {
        if (!n.title.trim()) { setErr('제목을 입력하세요'); return; }
        setSharing(true); setErr(''); setOk('');
        // 편집 중 내용이 게시되도록 먼저 저장한 뒤 공유 (stale 방지)
        const sr: any = await SaveNote(n);
        if (sr?.error) { setSharing(false); setErr(sr.error); return; }
        const saved = sr?.note || n;
        const r: any = await ShareNote(saved.id, space);
        setSharing(false);
        if (r?.error) { setErr(r.error); return; }
        if (r?.note) setN(r.note);
        setOk('Confluence에 공유됨 ✓');
        onReload();
    };
    const del = async () => {
        if (n.id) await DeleteNote(n.id);
        onReload();
        onClose();
    };
    const [aiBusy, setAiBusy] = useState(false);
    const aiTidy = async () => {
        setAiBusy(true); setErr(''); setOk('');
        const r: any = await SummarizeNote(n);
        setAiBusy(false);
        if (r?.error) { setErr(r.error); return; }
        if (r?.content) set({summary: r.content});
        setOk('AI 정리 완료 — 검토 후 저장하세요');
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <div className="tabs">
                        {(['meeting', 'call'] as const).map(k => (
                            <button key={k} className={n.kind === k ? 'tab tab-on' : 'tab'} onClick={() => set({kind: k})}>
                                {k === 'meeting' ? '회의' : '통화'}
                            </button>
                        ))}
                    </div>
                    <span className="hint">{n.id ? `기록 #${n.id}` : '새 기록'}</span>
                    <span style={{flex: 1}}/>
                    <button className="btn btn-sm" onClick={aiTidy} disabled={aiBusy} title="요약 칸의 메모를 AI가 요약·결정·액션으로 정리">{aiBusy ? '정리 중…' : '✨ AI 정리'}</button>
                    <button className="modal-x" onClick={onClose}>✕</button>
                </div>
                <input className="ent-in note-title-in" placeholder="제목" value={n.title} onChange={e => set({title: e.target.value})}/>
                <div className="note-form-row">
                    <label className="ent-field">일시<input className="ent-in" type="date" value={(n.occurred_at || '').slice(0, 10)} onChange={e => set({occurred_at: e.target.value})}/></label>
                    <label className="ent-field note-grow">참석자 / 상대<input className="ent-in" placeholder="이름, ..." value={n.participants} onChange={e => set({participants: e.target.value})}/></label>
                </div>
                {partGroups.length > 0 && (
                    <div className="ent-field">팀원에서 선택
                        <div className="member-pick">
                            {partGroups.map(g => (
                                <div key={g.name} className="member-pick-group">
                                    <span className="member-pick-team">{g.name}</span>
                                    {g.ms.map(m => (
                                        <button key={m.id} type="button"
                                                className={`pill ${partList().includes(m.name) ? 'pill-on' : ''}`}
                                                onClick={() => toggleParticipant(m.name)}>{m.name}</button>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div className="ent-field">거래처 / 프로젝트
                    <div className="poc-pills">
                        {entities.filter(e => e.active).map(e => (
                            <button key={e.id}
                                    className={`pill ${(n.entity_ids || []).includes(e.id) ? 'pill-on' : ''}`}
                                    style={(n.entity_ids || []).includes(e.id) ? {borderColor: e.accent || 'var(--accent)', color: e.accent || 'var(--accent)'} : undefined}
                                    onClick={() => toggleEntity(e.id)}>{e.name}</button>
                        ))}
                        {entities.length === 0 && <span className="hint">설정에서 거래처/프로젝트를 먼저 등록하세요</span>}
                    </div>
                </div>
                <div className="ent-field">
                    <div className="note-content-head">
                        <span>내용</span>
                        <div className="tabs note-mode">
                            <button className={mode === 'edit' ? 'tab tab-on' : 'tab'} onClick={() => setMode('edit')}>편집</button>
                            <button className={mode === 'preview' ? 'tab tab-on' : 'tab'} onClick={() => setMode('preview')}>미리보기</button>
                        </div>
                        <span className="hint">마크다운 지원</span>
                    </div>
                    {mode === 'edit'
                        ? <textarea className="ent-in note-area note-area-lg" placeholder="회의/통화 내용을 자유롭게 적으세요. 마크다운(#, -, **굵게** 등) 지원 — 붙여넣고 '미리보기'로 확인. ✨ AI 정리도 가능." value={n.summary} onChange={e => set({summary: e.target.value})}/>
                        : <div className="note-preview note-area-lg">{n.summary.trim() ? <Markdown text={n.summary}/> : <span className="hint">내용 없음</span>}</div>}
                </div>

                <div className="ent-field">녹음
                    <div className="note-rec">
                        {recState === 'recording' && <>
                            <span className="rec-dot"/><span className="rec-time">{fmtRec(recSecs)}</span>
                            <button className="btn btn-sm" onClick={pauseRec}>⏸ 일시정지</button>
                            <button className="btn btn-sm" onClick={stopRec}>⏹ 중지</button>
                        </>}
                        {recState === 'paused' && <>
                            <span className="rec-time">{fmtRec(recSecs)} · 일시정지됨</span>
                            <button className="btn btn-sm" onClick={resumeRec}>▶ 재개</button>
                            <button className="btn btn-sm" onClick={stopRec}>⏹ 중지</button>
                        </>}
                        {recState === 'idle' && recBlob && <>
                            <audio className="note-audio" controls src={recURL}/>
                            <span className="hint">저장 시 첨부됩니다</span>
                            {confirmDel ? <>
                                <span className="rec-time">삭제할까요?</span>
                                <button className="btn btn-sm rec-btn" onClick={discardRec}>삭제</button>
                                <button className="btn btn-sm" onClick={() => setConfirmDel(false)}>취소</button>
                            </> : <>
                                <button className="btn btn-sm" onClick={() => setConfirmDel(true)}>삭제</button>
                                <button className="btn btn-sm rec-btn" onClick={startRec}>● 다시 녹음</button>
                            </>}
                        </>}
                        {recState === 'idle' && !recBlob && (
                            n.audio_path ? <>
                                {audioSrc
                                    ? <audio className="note-audio" controls autoPlay src={audioSrc}/>
                                    : <button className="btn btn-sm" onClick={loadAudio}>▶ 녹음 듣기</button>}
                                <button className="btn btn-sm" onClick={() => downloadAudio(hasFf)} disabled={dlBusy} title={hasFf ? 'm4a(AAC)로 변환 — QuickTime 등 어디서나 재생' : '원본 파일 저장'}>{dlBusy ? '저장 중…' : (hasFf ? '⬇ 다운로드(m4a)' : '⬇ 다운로드')}</button>
                                {hasFf && <button className="btn btn-sm" onClick={() => downloadAudio(false)} disabled={dlBusy} title="변환 없이 원본(webm) 저장">원본</button>}
                                {hasPy && <button className="btn btn-sm" onClick={openNlmPanel} disabled={nlmBusy} title="NotebookLM에 업로드해 전사 기반 회의록 생성 (임시 노트북, 수 분 소요)">{nlmBusy ? '회의록 생성 중… (수 분)' : '📝 회의록 생성'}</button>}
                                <button className="btn btn-sm rec-btn" onClick={startRec}>● 다시 녹음(교체)</button>
                            </> : <button className="btn btn-sm rec-btn" onClick={startRec}>● 녹음 시작</button>
                        )}
                    </div>
                    {nlmPanel && (
                        <div className="nlm-panel">
                            <div className="hint">아래 노트 정보가 회의록 생성 시 맥락으로 함께 전달됩니다:</div>
                            <pre className="nlm-meta">{metaBlock()}</pre>
                            <div className="hint">추가 배경/맥락 (선택) — 용어·약어·논의 배경·이전 결정 등을 적으면 품질이 더 올라갑니다.</div>
                            <textarea className="ent-in note-area" rows={5} value={bgText} onChange={e => setBgText(e.target.value)}
                                      placeholder="예) 약어 MR=Merge Request, 지난 회의에서 견적 재검토 결정 …"/>
                            <div className="nlm-panel-actions">
                                <button className="btn btn-sm nlm-gen" onClick={genMinutes} disabled={nlmBusy}>{nlmBusy ? '생성 중… (수 분 소요)' : '📝 회의록 생성'}</button>
                                <button className="btn btn-sm" onClick={() => setNlmPanel(false)} disabled={nlmBusy}>취소</button>
                            </div>
                        </div>
                    )}
                </div>

                {n.id > 0 && (
                    <div className="note-share">
                        {n.confluence_url ? (
                            <>
                                <span className="note-shared-on"><Icon name="confluence" size={13}/> 공유됨</span>
                                <a className="instance" onClick={() => OpenURL(n.confluence_url)}>Confluence에서 열기</a>
                                <span style={{flex: 1}}/>
                                <button className="btn btn-sm" onClick={share} disabled={sharing}>{sharing ? '업데이트 중…' : '공유 업데이트'}</button>
                            </>
                        ) : spaces.length > 0 ? (
                            <>
                                <span className="note-share-label"><Icon name="confluence" size={13}/> Confluence 공유</span>
                                <select className="jselect" value={space} onChange={e => setSpace(e.target.value)}>
                                    <option value="">스페이스 선택…</option>
                                    {spaces.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                                </select>
                                <button className="btn btn-sm" onClick={share} disabled={sharing || !space}>{sharing ? '공유 중…' : '공유'}</button>
                            </>
                        ) : <span className="hint">Confluence가 설정되지 않아 공유할 수 없습니다.</span>}
                    </div>
                )}
                {n.id === 0 && <p className="hint">저장하면 Confluence에 공유할 수 있습니다.</p>}

                {err && <div className="warn-banner">⚠ {err}</div>}
                <div className="modal-actions">
                    {n.id ? <button className="map-del" title="삭제" onClick={del}>삭제</button> : <span/>}
                    {ok && <span className="hint">{ok}</span>}
                    <span style={{flex: 1}}/>
                    <button className="btn btn-sm" onClick={onClose}>닫기</button>
                    <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
                </div>
            </div>
        </div>
    );
}

function RecordsView({snap}: { snap: Snapshot }) {
    const [notes, setNotes] = useState<Note[] | null>(null);
    const [editing, setEditing] = useState<Note | null>(null);
    const [kindFilter, setKindFilter] = useState<'all' | 'meeting' | 'call'>('all');
    const [query, setQuery] = useState('');
    const reload = () => ListNotes('').then((ns: any) => setNotes(ns || []));
    useEffect(() => { reload(); }, []);

    const entName = (id: string) => snap.entities.find(e => e.id === id)?.name || id;
    const entAcc = (id: string) => snap.entities.find(e => e.id === id)?.accent || 'var(--accent)';
    const q = query.trim().toLowerCase();
    const list = (notes || [])
        .filter(n => kindFilter === 'all' || n.kind === kindFilter)
        .filter(n => !q || [n.title, n.summary, n.decisions, n.action_items, n.participants,
            ...(n.entity_ids || []).map(entName)].join(' ').toLowerCase().includes(q));

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>기록</h2>
                <div className="tabs">
                    {(['all', 'meeting', 'call'] as const).map(k => (
                        <button key={k} className={kindFilter === k ? 'tab tab-on' : 'tab'} onClick={() => setKindFilter(k)}>
                            {k === 'all' ? '전체' : k === 'meeting' ? '회의' : '통화'}
                        </button>
                    ))}
                </div>
                <input className="search" placeholder="제목·내용·참석자·엔티티 검색" value={query} onChange={e => setQuery(e.target.value)}/>
                <button className="btn btn-sm" onClick={() => setEditing({...blankNote(), kind: 'meeting'})}>🎙 녹음</button>
                <button className="btn btn-sm" onClick={() => setEditing(blankNote())}>+ 새 기록</button>
            </div>

            {!notes && <section className="stat-block"><div className="empty">불러오는 중…</div></section>}
            {notes && list.length === 0 && <section className="stat-block"><div className="empty">기록이 없습니다 — '+ 새 기록'으로 추가하세요</div></section>}
            {list.map(n => (
                <section key={n.id} className="stat-block note-card" onClick={() => setEditing(n)}>
                    <div className="note-head">
                        <span className={`note-kind note-${n.kind}`}>{n.kind === 'call' ? '통화' : '회의'}</span>
                        <b className="note-title">{n.title || '(제목 없음)'}</b>
                        {n.audio_path && <span className="note-shared" title="녹음 첨부">🎙</span>}
                        {n.confluence_url && <span className="note-shared" title="Confluence 공유됨">🔗</span>}
                        <span className="time">{(n.occurred_at || '').slice(0, 10)}</span>
                    </div>
                    {((n.entity_ids || []).length > 0 || n.participants) && (
                        <div className="note-tags">
                            {(n.entity_ids || []).map(id => (
                                <span key={id} className="poc-ptag" style={{borderColor: entAcc(id), color: entAcc(id)}}>{entName(id)}</span>
                            ))}
                            {n.participants && <span className="note-parts">{n.participants}</span>}
                        </div>
                    )}
                    {n.summary && <div className="note-snippet">{n.summary}</div>}
                </section>
            ))}

            {editing && <NoteEditor note={editing} entities={snap.entities} onClose={() => setEditing(null)} onReload={reload}/>}
        </div>
    );
}

// ---- 설정: 거래처/프로젝트(엔티티) 레지스트리 관리 ----
const AI_PROVIDERS = [
    {id: 'anthropic', label: 'Claude (Anthropic)'},
    {id: 'openai', label: 'OpenAI'},
    {id: 'gemini', label: 'Gemini (Google)'},
    {id: 'minimax', label: 'MiniMax'},
    {id: 'custom', label: '사용자 지정 (OpenAI 호환)'},
];

function AISettings() {
    const [c, setC] = useState<{ provider: string; model: string; base_url: string; has_key: boolean } | null>(null);
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    const load = () => GetAIConfig().then((x: any) => setC(x));
    useEffect(() => { load(); }, []);
    if (!c) return null;
    const set = (p: Partial<typeof c>) => { setC({...c, ...p}); setMsg(''); };
    const save = async () => {
        setSaving(true); setMsg('');
        const r: any = await SaveAIConfig(c.provider, c.model, c.base_url, key);
        setSaving(false);
        setKey('');
        load();
        setMsg(r || '저장되었습니다 ✓');
    };
    return (
        <section className="stat-block">
            <h3>AI 설정</h3>
            <p className="hint">주간 리포트 요약·기록 AI 정리에 쓸 제공자와 API 키. 키는 OS 키체인에 저장됩니다.</p>
            <div className="ent-grid">
                <label className="ent-field">제공자
                    <select className="jselect" value={c.provider} onChange={e => set({provider: e.target.value})}>
                        {AI_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                </label>
                <label className="ent-field">모델<input className="ent-in" placeholder="(제공자 기본값)" value={c.model} onChange={e => set({model: e.target.value})}/></label>
                {c.provider === 'custom' && <label className="ent-field">Base URL<input className="ent-in" placeholder="http://host/v1" value={c.base_url} onChange={e => set({base_url: e.target.value})}/></label>}
                <label className="ent-field">API 키<input className="ent-in" type="password" placeholder={c.has_key ? '설정됨 — 변경 시에만 입력' : '키 입력'} value={key} onChange={e => setKey(e.target.value)}/></label>
            </div>
            <div className="ent-actions">
                {c.has_key && <span className="hint">✓ 키 설정됨</span>}
                <span style={{flex: 1}}/>
                {msg && <span className="hint">{msg}</span>}
                <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
            </div>
        </section>
    );
}

const ACCENTS = [
    {label: '파랑', val: 'var(--accent)'}, {label: '보라', val: 'var(--purple)'},
    {label: '초록', val: 'var(--green)'}, {label: '주황', val: 'var(--orange)'}, {label: '빨강', val: 'var(--red)'},
];
// 유니코드 문자(한글 등)·숫자는 보존 — 한글명도 고유 id가 되도록(빈 경우만 'entity', 백엔드가 중복 접미사 처리)
const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]+/gu, '').replace(/^-+|-+$/g, '') || 'entity';

const blankMember = (teamId = ''): Member => ({id: '', name: '', team_id: teamId, role: '', email: '', gitlab_username: '', git_aliases: [], active: true});

// ---- 팀 관리 ----
function TeamsSection() {
    const [list, setList] = useState<Team[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    useEffect(() => { GetTeams().then((ts: any) => setList(ts || [])); }, []);

    if (!list) return <div className="stats scroll"><div className="empty">불러오는 중…</div></div>;
    const upd = (i: number, patch: Partial<Team>) => setList(l => l!.map((t, idx) => idx === i ? {...t, ...patch} : t));
    const add = () => setList(l => [...l!, {id: '', name: '', accent: 'var(--accent)', active: true}]);
    const del = (i: number) => setList(l => l!.filter((_, idx) => idx !== i));
    const save = async () => {
        setSaving(true); setMsg('');
        const r = await SaveTeams(list);
        const fresh: any = await GetTeams();
        setSaving(false);
        setList(fresh || list);
        setMsg(r || '저장되었습니다 ✓');
    };

    return (
        <div className="stats scroll">
            <div className="board-head"><h2>팀</h2></div>
            <p className="hint">조직의 팀을 등록합니다. 팀원 화면에서 각 팀원을 이 팀에 배정합니다.</p>
            {list.length === 0 && <div className="empty">등록된 팀이 없습니다 — 아래에서 추가하세요</div>}
            {list.map((t, i) => (
                <section key={i} className="stat-block ent-card" style={{borderLeft: `3px solid ${t.accent || 'var(--accent)'}`}}>
                    <div className="ent-row">
                        <input className="ent-in ent-name" placeholder="팀 이름 (예: 개발팀)" value={t.name} onChange={e => upd(i, {name: e.target.value})}/>
                        <select className="jselect" value={t.accent || 'var(--accent)'} onChange={e => upd(i, {accent: e.target.value})}>
                            {ACCENTS.map(a => <option key={a.val} value={a.val}>{a.label}</option>)}
                        </select>
                        <label className="ent-active"><input type="checkbox" checked={t.active} onChange={e => upd(i, {active: e.target.checked})}/> 활성</label>
                        <button className="map-del" title="삭제" onClick={() => del(i)}>✕</button>
                    </div>
                </section>
            ))}
            <div className="ent-actions">
                <button className="btn btn-sm" onClick={add}>+ 팀 추가</button>
                <span style={{flex: 1}}/>
                {msg && <span className="hint">{msg}</span>}
                <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '팀 저장'}</button>
            </div>
        </div>
    );
}

// ---- 팀원 관리 (팀별 그룹) — 회의록 참석자 선택·git 매핑 소스 ----
function MembersSection({onMapping}: { onMapping: () => void }) {
    const [list, setList] = useState<Member[] | null>(null);
    const [teams, setTeams] = useState<Team[]>([]);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    useEffect(() => {
        GetMembers().then((ms: any) => setList(ms || []));
        GetTeams().then((ts: any) => setTeams(ts || []));
    }, []);

    const csv = (arr: string[]) => (arr || []).join(', ');
    const parse = (s: string) => s.split(/[,]+/).map(x => x.trim()).filter(Boolean);

    if (!list) return <div className="stats scroll"><div className="empty">불러오는 중…</div></div>;
    const upd = (i: number, patch: Partial<Member>) => setList(l => l!.map((m, idx) => idx === i ? {...m, ...patch} : m));
    const add = () => setList(l => [...l!, blankMember(teams[0]?.id || '')]);
    const del = (i: number) => setList(l => l!.filter((_, idx) => idx !== i));
    const save = async () => {
        setSaving(true); setMsg('');
        const r = await SaveMembers(list);
        const fresh: any = await GetMembers();
        setSaving(false);
        setList(fresh || list);
        setMsg(r || '저장되었습니다 ✓');
    };

    // 팀별 그룹(팀 레지스트리 순서, 미지정은 마지막)
    const groups: { id: string; name: string }[] = teams.map(t => ({id: t.id, name: t.name}));
    if (list.some(m => !teams.find(t => t.id === m.team_id))) groups.push({id: '', name: '(미배정)'});

    const row = (m: Member, i: number) => (
        <section key={i} className="stat-block ent-card">
            <div className="ent-row">
                <input className="ent-in ent-name" placeholder="이름" value={m.name} onChange={e => upd(i, {name: e.target.value})}/>
                <select className="jselect" value={m.team_id} onChange={e => upd(i, {team_id: e.target.value})}>
                    <option value="">(팀 미배정)</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input className="ent-in" style={{maxWidth: 120}} placeholder="직책" value={m.role} onChange={e => upd(i, {role: e.target.value})}/>
                <label className="ent-active"><input type="checkbox" checked={m.active} onChange={e => upd(i, {active: e.target.checked})}/> 활성</label>
                <button className="map-del" title="삭제" onClick={() => del(i)}>✕</button>
            </div>
            <div className="ent-grid">
                <label className="ent-field">GitLab 계정<input className="ent-in" placeholder="username" value={m.gitlab_username} onChange={e => upd(i, {gitlab_username: e.target.value})}/></label>
                <label className="ent-field">이메일<input className="ent-in" placeholder="name@company.com" value={m.email} onChange={e => upd(i, {email: e.target.value})}/></label>
                <label className="ent-field">git 별칭 (이름/이메일, 쉼표)<input className="ent-in" placeholder="홍길동, gildong@old.com" value={csv(m.git_aliases)} onChange={e => upd(i, {git_aliases: parse(e.target.value)})}/></label>
            </div>
        </section>
    );

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>팀원</h2>
                <button className="btn btn-sm" onClick={onMapping}>⚙ git 사용자 매핑</button>
            </div>
            <p className="hint">팀원을 등록하면 회의록 참석자 선택과 git 작성자 매핑(별칭 → GitLab 계정)에 쓰입니다. 팀은 위 ‘팀’ 메뉴에서 먼저 등록하세요.</p>
            {teams.length === 0 && <div className="empty">먼저 ‘팀’ 메뉴에서 팀을 등록하면 팀원을 배정할 수 있습니다.</div>}
            {list.length === 0 && teams.length > 0 && <div className="empty">등록된 팀원이 없습니다 — 아래에서 추가하세요</div>}
            {groups.map(g => {
                const inGroup = list.map((m, i) => ({m, i})).filter(({m}) => (m.team_id || '') === g.id);
                if (inGroup.length === 0) return null;
                return (
                    <div key={g.id || '_none'} className="member-team">
                        <h4 className="member-team-h">{g.name} <span className="count">{inGroup.length}</span></h4>
                        {inGroup.map(({m, i}) => row(m, i))}
                    </div>
                );
            })}
            <div className="ent-actions">
                <button className="btn btn-sm" onClick={add} disabled={teams.length === 0}>+ 팀원 추가</button>
                <span style={{flex: 1}}/>
                {msg && <span className="hint">{msg}</span>}
                <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '팀원 저장'}</button>
            </div>
        </div>
    );
}

// ---- 거래처 / 프로젝트 ----
function EntitiesSection() {
    const [list, setList] = useState<Entity[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    useEffect(() => { GetEntities().then((es: any) => setList(es || [])); }, []);

    const csv = (arr: string[]) => (arr || []).join(', ');
    const parse = (s: string) => s.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);

    if (!list) return <div className="stats scroll"><div className="empty">불러오는 중…</div></div>;
    const upd = (i: number, patch: Partial<Entity>) => setList(l => l!.map((e, idx) => idx === i ? {...e, ...patch} : e));
    const add = () => setList(l => [...l!, {id: '', name: '', kind: 'project', gitlab_groups: [], jira_keys: [], confluence_query: '', aliases: [], accent: 'var(--accent)', active: true}]);
    const del = (i: number) => setList(l => l!.filter((_, idx) => idx !== i));
    const save = async () => {
        setSaving(true); setMsg('');
        const out = list.map(e => ({...e, id: (e.id || '').trim() || slug(e.name)}));
        const r = await SaveEntities(out);
        setSaving(false);
        setList(out);
        setMsg(r || '저장되었습니다 ✓');
    };

    return (
        <div className="stats scroll">
            <div className="board-head"><h2>거래처 / 프로젝트</h2></div>
            <p className="hint">엔티티는 GitLab 그룹·Jira 키·Confluence 검색어로 활동을 모읍니다. 여러 개는 쉼표로 입력. 저장하면 사이드바·허브에 반영됩니다.</p>
            {list.map((e, i) => (
                <section key={i} className="stat-block ent-card" style={{borderLeft: `3px solid ${e.accent || 'var(--accent)'}`}}>
                    <div className="ent-row">
                        <input className="ent-in ent-name" placeholder="이름" value={e.name} onChange={ev => upd(i, {name: ev.target.value})}/>
                        <select className="jselect" value={e.kind} onChange={ev => upd(i, {kind: ev.target.value})}>
                            <option value="project">프로젝트</option>
                            <option value="company">거래처</option>
                        </select>
                        <select className="jselect" value={e.accent || 'var(--accent)'} onChange={ev => upd(i, {accent: ev.target.value})}>
                            {ACCENTS.map(a => <option key={a.val} value={a.val}>{a.label}</option>)}
                        </select>
                        <label className="ent-active"><input type="checkbox" checked={e.active} onChange={ev => upd(i, {active: ev.target.checked})}/> 활성</label>
                        <button className="map-del" title="삭제" onClick={() => del(i)}>✕</button>
                    </div>
                    <div className="ent-grid">
                        <label className="ent-field">GitLab 그룹<input className="ent-in" placeholder="akashiq" value={csv(e.gitlab_groups)} onChange={ev => upd(i, {gitlab_groups: parse(ev.target.value)})}/></label>
                        <label className="ent-field">Jira 키<input className="ent-in" placeholder="KSHQ, AK" value={csv(e.jira_keys)} onChange={ev => upd(i, {jira_keys: parse(ev.target.value)})}/></label>
                        <label className="ent-field">Confluence 검색어<input className="ent-in" placeholder="(비우면 이름 사용)" value={e.confluence_query} onChange={ev => upd(i, {confluence_query: ev.target.value})}/></label>
                    </div>
                </section>
            ))}
            <div className="ent-actions">
                <button className="btn btn-sm" onClick={add}>+ 엔티티 추가</button>
                <span style={{flex: 1}}/>
                {msg && <span className="hint">{msg}</span>}
                <button className="refresh-btn" onClick={save} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
            </div>
        </div>
    );
}

type SettingsSection = 'ai' | 'teams' | 'members' | 'entities';

function SettingsView() {
    const [sec, setSec] = useState<SettingsSection>('ai');
    const [mapping, setMapping] = useState(false);
    const subs: { id: SettingsSection; label: string }[] = [
        {id: 'ai', label: 'AI 설정'},
        {id: 'teams', label: '팀'},
        {id: 'members', label: '팀원'},
        {id: 'entities', label: '거래처/프로젝트'},
    ];
    return (
        <div className="settings-wrap">
            <div className="settings-subnav">
                {subs.map(s => (
                    <button key={s.id} className={`subnav-item ${sec === s.id ? 'subnav-on' : ''}`} onClick={() => setSec(s.id)}>{s.label}</button>
                ))}
            </div>
            <div className="settings-body">
                {sec === 'ai' && <div className="stats scroll"><AISettings/></div>}
                {sec === 'teams' && <TeamsSection/>}
                {sec === 'members' && <MembersSection onMapping={() => setMapping(true)}/>}
                {sec === 'entities' && <EntitiesSection/>}
            </div>
            {mapping && <AuthorMappingModal onClose={() => setMapping(false)} onSaved={() => {}}/>}
        </div>
    );
}

// ---- 홈 대시보드 (부하 최소: 스냅샷 + 로컬 노트를 클라이언트에서 집계) ----
function DashboardView({snap, onEntity, onTab}: { snap: Snapshot; onEntity: (id: string) => void; onTab: (t: Tab) => void }) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [selJira, setSelJira] = useState<string | null>(null);
    const [editNote, setEditNote] = useState<Note | null>(null);
    useEffect(() => { ListNotes('').then((ns: any) => setNotes(ns || [])); }, []);

    const ents = snap.entities.filter(e => e.active);
    const today = new Date().toISOString().slice(0, 10);
    const entKeys = new Set<string>();
    ents.forEach(e => (e.jira_keys || []).forEach(k => entKeys.add(k)));
    const jira = snap.jira_issues.filter(i => entKeys.has(i.project_key));
    const inprog = jira.filter(i => i.status_category === 'indeterminate').length;
    const overdue = jira.filter(i => i.status_category !== 'done' && i.due_date && i.due_date < today)
        .sort((a, b) => a.due_date.localeCompare(b.due_date));
    const recentNotes = [...notes]
        .sort((a, b) => (b.occurred_at || b.updated_at).localeCompare(a.occurred_at || a.updated_at))
        .slice(0, 8);

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>대시보드</h2>
                <span className="poc-sub">{snap.gitlab_url.replace(/^https?:\/\//, '')} · 한눈에 보기</span>
            </div>
            <div className="cards">
                <div className="card dash-card" onClick={() => onTab('jira')}><div className="card-v">{comma(inprog)}</div><div className="card-l">진행 중 이슈</div></div>
                <div className="card dash-card" onClick={() => onTab('feed')}><div className="card-v">{comma(snap.open_mrs.length)}</div><div className="card-l">열린 MR</div></div>
                <div className="card"><div className="card-v" style={{WebkitTextFillColor: overdue.length > 0 ? 'var(--red)' : undefined}}>{comma(overdue.length)}</div><div className="card-l">기한 초과</div></div>
                <div className="card dash-card" onClick={() => onTab('records')}><div className="card-v">{comma(notes.length)}</div><div className="card-l">기록</div></div>
            </div>

            <section className="stat-block">
                <h3>엔티티 진행도</h3>
                {ents.length === 0 && <div className="empty">설정에서 거래처/프로젝트를 추가하세요</div>}
                <div className="dash-ents">
                    {ents.map(e => {
                        const pr = jiraProgress(snap.jira_issues, e);
                        const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
                        const w = (n: number) => pr.total ? `${(n / pr.total) * 100}%` : '0%';
                        const acc = e.accent || 'var(--accent)';
                        return (
                            <div key={e.id} className="dash-ent" onClick={() => onEntity(e.id)} style={{borderLeft: `3px solid ${acc}`}}>
                                <div className="dash-ent-top"><span className="poc-dot" style={{background: acc}}/><b>{e.name}</b><span className="dash-pct" style={{color: acc}}>{pct}%</span></div>
                                <div className="poc-funnel">
                                    <div className="poc-seg seg-done" style={{width: w(pr.done)}}/>
                                    <div className="poc-seg seg-prog" style={{width: w(pr.inprog)}}/>
                                    <div className="poc-seg seg-todo" style={{width: w(pr.todo)}}/>
                                </div>
                                <div className="dash-ent-counts"><b className="c-done">{pr.done}</b> 완료 · <b className="c-prog">{pr.inprog}</b> 진행 · <b className="c-todo">{pr.todo}</b> 대기</div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <div className="stat-cols">
                <section className="stat-block">
                    <h3>기한 초과 / 임박 <span className="count">{overdue.length}</span></h3>
                    {overdue.length === 0 && <div className="empty">없음 👍</div>}
                    {overdue.slice(0, 10).map(i => (
                        <div key={i.key} className="pipe" onClick={() => setSelJira(i.key)}>
                            <span className="jira-key">{i.key}</span>
                            <span className="pipe-proj">{i.summary}</span>
                            <span className="jira-due">~{i.due_date}</span>
                        </div>
                    ))}
                    {overdue.length > 10 && <div className="poc-more">+{overdue.length - 10}건 더</div>}
                </section>
                <section className="stat-block">
                    <h3>최근 기록 <span className="count">{notes.length}</span><a className="dash-more" onClick={() => onTab('records')}>전체 보기</a></h3>
                    {recentNotes.length === 0 && <div className="empty">기록 없음 — 기록 탭에서 추가</div>}
                    {recentNotes.map(n => (
                        <div key={n.id} className="pipe" onClick={() => setEditNote(n)}>
                            <span className={`note-kind note-${n.kind}`}>{n.kind === 'call' ? '통화' : '회의'}</span>
                            <span className="pipe-proj">{n.title || '(제목 없음)'}</span>
                            <span className="time">{(n.occurred_at || '').slice(0, 10)}</span>
                        </div>
                    ))}
                </section>
            </div>

            {selJira && <IssueModal issueKey={selJira} issues={snap.jira_issues} onClose={() => setSelJira(null)} onSelect={setSelJira}/>}
            {editNote && <NoteEditor note={editNote} entities={snap.entities} onClose={() => setEditNote(null)} onReload={() => ListNotes('').then((ns: any) => setNotes(ns || []))}/>}
        </div>
    );
}

// ---- 통합 검색 (부하 최소: 폴링으로 받은 스냅샷 + 로컬 노트를 클라이언트에서 필터) ----
function SearchView({snap, onEntity}: { snap: Snapshot; onEntity: (id: string) => void }) {
    const [query, setQuery] = useState('');
    const [notes, setNotes] = useState<Note[]>([]);
    const [selJira, setSelJira] = useState<string | null>(null);
    const [editNote, setEditNote] = useState<Note | null>(null);
    useEffect(() => { ListNotes('').then((ns: any) => setNotes(ns || [])); }, []);

    const q = query.trim().toLowerCase();
    const entName = (id: string) => snap.entities.find(e => e.id === id)?.name || id;

    const res = useMemo(() => {
        if (q.length < 1) return null;
        const has = (...xs: (string | undefined)[]) => xs.some(x => (x || '').toLowerCase().includes(q));
        const CAP = 12;
        const cut = (arr: any[]) => ({ items: arr.slice(0, CAP), total: arr.length });
        return {
            notes: cut(notes.filter(n => has(n.title, n.summary, n.participants, ...(n.entity_ids || []).map(entName)))),
            jira: cut(snap.jira_issues.filter(i => has(i.key, i.summary, i.assignee, i.project_name))),
            conf: cut(snap.confluence_pages.filter(p => has(p.title, p.space_name, p.author))),
            mrs: cut([...snap.open_mrs, ...snap.merged_mrs].filter(m => has(m.title, m.project_path, m.author?.username))),
            projs: cut(snap.projects.filter(p => has(p.path_with_namespace, p.name))),
            ents: cut(snap.entities.filter(e => has(e.name, ...(e.aliases || [])))),
        };
    }, [q, notes, snap]);

    const total = res ? res.notes.total + res.jira.total + res.conf.total + res.mrs.total + res.projs.total + res.ents.total : 0;

    const section = (label: string, kind: string, count: number, children: any) => count === 0 ? null : (
        <section className="stat-block">
            <h3><span className={`src-dot src-${kind}`}/>{label} <span className="count">{count}</span></h3>
            {children}
        </section>
    );
    const more = (g: { items: any[]; total: number }) => g.total > g.items.length && <div className="poc-more">+{g.total - g.items.length}개 더</div>;

    return (
        <div className="stats scroll">
            <div className="board-head">
                <h2>통합 검색</h2>
                <input className="search" autoFocus placeholder="기록·Jira·Confluence·GitLab·거래처/프로젝트 전체 검색" value={query} onChange={e => setQuery(e.target.value)} style={{minWidth: 280}}/>
                {res && <span className="poc-sub">{total}건</span>}
            </div>

            {!res && <section className="stat-block"><div className="empty">검색어를 입력하세요 — 폴링으로 받아둔 데이터에서 즉시 찾습니다(추가 조회 없음)</div></section>}
            {res && total === 0 && <section className="stat-block"><div className="empty">'{query}' 결과 없음</div></section>}

            {res && section('거래처 / 프로젝트', 'ent', res.ents.total, res.ents.items.map((e: Entity) => (
                <div key={e.id} className="pipe" onClick={() => onEntity(e.id)}>
                    <span className="src-dot" style={{background: e.accent || 'var(--accent)'}}/>
                    <span className="pipe-proj">{e.name}</span>
                    <span className="jira-assignee">{e.kind === 'company' ? '거래처' : '프로젝트'}</span>
                </div>
            )))}
            {res && section('기록', 'note', res.notes.total, <>
                {res.notes.items.map((n: Note) => (
                    <div key={n.id} className="pipe" onClick={() => setEditNote(n)}>
                        <span className={`note-kind note-${n.kind}`}>{n.kind === 'call' ? '통화' : '회의'}</span>
                        <span className="pipe-proj">{n.title || '(제목 없음)'}</span>
                        <span className="time">{(n.occurred_at || '').slice(0, 10)}</span>
                    </div>
                ))}
                {more(res.notes)}
            </>)}
            {res && section('Jira', 'jira', res.jira.total, <>
                {res.jira.items.map((i: JiraIssue) => (
                    <div key={i.key} className="pipe" onClick={() => setSelJira(i.key)}>
                        <span className={`jira-status jira-${i.status_category}`}>{i.status}</span>
                        <span className="jira-key">{i.key}</span>
                        <span className="pipe-proj">{i.summary}</span>
                        <span className="jira-assignee">{i.assignee || '미지정'}</span>
                    </div>
                ))}
                {more(res.jira)}
            </>)}
            {res && section('Confluence', 'conf', res.conf.total, <>
                {res.conf.items.map((p: ConfluencePage) => (
                    <div key={p.id} className="pipe" onClick={() => OpenURL(p.url)}>
                        <span className="poc-cfspace">{p.space_key}</span>
                        <span className="pipe-proj">{p.title}</span>
                        <span className="time">{timeAgo(p.updated)}</span>
                    </div>
                ))}
                {more(res.conf)}
            </>)}
            {res && section('MR', 'gl', res.mrs.total, <>
                {res.mrs.items.map((m: MR) => (
                    <div key={m.id} className="pipe" onClick={() => OpenURL(m.web_url)}>
                        <span className="jira-key">!{m.iid}</span>
                        <span className="pipe-proj">{m.title}</span>
                        <span className="jira-assignee">{m.project_path}</span>
                    </div>
                ))}
                {more(res.mrs)}
            </>)}
            {res && section('레포', 'gl', res.projs.total, <>
                {res.projs.items.map((p: Project) => (
                    <div key={p.id} className="pipe" onClick={() => OpenURL(p.web_url)}>
                        <span className="repo-name"><Icon name="repo" size={13} className="repo-ico"/>{p.path_with_namespace}</span>
                        <span className="time">{timeAgo(p.last_activity_at)}</span>
                    </div>
                ))}
                {more(res.projs)}
            </>)}

            {selJira && <IssueModal issueKey={selJira} issues={snap.jira_issues} onClose={() => setSelJira(null)} onSelect={setSelJira}/>}
            {editNote && <NoteEditor note={editNote} entities={snap.entities} onClose={() => setEditNote(null)} onReload={() => ListNotes('').then((ns: any) => setNotes(ns || []))}/>}
        </div>
    );
}

// ---- Main app ----
const FEED_LIMIT = 300;

function App() {
    const [snap, setSnap] = useState<Snapshot | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [tab, setTab] = useState<Tab>('home');
    const [hubFocus, setHubFocus] = useState<'all' | string>('all'); // 엔티티 허브 포커스
    const [period, setPeriod] = useState<Period>(30);
    const [filter, setFilter] = useState('');
    const [kinds, setKinds] = useState<Set<Kind>>(new Set());
    const [showBots, setShowBots] = useState(false); // 토큰봇 활동 표시 (기본 숨김)
    const [, setTick] = useState(0);
    // 갱신으로 새로 들어온 이벤트 ID (등장 애니메이션 대상)
    const prevEventIds = useRef<Set<number> | null>(null);
    const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

    // Go nil-slice → JSON null 방어 + 초기 zero-value 스냅샷 무시
    const normalize = (s: any): Snapshot => ({
        ...s,
        events: s.events ?? [],
        projects: s.projects ?? [],
        open_mrs: s.open_mrs ?? [],
        merged_mrs: s.merged_mrs ?? [],
        pipelines: s.pipelines ?? [],
        code_daily: s.code_daily ?? [],
        jira_issues: s.jira_issues ?? [],
        confluence_pages: s.confluence_pages ?? [],
        entities: s.entities ?? [],
    });
    const isReady = (s: any) =>
        s && s.fetched_at && !String(s.fetched_at).startsWith('0001');

    useEffect(() => {
        GetSnapshot().then(s => { if (isReady(s)) setSnap(normalize(s)); }).catch(() => {});
        const off = EventsOn('snapshot', (s: any) => {
            if (isReady(s)) setSnap(normalize(s));
            setProgress(null); // 수집 완료
        });
        const offT = EventsOn('tick', (ts: string) => {
            // 데이터 변경 없음: 갱신 시각만 업데이트
            setSnap(prev => prev ? {...prev, fetched_at: ts} : prev);
            setProgress(null);
        });
        const offP = EventsOn('progress', (p: Progress) => {
            setProgress(p.total > 0 && p.done < p.total ? p : null);
        });
        const t = setInterval(() => setTick(n => n + 1), 30_000); // re-render for relative times
        return () => { off(); offT(); offP(); clearInterval(t); };
    }, []);

    useEffect(() => {
        if (!snap) return;
        const prev = prevEventIds.current;
        const cur = new Set(snap.events.map(e => e.id));
        prevEventIds.current = cur;
        if (!prev) return; // 첫 스냅샷은 기준선만 (등장 애니메이션 없음)
        const fresh = new Set(snap.events.filter(e => !prev.has(e.id)).map(e => e.id));
        if (fresh.size === 0) return;
        setFreshIds(fresh);
        const clear = setTimeout(() => setFreshIds(new Set()), 3500);
        return () => clearTimeout(clear);
    }, [snap?.events]);

    // 새 이벤트 스태거 딜레이 (피드 표시 순서 기준, 최대 8단계)
    const freshDelay = useMemo(() => {
        const m = new Map<number, string>();
        if (!snap || freshIds.size === 0) return m;
        let i = 0;
        for (const e of snap.events) {
            if (freshIds.has(e.id)) m.set(e.id, `${Math.min(i++, 8) * 70}ms`);
        }
        return m;
    }, [snap, freshIds]);

    const events = useMemo(() => {
        if (!snap) return [];
        const q = filter.trim().toLowerCase();
        const cut = periodCutoff(period);
        return snap.events.filter(e => {
            if (new Date(e.created_at).getTime() < cut) return false;
            if (!showBots && e.author?.is_bot) return false;
            if (kinds.size > 0 && !kinds.has(eventKind(e))) return false;
            if (!q) return true;
            return (e.author?.username || '').toLowerCase().includes(q)
                || (e.author?.name || '').toLowerCase().includes(q)
                || (e.project_path || '').toLowerCase().includes(q)
                || (e.target_title || '').toLowerCase().includes(q)
                || (e.push_data?.ref || '').toLowerCase().includes(q);
        }).slice(0, FEED_LIMIT);
    }, [snap, filter, kinds, period, showBots]);

    // 통계/CI 화면에서 사용자·레포 클릭 → 피드 탭으로 이동해 필터 적용
    const drill = (q: string) => {
        setFilter(q);
        setKinds(new Set());
        setTab('feed');
    };

    const toggleKind = (k: Kind) => setKinds(prev => {
        const next = new Set(prev);
        next.has(k) ? next.delete(k) : next.add(k);
        return next;
    });

    if (!snap) {
        return (
            <div className="loading">
                <div className="loading-box">
                    <div>GitLab 데이터 불러오는 중…</div>
                    {progress && <>
                        <div className="pbar"><div className="pbar-fill" style={{width: `${(progress.done / progress.total) * 100}%`}}/></div>
                        <div className="pbar-text">{progress.phase} 수집 {progress.done} / {progress.total}</div>
                    </>}
                </div>
            </div>
        );
    }
    if (snap.needs_config) return <SetupView onSaved={() => setSnap(null)}/>;

    return (
        <div className="app">
            <nav className="sidebar">
                <div className="sidebar-brand">
                    <span className={`dot ${snap.error ? 'dot-red' : 'dot-green'}`} title={snap.error || '정상'}/>
                    <h1>Quantum Hub</h1>
                </div>
                <div className="nav-scroll">
                    <div className="nav-group">
                        <button className={`nav-item ${tab === 'home' ? 'nav-on' : ''}`} onClick={() => setTab('home')}>
                            <Icon name="home" size={15}/> <span>대시보드</span>
                        </button>
                        <button className={`nav-item ${tab === 'search' ? 'nav-on' : ''}`} onClick={() => setTab('search')}>
                            <Icon name="search" size={15}/> <span>통합 검색</span>
                        </button>
                    </div>
                    {NAV_GROUPS.map(g => (
                        <div key={g.label} className="nav-group">
                            <div className="nav-group-label">{g.label}</div>
                            {g.items.map(it => (
                                <button key={it.tab}
                                        className={`nav-item ${tab === it.tab ? 'nav-on' : ''}`}
                                        onClick={() => setTab(it.tab)}>
                                    <Icon name={it.icon} size={15}/> <span>{it.label}</span>
                                </button>
                            ))}
                        </div>
                    ))}
                    <div className="nav-group">
                        <div className="nav-group-label">현황</div>
                        <button className={`nav-item ${tab === 'poc' && hubFocus === 'all' ? 'nav-on' : ''}`}
                                onClick={() => { setHubFocus('all'); setTab('poc'); }}>
                            <Icon name="box" size={15}/> <span>전체 현황</span>
                        </button>
                    </div>
                    {(['project', 'company'] as const).map(kind => {
                        const list = (snap.entities || []).filter(e => e.active && (kind === 'company' ? e.kind === 'company' : e.kind !== 'company'));
                        if (list.length === 0) return null;
                        return (
                            <div key={kind} className="nav-group">
                                <div className="nav-group-label">{kind === 'company' ? '거래처' : '프로젝트'}</div>
                                {list.map(e => (
                                    <button key={e.id}
                                            className={`nav-item ${tab === 'poc' && hubFocus === e.id ? 'nav-on' : ''}`}
                                            onClick={() => { setHubFocus(e.id); setTab('poc'); }}>
                                        <span className="nav-dot" style={{background: e.accent || 'var(--accent)'}}/> <span>{e.name}</span>
                                    </button>
                                ))}
                            </div>
                        );
                    })}
                    <div className="nav-group">
                        <div className="nav-group-label">설정</div>
                        <button className={`nav-item ${tab === 'settings' ? 'nav-on' : ''}`} onClick={() => setTab('settings')}>
                            <Icon name="gear" size={15}/> <span>설정</span>
                        </button>
                    </div>
                </div>
                <div className="sidebar-foot">
                    <a className="instance" onClick={() => OpenURL(snap.gitlab_url)}>
                        {snap.gitlab_url.replace(/^https?:\/\//, '')}
                    </a>
                    {snap.version && <span className="version">v{snap.version.version}</span>}
                </div>
            </nav>

            <div className="main-area">
                <header className="topbar">
                    <nav className="tabs">
                        {PERIODS.map(p => (
                            <button key={p} className={period === p ? 'tab tab-on' : 'tab'} onClick={() => setPeriod(p)}>{p}일</button>
                        ))}
                    </nav>
                    <div className="chips">
                        {snap.stats && <>
                            <StatChip label="프로젝트" value={snap.stats.projects}/>
                            <StatChip label="그룹" value={snap.stats.groups}/>
                            <StatChip label="사용자(활성)" value={`${snap.stats.users} (${snap.stats.active_users})`}/>
                            <StatChip label="열린 MR" value={String(snap.open_mrs.length)}/>
                        </>}
                        <button className="refresh-btn" onClick={() => Refresh()}>↻ 새로고침</button>
                        {progress
                            ? <span className="fetched">{progress.phase} 수집 {progress.done}/{progress.total}</span>
                            : <LastUpdated ts={snap.fetched_at}/>}
                    </div>
                </header>

                {snap.error && <div className="error-banner">⚠ {snap.error}</div>}
                {snap.warning && <div className="warn-banner">⚠ {snap.warning}</div>}

                {tab === 'home' ? <DashboardView snap={snap} onEntity={(id) => { setHubFocus(id); setTab('poc'); }} onTab={setTab}/> : tab === 'stats' ? <StatsView snap={snap} period={period} onDrill={drill}/> : tab === 'ci' ? <CIView snap={snap} period={period} onDrill={drill}/> : tab === 'jira' ? <JiraView snap={snap} period={period}/> : tab === 'weekly' ? <WeeklyView onDrill={drill}/> : tab === 'poc' ? <HubView snap={snap} period={period} focus={hubFocus}/> : tab === 'records' ? <RecordsView snap={snap}/> : tab === 'search' ? <SearchView snap={snap} onEntity={(id) => { setHubFocus(id); setTab('poc'); }}/> : tab === 'settings' ? <SettingsView/> : (
            <main className="grid">
                <section className="panel feed">
                    <div className="panel-head">
                        <h2>활동 피드 <span className="count">{events.length}{events.length === FEED_LIMIT ? '+' : ''} / {period}일</span></h2>
                        <div className="filters">
                            {KINDS.map(k => (
                                <button key={k}
                                        className={`pill ${kinds.has(k) ? 'pill-on' : ''} pill-${k}`}
                                        onClick={() => toggleKind(k)}>
                                    <Icon name={k} size={12}/> {KIND_META[k].label}
                                </button>
                            ))}
                            <button className={`pill pill-bot ${showBots ? 'pill-on' : ''}`}
                                    title="CI/토큰봇 활동 표시"
                                    onClick={() => setShowBots(v => !v)}>
                                <Icon name="bot" size={12}/> 봇
                            </button>
                            <input className="search" placeholder="사용자 / 레포 / 브랜치 검색"
                                   value={filter} onChange={e => setFilter(e.target.value)}/>
                        </div>
                    </div>
                    <div className="scroll">
                        {events.map(e => {
                            const k = eventKind(e);
                            const isNew = freshIds.has(e.id);
                            return (
                                <div key={e.id}
                                     className={`event event-${k}${isNew ? ' event-new' : ''}`}
                                     style={isNew ? {animationDelay: freshDelay.get(e.id)} : undefined}>
                                    <span className={`badge badge-${k}`}><Icon name={k} size={15}/></span>
                                    <div className="event-body">
                                        <div className="event-top">
                                            <b><AuthorName a={e.author}/></b>
                                            <a className="proj" onClick={() => e.project_url && OpenURL(e.project_url)}>
                                                {e.project_path || `project #${e.project_id}`}
                                            </a>
                                            <span className="time">{timeAgo(e.created_at)}</span>
                                        </div>
                                        <div className="event-desc">{describeEvent(e)}</div>
                                    </div>
                                </div>
                            );
                        })}
                        {events.length === 0 && <div className="empty">표시할 이벤트가 없습니다</div>}
                    </div>
                </section>

                <aside className="side">
                    <section className="panel">
                        <div className="panel-head"><h2>열린 MR <span className="count">{snap.open_mrs.length}</span></h2></div>
                        <div className="scroll">
                            {snap.open_mrs.map(mr => (
                                <div key={mr.id} className="mr" onClick={() => OpenURL(mr.web_url)}>
                                    <span className="mr-icon"><Icon name="mr" size={15}/></span>
                                    <div className="mr-body">
                                        <div className="mr-title">{mr.draft && <span className="draft">Draft</span>}!{mr.iid} {mr.title}</div>
                                        <div className="mr-meta">
                                            <span>{mr.project_path}</span>
                                            <span>{mr.author?.username} · {timeAgo(mr.updated_at)}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {snap.open_mrs.length === 0 && <div className="empty">열린 MR 없음</div>}
                        </div>
                    </section>
                    <section className="panel">
                        <div className="panel-head"><h2>최근 활동 레포</h2></div>
                        <div className="scroll">
                            {snap.projects.slice(0, 30).map(p => (
                                <div key={p.id} className="repo" onClick={() => OpenURL(p.web_url)}>
                                    <span className="repo-name"><Icon name="repo" size={14} className="repo-ico"/>{p.path_with_namespace}</span>
                                    <span className="time">{timeAgo(p.last_activity_at)}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </aside>
            </main>
            )}
            </div>
        </div>
    );
}

export default App
