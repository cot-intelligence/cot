import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { getTasks, type TaskRecent, type TaskRunning } from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { fmt, project } from '../forest/format';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { stagePercent } from '../passive/PassiveBanner';

const POLL_MS = 5000;
const events = (n: number) => `${fmt.n(n)} event${n === 1 ? '' : 's'}`;
const STORE_KEY = 'cot.tasks.v1';
const DONE_MAX = 30;
const DISMISSED_MAX = 300;

interface DoneItem {
  id: string;
  kind: 'session' | 'passive';
  title: string;
  detail: string;
  href: string;
  at: string;
  tone: 'ok' | 'warn' | 'error';
}

interface Saved {
  done: DoneItem[];
  dismissed: string[];
  /** What was running at the last look, so work that finished while the tab was closed still lands in Done. */
  lastRunning: TaskRunning[];
}

function load(): Saved {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Saved>;
      return { done: v.done ?? [], dismissed: v.dismissed ?? [], lastRunning: v.lastRunning ?? [] };
    }
  } catch {
    /* storage blocked or corrupt: start empty */
  }
  return { done: [], dismissed: [], lastRunning: [] };
}

function save(s: Saved) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* per-browser convenience only */
  }
}

/** A session that stops sending events becomes a Done item that opens its trace. Keyed by its
 *  last activity, so a session that picks up again and finishes later shows up once more. */
function finishedSession(t: Extract<TaskRunning, { kind: 'session' }>): DoneItem {
  return {
    id: `${t.id}@${t.last_activity ?? t.started_at}`,
    kind: 'session',
    title: t.title,
    detail: [agentLabel(t.source), project(t.cwd), events(t.events)].join(' · '),
    href: `#/session/${t.session_id}`,
    at: new Date().toISOString(),
    tone: 'ok',
  };
}

function finishedImport(r: TaskRecent): DoneItem {
  const bits = [
    `${fmt.n(r.new_sessions)} new session${r.new_sessions === 1 ? '' : 's'}`,
    r.findings !== undefined ? `${fmt.n(r.findings)} findings` : null,
    r.held_back ? `${r.held_back} still running` : null,
  ].filter(Boolean);
  return {
    id: r.id,
    kind: 'passive',
    title: r.status === 'error' ? 'Transcript import failed' : 'Transcript import finished',
    detail: r.status === 'error' ? r.error ?? 'See Settings › Passive import' : bits.join(' · '),
    // Findings are the thing to look at when there are any; otherwise the new sessions.
    href: r.status === 'error' ? '#/settings' : r.findings ? '#/findings' : '#/sessions',
    at: r.finished_at,
    tone: r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'warn' : 'error',
  };
}

function runningLine(t: TaskRunning, now: string): { title: string; detail: string; href: string | null } {
  if (t.kind === 'session') {
    return {
      title: t.title,
      detail: [agentLabel(t.source), project(t.cwd), events(t.events), `started ${fmt.ago(t.started_at, now)}`].join(' · '),
      href: `#/session/${t.session_id}`,
    };
  }
  if (t.kind === 'passive') {
    return {
      title: t.phase === 'analysis' ? 'Analysing imported transcripts' : 'Importing transcripts',
      detail: (() => {
        const now = stagePercent(t.phase, t.progress, t.analysis);
        if (t.phase === 'analysis') return `Step 2 of 2 · enrichment${now != null ? ` ${now}%` : ''} · findings next`;
        return t.progress && now != null
          ? `Step 1 of 2 · ingestion ${now}% · ${agentLabel(t.progress.agent)}`
          : 'Step 1 of 2 · sessions appear as they land';
      })(),
      href: '#/settings',
    };
  }
  return { title: t.title, detail: 'Search covers new sessions once this finishes', href: null };
}

/**
 * Top-bar tray for work in progress: live agent sessions, passive transcript
 * imports and their analysis, the search index build. When something finishes
 * it moves to Done; opening a Done item takes you to its page and clears it.
 */
