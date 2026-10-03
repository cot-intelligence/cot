import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  getInsights,
  getSessionDetail,
  getSessions,
  sessionExportUrl,
  setSessionArchived,
  setSessionBookmarked,
  type ActionableInsight,
  type InsightsResponse,
  type SessionDetail,
  type SessionSummary,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { agentLabel } from '../forest/AgentMark';
import { categoryLabel, fmt, modelLabel, project, shortId } from '../forest/format';
import { CATEGORY_ICON, Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { Agent, Sev, type Severity } from '../forest/ui';

type SortKey = 'recent' | 'events' | 'duration' | 'cost';
const SEV_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
const LIMIT = 500;

interface SessionsViewProps {
  onSelect: (id: string) => void;
}

/** Markup mirrors the demo's Sessions page (demo-variants/src/variants/forest/pages-a.tsx), on the real list and actions. */
export function SessionsView({ onSelect }: SessionsViewProps) {
  const [q, setQ] = useState('');
  const [proj, setProj] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<SortKey>('recent');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [peek, setPeek] = useState<SessionSummary | null>(null);

  const queryClient = useQueryClient();
  const queryKey = ['sessionsTable', status, agent, q, archived, onlyBookmarked];
  // Server-side filters as before; the live stream keeps it fresh, the poll is the fallback.
  const { data } = usePolling<SessionSummary[]>(
    queryKey,
    () => getSessions({ limit: LIMIT, status: status || undefined, source: agent || undefined, q: q || undefined, archived, bookmarked: onlyBookmarked }),
    3000,
  );
  const { data: ins } = usePolling<InsightsResponse>(['insights', 30], () => getInsights(30, 'all'), 60000);
  const sessions = data ?? [];

  // Worst active finding per session, for the chip and the "With findings" filter.
  const flagged = useMemo(() => {
    const m = new Map<string, Severity>();
    for (const f of ins?.insights ?? []) {
      if (f.status !== 'active') continue;
      for (const e of f.evidence) {
        const cur = m.get(e.session_id);
        if (!cur || SEV_RANK[f.severity] < SEV_RANK[cur]) m.set(e.session_id, f.severity);
      }
    }
    return m;
  }, [ins]);
  const projects = useMemo(() => [...new Set(sessions.map((s) => project(s.cwd)))].sort(), [sessions]);
  const agents = useMemo(() => [...new Set(['claude', 'cursor', 'codex', ...sessions.map((s) => s.source)])], [sessions]);

  const rows = useMemo(() => {
    const r = sessions.filter((s) => (!proj || project(s.cwd) === proj) && (!onlyFlagged || flagged.has(s.id)));
    const val = (s: SessionSummary) =>
      sort === 'events' ? s.event_count : sort === 'duration' ? s.duration_seconds ?? 0 : sort === 'cost' ? s.cost_usd : new Date(s.last_activity ?? s.started_at).getTime();
    return r.sort((a, b) => (dir === 'desc' ? val(b) - val(a) : val(a) - val(b)));
  }, [sessions, proj, onlyFlagged, flagged, sort, dir]);

  const sortBy = (k: SortKey) => {
    if (sort === k) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSort(k);
      setDir('desc');
    }
  };
  const Th = ({ k, children, num }: { k: SortKey; children: string; num?: boolean }) => (
    <th className={num ? 'num' : undefined} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => sortBy(k)}>
        {children}
        {sort === k && <Icon name="down" size={12} style={{ transform: dir === 'asc' ? 'rotate(180deg)' : undefined }} />}
      </button>
    </th>
  );

  const patch = (update: (prev: SessionSummary[]) => SessionSummary[]) => queryClient.setQueryData<SessionSummary[]>(queryKey, (p) => update(p ?? []));
  const toggleBookmark = async (s: SessionSummary) => {
    const next = !s.bookmarked;
    patch((p) => (!next && onlyBookmarked ? p.filter((x) => x.id !== s.id) : p.map((x) => (x.id === s.id ? { ...x, bookmarked: next } : x))));
    try {
      await setSessionBookmarked(s.id, next);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessionsTable'] });
    }
  };
  const toggleArchive = async (s: SessionSummary) => {
    patch((p) => p.filter((x) => x.id !== s.id));
    setPeek(null);
    try {
      await setSessionArchived(s.id, !archived);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessionsTable'] });
    }
  };

  const any = q || proj || agent || status || onlyFlagged || onlyBookmarked || archived;
  const clear = () => {
    setQ('');
    setProj('');
    setAgent('');
    setStatus('');
    setOnlyFlagged(false);
    setOnlyBookmarked(false);
    setArchived(false);
  };
  const now = new Date().toISOString();
  const quiet = (on: boolean) => (on ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div><span className="label">Monitor</span><h1>Sessions</h1><p>Every traced agent session. Select a row to peek, open it for the full trace.</p></div>
        </div>
        <div className="toolbar">
          <label className="vfield"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, id or path" aria-label="Search sessions" /></label>
          <select className="sel" value={proj} onChange={(e) => setProj(e.target.value)} aria-label="Project"><option value="">All projects</option>{projects.map((p) => <option key={p}>{p}</option>)}</select>
          <select className="sel" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"><option value="">All agents</option>{agents.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}</select>
          <select className="sel" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option><option value="active">Live</option><option value="completed">Completed</option></select>
          <button type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={onlyFlagged} onClick={() => setOnlyFlagged((x) => !x)} style={quiet(onlyFlagged)}><Icon name="findings" size={14} />With findings</button>
          <select
            className="sel"
            value={archived ? 'archived' : onlyBookmarked ? 'bookmarked' : ''}
            onChange={(e) => { setArchived(e.target.value === 'archived'); setOnlyBookmarked(e.target.value === 'bookmarked'); }}
            aria-label="View">
            <option value="">All sessions</option>
            <option value="bookmarked">Bookmarked</option>
            <option value="archived">Archived</option>
          </select>
          {any && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={clear}>Clear</button>}
          <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{data ? `${rows.length} of ${sessions.length}${sessions.length >= LIMIT ? '+' : ''}` : '…'}</span>
        </div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 28 }} aria-label="Bookmark" />
                  <th>Session</th>
                  <th>Agent</th>
                  <Th k="events" num>Events</Th>
                  <Th k="duration" num>Duration</Th>
                  <Th k="cost" num>Spend</Th>
                  <Th k="recent">Last active</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const sev = flagged.get(s.id);
                  return (
                    <tr key={s.id} className="click" data-sel={peek?.id === s.id} onClick={() => setPeek(s)} onKeyDown={(e) => e.key === 'Enter' && setPeek(s)} tabIndex={0}>
                      <td>
                        <button
                          type="button"
                          className="iconbtn"
                          style={{ width: 24, height: 24, color: s.bookmarked ? 'var(--v-hot)' : undefined }}
                          onClick={(e) => { e.stopPropagation(); void toggleBookmark(s); }}
                          aria-label={s.bookmarked ? 'Remove bookmark' : 'Bookmark session'}
                          aria-pressed={s.bookmarked}>
                          <Icon name="star" size={14} style={s.bookmarked ? { fill: 'currentColor' } : undefined} />
                        </button>
                      </td>
                      <td style={{ maxWidth: 440 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          {s.status === 'active' && <span className="live" title="Live" />}
                          <span className="truncate" style={{ fontWeight: 500 }}>{s.title || 'Untitled session'}</span>
                          {sev && <Sev s={sev} />}
                        </div>
                        <span className="mono faint" style={{ fontSize: 11 }}>{project(s.cwd)} · {shortId(s.id)}</span>
                      </td>
                      <td><Agent id={s.source} /></td>
                      <td className="num">{s.event_count}</td>
                      <td className="num">{fmt.dur(s.duration_seconds ?? 0)}</td>
                      <td className="num">{s.has_cost ? fmt.usd(s.cost_usd) : '—'}</td>
                      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt.ago(s.last_activity ?? s.started_at, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data && rows.length === 0 && <div className="empty">{any ? 'No sessions match these filters.' : 'No sessions yet. Run an agent with cot hooks installed.'}</div>}
            {!data && <div className="empty">Loading sessions…</div>}
          </div>
        </div>
      </div>
      <Peek
        s={peek}
        findings={(ins?.insights ?? []).filter((f) => f.status === 'active' && peek && f.evidence.some((e) => e.session_id === peek.id))}
        archived={archived}
        onClose={() => setPeek(null)}
        onOpen={(id) => onSelect(id)}
        onArchive={toggleArchive}
      />
    </div>
  );
}

function Peek({
  s,
  findings,
  archived,
  onClose,
  onOpen,
  onArchive,
}: {
  s: SessionSummary | null;
  findings: ActionableInsight[];
  archived: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onArchive: (s: SessionSummary) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  useEffect(() => {
    setDetail(null);
    if (!s) return;
    let live = true;
    getSessionDetail(s.id).then((d) => live && setDetail(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = (detail?.events ?? detail?.timeline ?? []).slice(0, 8);

  return (
    <AnimatePresence>
      {s && (
        <>
          <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={s.title ?? 'Session'}
            initial={{ transform: 'translateX(105%)' }}
            animate={{ transform: 'translateX(0%)' }}
            exit={{ transform: 'translateX(105%)', transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ duration: 0.38, ease: [0.32, 0.72, 0, 1] }}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}>
            <div className="drawer-h">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{project(s.cwd)} · {shortId(s.id)}</span>
                <h2 style={{ margin: '4px 0 0', fontSize: 17, lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em' }}>{s.title || 'Untitled session'}</h2>
              </div>
              <button type="button" className="iconbtn" onClick={onClose} aria-label="Close" autoFocus><Icon name="close" /></button>
            </div>
            <div className="drawer-b">
              <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div className="kpi"><span className="label">Events</span><span className="v" style={{ fontSize: 22 }}>{s.event_count}</span></div>
                <div className="kpi"><span className="label">Spend</span><span className="v" style={{ fontSize: 22 }}>{s.has_cost ? fmt.usd(s.cost_usd) : '—'}</span></div>
                <div className="kpi"><span className="label">Duration</span><span className="v" style={{ fontSize: 22 }}>{fmt.dur(s.duration_seconds ?? 0)}</span></div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
                <Agent id={s.source} />
                {s.models.map((m) => <span key={m} className="vchip c-dim">{modelLabel(m)}</span>)}
              </div>
              {findings.map((f) => (
                <div key={f.fingerprint} className="finding" style={{ marginBottom: 8 }}>
                  <span className="meta" style={{ color: `var(--v-${f.severity === 'critical' ? 'alert' : f.severity === 'warn' ? 'amber' : 'cobalt'})` }}>{f.severity} · {f.id}</span>
                  <span className="ttl">{f.title}</span>
                </div>
              ))}
              <span className="label" style={{ display: 'block', margin: '16px 0 8px' }}>First events</span>
              {!detail ? (
                <p className="dim" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
              ) : (
                <ol className="tl">
                  {first.map((e) => {
                    const failed = e.status === 'error' || e.status === 'failed';
                    return (
                      <li key={e.id} className="tl-i" data-cat={e.category} data-err={failed}>
                        <span className="tl-ic"><Icon name={CATEGORY_ICON[e.category] ?? 'file'} size={15} /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="tl-t">{e.tool ?? categoryLabel(e.category)}{failed ? <span className="vchip c-critical" style={{ marginLeft: 8 }}>failed</span> : null}</div>
                          {e.target && <div className="tl-x" title={e.target}>{e.target}</div>}
                        </div>
                        <span className="tl-ts">{fmt.time(e.ts)}{e.duration_ms ? ` · ${fmt.ms(e.duration_ms)}` : ''}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
            <div style={{ padding: 16, borderTop: '1px solid var(--v-line)', display: 'flex', gap: 8 }}>
              <button type="button" className="vbtn vbtn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onOpen(s.id)}>Open full trace <Icon name="arrow" size={15} /></button>
              <a className="vbtn vbtn-quiet" href={sessionExportUrl(s.id)} download aria-label="Export session as JSON" title="Export as JSON"><Icon name="download" size={15} /></a>
              <button type="button" className="vbtn vbtn-quiet" onClick={() => onArchive(s)} aria-label={archived ? 'Restore session' : 'Archive session'} title={archived ? 'Restore' : 'Archive'}><Icon name="archive" size={15} /></button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
