import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getInsights,
  getMetrics,
  getConnections,
  getHookStatus,
  getOverviewWindow,
  getSessionsPage,
  getOutcomeTotals,
  getSessionShape,
  getShipped,
  type Connection,
  type HookHealthState,
  type HookStatus,
  type OutcomesSummaryLite,
  type ShippedList,
  type InsightPillar,
  type InsightsResponse,
  type Metrics,
  type OverviewWindow,
  type SessionShape,
  type SessionSummary,
} from '../../lib/api';
import { formatRelative, getCategoryMeta, userTimeZone } from '../../lib/categoryMeta';
import { compact, formatCost, formatMetricsDay, hourLabel } from '../../lib/format';
import { formatModel } from '../../lib/modelMeta';
import { sourceLabel } from '../../lib/sourceLabels';
import { usePolling } from '../../lib/usePolling';
import { getPrefs } from '../../lib/prefs';
import { Icon, type IconName } from '../ui/icons';
import { CHART_COLORS, type Datum } from './chartConstants';
import { DonutChart, HBars } from './chartTheme';
import { Columns, ShareBars as FShareBars, Sparkline, StackBar as FStackBar } from '../forest/charts';
import { fmt, modelLabel, project as fproject } from '../forest/format';
import { Icon as FIcon } from '../forest/icons';
import { Agent, agentColor as fAgentColor, Seg as FSeg, Sev } from '../forest/ui';
import { AttachmentsDrawer } from './AttachmentsDrawer';
import { ExportModal } from './ExportModal';
import { ContributionHeatmap, HeatStrip, lastDays } from './metricsCharts';
import { ShareCardModal } from './ShareCardModal';
import { ShippedRow } from './ShippedView';

const CARD_GRID = 'overflow-hidden rounded-cell border border-line/10 bg-line/10';

interface OverviewViewProps {
  onSelect: (id: string, eventId?: number) => void;
  onHistory?: (tab?: 'shell' | 'web') => void;
  onFindings?: (pillar?: InsightPillar) => void;
}

const WINDOWS = [
  { k: 1, l: '1d' },
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];
const DAY_MS = 86_400_000;
/** Rows in the Projects and Spend-by-model cards; the full lists are a click away. */
const TOP_ROWS = 5;
const SPEND_CHART_MIN = 96;
/** Height of Columns' date/value line (12px text + 8px gap), plus a hair of slack. */
const SPEND_LABEL_H = 30;
const HOUR_MS = 3_600_000;

