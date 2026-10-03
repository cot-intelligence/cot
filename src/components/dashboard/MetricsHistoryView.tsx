import { motion } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { Dropdown } from '../forest/Dropdown';
import { Seg as FSeg, Sev } from '../forest/ui';
import { ExtensionsView, useExtensions } from './ExtensionsView';

/** Activity's pages: one per kind of thing agents use. Plugins only have an installed list. */
export type ActivityPage = ActivityCategory | 'plugin';

interface MetricsHistoryViewProps {
  onSelect: (sessionId: string, eventId?: number) => void;
  onBack: () => void;
  initialTab?: ActivityPage;
  /** Opens with the log narrowed to one program / host / server / skill. */
  initialGroup?: string;
}

/** Activity: one page per Activity entry in the sidebar, all in the same layout. */
export function MetricsHistoryView({ onSelect, initialTab = 'shell', initialGroup }: MetricsHistoryViewProps) {
  if (initialTab === 'plugin') return <PluginsPage />;
  // Remount per tab so filters, the picked group and the range start fresh.
  return <UsageView key={initialTab} tab={initialTab} initialGroup={initialGroup} onSelect={onSelect} />;
}

/** Title and blurb; `children` sits on the right (the range). */
function PageHead({ title, blurb, children }: { title: string; blurb: string; children?: React.ReactNode }) {
  return (
    <div className="ph">
      <div><span className="label">Activity</span><h1>{title}</h1><p>{blurb}</p></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

/** Plugins are never called directly, so their page is the installed list with its own numbers. */
function PluginsPage() {
  const [days, setDays] = useState(7);
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <PageHead title="Plugins" blurb="Every plugin installed in your agents, what it ships, and how much of it sessions use. Its calls show under MCP and Skills.">
          <FSeg id="vf-arange" value={days} onChange={setDays} options={RANGES.map((r) => ({ k: r.days, l: r.short }))} />
        </PageHead>
        <ExtensionsView kind="plugin" days={days} showKpis />
      </div>
    </div>
  );
}

/** Per-tab wording: what one run is called, what runs group by, and the page's lede. */
const TAB: Record<ActivityCategory, { label: string; title: string; blurb: string; runs: string; group: string; groups: string; log: string }> = {
  shell: { label: 'Shell', title: 'Shell', blurb: 'Commands agents ran on the machine, grouped by program.', runs: 'Commands', group: 'Program', groups: 'Programs', log: 'Command log' },
  web: { label: 'Web', title: 'Web', blurb: 'Pages agents fetched and searches they ran, grouped by host.', runs: 'Requests', group: 'Host', groups: 'Hosts', log: 'Request log' },
  mcp: { label: 'MCP', title: 'MCP', blurb: 'Every MCP server your agents can start, and the tool calls sessions made to them.', runs: 'Calls', group: 'Server', groups: 'MCP servers', log: 'Call log' },
  skill: { label: 'Skills', title: 'Skills', blurb: 'Every skill your agents can load, and when sessions loaded them (by the agent or a /command).', runs: 'Loads', group: 'Skill', groups: 'Skills', log: 'Load log' },
};

export function activityHash(tab: ActivityPage, group?: string | null): string {
  if (tab === 'shell' && !group) return '#/metrics-history';
  return `#/metrics-history?tab=${tab}${group ? `&group=${encodeURIComponent(group)}` : ''}`;
}

const RANGES: { days: number; label: string; short: string }[] = [
  { days: 1, label: '24h', short: '24h' },
  { days: 7, label: '7 days', short: '7d' },
  { days: 30, label: '30 days', short: '30d' },
  { days: 0, label: 'All time', short: 'all' },
];

/** How many "Worth a look" entries show before "Show more". */
const ATTENTION_SHOWN = 3;

/**
 * What agents ran (shell), fetched (web), called (MCP) or loaded (skills). Four
 * numbers, a short ranked list of what is worth a look (measured against the
 * history before the range), what agents rely on, then every run.
 */
function UsageView({ onSelect, tab, initialGroup }: { onSelect: (sessionId: string, eventId?: number) => void; tab: ActivityCategory; initialGroup?: string }) {
  // A deep link to one server or skill should find it even if it ran weeks ago.
  const [days, setDays] = useState(initialGroup ? 30 : 7);
  const [project, setProject] = useState('');
  const [source, setSource] = useState('');
  const [plugin, setPlugin] = useState('');
  const [group, setGroup] = useState<string | null>(initialGroup ?? null);
  const [status, setStatus] = useState<LogStatus>('all');
  const logRef = useRef<HTMLDivElement>(null);
  // The log starts collapsed; a deep link to one group, or picking one, opens it.
  const [logOpen, setLogOpen] = useState(!!initialGroup);

  useEffect(() => {
    if (initialGroup) setGroup(initialGroup);
  }, [initialGroup]);

  const extension = tab === 'mcp' || tab === 'skill';
  const filters: ActivityFilters = { days, project: project || undefined, source: source || undefined, plugin: (extension && plugin) || undefined };
  const { data, isPending, isError } = useQuery({
    queryKey: ['activity', tab, filters],
    queryFn: () => getActivity(tab, filters),
    placeholderData: (prev) => (prev?.category === tab ? prev : undefined),
  });

  /** Jump from a summary to the matching slice of the log. */
  const showInLog = (next: { group?: string | null; status?: LogStatus }) => {
    if (next.group !== undefined) setGroup(next.group);
    if (next.status) setStatus(next.status);
    setLogOpen(true);
    requestAnimationFrame(() => logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const shell = tab === 'shell';
  const t = TAB[tab];
  const plugins = data?.plugins ?? [];
  const sm = data?.summary;
  const groups = data?.groups ?? [];
  const attention = data?.attention ?? [];
  const [moreAttention, setMoreAttention] = useState(false);
  const rangeLabel = days === 0 ? 'all time' : days === 1 ? 'last 24 hours' : `last ${days} days`;
  // MCP / Skills: the installed list (same query as the card below, so it loads once).
  const { data: installs } = useExtensions(extension ? days : -1);
  const inv = extension ? installs?.summary[tab as 'mcp' | 'skill'] : undefined;

  // Arriving narrowed to one group (e.g. "See in Activity"): jump to the open log once the
  // cards above it have their data, so it doesn't shift down after the jump. Instant, not
  // smooth: it's where the link was meant to land, not a scroll the user started.
  // Layout effect: the cards are committed and laid out, so the jump lands exactly (and a
  // paused animation frame in a background tab can't swallow it).
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (!initialGroup || landed.current || !data || (extension && !installs)) return;
    landed.current = true;
    logRef.current?.scrollIntoView({ block: 'start' });
  }, [initialGroup, data, installs, extension]);
  // Installed ones used in the range, so "used" and "never used" are both parts of the installed total.
  const installedUsed = extension ? (installs?.items ?? []).filter((i) => i.kind === tab && i.installed && i.usage.calls > 0).length : 0;

  // Markup mirrors the demo's Activity page (demo-variants/src/variants/forest/pages-b.tsx); the real filters,
  // "Worth a look" and the full searchable log are kept in the same style.
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <PageHead title={t.title} blurb={t.blurb}>
          <FSeg id="vf-arange" value={days} onChange={(d) => { setDays(d); setGroup(null); }} options={RANGES.map((r) => ({ k: r.days, l: r.short }))} />
        </PageHead>
        {(data?.projects.length || data?.sources.length || project || source || plugin) ? (
          <div className="toolbar">
            <Dropdown label="Project" value={project} onChange={setProject} options={[{ value: '', label: 'All projects' }, ...(data?.projects ?? []).map((p) => ({ value: p.cwd, label: fproject(p.cwd), meta: p.runs }))]} />
            <Dropdown label="Agent" value={source} onChange={setSource} options={[{ value: '', label: 'All agents' }, ...(data?.sources ?? []).map((x) => ({ value: x.source, label: sourceLabel(x.source), meta: x.runs }))]} />
            {extension && (plugins.length > 0 || plugin) && (
              <Dropdown label="Plugin" value={plugin} onChange={(v) => { setPlugin(v); setGroup(null); }}
                options={[
                  { value: '', label: 'Any plugin' },
                  ...plugins.map((p) => ({ value: p.key, label: p.label, meta: p.runs })),
                  ...(plugin && !plugins.some((p) => p.key === plugin) ? [{ value: plugin, label: plugin.replace(/^plugin:/, '') }] : []),
                ]} />
            )}
            {(project || source || plugin) && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => { setProject(''); setSource(''); setPlugin(''); }}>Clear</button>}
          </div>
        ) : null}

        {isError && !data ? (
          <div className="card empty">Collector offline. Activity is unavailable.</div>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi"><span className="label">{t.runs}</span><span className="v">{sm ? fmt.n(sm.runs) : '…'}</span><span className="d">{rangeLabel}</span></div>
              <div className="kpi"><span className="label">Failed</span><span className="v">{sm ? fmt.n(sm.failed) : '…'}</span><span className="d">{sm ? `${fmt.pct(sm.fail_rate)} fail rate` : ''}</span></div>
              <div className="kpi"><span className="label">Time spent</span><span className="v">{sm ? fmt.dur(sm.total_ms / 1000) : '…'}</span><span className="d">{sm ? `across ${fmt.n(sm.sessions)} sessions` : ''}</span></div>
              {extension ? (
                <div className="kpi">
                  <span className="label">Installed</span>
                  <span className="v">{inv ? fmt.n(inv.installed) : '…'}</span>
                  <span className="d">{inv ? `${fmt.n(installedUsed)} used in ${days === 0 ? 'all time' : days === 1 ? '24h' : `${days}d`} · ${fmt.n(inv.unused)} never used` : ''}</span>
                </div>
              ) : (
                <div className="kpi">
                  <span className="label">{shell ? 'Risky' : 'Local hosts'}</span>
                  <span className="v" style={{ color: shell && sm?.risky ? 'var(--v-alert)' : undefined }}>{sm ? (shell ? sm.risky : sm.local ?? 0) : '…'}</span>
                  <span className="d">{sm ? (shell ? `${sm.elevated} elevated` : 'localhost calls') : ''}</span>
                </div>
              )}
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

            {extension ? (
              <ExtensionsView kind={tab as 'mcp' | 'skill'} days={days} agent={source} />
            ) : (
            <div className="grid-2">
              <section className="card" style={{ overflow: 'hidden' }}>
                <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t">{t.groups}</span><span className="label">{data ? `${groups.length} groups` : '…'}</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="t">
                    <thead><tr><th>{t.group}</th>{shell && <th>Top verbs</th>}<th className="num">Runs</th><th className="num">Failed</th><th className="num">Time</th></tr></thead>
                    <tbody>
                      {groups.slice(0, 14).map((g) => (
                        <tr key={g.key} className="click" data-sel={group === g.key} onClick={() => showInLog({ group: group === g.key ? null : g.key })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && showInLog({ group: g.key })} title="Show these in the log">
                          <td className="mono" style={{ fontSize: 12 }}>
                            {g.key}
                            {g.elevated ? <span className="vchip c-warn" style={{ marginLeft: 8 }}>sudo {g.elevated}</span> : null}
                          </td>
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
                <div className="card-h"><span className="card-t">Time by {t.group.toLowerCase()}</span></div>
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
            )}

            <section ref={logRef} className="card" style={{ marginTop: 16, scrollMarginTop: 16, overflow: 'hidden' }}>
              <div className="card-h" style={{ paddingBottom: logOpen ? 12 : 16, flexWrap: 'wrap' }}>
                <button type="button" className="log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((o) => !o)}>
                  <FIcon name="chevron" size={14} />
                  <span className="card-t">{t.log} · {rangeLabel}</span>
                  <span className="label">{sm ? `${fmt.n(sm.runs)} ${t.runs.toLowerCase()}` : '…'}</span>
                </button>
                {logOpen && <FSeg id="vf-only" value={status} onChange={setStatus} options={(shell ? (['all', 'failed', 'risky'] as const) : (['all', 'failed'] as const)).map((k) => ({ k, l: k[0].toUpperCase() + k.slice(1) }))} />}
              </div>
              {logOpen && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15, ease: 'easeOut' }}>
                <ActivityLog
                  category={tab}
                  filters={filters}
                  group={group}
                  onClearGroup={() => setGroup(null)}
                  status={status}
                  onStatus={setStatus}
                  viaOptions={shell || tab === 'skill' ? data?.via : undefined}
                  onSelect={onSelect}
                />
              </motion.div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
