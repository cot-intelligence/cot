import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  getInsights,
  getSessionDetail,
  getSessionProjects,
  getSessionsPage,
  sessionExportUrl,
  setSessionArchived,
  setSessionBookmarked,
  type ActionableInsight,
  type InsightsResponse,
  type SessionDetail,
  type SessionPage,
  type SessionSummary,
  type TimelineItem,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { agentLabel } from '../forest/AgentMark';
import { categoryLabel, fmt, modelLabel, project, shortId } from '../forest/format';
import { CATEGORY_ICON, Icon } from '../forest/icons';
import { Dropdown } from '../forest/Dropdown';
import { EASE_OUT } from '../forest/motion';
import { Agent, Sev, type Severity } from '../forest/ui';

type SortKey = 'recent' | 'events' | 'duration' | 'cost';
const SEV_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
/** Sessions per page; the collector filters, sorts and counts across all of them. */
const PAGE = 20;

interface SessionsViewProps {
  onSelect: (id: string, eventId?: number) => void;
}

/** Markup mirrors the demo's Sessions page (demo-variants/src/variants/forest/pages-a.tsx), on the real list and actions. */
export function SessionsView({ onSelect }: SessionsViewProps) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  // Search runs on the collector across every session; wait for a pause in typing.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(qInput.trim()), 250);
    return () => window.clearTimeout(t);
  }, [qInput]);
  const [proj, setProj] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<SortKey>('recent');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [peek, setPeek] = useState<SessionSummary | null>(null);
  const [page, setPage] = useState(0);

  const queryClient = useQueryClient();
  const { data: ins } = usePolling<InsightsResponse>(['insights', 30], () => getInsights(30, 'all'), 60000);

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
  const flaggedIds = useMemo(() => (onlyFlagged ? [...flagged.keys()].sort() : undefined), [onlyFlagged, flagged]);

  // Any filter or sort change starts again at the first page.
  useEffect(() => setPage(0), [q, proj, agent, status, onlyFlagged, onlyBookmarked, archived, sort, dir]);

  const queryKey = ['sessionsTable', status, agent, q, proj, flaggedIds?.join(','), archived, onlyBookmarked, sort, dir, page];
  // The live stream keeps the visible page fresh; the poll is the fallback.
  const { data } = usePolling<SessionPage>(
    queryKey,
    () =>
      getSessionsPage({
        limit: PAGE,
        offset: page * PAGE,
        status: status || undefined,
        source: agent || undefined,
        q: q || undefined,
        project: proj || undefined,
        ids: flaggedIds,
        sort,
        order: dir,
        archived,
        bookmarked: onlyBookmarked,
      }),
    3000,
  );
  const { data: projectList } = usePolling(['sessionProjects', archived], () => getSessionProjects(archived), 60000);
  const rows = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // A delete or archive can shrink the list under the current page.
  useEffect(() => {
    if (data && page > 0 && page >= pages) setPage(pages - 1);
  }, [data, page, pages]);
  const agents = useMemo(() => [...new Set(['claude', 'cursor', 'codex', ...rows.map((s) => s.source)])], [rows]);

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

  const patch = (update: (prev: SessionSummary[]) => SessionSummary[]) =>
    queryClient.setQueryData<SessionPage>(queryKey, (p) => (p ? { ...p, sessions: update(p.sessions) } : p));
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
    setQInput('');
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
          <label className="vfield"><Icon name="search" size={15} /><input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search title, id or path" aria-label="Search sessions" /></label>
          <Dropdown label="Project" value={proj} onChange={setProj} options={[{ value: '', label: 'All projects' }, ...(projectList ?? []).map((p) => ({ value: p.project, label: p.project, meta: p.sessions }))]} />
          <Dropdown label="Agent" value={agent} onChange={setAgent} options={[{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: agentLabel(a) }))]} />
          <Dropdown label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'Any status' }, { value: 'active', label: 'Live' }, { value: 'completed', label: 'Completed' }]} />
          <button type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={onlyFlagged} onClick={() => setOnlyFlagged((x) => !x)} style={quiet(onlyFlagged)}><Icon name="findings" size={14} />With findings</button>
          <Dropdown
            label="View"
            value={archived ? 'archived' : onlyBookmarked ? 'bookmarked' : ''}
            onChange={(v) => { setArchived(v === 'archived'); setOnlyBookmarked(v === 'bookmarked'); }}
            options={[{ value: '', label: 'All sessions' }, { value: 'bookmarked', label: 'Bookmarked' }, { value: 'archived', label: 'Archived' }]}
          />
          {any && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={clear}>Clear</button>}
          <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{data ? `${fmt.n(total)} session${total === 1 ? '' : 's'}` : '…'}</span>
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
          {data && total > PAGE && <Pager page={page} pages={pages} total={total} onPage={setPage} />}
        </div>
      </div>
      <Peek
        s={peek}
        findings={(ins?.insights ?? []).filter((f) => f.status === 'active' && peek && f.evidence.some((e) => e.session_id === peek.id))}
        archived={archived}
        onClose={() => setPeek(null)}
        onOpen={onSelect}
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
  onOpen: (id: string, eventId?: number) => void;
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
  const moments = useMemo(() => (detail && s ? keyMoments(detail.events ?? detail.timeline ?? [], findings, s.id) : null), [detail, findings, s]);

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
              <span className="label" style={{ display: 'block', margin: '16px 0 4px' }}>Key moments</span>
              {!moments ? (
                <p className="dim" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
              ) : (
                <>
                  {moments.mix && <p className="mono faint" style={{ fontSize: 11, margin: '0 0 8px' }}>{moments.mix}</p>}
                  <ol className="tl">
                    {moments.rows.map(({ e, why, text }) => (
                      <li key={e.id} className="tl-i" data-cat={e.category} data-err={why === 'failed'}>
                        <span className="tl-ic"><Icon name={CATEGORY_ICON[e.category] ?? 'file'} size={15} /></span>
                        <div style={{ minWidth: 0 }}>
                          <button type="button" className="km" onClick={() => onOpen(s.id, e.id)} title="Open in the trace">
                            <span className="tl-t">
                              {e.tool ?? categoryLabel(e.category)}
                              {why === 'failed' && <span className="vchip c-critical" style={{ marginLeft: 8 }}>failed</span>}
                              {why === 'finding' && <span className="vchip c-warn" style={{ marginLeft: 8 }}>evidence</span>}
                            </span>
                            {text && <span className={e.category === 'prompt' || e.category === 'response' ? 'km-text' : 'tl-x'}>{text}</span>}
                          </button>
                        </div>
                        <span className="tl-ts">{fmt.time(e.ts)}</span>
                      </li>
                    ))}
                  </ol>
                  {moments.more > 0 && <p className="mono faint" style={{ fontSize: 11, margin: '4px 0 0 44px' }}>+{moments.more} more failed · in the full trace</p>}
                </>
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

type MomentWhy = 'prompt' | 'finding' | 'failed' | 'reply';
interface Moment { e: TimelineItem; why: MomentWhy; text: string | null }

const MAX_MOMENTS = 6;
const MIX: [string, string][] = [['shell', 'shell'], ['file_edit', 'edits'], ['file_read', 'reads'], ['web', 'web'], ['mcp', 'mcp'], ['subagent', 'subagents']];

/**
 * What a reader needs to decide whether to open a session: what it was asked, what went wrong, the
 * events behind its findings, and how it ended. Picked by meaning, shown in time order.
 */
function keyMoments(events: TimelineItem[], findings: ActionableInsight[], sessionId: string) {
  const byId = new Map<number, TimelineItem>();
  for (const e of events) {
    byId.set(e.id, e);
    if (e.end_id) byId.set(e.end_id, e);
  }
  const picked = new Map<number, Moment>();
  const add = (e: TimelineItem | undefined, why: MomentWhy) => {
    if (!e || picked.has(e.id) || picked.size >= MAX_MOMENTS) return;
    const text = e.category === 'prompt' || e.category === 'response' ? e.detail?.trim() || null : e.target;
    picked.set(e.id, { e, why, text });
  };

  add(events.find((e) => e.category === 'prompt'), 'prompt');
  for (const f of findings) for (const ev of f.evidence) if (ev.session_id === sessionId && ev.event_id != null) add(byId.get(ev.event_id), 'finding');
  // Keep a slot for the ending so a session with many failures still says how it finished.
  const reply = [...events].reverse().find((e) => e.category === 'response');
  const failed = events.filter((e) => e.status === 'error' || e.status === 'failed');
  const room = MAX_MOMENTS - picked.size - (reply ? 1 : 0);
  failed.slice(0, Math.max(0, room)).forEach((e) => add(e, 'failed'));
  add(reply, 'reply');

  const shownFailed = [...picked.values()].filter((m) => failed.includes(m.e)).length;
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const mix = MIX.filter(([c]) => counts.get(c)).map(([c, label]) => `${counts.get(c)} ${label}`).join(' · ');

  return {
    rows: [...picked.values()].sort((a, b) => a.e.ts.localeCompare(b.e.ts)),
    more: failed.length - shownFailed,
    mix: failed.length ? `${mix}${mix ? ' · ' : ''}${failed.length} failed` : mix,
  };
}

/** Page numbers with the first, last and two around the current; the rest fold into "…". */
function pageList(page: number, pages: number): (number | null)[] {
  const keep = new Set([0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages));
  const out: (number | null)[] = [];
  [...keep].sort((a, b) => a - b).forEach((p, i, a) => {
    // A gap of one page shows that page; only longer runs fold into "…".
    if (i > 0 && p - a[i - 1] === 2) out.push(p - 1);
    else if (i > 0 && p - a[i - 1] > 2) out.push(null);
    out.push(p);
  });
  return out;
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  const go = (p: number) => {
    onPage(p);
    document.getElementById('vf-scroll')?.scrollTo({ top: 0 });
  };
  const from = page * PAGE + 1;
  const to = Math.min(total, (page + 1) * PAGE);
  return (
    <nav className="pager" aria-label="Sessions pages">
      <span className="mono faint" style={{ fontSize: 12 }}>{fmt.n(from)}–{fmt.n(to)} of {fmt.n(total)}</span>
      <div className="pager-b">
        <button type="button" className="iconbtn" onClick={() => go(page - 1)} disabled={page === 0} aria-label="Previous page">
          <Icon name="chevron" size={15} style={{ transform: 'rotate(180deg)' }} />
        </button>
        {pageList(page, pages).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">…</span>
          ) : (
            <button key={p} type="button" className="pager-n" aria-current={p === page ? 'page' : undefined} aria-label={`Page ${p + 1}`} onClick={() => go(p)}>
              {p + 1}
            </button>
          ),
        )}
        <button type="button" className="iconbtn" onClick={() => go(page + 1)} disabled={page >= pages - 1} aria-label="Next page">
          <Icon name="chevron" size={15} />
        </button>
      </div>
    </nav>
  );
}
