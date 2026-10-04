import { useEffect, useMemo, useState } from 'react';
import {
  getAiAnalyses,
  getInsights,
  getMetrics,
  getConnections,
  getOverviewWindow,
  getSessionsPage,
  type AiAnalysis,
  type Connection,
  type InsightPillar,
  type InsightsResponse,
  type Metrics,
  type OverviewWindow,
  type SessionSummary,
} from '../../lib/api';
import { formatDuration, formatRelative, getCategoryMeta, userTimeZone } from '../../lib/categoryMeta';
import { compact, formatCost, formatMetricsDay, hourLabel } from '../../lib/format';
import { formatModel } from '../../lib/modelMeta';
import { sourceLabel } from '../../lib/sourceLabels';
import { usePolling } from '../../lib/usePolling';
import { getPrefs } from '../../lib/prefs';
import { Icon, type IconName } from '../ui/icons';
import { CardNote } from '../ui/Surface';
import { CHART_COLORS, type Datum } from './chartConstants';
import { DailyArea, DonutChart, HBars, HourBars } from './chartTheme';
import { ExecutiveSummary } from './ExecutiveSummary';
import { Columns, ShareBars as FShareBars, Sparkline, StackBar as FStackBar } from '../forest/charts';
import { fmt, modelLabel, project as fproject } from '../forest/format';
import { Icon as FIcon } from '../forest/icons';
import { Agent, agentColor as fAgentColor, Seg as FSeg, Sev } from '../forest/ui';
import { ExportModal } from './ExportModal';
import { ContributionHeatmap } from './metricsCharts';
import { ShareCardModal } from './ShareCardModal';

const CARD_GRID = 'overflow-hidden rounded-cell border border-line/10 bg-line/10';

interface OverviewViewProps {
  onSelect: (id: string, eventId?: number) => void;
  onHistory?: (tab?: 'shell' | 'web') => void;
  onFindings?: (pillar?: InsightPillar) => void;
}

