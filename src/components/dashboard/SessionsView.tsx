import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteSession,
  getInsights,
  getSessionProjects,
  getSessionKinds,
  getSessionsPage,
  type Archetype,
  setSessionArchived,
  setSessionBookmarked,
  type InsightsResponse,
  type SessionPage,
  type SessionSummary,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { useHoverPrefetch } from '../../lib/sessionDetailQuery';
import { agentLabel } from '../forest/AgentMark';
import { fmt, project, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { Dropdown } from '../forest/Dropdown';
import { Agent, Sev, type Severity } from '../forest/ui';
import { DeleteSessionDialog, SessionContextMenu, type SessionAction } from './SessionContextMenu';

type SortKey = 'recent' | 'events' | 'duration' | 'cost';
const SEV_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
/** Sessions per page; the collector filters, sorts and counts across all of them. */
const PAGE = 20;
const KIND_ORDER: Archetype[] = ['quick', 'standard', 'deep', 'marathon', 'automation'];
// Kinds are judged on active time against this user's own history (session_shape.py).
const KIND_LABEL: Record<Archetype, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep', marathon: 'Marathon', automation: 'Automation' };

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
  // #/sessions?agent=cursor&kind=deep&project=cot&status=active&sort=cost&flagged=1 opens pre-filtered
  // (the Overview links here from its numbers).
  const [init] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''));
  const [proj, setProj] = useState(init.get('project') ?? '');
  const [agent, setAgent] = useState(init.get('agent') ?? '');
  const [status, setStatus] = useState(init.get('status') ?? '');
  const [onlyFlagged, setOnlyFlagged] = useState(init.get('flagged') === '1');
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  const [archived, setArchived] = useState(false);
  const [kind, setKind] = useState<Archetype | ''>(() => {
    const k = init.get('kind') as Archetype | null;
    return k && KIND_ORDER.includes(k) ? k : '';
  });
  const [sort, setSort] = useState<SortKey>(() => {
    const k = init.get('sort');
    return k === 'events' || k === 'duration' || k === 'cost' ? k : 'recent';
  });
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [menu, setMenu] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const queryClient = useQueryClient();
  const hoverPrefetch = useHoverPrefetch();
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
  useEffect(() => setPage(0), [q, proj, agent, status, onlyFlagged, onlyBookmarked, archived, kind, sort, dir]);

  const queryKey = ['sessionsTable', status, agent, q, proj, flaggedIds?.join(','), archived, onlyBookmarked, kind, sort, dir, page];
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
        kind: kind || undefined,
      }),
    3000,
  );
  const { data: kinds } = usePolling(['sessionKinds'], getSessionKinds, 60000);
  const { data: projectList } = usePolling(['sessionProjects', archived], () => getSessionProjects(archived), 60000);
  const rows = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // A delete or archive can shrink the list under the current page.
  useEffect(() => {
    if (data && page > 0 && page >= pages) setPage(pages - 1);
  }, [data, page, pages]);
  const agents = useMemo(() => [...new Set(['claude', 'cursor', 'codex', 'opencode', 'hermes', ...rows.map((s) => s.source)])], [rows]);

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
    try {
      await setSessionArchived(s.id, !archived);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['sessionsTable'] });
    }
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
    });
  };
  const onAction = (action: SessionAction, s: SessionSummary) => {
    if (action === 'open') onSelect(s.id);
    else if (action === 'copy-id') copy(s.id, 'Session ID copied');
    else if (action === 'copy-path' && s.cwd) copy(s.cwd, 'Project path copied');
    else if (action === 'bookmark') void toggleBookmark(s);
    else if (action === 'archive') void toggleArchive(s);
    else if (action === 'delete') {
      setDeleteError(null);
      setToDelete(s);
    }
  };
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSession(toDelete.id);
      patch((p) => p.filter((x) => x.id !== toDelete.id));
      setToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['sessionsTable'] });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete the session.");
    } finally {
      setDeleting(false);
    }
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenuAt = (s: SessionSummary, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ s, x: r.right - 232, y: r.bottom + 4 });
  };

  const any = q || proj || agent || status || onlyFlagged || onlyBookmarked || archived || kind;
  const clear = () => {
    setQInput('');
    setQ('');
    setProj('');
    setAgent('');
    setStatus('');
    setOnlyFlagged(false);
    setOnlyBookmarked(false);
    setArchived(false);
    setKind('');
  };
  const now = new Date().toISOString();

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div><span className="label">Monitor</span><h1>Sessions</h1><p>Every traced agent session. Open one for its timeline, or right-click for quick actions.</p></div>
        </div>
        <div className="toolbar">
          <label className="vfield"><Icon name="search" size={15} /><input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search title, id or path" aria-label="Search sessions" /></label>
          <Dropdown label="Project" value={proj} onChange={setProj} options={[{ value: '', label: 'All projects' }, ...(projectList ?? []).map((p) => ({ value: p.project, label: p.project, meta: p.sessions }))]} />
          <Dropdown label="Agent" value={agent} onChange={setAgent} options={[{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: agentLabel(a) }))]} />
          <Dropdown label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'Any status' }, { value: 'active', label: 'Live' }, { value: 'completed', label: 'Completed' }]} />
          <Dropdown
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as Archetype | '')}
            options={[{ value: '', label: 'Any kind' }, ...KIND_ORDER.filter((k) => !kinds || kinds.counts[k] > 0).map((k) => ({ value: k, label: KIND_LABEL[k], meta: kinds?.counts[k] }))]}
          />
          <button type="button" className="tgl" aria-pressed={onlyFlagged} onClick={() => setOnlyFlagged((x) => !x)}><Icon name="findings" size={14} />With findings</button>
          <Dropdown
            label="View"
            value={archived ? 'archived' : onlyBookmarked ? 'bookmarked' : ''}
            onChange={(v) => { setArchived(v === 'archived'); setOnlyBookmarked(v === 'bookmarked'); }}
            options={[{ value: '', label: 'All sessions' }, { value: 'bookmarked', label: 'Bookmarked' }, { value: 'archived', label: 'Archived' }]}
          />
          {any && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={clear}>Clear</button>}
          <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{data ? `${fmt.n(total)}${data.capped ? '+' : ''} session${total === 1 ? '' : 's'}` : '…'}</span>
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
                  <th style={{ width: 36 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const sev = flagged.get(s.id);
                  return (
                    <tr
                      key={s.id}
                      className="click"
                      data-sel={menu?.s.id === s.id}
                      onClick={() => onSelect(s.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ s, x: e.clientX, y: e.clientY });
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter') onSelect(s.id);
                        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                          e.preventDefault();
                          openMenuAt(s, e.currentTarget);
                        }
                      }}
                      onPointerEnter={() => hoverPrefetch.start(s.id)}
                      onPointerLeave={hoverPrefetch.cancel}
                      onFocus={() => hoverPrefetch.start(s.id)}
                      tabIndex={0}>
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
                          {s.rating && (
                            <span role="img" aria-label={s.rating === 1 ? 'Rated good' : 'Rated bad'} title={s.rating === 1 ? 'Rated good' : 'Rated bad'} style={{ display: 'inline-flex', color: s.rating === 1 ? 'var(--v-olive)' : 'var(--v-alert)' }}>
                              <Icon name={s.rating === 1 ? 'thumb-up' : 'thumb-down'} size={13} />
                            </span>
                          )}
                          {sev && <Sev s={sev} />}
                        </div>
                        <span className="mono faint" style={{ fontSize: 11 }}>{project(s.cwd)} · {shortId(s.id)}</span>
                      </td>
                      <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Agent id={s.source} />{s.machine && <span className="mono faint" style={{ fontSize: 11 }} title="Imported from another machine">@{s.machine}</span>}</span></td>
                      <td className="num">{s.event_count}</td>
                      <td className="num" title={s.active_seconds != null ? `${fmt.dur(s.active_seconds)} active of ${fmt.dur(s.duration_seconds ?? 0)} open` : undefined}>
                        {fmt.dur(s.active_seconds ?? s.duration_seconds ?? 0)}
                        {s.kind && s.kind !== 'standard' && <span className="faint" style={{ fontSize: 11, marginLeft: 6 }}>{KIND_LABEL[s.kind].toLowerCase()}</span>}
                      </td>
                      <td className="num">{s.has_cost ? fmt.usd(s.cost_usd) : '—'}</td>
                      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt.ago(s.last_activity ?? s.started_at, now)}</td>
                      <td style={{ paddingLeft: 0 }}>
                        <button
                          type="button"
                          className="iconbtn row-more"
                          style={{ width: 28, height: 28 }}
                          aria-label="Session actions"
                          aria-haspopup="menu"
                          aria-expanded={menu?.s.id === s.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (menu?.s.id === s.id) setMenu(null);
                            else openMenuAt(s, e.currentTarget);
                          }}>
                          <Icon name="more" size={16} stroke={2.4} />
                        </button>
                      </td>
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
      <SessionContextMenu session={menu?.s ?? null} at={menu} archived={archived} onAction={onAction} onClose={closeMenu} />
      <DeleteSessionDialog session={toDelete} busy={deleting} error={deleteError} onCancel={() => setToDelete(null)} onConfirm={() => void confirmDelete()} />
      {copied && <div className="toast-mini" role="status">{copied}</div>}
    </div>
  );
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
