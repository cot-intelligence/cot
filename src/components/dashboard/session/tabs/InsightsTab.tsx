import { useMemo, useState } from 'react';
import type { CostModelEstimate, SessionDetail } from '../../../../lib/api';
import { formatDuration, getCategoryMeta, toTimestampString } from '../../../../lib/categoryMeta';
import { formatModel } from '../../../../lib/modelMeta';
import { buildInsights } from '../../../../lib/sessionInsights';
import { CHART_COLORS, type Datum } from '../../chartConstants';
import { AreaTrend, DonutChart, HBars } from '../../chartTheme';

interface InsightsTabProps {
  detail: SessionDetail;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
function dollars(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${compact(Math.round(n))}`;
}

// --- line-based building blocks (shared visual language with the Metrics page) ---

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">{n}</span>
        <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em] text-fg/65">
          {title}
        </h3>
        <span className="ml-1 h-px flex-1 bg-fg/10" />
      </div>
      {children}
    </section>
  );
}

function Grid({ cols, children }: { cols: string; children: React.ReactNode }) {
  return <div className={`grid gap-px bg-fg/10 ${cols}`}>{children}</div>;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-bg px-4 py-3">
      <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
      <p className={`mt-1 font-mono text-xl font-bold tabular-nums ${accent ? 'text-vermilion' : 'text-fg'}`}>
        {value}
      </p>
    </div>
  );
}

function ChartBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg p-4">
      <p className="mb-3 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
      {children}
    </div>
  );
}

export function InsightsTab({ detail }: InsightsTabProps) {
  const { summary: narrative, insights } = buildInsights(detail);
  const [open, setOpen] = useState(false);

  const s = detail.summary;
  const c = s.category_counts ?? {};
  const events = detail.events;
  const cat = (k: string) => c[k] ?? 0;

  const computed = useMemo(() => {
    const errors = events.filter((e) => e.status === 'error' || e.status === 'blocked');
    const stopped = events.filter((e) => e.status === 'interrupted');
    const responses = events.filter((e) => e.category === 'response');
    const avgResp = responses.length
      ? Math.round(responses.reduce((n, e) => n + (e.detail?.length ?? 0), 0) / responses.length)
      : 0;
    const modelCounts = new Map<string, number>();
    for (const e of events) if (e.model) modelCounts.set(e.model, (modelCounts.get(e.model) ?? 0) + 1);
    const longest = [...events]
      .filter((e) => (e.duration_ms ?? 0) > 0)
      .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
      .slice(0, 4);

    // Activity binned across the session lifetime.
    const ts = events
      .map((e) => Date.parse(toTimestampString(e.start_ts || e.ts)))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    let activity: { label: string; value: number }[] = [];
    if (ts.length >= 2) {
      const start = ts[0];
      const span = ts[ts.length - 1] - start || 1;
      const N = 32;
      const bins = new Array(N).fill(0);
      for (const t of ts) bins[Math.min(N - 1, Math.floor(((t - start) / span) * N))]++;
      activity = bins.map((v, i) => ({
        label: new Date(start + (i / N) * span).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        value: v,
      }));
    }
    return { errors, stopped, responses, avgResp, modelCounts, longest, activity };
  }, [events]);

  const categoryData: Datum[] = useMemo(
    () =>
      Object.entries(c)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v], i) => ({
          name: getCategoryMeta(k).label,
          value: v,
          color: CHART_COLORS[i % CHART_COLORS.length],
        })),
    [c],
  );

  const modelData: Datum[] = useMemo(
    () =>
      [...computed.modelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([m, n], i) => ({ name: formatModel(m), value: n, color: CHART_COLORS[i % CHART_COLORS.length] })),
    [computed.modelCounts],
  );

  const hasTokens = s.tokens.total > 0;
  const tokenData: Datum[] = [
    { name: 'Output', value: s.tokens.output, color: CHART_COLORS[0] },
    { name: 'Input', value: s.tokens.input, color: CHART_COLORS[1] },
    { name: 'Cache read', value: s.tokens.cache_read, color: CHART_COLORS[2] },
    { name: 'Cache write', value: s.tokens.cache_write, color: CHART_COLORS[3] },
  ];

  const costByModel = useMemo(() => {
    const map = new Map<string, CostModelEstimate>();
    for (const m of s.cost.models ?? []) {
      if (m.model) map.set(formatModel(m.model), m);
    }
    return map;
  }, [s.cost.models]);

  const hasCost = s.cost.total_usd > 0;
  const costData: Datum[] = hasCost
    ? [
        { name: 'Input', value: s.cost.models.reduce((n, m) => n + m.input_usd, 0), color: CHART_COLORS[1] },
        { name: 'Output', value: s.cost.models.reduce((n, m) => n + m.output_usd, 0), color: CHART_COLORS[0] },
        { name: 'Cache read', value: s.cost.models.reduce((n, m) => n + m.cache_read_usd, 0), color: CHART_COLORS[2] },
        { name: 'Cache write', value: s.cost.models.reduce((n, m) => n + m.cache_write_usd, 0), color: CHART_COLORS[3] },
      ].filter((d) => d.value > 0)
    : [];

  const files = [
    ...detail.components.files_edited.map((f) => ({ path: f.path!, count: f.count, kind: 'edit' as const })),
    ...detail.components.files_read.map((f) => ({ path: f.path!, count: f.count, kind: 'read' as const })),
  ];

  return (
    <div className="space-y-7">
      <p className="font-sans text-sm leading-relaxed text-fg/80">{narrative}</p>

      {/* Headline stats */}
      <Grid cols="grid-cols-2 sm:grid-cols-5">
        <Stat label="Duration" value={s.duration_seconds ? formatDuration(null, s.duration_seconds) : '—'} />
        <Stat label="Events" value={compact(s.event_count)} />
        <Stat label="Tool calls" value={compact(s.tool_count)} />
        <Stat label="Tokens" value={hasTokens ? compact(s.tokens.total) : '—'} />
        <Stat label="Est. cost" value={dollars(s.cost.total_usd)} accent={s.cost.total_usd > 0} />
      </Grid>

      <Section n="01" title="Activity">
        {computed.activity.length ? (
          <div className="bg-bg p-4">
            <AreaTrend data={computed.activity} />
          </div>
        ) : (
          <p className="font-mono text-xs text-fg/40">Not enough activity to chart.</p>
        )}
      </Section>

      <Section n="02" title="Breakdown">
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
                  {modelData.map((d, i) => {
                    const cm = costByModel.get(d.name);
                    return (
                      <div
                        key={d.name}
                        className="flex items-center justify-between gap-2 font-mono text-[0.62rem]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0"
                            style={{ background: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }}
                          />
                          <span className="truncate text-fg/70">{d.name}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-fg/45">
                          {cm && cm.pricing_found ? dollars(cm.total_usd) : 'unpriced'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="font-mono text-xs text-fg/40">No model data captured.</p>
            )}
          </ChartBox>
        </Grid>
      </Section>

      <Section n="03" title="Tokens & cost">
        <Grid cols="md:grid-cols-2">
          <ChartBox label={hasTokens ? `Token usage — ${compact(s.tokens.total)} total` : 'Token usage'}>
            {hasTokens ? (
              <div className="space-y-3">
                <HBars data={tokenData} height={150} />
                <p className="font-mono text-[0.58rem] text-fg/40">
                  {s.cost.unpriced_tokens
                    ? `${compact(s.cost.unpriced_tokens)} tokens could not be priced.`
                    : `Estimated at ${dollars(s.cost.total_usd)}.`}
                </p>
              </div>
            ) : (
              <p className="font-mono text-xs text-fg/40">No token data (Claude sessions only).</p>
            )}
          </ChartBox>
          <ChartBox label={hasCost ? `Cost breakdown — ${dollars(s.cost.total_usd)}` : 'Cost breakdown'}>
            {hasCost ? (
              <div className="space-y-3">
                <HBars data={costData} height={150} />
                <ul className="space-y-1">
                  {costData.map((d, i) => (
                    <li key={d.name} className="flex items-center justify-between gap-2 font-mono text-[0.62rem]">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0"
                          style={{ background: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="text-fg/70">{d.name}</span>
                      </span>
                      <span className="tabular-nums text-fg/45">{dollars(d.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="font-mono text-xs text-fg/40">No cost data available.</p>
            )}
          </ChartBox>
        </Grid>
      </Section>

      <Section n="04" title="Files">
        <div className="bg-bg p-4">
          <p className="mb-3 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
            Files touched — {files.length}
          </p>
          {files.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {files.slice(0, 24).map((f) => (
                <li
                  key={`${f.kind}-${f.path}`}
                  title={f.path}
                  className={`max-w-full truncate border px-2 py-1 font-mono text-[0.58rem] ${
                    f.kind === 'edit' ? 'border-vermilion/30 text-vermilion' : 'border-fg/15 text-fg/55'
                  }`}>
                  {f.path.split('/').slice(-1)[0]}
                  <span className="ml-1 text-fg/30">{f.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-xs text-fg/40">No files touched.</p>
          )}
        </div>
      </Section>

      <Section n="05" title="Conversation">
        <Grid cols="grid-cols-3 sm:grid-cols-4">
          <Stat label="Prompts" value={compact(cat('prompt'))} />
          <Stat label="Replies" value={compact(cat('response'))} />
          <Stat label="Thoughts" value={compact(cat('thought'))} />
          <Stat label="Avg reply" value={computed.avgResp ? `${compact(computed.avgResp)} ch` : '—'} />
          {computed.stopped.length > 0 && (
            <Stat label="Stopped" value={compact(computed.stopped.length)} accent />
          )}
        </Grid>
      </Section>

      {(computed.errors.length > 0 || computed.longest.length > 0) && (
        <Section n="06" title="Errors & notable">
          <Grid cols="md:grid-cols-2">
            <ChartBox label={`Longest-running (${computed.longest.length})`}>
              {computed.longest.length ? (
                <ul className="space-y-2">
                  {computed.longest.map((e) => {
                    const meta = getCategoryMeta(e.category);
                    return (
                      <li key={e.id} className="flex items-center justify-between gap-2 font-mono text-[0.62rem]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                          <span className="truncate text-fg/70">{e.title}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-fg/45">
                          {formatDuration(e.duration_ms)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="font-mono text-xs text-fg/40">—</p>
              )}
            </ChartBox>
            <ChartBox label={`Errors & blocked (${computed.errors.length})`}>
              {computed.errors.length ? (
                <ul className="space-y-1.5">
                  {computed.errors.slice(0, 8).map((e) => (
                    <li key={e.id} className="flex items-center gap-2 font-mono text-[0.62rem] text-fg/65">
                      <span className="rounded bg-vermilion px-1 py-0.5 text-[0.5rem] font-bold uppercase text-cream">
                        {e.status}
                      </span>
                      <span className="truncate">{e.title}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="font-mono text-xs text-fg/40">No errors — clean run.</p>
              )}
            </ChartBox>
          </Grid>
        </Section>
      )}

      {insights.length > 0 && (
        <div className="space-y-3 border-t border-fg/10 pt-5">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="font-mono text-[0.6rem] uppercase tracking-widest text-fg/45 hover:text-fg">
            {open ? 'Hide notes' : `Show narrative notes (${insights.length})`}
          </button>
          {open && (
            <ul className="space-y-2">
              {insights.map((ins, i) => (
                <li key={i} className="border-l-2 border-fg/20 pl-3">
                  <p className="font-mono text-xs font-bold text-fg">{ins.title}</p>
                  <p className="font-sans text-xs leading-relaxed text-fg/60">{ins.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
