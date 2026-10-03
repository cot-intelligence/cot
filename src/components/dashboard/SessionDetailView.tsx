import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessionDetail, sessionExportUrl, setSessionBookmarked, type ComponentEntry, type SessionDetail, type Store, type TimelineItem } from '../../lib/api';
import { setDocumentTitle } from '../../lib/documentTitle';
import { sessionHref, SessionStoreContext } from '../../lib/sessionStore';
import { categoryLabel, fmt, modelLabel, project } from '../forest/format';
import { CATEGORY_ICON, Icon } from '../forest/icons';
import { Agent } from '../forest/ui';
import { ActivityMap } from './session/ActivityMap';
import { AttachmentTags } from './session/AttachmentTags';
import { EventDetailPanel } from './session/EventDetailPanel';
import { InsightsTab } from './session/tabs/InsightsTab';

interface SessionDetailViewProps {
  sessionId: string;
  /** When set, open the timeline focused on this event (e.g. from search). */
  focusEventId?: number;
  /** Search text that led here; its first match in the focused event is scrolled into view. */
  focusQuery?: string;
  /** `replay` for a Session Replay import; everything on the page reads that DB. */
  store?: Store;
  /** Changes on every navigation, so following the same event reference again re-runs the jump. */
  focusNonce?: number;
}

type Tab = 'timeline' | 'files' | 'findings' | 'map';
const PAGE = 200;
const TEXT_KINDS = new Set(['prompt', 'response', 'thought', 'question', 'plan', 'subagent', 'notification']);

/** Markup mirrors the demo's session page (demo-variants/src/variants/forest/pages-a.tsx, SessionPage),
 *  with the real app's event detail, map, insights, links, bookmark and export kept inside it. */
