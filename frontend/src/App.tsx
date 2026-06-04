import {useEffect, useMemo, useState} from 'react';
import './App.css';
import {GetSnapshot, Refresh, SaveConfig, OpenURL} from "../wailsjs/go/main/App";
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
}
interface Stats {
    forks: string; issues: string; merge_requests: string; users: string;
    projects: string; groups: string; active_users: string;
}
interface Pipeline {
    id: number; project_id: number; status: string; source: string; ref: string; sha: string;
    created_at: string; updated_at: string; web_url: string; project_path: string;
}
interface Snapshot {
    fetched_at: string; gitlab_url: string;
    version: { version: string } | null; stats: Stats | null;
    events: GLEvent[]; projects: Project[]; open_mrs: MR[]; merged_mrs: MR[];
    pipelines: Pipeline[];
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

// 활동 지수 가중치: 커밋 1, MR 생성 4, 머지 6, 댓글 1, 기타 0.5
function eventScore(e: GLEvent): number {
    const k = eventKind(e);
    if (k === 'push') return Math.max(1, Math.min(e.push_data?.commit_count ?? 1, 20));
    if (k === 'mr') return e.action_name === 'opened' ? 4 : 2;
    if (k === 'merge') return 6;
    if (k === 'comment') return 1;
    return 0.5;
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

function aggregateUsers(events: GLEvent[]): UserStat[] {
    const map = new Map<string, UserStat>();
    for (const e of events) {
        const u = e.author?.username || '?';
        let s = map.get(u);
        if (!s) {
            s = {username: u, name: authorLabel(e.author), isBot: !!e.author?.is_bot, score: 0, commits: 0, pushes: 0, mrs: 0, merges: 0, comments: 0, byDay: new Map()};
            map.set(u, s);
        }
        const k = eventKind(e);
        const sc = eventScore(e);
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

function CIView({snap, period}: { snap: Snapshot; period: Period }) {
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
                                <span className="lb-name lb-name-wide" title={path}>{path}</span>
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
function StatsView({snap, period}: { snap: Snapshot; period: Period }) {
    const [includeBots, setIncludeBots] = useState(false);
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
        const all = aggregateUsers(events);
        return includeBots ? all : all.filter(u => !u.isBot);
    }, [events, includeBots]);

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
            </div>

            {/* 사용자 리더보드 */}
            <section className="stat-block">
                <h3>
                    사용자별 활동 지수 <span className="hint">커밋 1 · MR 4 · 머지 6 · 댓글 1</span>
                    <label className="toggle">
                        <input type="checkbox" checked={includeBots} onChange={e => setIncludeBots(e.target.checked)}/>
                        토큰봇 포함
                    </label>
                </h3>
                {top.map((u, i) => (
                    <div key={u.username} className="lb-row">
                        <span className="lb-rank">{i + 1}</span>
                        <span className="lb-name" title={u.username}>{u.name}</span>
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
                            <span className="heat-name">{u.name}</span>
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

            {/* 레포별 활동 */}
            <section className="stat-block">
                <h3>레포별 활동 Top 10 <span className="hint">이벤트 수 기준</span></h3>
                {repos.map(([path, n]) => (
                    <div key={path} className="lb-row">
                        <span className="lb-name lb-name-wide">{path}</span>
                        <div className="lb-bar-wrap">
                            <div className="lb-bar lb-bar-repo" style={{width: `${(n / repoMax) * 100}%`}}/>
                        </div>
                        <span className="lb-score">{n}</span>
                    </div>
                ))}
            </section>
        </div>
    );
}

// ---- Main app ----
const FEED_LIMIT = 300;

function App() {
    const [snap, setSnap] = useState<Snapshot | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [tab, setTab] = useState<'feed' | 'stats' | 'ci'>('feed');
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

            {tab === 'stats' ? <StatsView snap={snap} period={period}/> : tab === 'ci' ? <CIView snap={snap} period={period}/> : (
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
                            {snap.projects.map(p => (
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
