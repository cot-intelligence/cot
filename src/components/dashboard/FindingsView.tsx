import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  dismissInsight,
  getInsights,
  getSessions,
  restoreInsight,
  type ActionableInsight,
  type InsightPillar,
  type InsightsResponse,
  type InsightStatus,
  type SessionSummary,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { agentLabel } from '../forest/AgentMark';
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

interface FindingsViewProps {
  onSelect: (id: string, eventId?: number) => void;
  initialPillar?: InsightPillar;
}

/** Markup mirrors the demo's Findings page (demo-variants/src/variants/forest/pages-b.tsx). */
export function FindingsView({ onSelect, initialPillar }: FindingsViewProps) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<InsightStatus>('active');
  const [pillar, setPillar] = useState<InsightPillar | ''>(initialPillar ?? '');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: ins, error } = usePolling<InsightsResponse>(
    ['insights', days, refreshKey || undefined].filter((x) => x !== undefined),
    () => getInsights(days, 'all'),
    60000,
  );
  // Same key as the Overview's sample, for the evidence lines (project · agent).
  const { data: recent } = usePolling<SessionSummary[]>(['sessions', 'overview', 500], () => getSessions({ limit: 500 }), 30000);
  const byId = useMemo(() => new Map((recent ?? []).map((s) => [s.id, s])), [recent]);

  useEffect(() => {
    if (initialPillar) setPillar(initialPillar);
  }, [initialPillar]);

  const all = ins?.insights ?? [];
  const count = (s: InsightStatus) => all.filter((f) => f.status === s).length;
  const rows = all.filter((f) => f.status === status && (!pillar || f.pillar === pillar));
  const cur: ActionableInsight | undefined = rows.find((f) => f.fingerprint === sel) ?? rows[0];

  const act = async (f: ActionableInsight, action: 'dismiss' | 'restore') => {
    const i = rows.findIndex((r) => r.fingerprint === f.fingerprint);
    const next = rows[i + 1] ?? rows[i - 1];
    setBusy(true);
    try {
      await (action === 'dismiss' ? dismissInsight(f.fingerprint) : restoreInsight(f.fingerprint));
      setSel(next?.fingerprint ?? null);
    } finally {
      setBusy(false);
      setRefreshKey((k) => k + 1);
    }
  };

  // j/k move through the list: instant, it's a keyboard action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir || !rows.length) return;
      e.preventDefault();
      const i = Math.max(0, rows.findIndex((r) => r.fingerprint === cur?.fingerprint));
      const n = rows[Math.min(rows.length - 1, Math.max(0, i + dir))];
      setSel(n.fingerprint);
      document.querySelector(`[data-fp="${n.fingerprint}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cur]);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Govern</span>
            <h1>Findings</h1>
            <p>{RULE_COUNT} rules across security, cost and usability, run on {days ? `the last ${days} days` : 'all history'}.</p>
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
              <span className="mono faint" style={{ fontSize: 11 }}>{ins ? all.filter((f) => (!p || f.pillar === p) && f.status === status).length : '…'}</span>
            </button>
          ))}
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
              {ins && rows.length === 0 && <div className="empty">Nothing {status} here.</div>}
              {ins && (
                <motion.ul variants={listParent} initial={false} animate="show" style={{ listStyle: 'none', margin: 0, padding: 6 }}>
                  {rows.map((f) => {
                    const on = cur?.fingerprint === f.fingerprint;
                    return (
                      <motion.li key={f.fingerprint} variants={listItem}>
                        <button
                          type="button"
                          data-fp={f.fingerprint}
                          onClick={() => setSel(f.fingerprint)}
                          aria-current={on}
                          style={{ width: '100%', textAlign: 'left', border: 0, background: on ? 'var(--v-bg)' : 'none', borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 4, boxShadow: on ? '0 0 0 1px var(--v-mute)' : undefined }}>
                          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Sev s={f.severity} /><span className="mono faint truncate" style={{ fontSize: 11 }}>{f.id}</span></span>
                          <span className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>{f.title}</span>
                        </button>
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
                  <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--v-line)', paddingTop: 14, alignItems: 'center' }}>
                    {cur.status === 'active' && <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={busy} onClick={() => act(cur, 'dismiss')}>Dismiss</button>}
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