/** "14:00" for an hour bucket key ("2026-10-16T14", UTC) in the viewer's time. */
function hourBucketLabel(key: string): string {
  return new Date(`${key}:00:00Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function windowText(days: number): string {
  if (!days) return 'All time';
  return days === 1 ? 'Last 24 hours' : `Last ${days} days`;
}

function shortPath(p: string | null): string {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

// --- building blocks ---

function Section({ title, aside, children }: { n?: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-h"><span className="card-t">{title}</span>{aside}</div>
      <div className="card-b">{children}</div>
    </section>
  );
}

/** Seamless ruled grid — cells share single hairlines, no outer box. */
function Grid({ cols, children }: { cols: string; children: React.ReactNode }) {
  return <div className={`grid gap-px ${CARD_GRID} ${cols}`}>{children}</div>;
}

function Spotlight({
  kicker,
  value,
  sub,
  accent,
  href,
}: {
  kicker: string;
  value: string;
  sub: string;
  accent: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="font-mono text-label font-semibold uppercase tracking-label text-fg/60">
        {kicker}
      </p>
      <p className={`mt-1 font-mono text-3xl font-semibold leading-none tracking-[-0.02em] ${accent}`}>
        {value}
      </p>
      <p className="mt-2 font-mono text-label uppercase tracking-label text-fg/60">{sub}</p>
    </>
  );
  return href ? (
    <a href={href} className="block bg-surface px-4 py-5 transition-colors hover:bg-fg/[0.03]">{body}</a>
  ) : (
    <div className="bg-surface px-4 py-5">{body}</div>
  );
}

function ChartBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface p-4">
      <p className="mb-3 font-mono text-label uppercase tracking-label text-fg/40">{label}</p>
      {children}
    </div>
  );
}

export function OverviewView({ onSelect, onHistory, onFindings }: OverviewViewProps) {
  const tz = userTimeZone();
  const { data: m, error } = usePolling<Metrics>(['metrics', tz], () => getMetrics(tz), 5000);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ type: string | null } | null>(null);
  // The spend chart fills its card, which stretches to the Needs review card beside it.
  const spendBody = useRef<HTMLDivElement>(null);
  const [spendChartH, setSpendChartH] = useState(SPEND_CHART_MIN);
  const spendReady = !!m;
  useLayoutEffect(() => {
    const el = spendBody.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      const inner = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      // Leave room for the date/value line above the bars. A measure taken before
      // styles resolve reads NaN; keep the floor rather than an unsized chart.
      const h = Math.floor(inner - SPEND_LABEL_H);
      setSpendChartH(Number.isFinite(h) ? Math.max(SPEND_CHART_MIN, h) : SPEND_CHART_MIN);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [spendReady]);

  // The window drives findings, spend and the projects table; the deeper charts below stay all-time.
  const [days, setDays] = useState<number>(() => getPrefs().range);
  const { data: ins } = usePolling<InsightsResponse>(['insights', days], () => getInsights(days, 'all'), 60000);
  const { data: totals } = usePolling<OverviewWindow>(['overview-window', days], () => getOverviewWindow(days), 30000);
  const win = useMemo(() => windowed(totals, days), [totals, days]);
  // Findings per project: only the sessions findings cite need their project.
  const evidenceIds = useMemo(
    () => [...new Set((ins?.insights ?? []).filter((f) => f.status === 'active').flatMap((f) => f.evidence.map((e) => e.session_id)))].sort().slice(0, 500),
    [ins],
  );
  const { data: evidenceSessions } = usePolling<SessionSummary[]>(
    ['sessions', 'overview-evidence', evidenceIds.join(',')],
    () => (evidenceIds.length ? getSessionsPage({ ids: evidenceIds, limit: 500 }).then((p) => p.sessions) : Promise.resolve([])),
    60000,
  );
  const { data: connections } = usePolling<Connection[]>(['connections'], () => getConnections(), 30000);
  // How cot gets each agent's sessions: live hooks, hooks that went missing, or
  // import only (agents cot reads from disk). "Connected" above only means an
  // event arrived in the last few minutes, so it can't say whether hooks work.
  const { data: hooks } = usePolling<HookStatus>(['hooks-status'], () => getHookStatus(), 60000);
  const hookHealth = useMemo(() => new Map((hooks?.agents ?? []).map((a) => [a.source as string, a.health])), [hooks]);
  const { data: shipped } = usePolling<ShippedList>(['shipped', days], () => getShipped(days), 60000);
  const { data: outcomeTotals } = usePolling<OutcomesSummaryLite>(['outcomes', days], () => getOutcomeTotals(days), 120000);
  const shapeDays = days || 365;
  const { data: shape } = usePolling<SessionShape>(['session-shape', shapeDays, tz], () => getSessionShape(shapeDays, tz), 60000);

  if (!m) {
    if (error) {
      return (
        <div className="scroll" id="vf-scroll">
          <div className="page"><div className="card empty">Collector offline — overview unavailable.</div></div>
        </div>
      );
    }
    return <OverviewSkeleton />;
  }

  const t = m.totals;
  const fun = m.fun;
  const activeDays = m.by_day.length;
  const usage = usageFor(days, m.by_day, win.series);
  const avgPerActive = activeDays
    ? Math.round(m.by_day.reduce((n, d) => n + d.events, 0) / activeDays)
    : 0;

  const categoryData: Datum[] = m.by_category.slice(0, 8).map((c, i) => ({
    name: getCategoryMeta(c.category).label,
    value: c.events,
    color: CHART_COLORS[i % CHART_COLORS.length],
    href: CATEGORY_HREF[c.category],
  }));
  const modelData: Datum[] = m.by_model.map((x, i) => ({
    name: formatModel(x.model),
    value: x.events,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
  const tokenData: Datum[] = [
    { name: 'Output', value: m.tokens.output, color: CHART_COLORS[0] },
    { name: 'Input', value: m.tokens.input, color: CHART_COLORS[1] },
    { name: 'Cache read', value: m.tokens.cache_read, color: CHART_COLORS[2] },
    { name: 'Cache write', value: m.tokens.cache_write, color: CHART_COLORS[3] },
  ];
  const agentData: Datum[] = m.by_source.map((x, i) => ({
    name: sourceLabel(x.source),
    value: x.events,
    color: i === 0 ? CHART_COLORS[1] : CHART_COLORS[0],
  }));

  const active = (ins?.insights ?? []).filter((f) => f.status === 'active');
  const review = active.filter((f) => f.severity !== 'info');
  const criticals = active.filter((f) => f.severity === 'critical').length;
  const sources = totals?.sources ?? [];
  const projectFindings = (cwd: string | null) => {
    const ids = new Set((evidenceSessions ?? []).filter((x) => x.cwd === cwd).map((x) => x.id));
    const hits = active.filter((f) => f.evidence.some((e) => ids.has(e.session_id)));
    return { n: hits.length, critical: hits.some((f) => f.severity === 'critical') };
  };
  const kpis = [
    { k: 'Sessions', v: fmt.n(win.sessions), spark: win.series.map((x) => x.sessions), note: `${t.active_sessions} live now`, href: '#/sessions', go: 'All sessions' },
    { k: 'Spend', v: fmt.usd(win.cost), spark: win.series.map((x) => x.cost), note: 'list price, all models', href: '#/sessions?sort=cost', go: 'Costliest sessions' },
    { k: 'Tool calls', v: fmt.n(win.tools), spark: win.series.map((x) => x.events), note: `${fmt.pct(fun.error_rate)} errored`, href: '#/metrics-history', go: 'Shell activity' },
    { k: 'Needs review', v: ins ? fmt.n(review.length) : '…', spark: undefined, note: ins ? `${criticals} critical · ${active.length} open in total` : 'computing…', href: '#/findings', go: 'Findings' },
  ];

  const now = new Date().toISOString();
  const go = (hash: string) => { window.location.hash = hash; };
  // Both leaderboards show the same number of rows, so neither column ends early.
  const leaderRows = Math.min(m.by_project.length, m.busiest_sessions.length) || Math.max(m.by_project.length, m.busiest_sessions.length);
  const models = [...m.cost.by_model].filter((x) => (x.cost ?? 0) > 0).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  // Markup below mirrors the demo's Overview (demo-variants/src/variants/forest/pages-a.tsx) one to one.
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Overview</span>
            <h1>Local workspace</h1>
            <p>{windowText(days)} across {win.projects.length} projects and {sources.length} agents.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <FSeg id="vf-range" value={days} options={WINDOWS} onChange={setDays} />
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setExportOpen(true)}><FIcon name="download" size={15} />Export</button>
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setShareOpen(true)} title="Share a metrics card"><FIcon name="external" size={15} />Share</button>
          </div>
        </div>


        <div className="kpis">
          {kpis.map((k) => (
            <a className="kpi kpi-link" key={k.k} href={k.href} title={`Open ${k.go}`}>
              <span className="label">{k.k}</span>
              <span className="v">{k.v}</span>
              <span className="d"><span className="truncate">{k.note}</span>{k.spark && <span style={{ color: 'var(--v-hot)' }}><Sparkline values={k.spark} width={72} height={20} /></span>}</span>
            </a>
          ))}
        </div>

        <>
          <Section n="01" title={days === 1 ? 'Hourly usage' : 'Daily usage'} aside={<span className="label">{windowText(days).toLowerCase()}</span>}>
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-x-7 gap-y-1">
                <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                  {compact(usage.total)}{' '}
                  <span className="text-label font-normal uppercase tracking-label text-fg/60">{usage.unit}</span>
                </span>
                <span className="font-mono text-label text-fg/60">
                  {usage.active} active {usage.step}{usage.active === 1 ? '' : 's'}
                </span>
                <span className="font-mono text-label text-fg/60">
                  ~{compact(usage.avg)} / {usage.step}
                </span>
                {usage.busiest && (
                  <span className="font-mono text-label text-fg/60">
                    busiest <span className="font-semibold text-fg/80">{usage.busiest.label}</span> · {compact(usage.busiest.value)}
                  </span>
                )}
              </div>
              {usage.cells ? (
                <HeatStrip cells={usage.cells} unit={usage.unit} />
              ) : (
                <ContributionHeatmap data={m.by_day.map((d) => ({ label: d.day, value: d.events }))} />
              )}
            </div>
          </Section>
        </>

        <div className="grid-2">
          <section className="card" aria-labelledby="vf-spend" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-h"><span className="card-t" id="vf-spend">{days === 1 ? 'Hourly spend' : 'Daily spend'}</span><span className="mono faint" style={{ fontSize: 12 }}>{fmt.usd(win.cost)} total</span></div>
            {/* Out of flow, so the chart can't push the card taller than the row. */}
            <div style={{ flex: 1, position: 'relative', minHeight: SPEND_CHART_MIN + SPEND_LABEL_H + 40 }}>
              <div className="card-b" ref={spendBody} style={{ position: 'absolute', inset: 0 }}>
                <Columns key={days} data={win.series.map((x) => ({ key: x.day, value: x.cost }))} color="var(--v-hot)" muted="var(--v-mute)" label={days === 1 ? hourBucketLabel : fmt.day} format={fmt.usd} height={spendChartH} />
              </div>
            </div>
          </section>
          <section className="card" aria-labelledby="vf-review">
            <div className="card-h"><span className="card-t" id="vf-review">Needs review</span><button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => onFindings?.()}>All findings <FIcon name="arrow" size={14} /></button></div>
            {!ins ? (
              <div className="card-b dim" style={{ fontSize: 13 }}>Computing findings…</div>
            ) : (
              <ul className="card-b" style={{ listStyle: 'none', margin: 0, display: 'grid', gap: 0, paddingTop: 4 }}>
                {review.length === 0 && <li className="dim" style={{ fontSize: 13 }}>Nothing needs review.</li>}
                {review.slice(0, 5).map((f) => (
                  <li key={f.fingerprint}>
                    <button type="button" onClick={() => onFindings?.(f.pillar)} className="hov" style={{ width: 'calc(100% + 16px)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'center', padding: '5px 8px', margin: '0 -8px', borderRadius: 8, border: 0, background: 'none', textAlign: 'left' }}>
                      <Sev s={f.severity} />
                      <span className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="grid-2">
          <section className="card" aria-labelledby="vf-shipped" style={{ overflow: 'hidden' }}>
            <div className="card-h"><span className="card-t" id="vf-shipped">Latest shipped</span><a href="#/metrics-history?tab=shipped" className="vbtn vbtn-ghost vbtn-sm">All <FIcon name="arrow" size={14} /></a></div>
            {!shipped ? (
              <div className="card-b" style={{ display: 'grid', gap: 10 }}>{[0, 1, 2].map((i) => <span key={i} className="sk" style={{ height: 40 }} />)}</div>
            ) : shipped.items.length === 0 ? (
              <div className="oc-empty"><b>Nothing shipped {days ? 'in this window' : 'yet'}</b><p>Pull requests, commits and pushes agents make show up here with their links.</p></div>
            ) : (
              <ul className="sh-list">
                {/* Pull requests and merges first: they are what a reviewer sees. Commits fill in when there are few. */}
                {[...shipped.items.filter((it) => it.kind === 'pr' || it.kind === 'merge'), ...shipped.items.filter((it) => it.kind === 'commit')]
                  .slice(0, 7)
                  .map((it, i) => <ShippedRow key={`${it.kind}:${it.event_id ?? it.sha}:${i}`} it={it} now={now} onSelect={onSelect} index={i} />)}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="vf-outcomes">
            <div className="card-h"><span className="card-t" id="vf-outcomes">Outcomes</span><span className="label">{windowText(days).toLowerCase()}</span></div>
            {!shipped || !outcomeTotals ? (
              <div className="card-b" style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3].map((i) => <span key={i} className="sk" style={{ height: 28 }} />)}</div>
            ) : (
              <div className="card-b oc-card">
                <div className="oc-counts">
                  {[
                    { l: 'PRs opened', v: shipped.counts.pr, k: 'pr' },
                    { l: 'Merged', v: shipped.counts.merge, k: 'merge' },
                    { l: 'Commits', v: shipped.counts.commit, k: 'commit' },
                    { l: 'Pushes', v: shipped.counts.push, k: 'push' },
                  ].map((x) => (
                    <a key={x.k} href={`#/metrics-history?tab=shipped&kind=${x.k}`} className="oc-count" title={`See every ${x.l.toLowerCase()}`}>
                      <b className="tnum">{fmt.n(x.v)}</b><span>{x.l}</span>
                    </a>
                  ))}
                </div>
                <p className="dim" style={{ margin: 0, fontSize: 12 }}>
                  {outcomeTotals.totals.git_commits > 0 && (
                    <span className="mono"><span className="d-add">+{fmt.k(outcomeTotals.totals.added)}</span> <span className="d-rm">−{fmt.k(outcomeTotals.totals.removed)}</span> lines · </span>
                  )}
                  {fmt.n(outcomeTotals.totals.sessions_shipped)} of {fmt.n(win.sessions)} sessions shipped something
                </p>
                <div>
                  <span className="label">By project</span>
                  <ul className="oc-proj">
                    {outcomeTotals.projects
                      .filter((p) => p.prs_opened || p.commits || p.git_commits)
                      .sort((a, b) => b.prs_opened - a.prs_opened || Math.max(b.commits, b.git_commits) - Math.max(a.commits, a.git_commits))
                      .slice(0, 5)
                      .map((p) => {
                        const commits = Math.max(p.commits, p.git_commits);
                        return (
                          <li key={p.project ?? '-'}>
                            <a href={`#/metrics-history?tab=shipped&group=${encodeURIComponent(p.project_name ?? 'no project')}`} title={p.project ?? ''}>
                              <span className="mono truncate">{p.project_name ?? 'no project'}</span>
                              <span className="tnum dim">{p.prs_opened > 0 && `${fmt.n(p.prs_opened)} PR${p.prs_opened === 1 ? '' : 's'} · `}{fmt.n(commits)} commit{commits === 1 ? '' : 's'}</span>
                            </a>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="grid-2">
          <section className="card" aria-labelledby="vf-proj" style={{ overflow: 'hidden' }}>
            <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t" id="vf-proj">Projects</span><a href="#/projects" className="vbtn vbtn-ghost vbtn-sm">All <FIcon name="arrow" size={14} /></a></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="t t-compact">
                <thead><tr><th>Project</th><th>Agents</th><th className="num">Sessions</th><th className="num">Spend</th><th className="num">Findings</th></tr></thead>
                <tbody>
                  {win.projects.slice(0, TOP_ROWS).map((p) => {
                    const fx = projectFindings(p.cwd);
                    return (
                      <tr key={p.cwd ?? '-'} className="click" onClick={() => { window.location.hash = `#/project/${encodeURIComponent(fproject(p.cwd))}`; }}>
                        <td><a href={`#/project/${encodeURIComponent(fproject(p.cwd))}`} className="mono proj-link" style={{ fontSize: 12 }} title={p.cwd ?? ''}>{fproject(p.cwd)}</a></td>
                        <td style={{ minWidth: 120 }}><FStackBar parts={sources.map((a) => ({ key: sourceLabel(a), value: p.agents[a] ?? 0, color: fAgentColor(a) }))} /></td>
                        <td className="num">{p.sessions}</td>
                        <td className="num">{fmt.usd(p.cost)}</td>
                        <td className="num">{fx.critical ? <span style={{ color: 'var(--v-alert)' }}>{fx.n}</span> : fx.n}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 14, padding: '10px 20px 14px', borderTop: '1px solid var(--v-line)', fontSize: 12 }} className="dim">
              {sources.map((a) => <span key={a} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: fAgentColor(a) }} />{sourceLabel(a)}</span>)}
            </div>
          </section>
          <section className="card" aria-labelledby="vf-models">
            <div className="card-h"><span className="card-t" id="vf-models">Spend by model</span><a href="#/sessions?sort=cost" className="vbtn vbtn-ghost vbtn-sm" title="Sessions by spend">Costliest sessions <FIcon name="arrow" size={14} /></a></div>
            <div className="card-b">
              <FShareBars rows={models.slice(0, TOP_ROWS).map((x) => ({ key: x.model, label: <span className="mono" style={{ fontSize: 12 }}>{modelLabel(x.model)}</span>, value: x.cost ?? 0 }))} color="var(--v-hot)" track="var(--v-panel)" format={fmt.usd} compact />
              {m.cost.unpriced_models.length > 0 && <p className="faint" style={{ fontSize: 12, margin: '14px 0 0' }}>Unpriced: {m.cost.unpriced_models.slice(0, 4).map(modelLabel).join(', ')}{m.cost.unpriced_models.length > 4 ? '…' : ''}</p>}
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16 }} aria-labelledby="vf-agents">
          <div className="card-h"><span className="card-t" id="vf-agents">Agents</span><a href="#/governance" className="vbtn vbtn-ghost vbtn-sm">Coverage <FIcon name="arrow" size={14} /></a></div>
          <div className="card-b agent-list">
            {(connections ?? m.by_source.map((x) => ({ source: x.source, sessions: x.sessions, events: x.events, last_event: null, connected: true }))).map((c) => (
              <a key={c.source} href={`#/sessions?agent=${encodeURIComponent(c.source)}`} className="agent-row" title={`${sourceLabel(c.source)} sessions`}>
                <Agent id={c.source} />
                <span className="mono num-t agent-n">{fmt.n(c.sessions)} sessions · {fmt.n(c.events)} events</span>
                <span className="faint agent-last">{c.last_event ? `Last event ${fmt.ago(c.last_event, now)}` : 'No events yet'}</span>
                <CaptureChip health={hookHealth.get(c.source)} />
              </a>
            ))}
          </div>
        </section>

        <>
          <Section n="02" title="Highlights">
            <Grid cols="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <Spotlight
                accent="text-hot"
                kicker="Peak activity"
                value={fun.peak_hour != null ? hourLabel(fun.peak_hour) : '—'}
                sub="busiest hour of day"
              />
              <Spotlight
                accent="text-cobalt"
                kicker="Busiest day"
                value={fun.busiest_day ? formatMetricsDay(fun.busiest_day.day) : '—'}
                sub={fun.busiest_day ? `${compact(fun.busiest_day.events)} events` : 'no data'}
              />
              <Spotlight
                accent="text-fg"
                kicker="Active days"
                value={String(activeDays)}
                sub={`~${compact(avgPerActive)} events / day`}
              />
              <Spotlight
                href="#/sessions?status=active"
                accent="text-fg"
                kicker="Agents at once"
                value={shape ? String(shape.concurrency.peak) : '—'}
                sub={shape ? `${Math.round(shape.concurrency.overlap_share * 100)}% of working time in parallel` : 'counting…'}
              />
            </Grid>
          </Section>
        </>

        <>
          <Section n="05" title="Breakdown">
            <Grid cols="md:grid-cols-2">
              <ChartBox label="Event categories">
                <HBars data={categoryData} height={Math.max(200, categoryData.length * 26)} onPick={(d) => { if (d.href) window.location.hash = d.href; }} />
              </ChartBox>
              <ChartBox label="Models">
                {modelData.length ? (
                  <div className="flex items-center gap-3">
                    <div className="w-40 shrink-0">
                      <DonutChart data={modelData} centerLabel={String(modelData.length)} centerSub="models" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      {m.by_model.slice(0, 8).map((model, i) => (
                        <div
                          key={model.model}
                          className="flex items-center justify-between gap-2 font-mono text-label">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="h-2 w-2 shrink-0"
                              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                            />
                            <span className="truncate">{formatModel(model.model)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-fg/60">
                            {model.cost != null && <span className="text-hot/70">{formatCost(model.cost)}</span>}
                            <span>{compact(model.events)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-fg/40">No model data captured.</p>
                )}
              </ChartBox>
            </Grid>
          </Section>
        </>

        <>
          <Section n="06" title="Tokens & agents">
            <Grid cols="md:grid-cols-2">
              <ChartBox label={`Token usage — ${compact(m.tokens.total)} total`}>
                <HBars data={tokenData} height={150} />
              </ChartBox>
              <ChartBox label="Agents">
                <div className="flex items-center gap-3">
                  <div className="w-40 shrink-0">
                    <DonutChart data={agentData} centerLabel={compact(t.events)} centerSub="events" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    {m.by_source.slice(0, 4).map((s) => (
                      <a key={s.source} href={`#/sessions?agent=${encodeURIComponent(s.source)}`} className="block rounded-md px-2 py-1 -mx-2 transition-colors hover:bg-fg/[0.04]">
                        <p className="font-mono text-sm font-semibold text-fg">{sourceLabel(s.source)}</p>
                        <p className="font-mono text-label text-fg/60">
                          {s.sessions} sess · {compact(s.events)} ev
                        </p>
                      </a>
                    ))}
                    {m.by_source.length > 4 && (
                      <a href="#/governance" className="block font-mono text-label text-fg/50 hover:text-hot">+{m.by_source.length - 4} more agents</a>
                    )}
                  </div>
                </div>
              </ChartBox>
            </Grid>
          </Section>
        </>


        {fun.busiest_day && (
          <>
            <Section n="10" title="By the numbers">
              <Grid cols="grid-cols-2 sm:grid-cols-3">
                <Fact icon="terminal" label="Shell commands" value={compact(fun.shell_commands)} onClick={() => onHistory?.('shell')} />
                <Fact icon="file" label="Files touched" value={compact(fun.files_touched)} onClick={() => go('#/metrics-history?tab=edits')} />
                <Fact icon="edit" label="Edits / reads" value={`${compact(fun.files_edited)} / ${compact(fun.files_read)}`} onClick={() => go('#/metrics-history?tab=edits')} />
                <Fact icon="plug" label="MCP calls" value={compact(fun.mcp_calls)} onClick={() => go('#/metrics-history?tab=mcp')} />
                <Fact icon="globe" label="Web fetches" value={compact(fun.web_calls)} onClick={() => onHistory?.('web')} />
                <Fact icon="chat" label="Prompts / replies" value={`${compact(fun.prompts)} / ${compact(fun.responses)}`} onClick={() => go('#/sessions?sort=events')} />
                <Fact icon="brain" label="Thoughts" value={compact(fun.thoughts)} />
                <Fact icon="search" label="Favorite tool" value={fun.top_tool ?? '—'} />
                <Fact icon="layers" label="Projects" value={compact(t.projects)} onClick={() => go('#/projects')} />
              </Grid>
            </Section>
          </>
        )}

        <>
          <Section
            n="11"
            title="Attachments"
            aside={m.attachments.total > 0 && (
              <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setAttachments({ type: null })}>
                All {fmt.n(m.attachments.total)} <FIcon name="arrow" size={14} />
              </button>
            )}>
            {m.attachments.total > 0 ? (
              <div>
                {m.attachments.by_type.length > 0 && (
                  <div className="flex min-h-[5rem] items-center justify-center border rounded-cell border-line/10 bg-panel/40 px-4 py-5">
                    <WordCloud data={m.attachments.by_type} onPick={(type) => setAttachments({ type })} />
                  </div>
                )}
              </div>
            ) : (
              <p className="font-mono text-xs text-fg/40">No files attached yet.</p>
            )}
          </Section>
        </>

        <>
          <Section n="12" title="Leaderboards">
            <Grid cols="md:grid-cols-2">
              <div className="bg-surface p-4">
                <p className="mb-3 font-mono text-label uppercase tracking-label text-fg/40">
                  Top projects
                </p>
                <ul className="divide-y divide-fg/10">
                  {m.by_project.slice(0, leaderRows).map((p, i) => (
                    <li key={p.cwd}>
                      <a href={`#/project/${encodeURIComponent(fproject(p.cwd))}`} className="flex items-center gap-3 py-2 transition-colors hover:text-hot">
                      <RankBadge n={i + 1} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-fg/75" title={p.cwd}>
                          {shortPath(p.cwd)}
                        </p>
                        <p className="font-mono text-label text-fg/40">
                          {p.sessions} sess · {compact(p.events)} ev · {formatRelative(p.last_activity)}
                        </p>
                      </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-surface p-4">
                <p className="mb-3 font-mono text-label uppercase tracking-label text-fg/40">
                  Busiest sessions
                </p>
                <ul className="divide-y divide-fg/10">
                  {m.busiest_sessions.slice(0, leaderRows).map((s, i) => (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        onClick={() => onSelect(s.session_id)}
                        className="flex w-full items-center gap-3 py-2 text-left">
                        <RankBadge n={i + 1} />
                        {/* Two lines, like Top projects, so both columns end together. */}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-xs text-fg/75 transition-colors hover:text-hot">{shortPath(s.cwd)}</span>
                          <span className="block font-mono text-label text-fg/40">{s.session_id.slice(0, 8)} · {compact(s.events)} ev</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </Grid>
          </Section>
        </>


        <>
          <p className="mt-4 px-5 pb-2 font-mono text-label uppercase leading-5 tracking-label text-fg/40" style={{ textWrap: 'pretty' }}>
            Charts below the agents are all-time · findings, spend and projects follow the window ·
            findings auto-resolve when the signal stops · AI analysis only runs when you ask
          </p>
        </>
      </div>

      {shareOpen && <ShareCardModal metrics={m} onClose={() => setShareOpen(false)} />}
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
      <AttachmentsDrawer
        open={!!attachments}
        initialType={attachments?.type}
        onClose={() => setAttachments(null)}
        onOpen={(sessionId, eventId) => {
          setAttachments(null);
          onSelect(sessionId, eventId);
        }}
      />
    </div>
  );
}

function Fact({ icon, label, value, onClick }: { icon: IconName; label: string; value: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center border border-line/20 text-fg/60 ${onClick ? 'transition-colors group-hover:border-hot group-hover:text-hot' : ''}`}>
        <Icon name={icon} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate font-mono text-sm font-semibold text-fg ${onClick ? 'transition-colors group-hover:text-hot' : ''}`} title={value}>
          {value}
        </p>
        <p className="font-mono text-label uppercase tracking-label text-fg/40">{label}</p>
      </div>
      {onClick && (
        <Icon name="chevron-right" className="h-3 w-3 shrink-0 text-fg/40 transition-colors group-hover:text-hot" />
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="group flex w-full items-center gap-3 bg-surface px-4 py-3 text-left transition-colors hover:bg-fg/[0.03]">
        {inner}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-3 bg-surface px-4 py-3">
      {inner}
    </div>
  );
}

function WordCloud({ data, onPick }: { data: { type: string; count: number }[]; onPick: (type: string) => void }) {
  const counts = data.map((d) => d.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  // Bigger word = more files of that type.
  const sized = [...data].sort((a, b) => b.count - a.count);
  const fontRem = (c: number) => (max === min ? 1.6 : 0.95 + ((c - min) / (max - min)) * 1.85);
  return (
    <div className="flex flex-wrap items-baseline justify-center gap-x-6 gap-y-2">
      {sized.map((d, i) => (
        <button
          type="button"
          key={d.type}
          onClick={() => onPick(d.type)}
          title={`${d.type} · ${d.count} ${d.count === 1 ? 'file' : 'files'} · show them`}
          style={{ fontSize: `${fontRem(d.count)}rem`, color: CHART_COLORS[i % CHART_COLORS.length] }}
          className="wc-word font-mono font-semibold leading-none">
          {d.type}
          <span className="ml-1 align-super font-mono text-label not-italic text-fg/40">
            {d.count}
          </span>
        </button>
      ))}
    </div>
  );
}

function RankBadge({ n }: { n: number }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center border border-line/20 font-mono text-label font-semibold tabular-nums ${
        n === 1 ? 'bg-hot text-on-hot' : 'text-fg/60'
      }`}>
      {n}
    </span>
  );
}

/**
 * Daily usage for the selected window: the year calendar for "all", otherwise
 * one strip cell per day (per hour, from tool calls, for the 24-hour window),
 * with the headline figures worked out over the same cells.
 */
function usageFor(days: number, byDay: Metrics['by_day'], series: ReturnType<typeof windowed>['series']) {
  type Cell = { key: string; label: string; value: number };
  let cells: Cell[] | null;
  let unit = 'events tracked';
  let step = 'day';
  if (days === 1) {
    cells = series.map((x) => ({ key: x.day, label: hourBucketLabel(x.day), value: x.tools }));
    unit = 'tool calls';
    step = 'hour';
  } else if (days > 0) {
    const counts = new Map(byDay.map((d) => [d.day, d.events]));
    cells = lastDays(days).map((day) => ({ key: day, label: formatMetricsDay(day), value: counts.get(day) ?? 0 }));
  } else {
    cells = null;
  }
  const all: Cell[] = cells ?? byDay.map((d) => ({ key: d.day, label: formatMetricsDay(d.day), value: d.events }));
  const active = all.filter((c) => c.value > 0);
  const total = all.reduce((n, c) => n + c.value, 0);
  const busiest = active.reduce<Cell | null>((b, c) => (!b || c.value > b.value ? c : b), null);
  return { cells, unit, step, total, active: active.length, avg: active.length ? Math.round(total / active.length) : 0, busiest };
}

/** The window's totals with one series point per day (per hour for the 24-hour
 * window), empty buckets included. */
function windowed(w: OverviewWindow | null | undefined, days: number) {
  const now = Date.now();
  const oldest = w?.oldest ? new Date(w.oldest).getTime() : now;
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const n = hourly ? 24 : Math.min(days || Math.max(1, Math.ceil((now - oldest) / DAY_MS)), 120);
  const byDay = new Map((w?.series ?? []).map((x) => [x.day, x]));
  const series = Array.from({ length: n }, (_, i) => {
    const day = new Date(now - (n - 1 - i) * step).toISOString().slice(0, hourly ? 13 : 10);
    const x = byDay.get(day);
    return { day, cost: x?.cost ?? 0, sessions: x?.sessions ?? 0, tools: x?.tools ?? 0, events: x?.tools ?? 0 };
  });
  return { sessions: w?.sessions ?? 0, cost: w?.cost ?? 0, tools: w?.tools ?? 0, series, projects: w?.projects ?? [] };
}

/** Loading state in the demo's skeleton style (.sk blocks in the same layout as the loaded page). */
function OverviewSkeleton() {
  return (
    <div className="scroll" id="vf-scroll" aria-busy="true">
      <div className="page">
        <div className="ph">
          <div style={{ display: 'grid', gap: 10 }}>
            <span className="sk" style={{ height: 12, width: 70 }} />
            <span className="sk" style={{ height: 30, width: 260 }} />
            <span className="sk" style={{ height: 14, width: 320 }} />
          </div>
        </div>
        <div className="kpis">
          {[0, 1, 2, 3].map((i) => (
            <div className="kpi" key={i}>
              <span className="sk" style={{ height: 10, width: 80 }} />
              <span className="sk" style={{ height: 28, width: 110, margin: '4px 0' }} />
              <span className="sk" style={{ height: 12, width: 140 }} />
            </div>
          ))}
        </div>
        <div className="grid-2">
          <div className="card"><div className="card-b"><span className="sk" style={{ display: 'block', height: 220 }} /></div></div>
          <div className="card"><div className="card-b"><span className="sk" style={{ display: 'block', height: 220 }} /></div></div>
        </div>
      </div>
    </div>
  );
}

/** Where a click on an Event categories bar goes: the Activity page for that kind of event. */
const CATEGORY_HREF: Record<string, string> = {
  shell: '#/metrics-history',
  web: '#/metrics-history?tab=web',
  file_edit: '#/metrics-history?tab=edits',
  mcp: '#/metrics-history?tab=mcp',
  skill: '#/metrics-history?tab=skill',
  prompt: '#/sessions?sort=events',
  response: '#/sessions?sort=events',
};

/** Agent tiles per row: a full row when it fits, else two even rows (6 → 3 + 3, not 4 + 2). */
/** One quiet word per agent tile on how its sessions reach cot. Only missing hooks
 *  are a warning; agents read from disk are simply imported. */
function CaptureChip({ health }: { health: HookHealthState | undefined }) {
  if (health === undefined) return <span className="vchip c-dim" title="Read from the agent's files on disk">imported</span>;
  if (health === 'missing_hooks' || health === 'not_installed') {
    return <span className="vchip c-warn" title="Hooks are missing: new sessions only arrive by import. Fix it under Coverage."><span className="dot" />hooks off</span>;
  }
  return <span className="vchip c-ok" title="Events arrive live from the agent's hooks"><span className="dot" />live hooks</span>;
}