export function SessionDetailView({ sessionId, focusEventId, focusQuery, store = 'main', focusNonce }: SessionDetailViewProps) {
  const [tab, setTab] = useState<Tab>('timeline');
  const [cat, setCat] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(focusEventId ?? null);
  const [shown, setShown] = useState(PAGE);
  const queryClient = useQueryClient();
  const key = store === 'main' ? ['sessionDetail', sessionId] : ['sessionDetail', store, sessionId];
  // Only a live session changes, so only a live one refetches: a finished trace can be large,
  // and re-reading it every 15s holds up whatever the collector is asked next.
  const { data: detail } = useQuery({
    queryKey: key,
    queryFn: () => getSessionDetail(sessionId, store),
    refetchInterval: (q) => (store === 'main' && q.state.data?.summary.status === 'active' ? 15000 : false),
  });

  useEffect(() => {
    setTab('timeline');
    setCat(null);
    setOpen(focusEventId ?? null);
    setShown(PAGE);
  }, [sessionId, focusEventId]);

  useEffect(() => {
    setDocumentTitle(detail ? detail.summary.title?.trim() || detail.summary.id.slice(0, 16) : 'Session');
  }, [detail]);

  const events = useMemo(() => detail?.events ?? detail?.timeline ?? [], [detail]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, [events]);
  const list = cat ? events.filter((e) => e.category === cat) : events;

  // Every jump to an event (Map, a reference inside an event, search, a finding's evidence, a
  // link from elsewhere) goes through here: show the timeline unfiltered, page far enough to
  // include the row, open it, and once it has rendered scroll to it and pulse it once.
  const [reveal, setReveal] = useState<{ id: number; at: number } | null>(null);
  const revealEvent = useCallback(
    (eventId: number) => {
      const i = events.findIndex((e) => e.id === eventId || e.end_id === eventId);
      if (i < 0) return;
      const rowId = events[i].id; // a span's end half points at its start row
      setTab('timeline');
      setCat(null);
      setOpen(rowId);
      setShown((n) => Math.max(n, i + 20));
      setReveal({ id: rowId, at: Date.now() });
    },
    [events],
  );
  useEffect(() => {
    if (!reveal || tab !== 'timeline') return;
    let tries = 0;
    let raf = 0;
    const seek = () => {
      const el = document.querySelector<HTMLElement>(`[data-ev="${reveal.id}"]`);
      if (!el) {
        if (++tries < 30) raf = requestAnimationFrame(seek);
        return;
      }
      // Centre a row that fits; a tall one (an open event with its detail) starts at the top so its header shows.
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
      el.scrollIntoView({ block: tall ? 'start' : 'center' });
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.animate(
        [{ backgroundColor: 'color-mix(in srgb, var(--v-hot) 14%, transparent)' }, { backgroundColor: 'transparent' }],
        { duration: reduce ? 600 : 1400, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
      setReveal(null);
    };
    raf = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(raf);
  }, [reveal, tab, shown, cat]);

  // A link that names an event (search, a finding, Key moments, Activity) lands on it.
  useEffect(() => {
    if (focusEventId != null && events.length) revealEvent(focusEventId);
  }, [focusEventId, focusNonce, events.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) {
    return (
      <div className="scroll" id="vf-scroll">
        <div className="page" aria-busy="true">
          <span className="sk" style={{ display: 'block', height: 14, width: 90, marginBottom: 16 }} />
          <span className="sk" style={{ display: 'block', height: 28, width: '55%', marginBottom: 12 }} />
          <span className="sk" style={{ display: 'block', height: 18, width: 300, marginBottom: 24 }} />
          <div className="kpis">{[0, 1, 2, 3].map((i) => <div className="kpi" key={i}><span className="sk" style={{ height: 10, width: 70 }} /><span className="sk" style={{ height: 28, width: 90 }} /></div>)}</div>
        </div>
      </div>
    );
  }

  const s = detail.summary;
  const c = detail.components;
  const back = store === 'replay' ? { href: '#/replay', label: 'Session Replay' } : { href: '#/sessions', label: 'Sessions' };
  const parents = detail.links?.parents ?? [];
  const subagents = (detail.links?.children ?? []).filter((l) => l.type === 'subagent');
  const fileCount = c.files_edited.length + c.files_read.length;
  const toggleBookmark = async () => {
    const next = !s.bookmarked;
    queryClient.setQueryData<SessionDetail>(key, (p) => (p ? { ...p, summary: { ...p.summary, bookmarked: next } } : p));
    try {
      await setSessionBookmarked(sessionId, next);
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const tabs: { k: Tab; l: string }[] = [
    { k: 'timeline', l: `Timeline · ${events.length}` },
    { k: 'files', l: `Files · ${fileCount}` },
    { k: 'findings', l: 'Findings' },
    { k: 'map', l: 'Map' },
  ];
  const strip = (p: string) => (s.cwd && p.startsWith(s.cwd + '/') ? p.slice(s.cwd.length + 1) : p);

  return (
    <SessionStoreContext.Provider value={store}>
      <div className="scroll" id="vf-scroll">
        <div className="page">
          <a href={back.href} className="vbtn vbtn-ghost vbtn-sm" style={{ marginLeft: -10, marginBottom: 8 }}><Icon name="back" size={14} />{back.label}</a>
          <div className="ph" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0, maxWidth: 820 }}>
              <span className="mono faint" style={{ fontSize: 12 }}>{project(s.cwd)} · {s.id}</span>
              <h1 style={{ fontSize: 24, lineHeight: '30px', overflowWrap: 'anywhere' }}>{s.title || 'Untitled session'}</h1>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                {s.status === 'active' ? <span className="vchip c-ok"><span className="dot" />live</span> : <span className="vchip c-dim">completed</span>}
                <Agent id={s.source} />
                {s.models.map((m) => <span key={m} className="vchip c-dim">{modelLabel(m)}</span>)}
                <span className="mono faint" style={{ fontSize: 12 }}>started {fmt.dayTime(s.started_at)}</span>
              </div>
              {(parents.length > 0 || subagents.length > 0) && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }} className="dim">
                  {parents.map((p) => <a key={p.session_id} href={sessionHref(p.session_id, store)} className="vchip c-info">{p.type === 'subagent' ? 'parent' : 'reviewed'} · {p.session_id.slice(0, 8)}</a>)}
                  {subagents.map((p) => <a key={p.session_id} href={sessionHref(p.session_id, store)} className="vchip c-dim">subagent · {p.label || p.session_id.slice(0, 8)}</a>)}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <a className="vbtn vbtn-quiet vbtn-sm" href={sessionExportUrl(s.id, store)} download><Icon name="download" size={14} />Export</a>
              {store === 'main' && (
                <button type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={s.bookmarked} onClick={toggleBookmark} style={s.bookmarked ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined}>
                  <Icon name="star" size={14} style={s.bookmarked ? { fill: 'currentColor' } : undefined} />{s.bookmarked ? 'Bookmarked' : 'Bookmark'}
                </button>
              )}
            </div>
          </div>

          <div className="kpis" style={{ marginBottom: 20 }}>
            <div className="kpi"><span className="label">Events</span><span className="v">{fmt.n(s.event_count)}</span></div>
            <div className="kpi"><span className="label">Tool calls</span><span className="v">{fmt.n(s.tool_count)}</span></div>
            <div className="kpi"><span className="label">Duration</span><span className="v">{fmt.dur(s.duration_seconds ?? 0)}</span></div>
            <div className="kpi"><span className="label">Spend</span><span className="v">{s.has_cost ? fmt.usd(s.cost_usd) : '—'}</span><span className="d">{fmt.k(s.tokens.total)} tokens</span></div>
          </div>

          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}>
                {t.l}
                {tab === t.k && <motion.span layoutId="vf-tab" className="bar" transition={{ type: 'spring', duration: 0.3, bounce: 0 }} />}
              </button>
            ))}
          </div>

          {tab === 'timeline' && (
            <div className="grid-2 grid-trace" style={{ marginTop: 0 }}>
              <div className="card">
                <div className="card-b">
                  <ol className="tl">
                    {list.slice(0, shown).map((e) => (
                      <TraceRow key={e.id} e={e} live={s.status === 'active'} open={open === e.id} focusQuery={e.id === focusEventId ? focusQuery : undefined} onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} sessionId={sessionId} onJump={revealEvent} />
                    ))}
                  </ol>
                  {list.length === 0 && <div className="empty">No events{cat ? ' of this kind' : ''}.</div>}
                  {list.length > shown && (
                    <div style={{ textAlign: 'center', paddingTop: 12 }}>
                      <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}</button>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'grid', gap: 4, alignContent: 'start', position: 'sticky', top: 0 }}>
                <span className="label" style={{ padding: '0 8px 6px' }}>Filter</span>
                {[null, ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])].map((k) => (
                  <button
                    key={k ?? 'all'}
                    type="button"
                    className="nav-i"
                    style={{ border: 0, background: cat === k ? 'var(--v-surface)' : undefined, boxShadow: cat === k ? '0 0 0 1px var(--v-line)' : undefined, color: cat === k ? 'var(--v-fg)' : undefined }}
                    onClick={() => { setCat(k); setShown(PAGE); }}>
                    <Icon name={k ? CATEGORY_ICON[k] ?? 'file' : 'layers'} size={15} />
                    <span>{k ? categoryLabel(k) : 'All events'}</span>
                    <span className="ct">{k ? counts[k] : events.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'files' && (
            <div className="grid-2e" style={{ marginTop: 0 }}>
              <FileCard title="Edited" icon="edit" color="var(--v-olive)" items={c.files_edited} strip={strip} />
              <FileCard title="Read" icon="file" color="var(--v-cobalt)" items={c.files_read} strip={strip} />
              {c.skills_context.length > 0 && <FileCard title="Context & skills" icon="layers" items={c.skills_context} strip={strip} />}
              {c.mcp_plugins.length > 0 && <FileCard title="MCP" icon="plug" items={c.mcp_plugins} strip={strip} />}
              {c.web_calls.length > 0 && <FileCard title="Web" icon="globe" items={c.web_calls} strip={strip} />}
              {c.subagents.length > 0 && <FileCard title="Subagents" icon="users" items={c.subagents} strip={strip} />}
            </div>
          )}

          {tab === 'findings' && (
            <div className="card"><div className="card-b"><InsightsTab detail={detail} /></div></div>
          )}

          {tab === 'map' && (
            <div className="card"><div className="card-b" style={{ overflowX: 'auto' }}>
              <ActivityMap items={events} sessionId={sessionId} activeKey={null} onJump={(it) => revealEvent(it.id)} />
            </div></div>
          )}
        </div>
      </div>
    </SessionStoreContext.Provider>
  );
}

