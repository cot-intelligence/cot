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
import { Dropdown } from '../forest/Dropdown';
import { Seg as FSeg, Sev } from '../forest/ui';
import { extensionPageHref, ExtensionsView } from './ExtensionsView';

/** Activity's pages: one per kind of thing agents use. Plugins only have an installed list. */
export type ActivityPage = ActivityCategory | 'plugin';

interface MetricsHistoryViewProps {
  onSelect: (sessionId: string, eventId?: number) => void;
  onBack: () => void;
  initialTab?: ActivityPage;
  /** Opens with the log narrowed to one program / host / server / skill. */
  initialGroup?: string;
  /** MCP / Skills: show what is installed instead of what ran. */
  installed?: boolean;
}

const INSTALLED: Record<'mcp' | 'skill' | 'plugin', { title: string; blurb: string }> = {
  mcp: { title: 'MCP servers', blurb: 'Servers your agents can start, where each is configured, how often sessions call them, and launch risks.' },
  skill: { title: 'Skills', blurb: 'Skills your agents can load, where each is installed, how often sessions use them, and the security scan.' },
  plugin: { title: 'Plugins', blurb: 'Plugins installed in each agent, what they ship, and how much of it sessions use. Their calls show under MCP and Skills.' },
};

/** Activity: one page per Activity entry in the sidebar. */
export function MetricsHistoryView({ onSelect, initialTab = 'shell', initialGroup, installed }: MetricsHistoryViewProps) {
  if (initialTab === 'plugin' || installed) {
    const kind = initialTab === 'plugin' ? 'plugin' : (initialTab as 'mcp' | 'skill');
    return (
      <div className="scroll" id="vf-scroll">
        <div className="page">
          <PageHead tab={initialTab} title={INSTALLED[kind].title} blurb={INSTALLED[kind].blurb} installed />
          <ExtensionsView key={kind} kind={kind} />
        </div>
      </div>
    );
  }
  // Remount per tab so filters, the picked group and the range start fresh.
  return <UsageView key={initialTab} tab={initialTab} initialGroup={initialGroup} onSelect={onSelect} />;
}

/** Title, blurb, and for MCP / Skills the Usage | Installed switch; `children` sits beside it (the range). */
function PageHead({ tab, title, blurb, installed, children }: { tab: ActivityPage; title: string; blurb: string; installed?: boolean; children?: React.ReactNode }) {
  const switchable = tab === 'mcp' || tab === 'skill';
  return (
    <div className="ph">
      <div><span className="label">Activity</span><h1>{title}</h1><p>{blurb}</p></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {switchable && (
          <FSeg
            id="vf-aview"
            value={installed ? 'installed' : 'usage'}
            onChange={(v) => { window.location.hash = v === 'installed' ? `#/metrics-history?tab=${tab}&view=installed` : activityHash(tab); }}
            options={[{ k: 'usage', l: 'Usage' }, { k: 'installed', l: 'Installed' }]}
          />
        )}
        {children}
      </div>
    </div>
  );
}

/** Per-tab wording: what one run is called, what runs group by, and the page's lede. */
const TAB: Record<ActivityCategory, { label: string; title: string; blurb: string; runs: string; group: string; groups: string; log: string }> = {
  shell: { label: 'Shell', title: 'Shell', blurb: 'Commands agents ran on the machine, grouped by program.', runs: 'Commands', group: 'Program', groups: 'Programs', log: 'Command log' },
  web: { label: 'Web', title: 'Web', blurb: 'Pages agents fetched and searches they ran, grouped by host.', runs: 'Requests', group: 'Host', groups: 'Hosts', log: 'Request log' },
  mcp: { label: 'MCP', title: 'MCP', blurb: 'Tool calls agents made to MCP servers, grouped by server.', runs: 'Calls', group: 'Server', groups: 'MCP servers', log: 'Call log' },
  skill: { label: 'Skills', title: 'Skills', blurb: 'Skills agents loaded, whether they picked them or you ran a /command.', runs: 'Loads', group: 'Skill', groups: 'Skills', log: 'Load log' },
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
const ATTENTION_SHOWN = 5;

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

  // Markup mirrors the demo's Activity page (demo-variants/src/variants/forest/pages-b.tsx); the real filters,
  // "Worth a look" and the full searchable log are kept in the same style.
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <PageHead tab={tab} title={t.title} blurb={t.blurb}>
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
                  <span className="label">{tab === 'mcp' ? 'Servers' : 'Skills'}</span>
                  <span className="v">{sm ? fmt.n(sm.groups) : '…'}</span>
                  <span className="d">{sm ? (tab === 'mcp' ? `${fmt.n(sm.tools ?? 0)} distinct tools` : `${fmt.n(sm.slash ?? 0)} started with a /command`) : ''}</span>
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

            <div className="grid-2">
              <section className="card" style={{ overflow: 'hidden' }}>
                <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t">{t.groups}</span><span className="label">{data ? `${groups.length} groups` : '…'}</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="t">
                    <thead><tr><th>{t.group}</th>{tab !== 'web' && <th>{tab === 'mcp' ? 'Top tools' : tab === 'skill' ? 'Loaded via' : 'Top verbs'}</th>}<th className="num">{tab === 'skill' ? 'Loads' : tab === 'mcp' ? 'Calls' : 'Runs'}</th><th className="num">Failed</th><th className="num">Time</th></tr></thead>
                    <tbody>
                      {groups.slice(0, 14).map((g) => (
                        <tr key={g.key} className="click" data-sel={group === g.key} onClick={() => showInLog({ group: group === g.key ? null : g.key })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && showInLog({ group: g.key })} title="Show these in the log">
                          <td className="mono" style={{ fontSize: 12 }}>
                            {g.ext_key ? (
                              <a href={extensionPageHref(g.ext_key)} onClick={(e) => e.stopPropagation()} className="hov" title="Open in Extensions" style={{ color: 'inherit', textDecoration: 'none' }}>{g.key}</a>
                            ) : g.key}
                            {g.plugin && <span className="vchip c-dim" style={{ marginLeft: 8 }} title={g.plugin.replace(/^plugin:/, '')}>plugin</span>}
                            {g.installed === false && (g.origin
                              ? <span className="vchip c-dim" style={{ marginLeft: 8 }} title="Provided by the agent app, so no config file lists it">{g.origin}</span>
                              : <span className="vchip c-warn" style={{ marginLeft: 8 }} title="Used in sessions, but no agent config on this machine lists it now">not on disk</span>)}
                            {g.elevated ? <span className="vchip c-warn" style={{ marginLeft: 8 }}>sudo {g.elevated}</span> : null}
                          </td>
                          {tab !== 'web' && <td><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(g.verbs ?? []).slice(0, 3).map((v) => <span key={v.key} className="vchip c-dim">{v.key} {v.runs}</span>)}</div></td>}
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

            <section ref={logRef} className="card" style={{ marginTop: 16, scrollMarginTop: 16, overflow: 'hidden' }}>
              <div className="card-h" style={{ paddingBottom: 12, flexWrap: 'wrap' }}>
                <span className="card-t">{t.log} · {rangeLabel}</span>
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
                  viaOptions={shell || tab === 'skill' ? data?.via : undefined}
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