const WINDOWS = [
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];
const DAY_MS = 86_400_000;

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

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="font-mono text-label uppercase tracking-label text-fg/40">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent ?? 'text-fg'}`}>{value}</p>
      {hint && <p className="font-mono text-label text-fg/40">{hint}</p>}
    </div>
  );
}

function Spotlight({
  kicker,
  value,
  sub,
  accent,
}: {
  kicker: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div className="bg-surface px-4 py-5">
      <p className="font-mono text-label font-semibold uppercase tracking-label text-fg/60">
        {kicker}
      </p>
      <p className={`mt-1 font-mono text-3xl font-semibold leading-none tracking-[-0.02em] ${accent}`}>
        {value}
      </p>
      <p className="mt-2 font-mono text-label uppercase tracking-label text-fg/60">{sub}</p>
    </div>
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

  // The executive summary leads with the latest saved AI analysis, if one exists.
  const [analyses, setAnalyses] = useState<AiAnalysis[]>([]);
  useEffect(() => {
    getAiAnalyses().then(setAnalyses).catch(() => {});
  }, []);
  const latestAi = analyses.find((a) => a.status === 'ok' && a.result) ?? null;

  const jumpToPillar = (pillar: InsightPillar) => onFindings?.(pillar);

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
  const dayData = m.by_day.map((d) => ({ day: d.day, events: d.events }));
  const activeDays = m.by_day.length;
  const avgPerActive = activeDays
    ? Math.round(m.by_day.reduce((n, d) => n + d.events, 0) / activeDays)
    : 0;

  const categoryData: Datum[] = m.by_category.slice(0, 8).map((c, i) => ({
    name: getCategoryMeta(c.category).label,
    value: c.events,
    color: CHART_COLORS[i % CHART_COLORS.length],
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
    { k: 'Sessions', v: fmt.n(win.sessions), spark: win.series.map((x) => x.sessions), note: `${t.active_sessions} live now` },
    { k: 'Spend', v: fmt.usd(win.cost), spark: win.series.map((x) => x.cost), note: 'list price, all models' },
    { k: 'Tool calls', v: fmt.n(win.tools), spark: win.series.map((x) => x.events), note: `${fmt.pct(fun.error_rate)} errored` },
    { k: 'Needs review', v: ins ? fmt.n(review.length) : '…', spark: undefined, note: ins ? `${criticals} critical · ${active.length} open in total` : 'computing…' },
  ];

  const now = new Date().toISOString();
  const models = [...m.cost.by_model].filter((x) => (x.cost ?? 0) > 0).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  // Markup below mirrors the demo's Overview (demo-variants/src/variants/forest/pages-a.tsx) one to one.
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Overview</span>
            <h1>Local workspace</h1>
            <p>{days ? `Last ${days} days` : 'All time'} across {win.projects.length} projects and {sources.length} agents.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <FSeg id="vf-range" value={days} options={WINDOWS} onChange={setDays} />
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setExportOpen(true)}><FIcon name="download" size={15} />Export</button>
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setShareOpen(true)} title="Share a metrics card"><FIcon name="external" size={15} />Share</button>
          </div>
        </div>

        <div className="kpis">
          {kpis.map((k) => (
            <div className="kpi" key={k.k}>
              <span className="label">{k.k}</span>
              <span className="v">{k.v}</span>
              <span className="d"><span className="truncate">{k.note}</span>{k.spark && <span style={{ color: 'var(--v-hot)' }}><Sparkline values={k.spark} width={72} height={20} /></span>}</span>
            </div>
          ))}
        </div>

        <div className="grid-2">
          <section className="card" aria-labelledby="vf-spend">
            <div className="card-h"><span className="card-t" id="vf-spend">Daily spend</span><span className="mono faint" style={{ fontSize: 12 }}>{fmt.usd(win.cost)} total</span></div>
            <div className="card-b">
              <Columns key={days} data={win.series.map((x) => ({ key: x.day, value: x.cost }))} color="var(--v-hot)" muted="var(--v-mute)" label={fmt.day} format={fmt.usd} height={180} />
            </div>
          </section>
          <section className="card" aria-labelledby="vf-review">
            <div className="card-h"><span className="card-t" id="vf-review">Needs review</span><button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => onFindings?.()}>All findings <FIcon name="arrow" size={14} /></button></div>
            {!ins ? (
              <div className="card-b dim" style={{ fontSize: 13 }}>Computing findings…</div>
            ) : (
              <ul className="card-b" style={{ listStyle: 'none', margin: 0, display: 'grid', gap: 2 }}>
                {review.length === 0 && <li className="dim" style={{ fontSize: 13 }}>Nothing needs review.</li>}
                {review.slice(0, 5).map((f) => (
                  <li key={f.fingerprint}>
                    <button type="button" onClick={() => onFindings?.(f.pillar)} className="hov" style={{ width: 'calc(100% + 16px)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'center', padding: '8px 8px', margin: '0 -8px', borderRadius: 10, border: 0, background: 'none', textAlign: 'left' }}>
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
          <section className="card" aria-labelledby="vf-proj" style={{ overflow: 'hidden' }}>
            <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t" id="vf-proj">Projects</span><span className="label">by spend</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="t">
                <thead><tr><th>Project</th><th>Agents</th><th className="num">Sessions</th><th className="num">Spend</th><th className="num">Findings</th></tr></thead>
                <tbody>
                  {win.projects.map((p) => {
                    const fx = projectFindings(p.cwd);
                    return (
                      <tr key={p.cwd ?? '-'}>
                        <td><span className="mono" style={{ fontSize: 12 }} title={p.cwd ?? ''}>{fproject(p.cwd)}</span></td>
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
            <div className="card-h"><span className="card-t" id="vf-models">Spend by model</span><span className="label">all time</span></div>
            <div className="card-b">
              <FShareBars rows={models.map((x) => ({ key: x.model, label: <span className="mono" style={{ fontSize: 12 }}>{modelLabel(x.model)}</span>, value: x.cost ?? 0 }))} color="var(--v-hot)" track="var(--v-panel)" format={fmt.usd} />
              {m.cost.unpriced_models.length > 0 && <p className="faint" style={{ fontSize: 12, margin: '14px 0 0' }}>Unpriced: {m.cost.unpriced_models.slice(0, 4).map(modelLabel).join(', ')}{m.cost.unpriced_models.length > 4 ? '…' : ''}</p>}
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16 }} aria-labelledby="vf-agents">
          <div className="card-h"><span className="card-t" id="vf-agents">Agents</span><a href="#/governance" className="vbtn vbtn-ghost vbtn-sm">Coverage <FIcon name="arrow" size={14} /></a></div>
          <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {(connections ?? m.by_source.map((x) => ({ source: x.source, sessions: x.sessions, events: x.events, last_event: null, connected: true }))).map((c) => (
              <div key={c.source} style={{ display: 'grid', gap: 6, padding: 14, borderRadius: 12, background: 'var(--v-bg)', border: '1px solid var(--v-line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><Agent id={c.source} /><span className={`vchip ${c.connected ? 'c-ok' : 'c-dim'}`}><span className="dot" />{c.connected ? 'connected' : 'not connected'}</span></div>
                <span className="mono" style={{ fontSize: 12 }}>{c.sessions} sessions · {fmt.n(c.events)} events</span>
                <span className="faint" style={{ fontSize: 12 }}>{c.last_event ? `Last event ${fmt.ago(c.last_event, now)}` : 'No events yet'}</span>
              </div>
            ))}
          </div>
        </section>

        <Section title="Executive summary">
          <ExecutiveSummary insights={ins ?? null} metrics={m} aiAnalysis={latestAi} onJump={jumpToPillar} />
        </Section>

        <>
          <Section n="01" title="Daily usage">
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-x-7 gap-y-1">
                <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                  {compact(t.events)}{' '}
                  <span className="text-label font-normal uppercase tracking-label text-fg/60">
                    events tracked
                  </span>
                </span>
                <span className="font-mono text-label text-fg/60">
                  {activeDays} active {activeDays === 1 ? 'day' : 'days'}
                </span>
                <span className="font-mono text-label text-fg/60">
                  ~{compact(avgPerActive)} events / day
                </span>
                {fun.busiest_day && (
                  <span className="font-mono text-label text-fg/60">
                    busiest{' '}
                    <span className="font-semibold text-fg/80">{formatMetricsDay(fun.busiest_day.day)}</span> ·{' '}
                    {compact(fun.busiest_day.events)}
                  </span>
                )}
              </div>
              <ContributionHeatmap data={m.by_day.map((d) => ({ label: d.day, value: d.events }))} />
            </div>
          </Section>
        </>

        <>
          <Section n="02" title="Highlights">
            <Grid cols="grid-cols-1 sm:grid-cols-3">
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
            </Grid>
          </Section>
        </>

        <>
          <Section n="03" title="Activity">
            <Grid cols="md:grid-cols-2">
              <ChartBox label="Events per day">
                <DailyArea data={dayData.slice(-45)} />
              </ChartBox>
              <ChartBox label={`By hour — peak ${fun.peak_hour != null ? hourLabel(fun.peak_hour) : '—'}`}>
                <HourBars data={m.by_hour} peak={fun.peak_hour} />
              </ChartBox>
            </Grid>
          </Section>
        </>


        <>
          <Section n="05" title="Breakdown">
            <Grid cols="md:grid-cols-2">
              <ChartBox label="Event categories">
                <HBars data={categoryData} />
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
                    {m.by_source.map((s) => (
                      <div key={s.source} className="">
                        <p className="font-mono text-sm font-semibold text-fg">{sourceLabel(s.source)}</p>
                        <p className="font-mono text-label text-fg/60">
                          {s.sessions} sess · {compact(s.events)} ev
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </ChartBox>
            </Grid>
          </Section>
        </>


        <>
          <Section n="08" title="All time" aside={<CardNote>since install</CardNote>}>
            <Grid cols="grid-cols-2 sm:grid-cols-4">
              <Stat label="Sessions" value={compact(t.sessions)} hint={`${t.active_sessions} active now`} />
              <Stat label="Events" value={compact(t.events)} />
              <Stat label="Tool calls" value={compact(t.tool_calls)} />
              <Stat label="Tokens" value={compact(m.tokens.total)} />
              <Stat label="Est. cost" value={m.cost.total > 0 ? formatCost(m.cost.total) : '—'} />
              <Stat label="Projects" value={compact(t.projects)} />
              <Stat label="Fixed this week" value={ins ? String(ins.counts.resolved_recently) : '…'} accent="text-olive" />
              <Stat label="Error rate" value={`${(fun.error_rate * 100).toFixed(1)}%`} />
              <Stat label="Errors" value={compact(t.errors)} />
              <Stat label="Permissions" value={compact(t.permissions)} />
              <Stat
                label="Avg session"
                value={t.avg_duration_seconds ? formatDuration(null, t.avg_duration_seconds) : '—'}
              />
            </Grid>
          </Section>
        </>


        {fun.busiest_day && (
          <>
            <Section n="10" title="By the numbers">
              <Grid cols="grid-cols-2 sm:grid-cols-3">
                <Fact icon="terminal" label="Shell commands" value={compact(fun.shell_commands)} onClick={() => onHistory?.('shell')} />
                <Fact icon="file" label="Files touched" value={compact(fun.files_touched)} />
                <Fact icon="edit" label="Edits / reads" value={`${compact(fun.files_edited)} / ${compact(fun.files_read)}`} />
                <Fact icon="plug" label="MCP calls" value={compact(fun.mcp_calls)} />
                <Fact icon="globe" label="Web fetches" value={compact(fun.web_calls)} onClick={() => onHistory?.('web')} />
                <Fact icon="chat" label="Prompts / replies" value={`${compact(fun.prompts)} / ${compact(fun.responses)}`} />
                <Fact icon="brain" label="Thoughts" value={compact(fun.thoughts)} />
                <Fact icon="search" label="Favorite tool" value={fun.top_tool ?? '—'} />
                <Fact icon="layers" label="Projects" value={compact(t.projects)} />
              </Grid>
            </Section>
          </>
        )}

        <>
          <Section n="11" title="Attachments">
            {m.attachments.total > 0 ? (
              <div>
                {m.attachments.by_type.length > 0 && (
                  <div className="flex min-h-[5rem] items-center justify-center border rounded-cell border-line/10 bg-panel/40 px-4 py-5">
                    <WordCloud data={m.attachments.by_type} />
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
                  {m.by_project.map((p, i) => (
                    <li key={p.cwd} className="flex items-center gap-3 py-2">
                      <RankBadge n={i + 1} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-fg/75" title={p.cwd}>
                          {shortPath(p.cwd)}
                        </p>
                        <p className="font-mono text-label text-fg/40">
                          {p.sessions} sess · {compact(p.events)} ev · {formatRelative(p.last_activity)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-surface p-4">
                <p className="mb-3 font-mono text-label uppercase tracking-label text-fg/40">
                  Busiest sessions
                </p>
                <ul className="divide-y divide-fg/10">
                  {m.busiest_sessions.map((s, i) => (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        onClick={() => onSelect(s.session_id)}
                        className="flex w-full items-center gap-3 py-2 text-left">
                        <RankBadge n={i + 1} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg/75 transition-colors hover:text-hot">
                          {shortPath(s.cwd)} <span className="text-fg/40">{s.session_id.slice(0, 8)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-label tabular-nums text-fg/60">
                          {compact(s.events)}
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

function WordCloud({ data }: { data: { type: string; count: number }[] }) {
  const counts = data.map((d) => d.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  // Bigger word = more files of that type.
  const sized = [...data].sort((a, b) => b.count - a.count);
  const fontRem = (c: number) => (max === min ? 1.6 : 0.95 + ((c - min) / (max - min)) * 1.85);
  return (
    <div className="flex flex-wrap items-baseline justify-center gap-x-6 gap-y-2">
      {sized.map((d, i) => (
        <span
          key={d.type}
          title={`${d.type} · ${d.count} ${d.count === 1 ? 'file' : 'files'}`}
          style={{ fontSize: `${fontRem(d.count)}rem`, color: CHART_COLORS[i % CHART_COLORS.length] }}
          className="font-mono font-semibold leading-none">
          {d.type}
          <span className="ml-1 align-super font-mono text-label not-italic text-fg/40">
            {d.count}
          </span>
        </span>
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

/** The window's totals with one series point per day, empty days included. */
function windowed(w: OverviewWindow | null | undefined, days: number) {
  const now = Date.now();
  const oldest = w?.oldest ? new Date(w.oldest).getTime() : now;
  const nDays = Math.min(days || Math.max(1, Math.ceil((now - oldest) / DAY_MS)), 120);
  const byDay = new Map((w?.series ?? []).map((x) => [x.day, x]));
  const series = Array.from({ length: nDays }, (_, i) => {
    const day = new Date(now - (nDays - 1 - i) * DAY_MS).toISOString().slice(0, 10);
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