function TraceRow({ e, open, live, focusQuery, onToggle, sessionId, onJump }: { e: TimelineItem; open: boolean; live: boolean; focusQuery?: string; onToggle: () => void; sessionId: string; onJump: (id: number) => void }) {
  const failed = e.status === 'error' || e.status === 'failed';
  const text = TEXT_KINDS.has(e.category) ? e.detail?.trim() : '';
  return (
    <li className="tl-i" data-cat={e.category} data-err={failed} data-ev={e.id} data-open={open}>
      <span className="tl-ic"><Icon name={CATEGORY_ICON[e.category] ?? 'file'} size={15} /></span>
      <div style={{ minWidth: 0 }}>
        <button type="button" onClick={onToggle} aria-expanded={open} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
          <div className="tl-t">{e.tool ?? categoryLabel(e.category)}{failed ? <span className="vchip c-critical" style={{ marginLeft: 8 }}>failed</span> : null}{live && e.ongoing === true ? <span className="vchip c-ok" style={{ marginLeft: 8 }}><span className="dot" />running</span> : null}</div>
          {e.target && <div className="tl-x" title={e.target}>{e.target}</div>}
        </button>
        {text && <TraceText kind={e.category} text={text} />}
        {e.attachments && e.attachments.length > 0 && <div style={{ marginTop: 6 }}><AttachmentTags attachments={e.attachments} /></div>}
        {open && (
          <div className="tl-detail">
            <EventDetailPanel item={e} sessionId={sessionId} onJump={onJump} compact />
            {focusQuery && <p className="mono faint" style={{ fontSize: 11, margin: '8px 0 0' }}>Matched “{focusQuery}”</p>}
          </div>
        )}
      </div>
      <span className="tl-ts">{fmt.time(e.ts)}{e.duration_ms ? ` · ${fmt.ms(e.duration_ms)}` : ''}</span>
    </li>
  );
}