export function TaskTray() {
  const [saved, setSaved] = useState<Saved>(load);
  const [running, setRunning] = useState<TaskRunning[]>(saved.lastRunning);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      try {
        const { running: cur, recent } = await getTasks();
        if (!live) return;
        setRunning(cur);
        setNow(new Date().toISOString());
        setSaved((prev) => {
          const curIds = new Set(cur.map((t) => t.id));
          const known = new Set([...prev.done.map((d) => d.id), ...prev.dismissed]);
          const fresh: DoneItem[] = [];
          for (const t of prev.lastRunning) {
            if (curIds.has(t.id) || t.kind !== 'session') continue;
            const d = finishedSession(t);
            if (!known.has(d.id)) fresh.push(d);
          }
          for (const r of recent) if (!known.has(r.id)) fresh.push(finishedImport(r));
          const next = { ...prev, lastRunning: cur, done: [...fresh, ...prev.done].slice(0, DONE_MAX) };
          save(next);
          return next;
        });
      } catch {
        /* collector briefly away: keep what we have */
      }
      if (live) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const dismiss = (ids: string[]) =>
    setSaved((prev) => {
      const gone = new Set(ids);
      const next = {
        ...prev,
        done: prev.done.filter((d) => !gone.has(d.id)),
        dismissed: [...ids, ...prev.dismissed].slice(0, DISMISSED_MAX),
      };
      save(next);
      return next;
    });

  const done = saved.done;
  const busy = running.length > 0;
  const label = [busy ? `${running.length} in progress` : null, done.length ? `${done.length} done` : null].filter(Boolean).join(', ') || 'Nothing in progress';

  return (
    <div className="tray" ref={root}>
      <button
        ref={button}
        type="button"
        className="iconbtn tray-b"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Activity: ${label}`}
        title="Activity"
        onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={17} />
        {done.length > 0 ? (
          <span className="tray-count" aria-hidden="true">{done.length > 9 ? '9+' : done.length}</span>
        ) : busy ? (
          <span className="tray-live live" aria-hidden="true" />
        ) : null}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="tray-pop"
            role="dialog"
            aria-label="Activity"
            initial={{ opacity: 0, transform: 'translateY(-4px) scale(0.97)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={{ opacity: 0, transform: 'translateY(-2px) scale(0.98)', transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: EASE_OUT }}>
            <section aria-labelledby="tray-run">
              <div className="tray-h">
                <span id="tray-run" className="label">In progress{busy ? ` · ${running.length}` : ''}</span>
              </div>
              {busy ? (
                <ul className="tray-l">
                  {running.map((t) => {
                    const line = runningLine(t, now);
                    const body = (
                      <>
                        {t.kind === 'session' ? <span className="live tray-ic-live" aria-hidden="true" /> : <span className="tray-spin" aria-hidden="true" />}
                        <span className="tray-t">
                          <b className="truncate">{line.title}</b>
                          <span className="tray-d truncate">{line.detail}</span>
                        </span>
                      </>
                    );
                    return (
                      <li key={t.id}>
                        {line.href ? (
                          <a className="tray-i" href={line.href} onClick={() => setOpen(false)}>{body}</a>
                        ) : (
                          <div className="tray-i" data-static>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="tray-empty">Nothing running right now.</p>
              )}
            </section>
            <section aria-labelledby="tray-done" className="tray-sec">
              <div className="tray-h">
                <span id="tray-done" className="label">Done{done.length ? ` · ${done.length}` : ''}</span>
                {done.length > 1 && (
                  <button type="button" className="tray-clear" onClick={() => dismiss(done.map((d) => d.id))}>Clear all</button>
                )}
              </div>
              {done.length ? (
                <ul className="tray-l">
                  {done.map((d) => (
                    <li key={d.id}>
                      <a
                        className="tray-i"
                        href={d.href}
                        onClick={() => {
                          // Opening it is reading it: take the user there and let it go.
                          dismiss([d.id]);
                          setOpen(false);
                        }}>
                        <span className="tray-ic" data-tone={d.tone} aria-hidden="true">
                          <Icon name={d.tone === 'error' ? 'close' : 'check'} size={13} />
                        </span>
                        <span className="tray-t">
                          <b className="truncate">{d.title}</b>
                          <span className="tray-d truncate">{d.detail}</span>
                        </span>
                        <span className="tray-ago mono">{fmt.ago(d.at, now)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="tray-empty">Finished work shows up here. Open an item to go to it.</p>
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
