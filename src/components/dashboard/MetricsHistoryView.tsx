import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getActivity,
  type ActivityCategory,
  type ActivityFilters,
} from '../../lib/api';
import { sourceLabel } from '../../lib/sourceLabels';
import { ActivityLog, type LogStatus } from './activity/ActivityLog';
import { ShareBars as FShareBars } from '../forest/charts';
import { fmt, project as fproject } from '../forest/format';
import { Icon as FIcon } from '../forest/icons';
import { Seg as FSeg, Sev } from '../forest/ui';

interface MetricsHistoryViewProps {
  onSelect: (sessionId: string, eventId?: number) => void;
  onBack: () => void;
  initialTab?: ActivityCategory;
}

const RANGES: { days: number; label: string; short: string }[] = [
  { days: 1, label: '24h', short: '24h' },
  { days: 7, label: '7 days', short: '7d' },
  { days: 30, label: '30 days', short: '30d' },
  { days: 0, label: 'All time', short: 'all' },
];

/** How many "Worth a look" entries show before "Show more". */
const ATTENTION_SHOWN = 5;

/**
 * Activity: what agents ran in the shell and fetched from the web. Four
 * numbers, a short ranked list of what is worth a look (measured against the
 * history before the range), what agents rely on, then every command.
 */
export function MetricsHistoryView({ onSelect, initialTab = 'shell' }: MetricsHistoryViewProps) {
  const [tab, setTab] = useState<ActivityCategory>(initialTab);
  const [days, setDays] = useState(7);
  const [project, setProject] = useState('');
  const [source, setSource] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [status, setStatus] = useState<LogStatus>('all');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => setTab(initialTab), [initialTab]);

  const filters: ActivityFilters = { days, project: project || undefined, source: source || undefined };
  const { data, isPending, isError } = useQuery({
    queryKey: ['activity', tab, filters],
    queryFn: () => getActivity(tab, filters),
    placeholderData: (prev) => (prev?.category === tab ? prev : undefined),
  });

  const switchTab = (next: ActivityCategory) => {
    setTab(next);
    setGroup(null);
    setStatus('all');
    window.history.replaceState(null, '', next === 'web' ? '#/metrics-history?tab=web' : '#/metrics-history');
  };

  /** Jump from a summary to the matching slice of the log. */
  const showInLog = (next: { group?: string | null; status?: LogStatus }) => {
    if (next.group !== undefined) setGroup(next.group);
    if (next.status) setStatus(next.status);
    requestAnimationFrame(() => logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const shell = tab === 'shell';
  const sm = data?.summary;
  const groups = data?.groups ?? [];
  const attention = data?.attention ?? [];
  const [moreAttention, setMoreAttention] = useState(false);
  const rangeLabel = days === 0 ? 'all time' : days === 1 ? 'last 24 hours' : `last ${days} days`;

  // Markup mirrors the demo's Activity page (demo-variants/src/variants/forest/pages-b.tsx); the real filters,
  // "Worth a look" and the full searchable log are kept in the same style.
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div><span className="label">Monitor</span><h1>Activity</h1><p>What agents ran on the machine, grouped by {shell ? 'program' : 'host'}.</p></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FSeg id="vf-kind" value={tab} onChange={switchTab} options={[{ k: 'shell', l: 'Shell' }, { k: 'web', l: 'Web' }]} />
            <FSeg id="vf-arange" value={days} onChange={(d) => { setDays(d); setGroup(null); }} options={RANGES.map((r) => ({ k: r.days, l: r.short }))} />
          </div>
        </div>
        {(data?.projects.length || data?.sources.length || project || source) ? (
          <div className="toolbar">
            <select className="sel" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects</option>
              {(data?.projects ?? []).map((p) => <option key={p.cwd} value={p.cwd}>{fproject(p.cwd)} · {p.runs}</option>)}
            </select>
            <select className="sel" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Agent">
              <option value="">All agents</option>
              {(data?.sources ?? []).map((x) => <option key={x.source} value={x.source}>{sourceLabel(x.source)} · {x.runs}</option>)}
            </select>
            {(project || source) && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => { setProject(''); setSource(''); }}>Clear</button>}
          </div>
        ) : null}

        {isError && !data ? (
          <div className="card empty">Collector offline. Activity is unavailable.</div>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi"><span className="label">{shell ? 'Commands' : 'Requests'}</span><span className="v">{sm ? fmt.n(sm.runs) : '…'}</span><span className="d">{rangeLabel}</span></div>
              <div className="kpi"><span className="label">Failed</span><span className="v">{sm ? fmt.n(sm.failed) : '…'}</span><span className="d">{sm ? `${fmt.pct(sm.fail_rate)} fail rate` : ''}</span></div>
              <div className="kpi"><span className="label">Time spent</span><span className="v">{sm ? fmt.dur(sm.total_ms / 1000) : '…'}</span><span className="d">{sm ? `across ${fmt.n(sm.sessions)} sessions` : ''}</span></div>
              <div className="kpi">
                <span className="label">{shell ? 'Risky' : 'Local hosts'}</span>
                <span className="v" style={{ color: shell && sm?.risky ? 'var(--v-alert)' : undefined }}>{sm ? (shell ? sm.risky : sm.local ?? 0) : '…'}</span>
                <span className="d">{sm ? (shell ? `${sm.elevated} elevated` : 'localhost calls') : ''}</span>
              </div>
            </div>

            <section className="card" style={{ marginTop: 16, overflow: 'hidden' }}>
              <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t">Worth a look</span><span className="label">{data ? `${attention.length} ${attention.length === 1 ? 'item' : 'items'}` : '…'}</span></div>
              {isPending && !data ? (
                <div className="card-b dim" style={{ fontSize: 13 }}>Loading…</div>
              ) : attention.length === 0 ? (
                <div className="card-b dim" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><FIcon name="check" size={15} style={{ color: 'var(--v-olive)' }} />Nothing unusual in this range.</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px' }}>
                  {(moreAttention ? attention : attention.slice(0, ATTENTION_SHOWN)).map((a, i) => (
                    <li key={`${a.kind}-${a.title}-${i}`}>
                      <button type="button" className="hov" onClick={() => onSelect(a.ref.session_id, a.ref.event_id)} style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', borderRadius: 10, padding: '10px 12px', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 10px', alignItems: 'center' }}>
                        <Sev s={a.severity} />
                        <span className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</span>
                        {(a.subject || a.names || a.detail) && (
                          <span className="mono faint truncate" style={{ gridColumn: 2, fontSize: 12 }} title={a.names ? a.names.join(', ') : a.subject ?? a.detail ?? ''}>
                            {a.names ? a.names.join(', ') : a.subject ?? ''}{a.detail ? `${a.subject || a.names ? ' · ' : ''}${a.detail}` : ''}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                  {attention.length > ATTENTION_SHOWN && (
                    <li><button type="button" className="vbtn vbtn-ghost vbtn-sm" style={{ margin: '4px 4px 0' }} onClick={() => setMoreAttention((x) => !x)}>{moreAttention ? 'Show fewer' : `Show all ${attention.length}`}</button></li>
                  )}
                </ul>
              )}
            </section>

            <div className="grid-2">
              <section className="card" style={{ overflow: 'hidden' }}>
                <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t">{shell ? 'Programs' : 'Hosts'}</span><span className="label">{data ? `${groups.length} groups` : '…'}</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="t">
                    <thead><tr><th>{shell ? 'Program' : 'Host'}</th>{shell && <th>Top verbs</th>}<th className="num">Runs</th><th className="num">Failed</th><th className="num">Time</th></tr></thead>
                    <tbody>
                      {groups.slice(0, 14).map((g) => (
                        <tr key={g.key} className="click" data-sel={group === g.key} onClick={() => showInLog({ group: group === g.key ? null : g.key })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && showInLog({ group: g.key })} title="Show these in the log">
                          <td className="mono" style={{ fontSize: 12 }}>{g.key}{g.elevated ? <span className="vchip c-warn" style={{ marginLeft: 8 }}>sudo {g.elevated}</span> : null}</td>
                          {shell && <td><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(g.verbs ?? []).slice(0, 3).map((v) => <span key={v.key} className="vchip c-dim">{v.key} {v.runs}</span>)}</div></td>}
                          <td className="num">{g.runs}</td>
                          <td className="num" style={{ color: g.failed ? 'var(--v-alert)' : undefined }}>{g.failed}</td>
                          <td className="num">{fmt.ms(g.total_ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data && groups.length === 0 && <div className="empty">Nothing ran in this range.</div>}
                </div>
              </section>
              <section className="card">
                <div className="card-h"><span className="card-t">Time by {shell ? 'program' : 'host'}</span></div>
                <div className="card-b">
                  <FShareBars
                    key={tab}
                    rows={groups.slice().sort((x, y) => y.total_ms - x.total_ms).slice(0, 8).map((g) => ({ key: g.key, label: <span className="mono" style={{ fontSize: 12 }}>{g.key}</span>, value: g.total_ms / 1000, color: g.failed ? 'var(--v-amber)' : undefined }))}
                    color="var(--v-hot)"
                    track="var(--v-panel)"
                    format={(v) => fmt.dur(v)}
                  />
                  <p className="faint" style={{ fontSize: 12, margin: '14px 0 0' }}>Amber bars had at least one failed run.</p>
                </div>
              </section>
            </div>

            <section ref={logRef} className="card" style={{ marginTop: 16, scrollMarginTop: 16, overflow: 'hidden' }}>
              <div className="card-h" style={{ paddingBottom: 12, flexWrap: 'wrap' }}>
                <span className="card-t">{shell ? 'Command log' : 'Request log'} · {rangeLabel}</span>
                <FSeg id="vf-only" value={status} onChange={setStatus} options={(shell ? (['all', 'failed', 'risky'] as const) : (['all', 'failed'] as const)).map((k) => ({ k, l: k[0].toUpperCase() + k.slice(1) }))} />
              </div>
              <div>
                <ActivityLog
                  category={tab}
                  filters={filters}
                  group={group}
                  onClearGroup={() => setGroup(null)}
                  status={status}
                  onStatus={setStatus}
                  viaOptions={shell ? data?.via : undefined}
                  onSelect={onSelect}
                />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
