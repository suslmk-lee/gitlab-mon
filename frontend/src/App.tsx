import {useEffect, useMemo, useState} from 'react';
import './App.css';
import {GetSnapshot, Refresh, SaveConfig, OpenURL, SaveCSV, JiraMove} from "../wailsjs/go/main/App";
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
interface Snapshot {
    fetched_at: string; gitlab_url: string;
    version: { version: string } | null; stats: Stats | null;
    events: GLEvent[]; projects: Project[]; open_mrs: MR[]; merged_mrs: MR[];
    pipelines: Pipeline[]; code_daily: CodeDay[];
    jira_issues: JiraIssue[]; jira_url: string;
    error: string; warning: string; needs_config: boolean;
}

interface Progress { phase: string; done: number; total: number }

type Period = 7 | 30 | 90;
const PERIODS: Period[] = [7, 30, 90];
const periodCutoff = (p: Period) => Date.now() - p * 86_400_000;

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
    if (a === 'accepted') return 'merge';
    if (e.target_type === 'MergeRequest') return 'mr';
    if (a.startsWith('commented')) return 'comment';
    return 'other';
}

const KIND_META: Record<Kind, { label: string; icon: string; color: string }> = {
    push:    {label: 'Push',  icon: '⬆', color: 'var(--green)'},
    merge:   {label: 'Merge', icon: '⛙', color: 'var(--purple)'},
    mr:      {label: 'MR',    icon: '⎇', color: 'var(--accent)'},
    comment: {label: '댓글',   icon: '💬', color: 'var(--orange)'},
    other:   {label: '기타',   icon: '•', color: 'var(--muted)'},
};
const KINDS = Object.keys(KIND_META) as Kind[];