/** Prompt, reply and thinking text in the trace. Thinking starts folded; long text clamps with a toggle. */
function TraceText({ kind, text }: { kind: string; text: string }) {
  const long = text.length > 320 || text.split('\n').length > 5;
  const [open, setOpen] = useState(false);
  return (
    <div className="tx" data-kind={kind} data-open={open || !long}>
      <p className="tx-b">{text}</p>
      {long && (
        <button type="button" className="tx-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show less' : kind === 'thought' ? 'Show thinking' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function FileCard({ title, icon, color, items, strip }: { title: string; icon: string; color?: string; items: ComponentEntry[]; strip: (p: string) => string }) {
  return (
    <div className="card">
      <div className="card-h"><span className="card-t">{title}</span><span className="label">{items.length}</span></div>
      <ul className="card-b" style={{ listStyle: 'none', margin: 0, display: 'grid', gap: 8 }}>
        {items.map((f, i) => {
          const name = f.path ?? f.target ?? '';
          return (
            <li key={`${name}-${i}`} className="mono truncate" style={{ fontSize: 12 }} title={name}>
              <Icon name={icon} size={13} style={{ display: 'inline', verticalAlign: -2, marginRight: 8, color: color ?? 'var(--v-dim)' }} />
              {strip(name)}
              {f.count > 1 && <span className="faint"> · {f.count}×</span>}
            </li>
          );
        })}
        {items.length === 0 && <li className="dim">None.</li>}
      </ul>
    </div>
  );
}
