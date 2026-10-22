import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  dismissInsight,
  getInsights,
  getRules,
  getSessions,
  restoreInsight,
  type ActionableInsight,
  type InsightPillar,
  type InsightSeverity,
  type InsightsResponse,
  type InsightStatus,
  type SessionSummary,
  type UserRule,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { agentLabel } from '../forest/AgentMark';
import { Dropdown } from '../forest/Dropdown';
import { fmt, project, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { listItem, listParent } from '../forest/motion';
import { Seg, Sev } from '../forest/ui';

// Rules registered in backend/app/insights.py (@rule). Update together.
const RULE_COUNT = 17;
const PILLAR_ICON: Record<InsightPillar, string> = { security: 'lock', cost: 'dollar', usability: 'bolt' };
const sevVar = (s: string) => `var(--${s === 'critical' ? 'alert' : s === 'warn' ? 'amber' : 'cobalt'})`;
const WINDOWS = [
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];
const SEVERITIES: InsightSeverity[] = ['critical', 'warn', 'info'];

interface FindingsViewProps {
  onSelect: (id: string, eventId?: number) => void;
  initialPillar?: InsightPillar;
  /** Open on this finding (by fingerprint), e.g. from a notification; a new nonce re-opens it. */
  focusFinding?: string;
  focusNonce?: number;
}

/** Markup mirrors the demo's Findings page (demo-variants/src/variants/forest/pages-b.tsx). */
export function FindingsView({ onSelect, initialPillar, focusFinding, focusNonce }: FindingsViewProps) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<InsightStatus>('active');
  const [pillar, setPillar] = useState<InsightPillar | ''>(initialPillar ?? '');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('');
  const [rule, setRule] = useState('');
  const [proj, setProj] = useState('');
  const [agent, setAgent] = useState('');
  const { data: ins, error } = usePolling<InsightsResponse>(
    ['insights', days, refreshKey || undefined].filter((x) => x !== undefined),
    () => getInsights(days, 'all'),
    60000,
  );
  // Same key as the Overview's sample, for the evidence lines (project · agent).
  const { data: recent } = usePolling<SessionSummary[]>(['sessions', 'overview', 500], () => getSessions({ limit: 500 }), 30000);
  const { data: myRules } = usePolling<UserRule[]>(['rules'], () => getRules(), 60000);
  const userRules = (myRules ?? []).filter((r) => r.enabled).length;
  const byId = useMemo(() => new Map((recent ?? []).map((s) => [s.id, s])), [recent]);

  useEffect(() => {
    if (initialPillar) setPillar(initialPillar);
  }, [initialPillar]);

  // A link to one finding: once it is loaded, clear whatever hides it (window, status,
  // pillar, filters), select it, then scroll its row into view and pulse it once.
  const [focus, setFocus] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ fp: string; at: number } | null>(null);
  useEffect(() => {
    if (focusFinding) setFocus(focusFinding);
  }, [focusFinding, focusNonce]);
  useEffect(() => {
    if (!focus || !ins || ins.window_days !== days) return;
    const f = ins.insights.find((x) => x.fingerprint === focus);
    if (!f && days !== 0) {
      setDays(0); // outside this window: look through all history
      return;
    }
    setFocus(null);
    // Drop the finding from the URL so following the same link again is a new navigation.
    window.history.replaceState(null, '', f ? `#/findings?pillar=${f.pillar}` : '#/findings');
    if (!f) return; // gone since the link was made
    setStatus(f.status);
    setPillar(f.pillar);
    setQ(''); setSev(''); setRule(''); setProj(''); setAgent('');
    setSel(f.fingerprint);
    setReveal({ fp: f.fingerprint, at: Date.now() });
  }, [focus, ins, days]);
  useEffect(() => {
    if (!reveal) return;
    // Timers, not animation frames: a window just brought forward can hold frames back.
    let tries = 0;
    const timers: number[] = [];
    const seek = () => {
      const el = document.querySelector<HTMLElement>(`[data-fp="${reveal.fp}"]`);
      // On a cold load the row can exist before it has layout (a lazy chunk still suspending).
      if (!el?.getClientRects().length) {
        if (++tries < 120) timers.push(window.setTimeout(seek, 25));
        return;
      }
      // Rows and the detail card settle around it, so re-align a few times.
      el.scrollIntoView({ block: 'center' });
      for (const ms of [80, 200, 400]) timers.push(window.setTimeout(() => el.scrollIntoView({ block: 'center' }), ms));
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.animate(
        [{ backgroundColor: 'color-mix(in srgb, var(--v-hot) 14%, transparent)' }, { backgroundColor: 'transparent' }],
        { duration: reduce ? 600 : 1400, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    };
    seek();
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [reveal]);

  const all = ins?.insights ?? [];
  // Project and agent come from the evidence sessions; a finding matches if any of them does.
  const sessionsOf = (f: ActionableInsight) => f.evidence.map((e) => byId.get(e.session_id)).filter((s): s is SessionSummary => !!s);
  const needle = q.trim().toLowerCase();
  const filtered = all.filter((f) => {
    if (sev && f.severity !== sev) return false;
    if (rule && f.group_title !== rule) return false;
    if (needle && ![f.title, f.detail, f.id, f.group_title, ...f.evidence.map((e) => e.label)].some((t) => t?.toLowerCase().includes(needle))) return false;
    if (proj || agent) {
      const ss = sessionsOf(f);
      if (proj && !ss.some((s) => project(s.cwd) === proj)) return false;
      if (agent && !ss.some((s) => s.source === agent)) return false;
    }
    return true;
  });
  const count = (s: InsightStatus) => filtered.filter((f) => f.status === s).length;
  const rows = filtered.filter((f) => f.status === status && (!pillar || f.pillar === pillar));
  const tally = (key: (f: ActionableInsight) => string[]) => {
    const m = new Map<string, number>();
    for (const f of all) if (f.status === status) for (const k of new Set(key(f))) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const ruleOpts = tally((f) => [f.group_title]);
  const projOpts = tally((f) => sessionsOf(f).map((s) => project(s.cwd)));
  const agentOpts = tally((f) => sessionsOf(f).map((s) => s.source));
  const anyFilter = !!(q || sev || rule || proj || agent);
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setSel(null); };
  const clear = () => { setQ(''); setSev(''); setRule(''); setProj(''); setAgent(''); setSel(null); };
  const cur: ActionableInsight | undefined = rows.find((f) => f.fingerprint === sel) ?? rows[0];
  // One row per rule: a rule that fired several times (the same command run over
  // and over, say) folds into a group you open, in the order its worst finding sorts.
  const groups = useMemo(() => {
    const m = new Map<string, ActionableInsight[]>();
    for (const f of rows) m.set(f.id, [...(m.get(f.id) ?? []), f]);
    return [...m.values()];
  }, [rows]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // A link or j/k that lands inside a closed group opens it, so the selection is visible.
  useEffect(() => {
    if (!sel) return;
    const f = rows.find((r) => r.fingerprint === sel);
    if (f && !open.has(f.id) && (groups.find((g) => g[0].id === f.id)?.length ?? 0) > 1) setOpen((o) => new Set(o).add(f.id));
  }, [sel]);
  // What j/k walks: each finding of an open group, or a closed group's first one.
  const visible = groups.flatMap((g) => (g.length === 1 || open.has(g[0].id) ? g : [g[0]]));

  const act = async (f: ActionableInsight, action: 'dismiss' | 'restore', reason?: string) => {
    const i = rows.findIndex((r) => r.fingerprint === f.fingerprint);
    const next = rows[i + 1] ?? rows[i - 1];
    setBusy(true);
    try {
      await (action === 'dismiss' ? dismissInsight(f.fingerprint, reason) : restoreInsight(f.fingerprint));
      setSel(next?.fingerprint ?? null);
    } finally {
      setBusy(false);
      setRefreshKey((k) => k + 1);
      // The nav badge counts open findings from /v1/stats.
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    }
  };

  // j/k move through the list: instant, it's a keyboard action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir || !visible.length) return;
      e.preventDefault();
      const at = visible.findIndex((r) => r.fingerprint === cur?.fingerprint);
      const i = at >= 0 ? at : Math.max(0, visible.findIndex((r) => r.id === cur?.id));
      const n = visible[Math.min(visible.length - 1, Math.max(0, i + dir))];
      setSel(n.fingerprint);
      document.querySelector(`[data-fp="${n.fingerprint}"], [data-group="${n.id}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, cur]);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Govern</span>
            <h1>Findings</h1>
            <p>{RULE_COUNT} built-in rules{userRules ? ` and ${userRules} of yours` : ''} across security, cost and usability, run on {days ? `the last ${days} days` : 'all history'}. <a href="#/rules">Manage rules</a></p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Seg id="vf-fwin" value={days} onChange={(k) => { setDays(k); setSel(null); }} options={WINDOWS} />
            <Seg
              id="vf-fstat"
              value={status}
              onChange={(k) => { setStatus(k); setSel(null); }}
              options={(['active', 'resolved', 'dismissed'] as const).map((k) => ({ k, l: `${k[0].toUpperCase()}${k.slice(1)} ${ins ? count(k) : '…'}` }))}
            />
          </div>
        </div>
        <div className="toolbar">
          {(['', 'security', 'cost', 'usability'] as const).map((p) => (
            <button
              key={p || 'all'}
              type="button"
              className="vbtn vbtn-quiet vbtn-sm"
              aria-pressed={pillar === p}
              onClick={() => { setPillar(p); setSel(null); }}
              style={pillar === p ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined}>
              {p && <Icon name={PILLAR_ICON[p]} size={14} />}
              {p ? p[0].toUpperCase() + p.slice(1) : 'All pillars'}
              <span className="mono faint" style={{ fontSize: 11 }}>{ins ? filtered.filter((f) => (!p || f.pillar === p) && f.status === status).length : '…'}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <label className="vfield"><Icon name="search" size={15} /><input value={q} onChange={(e) => filter(setQ)(e.target.value)} placeholder="Search title, detail or evidence" aria-label="Search findings" /></label>
          <Dropdown label="Severity" value={sev} onChange={filter(setSev)} options={[{ value: '', label: 'Any severity' }, ...SEVERITIES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1), meta: all.filter((f) => f.status === status && f.severity === s).length }))]} />
          <Dropdown label="Rule" value={rule} onChange={filter(setRule)} options={[{ value: '', label: 'All rules' }, ...ruleOpts.map(([r, n]) => ({ value: r, label: r, meta: n }))]} />
          <Dropdown label="Project" value={proj} onChange={filter(setProj)} options={[{ value: '', label: 'All projects' }, ...projOpts.map(([p, n]) => ({ value: p, label: p, meta: n }))]} />
          <Dropdown label="Agent" value={agent} onChange={filter(setAgent)} options={[{ value: '', label: 'All agents' }, ...agentOpts.map(([a, n]) => ({ value: a, label: agentLabel(a), meta: n }))]} />
          {anyFilter && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={clear}>Clear</button>}
          <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{ins ? `${fmt.n(rows.length)} finding${rows.length === 1 ? '' : 's'}` : '…'}</span>
        </div>

        {error && !ins ? (
          <div className="card empty">Collector offline — findings unavailable.</div>
        ) : (
          <div className="grid-2" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.15fr)' }}>
            <div className="card" style={{ overflow: 'hidden' }}>
              {!ins && (
                <div style={{ padding: 6 }} aria-busy="true">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
                      <span className="sk" style={{ height: 18, width: 120 }} />
                      <span className="sk" style={{ height: 14, width: `${55 + ((i * 17) % 35)}%` }} />
                    </div>
                  ))}
                  <p className="faint" style={{ fontSize: 12, padding: '4px 12px 8px', margin: 0 }}>Computing findings on your traces. Large databases take a little while.</p>
                </div>
              )}
              {ins && rows.length === 0 && <div className="empty">{anyFilter ? `No ${status} findings match these filters.` : `Nothing ${status} here.`}</div>}
              {ins && (
                <motion.ul variants={listParent} initial={false} animate="show" style={{ listStyle: 'none', margin: 0, padding: 6 }}>
                  {groups.map((g) => {
                    if (g.length === 1) {
                      const f = g[0];
                      return (
                        <motion.li key={f.fingerprint} variants={listItem}>
                          <FindingRow f={f} on={cur?.fingerprint === f.fingerprint} onSelect={() => setSel(f.fingerprint)} />
                        </motion.li>
                      );
                    }
                    const id = g[0].id;
                    const isOpen = open.has(id);
                    const holds = g.some((f) => f.fingerprint === cur?.fingerprint);
                    return (
                      <motion.li key={`g:${id}`} variants={listItem} className="fnd-g" data-open={isOpen || undefined}>
                        <button
                          type="button"
                          data-group={id}
                          className="fnd-row fnd-gh"
                          aria-expanded={isOpen}
                          aria-current={holds && !isOpen ? true : undefined}
                          onClick={() => { toggle(id); if (!holds) setSel(g[0].fingerprint); }}>
                          <span className="fnd-top">
                            <Sev s={worst(g)} />
                            <span className="mono faint truncate" style={{ fontSize: 11 }}>{id.startsWith('user.') ? `your rule · ${g[0].group_title}` : id}</span>
                            <span className="fnd-n mono">{g.length}</span>
                            <Icon name="down" size={14} className="fnd-chev" />
                          </span>
                          <span className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>{g[0].group_title}</span>
                        </button>
                        {isOpen && (
                          <ul className="fnd-kids">
                            {g.map((f) => (
                              <li key={f.fingerprint}>
                                <FindingRow f={f} on={cur?.fingerprint === f.fingerprint} onSelect={() => setSel(f.fingerprint)} nested />
                              </li>
                            ))}
                          </ul>
                        )}
                      </motion.li>
                    );
                  })}
                </motion.ul>
              )}
            </div>
            {cur ? (
              <article key={cur.fingerprint} className="card" style={{ alignSelf: 'start', position: 'sticky', top: 0 }}>
                <div className="card-b" style={{ display: 'grid', gap: 14 }}>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: sevVar(cur.severity) }}>{cur.severity} · {cur.group_title}</span>
                  <h2 style={{ margin: 0, fontSize: 20, lineHeight: '28px', letterSpacing: '-0.015em' }}>{cur.title}</h2>
                  <p className="dim" style={{ margin: 0, overflowWrap: 'anywhere' }}>{cur.detail}</p>
                  <div style={{ padding: 14, borderRadius: 12, background: 'var(--v-bg)', border: '1px solid var(--v-line)' }}>
                    <b>Fix: </b><span className="dim">{cur.recommendation}</span>
                  </div>
                  {cur.metric && (
                    <div>
                      <span className="label">{cur.metric.label}</span>
                      <div style={{ fontSize: 24, fontWeight: 600 }} className="tnum">{cur.metric.unit === 'USD' ? fmt.usd(cur.metric.value) : `${fmt.n(cur.metric.value)} ${cur.metric.unit}`}</div>
                    </div>
                  )}
                  <div>
                    <span className="label">Evidence · {cur.evidence.length}</span>
                    <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 6 }}>
                      {cur.evidence.map((e, i) => {
                        const s = byId.get(e.session_id);
                        return (
                          <li key={`${e.session_id}-${e.event_id ?? i}`}>
                            <button
                              type="button"
                              onClick={() => onSelect(e.session_id, e.event_id ?? undefined)}
                              className="hov"
                              style={{ width: '100%', textAlign: 'left', background: 'none', display: 'grid', gap: 2, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--v-line)' }}>
                              <span className="mono truncate" style={{ fontSize: 12 }}>{e.label}</span>
                              <span className="faint" style={{ fontSize: 11 }}>
                                {s ? `${project(s.cwd)} · ${shortId(s.id)} · ${agentLabel(s.source)}` : shortId(e.session_id)}
                                {e.value ? ` · ${e.value}` : ''}
                                {e.ts ? ` · ${fmt.dayTime(e.ts)}` : ''}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {cur.status === 'dismissed' && (
                    <p className="dim" style={{ fontSize: 13, margin: 0 }}>
                      Dismissed{cur.dismissed_at ? ` ${fmt.day(cur.dismissed_at)}` : ''}
                      {cur.dismiss_reason ? <>: <span style={{ color: 'var(--v-fg)' }}>{cur.dismiss_reason}</span></> : '.'}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--v-line)', paddingTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                    {cur.status === 'active' && <DismissControl key={cur.fingerprint} busy={busy} onDismiss={(reason) => act(cur, 'dismiss', reason)} />}
                    {cur.status === 'dismissed' && <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={busy} onClick={() => act(cur, 'restore')}>Reopen</button>}
                    {cur.status === 'resolved' && cur.resolved_at && <span className="vchip c-ok"><span className="dot" />fixed {fmt.day(cur.resolved_at)}</span>}
                    <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }}>{cur.first_seen ? `first seen ${fmt.day(cur.first_seen)}` : ''}</span>
                  </div>
                </div>
              </article>
            ) : (
              <div />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SEV_RANK: Record<string, number> = { critical: 3, warn: 2, info: 1 };
const worst = (g: ActionableInsight[]) => g.reduce((a, f) => ((SEV_RANK[f.severity] ?? 0) > (SEV_RANK[a] ?? 0) ? f.severity : a), g[0].severity);

/** One finding in the list. Inside a group the rule is already said above, so the
 *  row shows the title and its first evidence (which command, which file) instead. */
function FindingRow({ f, on, onSelect, nested }: { f: ActionableInsight; on: boolean; onSelect: () => void; nested?: boolean }) {
  return (
    <button type="button" data-fp={f.fingerprint} onClick={onSelect} aria-current={on} className="fnd-row" data-nested={nested || undefined}>
      {!nested && (
        <span className="fnd-top"><Sev s={f.severity} /><span className="mono faint truncate" style={{ fontSize: 11 }}>{f.id.startsWith('user.') ? `your rule · ${f.group_title}` : f.id}</span></span>
      )}
      <span className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>{f.title}</span>
      {nested && f.evidence[0]?.label && <span className="mono faint truncate" style={{ fontSize: 11 }}>{f.evidence[0].label}</span>}
    </button>
  );
}

const QUICK_REASONS = ['Expected', 'False positive', "Won't fix"];

/** Dismiss, with an optional reason: a quick pick or a few words of its own. */
function DismissControl({ busy, onDismiss }: { busy: boolean; onDismiss: (reason?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={busy} onClick={() => setOpen(true)}>Dismiss</button>;
  }
  const submit = () => onDismiss(reason.trim() || undefined);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      style={{ display: 'grid', gap: 8, width: '100%' }}>
      <label className="vfield" style={{ width: '100%' }}>
        <input
          autoFocus
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), setReason(''))}
          placeholder="Why dismiss it? (optional)"
          aria-label="Reason for dismissing"
        />
      </label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {QUICK_REASONS.map((r) => (
          <button key={r} type="button" className="vchip c-dim" style={{ cursor: 'pointer', border: 0 }} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => { setOpen(false); setReason(''); }}>Cancel</button>
          <button type="submit" className="vbtn vbtn-quiet vbtn-sm" disabled={busy}>Dismiss</button>
        </span>
      </div>
    </form>
  );
}