function describeEvent(e: GLEvent): string {
    const k = eventKind(e);
    if (k === 'push' && e.push_data) {
        const n = e.push_data.commit_count;
        if (e.push_data.action === 'created') return `브랜치 생성 ${e.push_data.ref}`;
        if (e.push_data.action === 'removed') return `브랜치 삭제 ${e.push_data.ref}`;
        return `${e.push_data.ref} 에 ${n}개 커밋 push${e.push_data.commit_title ? ` — ${e.push_data.commit_title}` : ''}`;
    }
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
    return (a.is_bot ? '🤖 ' : '') + (a.name || a.username);
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
    return <div className="chip"><span className="chip-value">{value}</span><span className="chip-label">{label}</span></div>;
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
    return <span className="fetched" title="30초 주기로 자동 갱신됩니다">{txt} 갱신 · 30s 주기</span>;
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

function JiraBoard({issues, projectKey, onBack}: { issues: JiraIssue[]; projectKey: string; onBack: () => void }) {
    const [moving, setMoving] = useState<string | null>(null);
    const [err, setErr] = useState('');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const projIssues = useMemo(() => issues.filter(i => i.project_key === projectKey), [issues, projectKey]);
    const projectName = projIssues[0]?.project_name || projectKey;

    // 컬럼 = 이 프로젝트 이슈들이 가진 상태 (카테고리 순 정렬)
    const columns = useMemo(() => {
        const seen = new Map<string, string>(); // status → category
        for (const i of projIssues) seen.set(i.status, i.status_category);
        return [...seen.entries()].sort((a, b) =>
            (CAT_ORDER[a[1]] ?? 9) - (CAT_ORDER[b[1]] ?? 9) || a[0].localeCompare(b[0]));
    }, [projIssues]);

    // 하위 이슈를 가진 모든 부모 키 (전체 접기/펼치기용)
    const parentKeys = useMemo(() => {
        const withKids = new Set(projIssues.map(i => i.parent_key).filter(Boolean));
        return [...withKids];
    }, [projIssues]);
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

    return (
        <div className="stats scroll">
            <div className="board-head">
                <button className="btn btn-sm" onClick={onBack}>← 전체 현황</button>
                <h2>{projectKey} <span className="hint">{projectName} · 카드를 드래그하면 상태가 변경됩니다</span></h2>
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
                    const inCol = projIssues.filter(i => i.status === status)
                        .sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
                    const tops = inCol.filter(i => !i.parent_key);
                    const subsAll = inCol.filter(i => i.parent_key);
                    const topKeys = new Set(tops.map(t => t.key));

                    // 행 구성: 부모 + (펼침 상태면) 자식들, 그 뒤에 부모가 다른 컬럼인 하위 이슈
                    type Row = { i: JiraIssue; kids: number; hidden: number };
                    const rows: Row[] = [];
                    for (const t of tops) {
                        const kids = subsAll.filter(sb => sb.parent_key === t.key);
                        const isCollapsed = collapsed.has(t.key);
                        rows.push({i: t, kids: kids.length, hidden: isCollapsed ? kids.length : 0});
                        if (!isCollapsed) kids.forEach(k => rows.push({i: k, kids: 0, hidden: 0}));
                    }
                    const orphans = subsAll.filter(sb => !topKeys.has(sb.parent_key))
                        .sort((a, b) => a.parent_key.localeCompare(b.parent_key));
                    // 부모가 다른 컬럼에 있어도 접혀 있으면 자식 숨김
                    for (const o of orphans) {
                        if (!collapsed.has(o.parent_key)) rows.push({i: o, kids: 0, hidden: 0});
                    }

                    const total = inCol.length;
                    const shown = cat === 'done' ? rows.slice(0, 15) : rows;
                    const today = new Date().toISOString().slice(0, 10);
                    return (
                        <div key={status} className={`col col-${cat}`}
                             onDragOver={e => e.preventDefault()}
                             onDrop={e => drop(e, status)}>
                            <div className="col-head">
                                <span className={`jira-status jira-${cat}`}>{status}</span>
                                <span className="count">{total}</span>
                            </div>
                            <div className="col-cards">
                                {shown.map(({i, kids, hidden}) => {
                                    const late = i.status_category !== 'done' && i.due_date && i.due_date < today;
                                    const parentVisible = i.parent_key && topKeys.has(i.parent_key);
                                    return (
                                        <div key={i.key}
                                             className={`jcard ${i.parent_key ? 'jcard-sub' : ''} ${moving === i.key ? 'jcard-moving' : ''}`}
                                             draggable
                                             onDragStart={e => e.dataTransfer.setData('text/plain', i.key)}
                                             onDoubleClick={() => OpenURL(i.url)}
                                             title={`${i.parent_key ? `상위: ${i.parent_key} ${i.parent_summary}\n` : ''}더블클릭: Jira에서 열기 / 드래그: 상태 변경`}>
                                            <div className="jcard-top">
                                                {kids > 0 && (
                                                    <button className="jfold"
                                                            onClick={e => { e.stopPropagation(); toggle(i.key); }}
                                                            title={collapsed.has(i.key) ? '하위 이슈 펼치기' : '하위 이슈 접기'}>
                                                        {collapsed.has(i.key) ? '▸' : '▾'}
                                                    </button>
                                                )}
                                                <span className="jira-key">{i.key}</span>
                                                {hidden > 0 && <span className="jkids">하위 {hidden}</span>}
                                                {i.parent_key && !parentVisible &&
                                                    <span className="jparent" title={i.parent_summary}>↳ {i.parent_key}</span>}
                                                {i.priority && <span className={`jprio jprio-${i.priority.toLowerCase()}`}>{i.priority}</span>}
                                            </div>
                                            <div className="jcard-summary">{i.summary}</div>
                                            <div className="jcard-meta">
                                                <span>{i.assignee || '미지정'}</span>
                                                {i.due_date && <span className={late ? 'jira-due' : ''}>~{i.due_date}</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                                {cat === 'done' && rows.length > 15 &&
                                    <div className="empty" style={{padding: '8px'}}>+{rows.length - 15}건 더 (최근 15건만 표시)</div>}
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
    const issues = snap.jira_issues;
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

    if (board) return <JiraBoard issues={issues} projectKey={board} onBack={() => setBoard(null)}/>;

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
                <div className="card"><div className="card-v">{open.length}</div><div className="card-l">열린 이슈</div></div>
                <div className="card"><div className="card-v">{inProgress.length}</div><div className="card-l">진행 중</div></div>
                <div className="card"><div className="card-v">{createdInPeriod.length}</div><div className="card-l">생성 ({period}일)</div></div>
                <div className="card"><div className="card-v">{doneInPeriod.length}</div><div className="card-l">완료 ({period}일)</div></div>
                <div className="card">
                    <div className="card-v" style={{WebkitTextFillColor: overdue.length > 0 ? 'var(--red)' : undefined}}>{overdue.length}</div>
                    <div className="card-l">기한 초과</div>
                </div>
            </div>

            {overdue.length > 0 && (
                <section className="stat-block">
                    <h3>기한 초과 <span className="count">{overdue.length}</span></h3>
                    {overdue.map(i => (
                        <div key={i.key} className="pipe" onClick={() => OpenURL(i.url)}>
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
                    <div key={i.key} className="pipe" onClick={() => OpenURL(i.url)}>
                        <span className={`jira-status jira-${i.status_category}`}>{i.status}</span>
                        <span className="jira-key">{i.key}</span>
                        <span className="pipe-proj">{i.summary}</span>
                        <span className="jira-assignee">{i.assignee || '미지정'}</span>
                        <span className="time">{timeAgo(i.updated)}</span>
                    </div>
                ))}
            </section>
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
                <div className="card"><div className="card-v">{pipes.length}</div><div className="card-l">파이프라인 ({period}일)</div></div>
                <div className="card"><div className="card-v" style={{WebkitTextFillColor: rate !== null && rate < 70 ? 'var(--red)' : undefined}}>{rate !== null ? `${rate}%` : '—'}</div><div className="card-l">성공률</div></div>
                <div className="card"><div className="card-v">{failed.length}</div><div className="card-l">실패</div></div>
                <div className="card"><div className="card-v">{running.length}</div><div className="card-l">실행/대기 중</div></div>
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
    const fmtN = (n: number) => n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);

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
                <div className="card"><div className="card-v">{mrOpened}</div><div className="card-l">MR 생성 ({period}일)</div></div>
                <div className="card"><div className="card-v">{mergedMRs.length}</div><div className="card-l">머지 완료 ({period}일)</div></div>
                <div className="card"><div className="card-v">{leadTimes.length ? fmtDur(avgLead) : '—'}</div><div className="card-l">평균 머지 리드타임</div></div>
                <div className="card"><div className="card-v">{snap.open_mrs.length}</div><div className="card-l">열린 MR</div></div>
                <div className="card"><div className="card-v">{openAges.length ? fmtDur(avgOpenAge) : '—'}</div><div className="card-l">열린 MR 평균 나이</div></div>
                <div className="card"><div className="card-v">{events.length}</div><div className="card-l">전체 이벤트 ({period}일)</div></div>
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
                        <span className="lb-name drill" title={`${u.username} — 클릭하면 피드에서 필터`} onClick={() => onDrill(u.username)}>{u.name}</span>
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
                            <span className="heat-name drill" title={`${u.username} — 클릭하면 피드에서 필터`} onClick={() => onDrill(u.username)}>{u.name}</span>
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

// ---- Main app ----
const FEED_LIMIT = 300;

function App() {
    const [snap, setSnap] = useState<Snapshot | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [tab, setTab] = useState<'feed' | 'stats' | 'ci' | 'jira'>('feed');
    const [period, setPeriod] = useState<Period>(30);
    const [filter, setFilter] = useState('');
    const [kinds, setKinds] = useState<Set<Kind>>(new Set());
    const [, setTick] = useState(0);

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

    const events = useMemo(() => {
        if (!snap) return [];
        const q = filter.trim().toLowerCase();
        const cut = periodCutoff(period);
        return snap.events.filter(e => {
            if (new Date(e.created_at).getTime() < cut) return false;
            if (kinds.size > 0 && !kinds.has(eventKind(e))) return false;
            if (!q) return true;
            return (e.author?.username || '').toLowerCase().includes(q)
                || (e.author?.name || '').toLowerCase().includes(q)
                || (e.project_path || '').toLowerCase().includes(q)
                || (e.target_title || '').toLowerCase().includes(q)
                || (e.push_data?.ref || '').toLowerCase().includes(q);
        }).slice(0, FEED_LIMIT);
    }, [snap, filter, kinds, period]);

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
            <header className="topbar">
                <div className="brand">
                    <span className={`dot ${snap.error ? 'dot-red' : 'dot-green'}`} title={snap.error || '정상'}/>
                    <h1>GitLab Monitor</h1>
                    <a className="instance" onClick={() => OpenURL(snap.gitlab_url)}>
                        {snap.gitlab_url.replace(/^https?:\/\//, '')}
                    </a>
                    {snap.version && <span className="version">v{snap.version.version}</span>}
                    <nav className="tabs">
                        <button className={tab === 'feed' ? 'tab tab-on' : 'tab'} onClick={() => setTab('feed')}>활동 피드</button>
                        <button className={tab === 'stats' ? 'tab tab-on' : 'tab'} onClick={() => setTab('stats')}>통계</button>
                        <button className={tab === 'ci' ? 'tab tab-on' : 'tab'} onClick={() => setTab('ci')}>파이프라인</button>
                        <button className={tab === 'jira' ? 'tab tab-on' : 'tab'} onClick={() => setTab('jira')}>Jira</button>
                    </nav>
                    <nav className="tabs">
                        {PERIODS.map(p => (
                            <button key={p} className={period === p ? 'tab tab-on' : 'tab'} onClick={() => setPeriod(p)}>{p}일</button>
                        ))}
                    </nav>
                </div>
                <div className="chips">
                    {snap.stats && <>
                        <StatChip label="프로젝트" value={snap.stats.projects}/>
                        <StatChip label="그룹" value={snap.stats.groups}/>
                        <StatChip label="사용자(활성)" value={`${snap.stats.users} (${snap.stats.active_users})`}/>
                        <StatChip label="열린 MR" value={String(snap.open_mrs.length)}/>
                    </>}
                    <button className="btn btn-sm" onClick={() => Refresh()}>↻ 새로고침</button>
                    {progress
                        ? <span className="fetched">{progress.phase} 수집 {progress.done}/{progress.total}</span>
                        : <LastUpdated ts={snap.fetched_at}/>}
                </div>
            </header>

            {snap.error && <div className="error-banner">⚠ {snap.error}</div>}
            {snap.warning && <div className="warn-banner">⚠ {snap.warning}</div>}

            {tab === 'stats' ? <StatsView snap={snap} period={period} onDrill={drill}/> : tab === 'ci' ? <CIView snap={snap} period={period} onDrill={drill}/> : tab === 'jira' ? <JiraView snap={snap} period={period}/> : (
            <main className="grid">
                <section className="panel feed">
                    <div className="panel-head">
                        <h2>활동 피드 <span className="count">{events.length}{events.length === FEED_LIMIT ? '+' : ''} / {period}일</span></h2>
                        <div className="filters">
                            {KINDS.map(k => (
                                <button key={k}
                                        className={`pill ${kinds.has(k) ? 'pill-on' : ''} pill-${k}`}
                                        onClick={() => toggleKind(k)}>
                                    {KIND_META[k].icon} {KIND_META[k].label}
                                </button>
                            ))}
                            <input className="search" placeholder="사용자 / 레포 / 브랜치 검색"
                                   value={filter} onChange={e => setFilter(e.target.value)}/>
                        </div>
                    </div>
                    <div className="scroll">
                        {events.map(e => {
                            const k = eventKind(e);
                            return (
                                <div key={e.id} className={`event event-${k}`}>
                                    <span className={`badge badge-${k}`}>{KIND_META[k].icon}</span>
                                    <div className="event-body">
                                        <div className="event-top">
                                            <b>{authorLabel(e.author)}</b>
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
                                    <div className="mr-title">{mr.draft && <span className="draft">Draft</span>}!{mr.iid} {mr.title}</div>
                                    <div className="mr-meta">
                                        <span>{mr.project_path}</span>
                                        <span>{mr.author?.username} · {timeAgo(mr.updated_at)}</span>
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
                                    <span className="repo-name">{p.path_with_namespace}</span>
                                    <span className="time">{timeAgo(p.last_activity_at)}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </aside>
            </main>
            )}
        </div>
    );
}

export default App
