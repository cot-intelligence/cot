import { useState } from 'react';
import { getMetrics, type Metrics } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { formatDuration, formatRelative, getCategoryMeta } from '../../lib/categoryMeta';
import { formatModel } from '../../lib/modelMeta';
import { sourceLabel } from '../../lib/sourceLabels';
import { FadeIn } from '../ui/FadeIn';
import { Icon, type IconName } from '../ui/icons';
import { MetricsSkeleton } from '../ui/Skeleton';
import { CHART_COLORS, type Datum } from './chartConstants';
import { DailyArea, DonutChart, HBars, HourBars } from './chartTheme';
import { ContributionHeatmap } from './metricsCharts';
import { ShareCardModal } from './ShareCardModal';

interface MetricsViewProps {
  onSelect: (id: string) => void;
  onHistory?: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

import { compact, hourLabel } from '../../lib/format';
function niceDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}
function shortPath(p: string | null): string {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}
function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

// --- line-based building blocks (no cards) ---

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">{n}</span>
        <h2 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em] text-fg/65">
          {title}
        </h2>
        <span className="ml-1 h-px flex-1 bg-fg/10" />
      </div>
      {children}
    </section>
  );
}

/** Seamless ruled grid — cells share single hairlines, no outer box. */
function Grid({ cols, children }: { cols: string; children: React.ReactNode }) {
  return <div className={`grid gap-px bg-fg/10 ${cols}`}>{children}</div>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-bg px-4 py-3">
      <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-fg">{value}</p>
      {hint && <p className="font-mono text-[0.55rem] text-fg/40">{hint}</p>}
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
    <div className="bg-bg px-4 py-5">
      <p className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
        {kicker}
      </p>
      <p className={`mt-1 font-serif text-4xl font-extrabold italic leading-none ${accent}`}>
        {value}
      </p>
      <p className="mt-2 font-mono text-[0.55rem] uppercase tracking-widest text-fg/45">{sub}</p>
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

export function MetricsView({ onSelect, onHistory }: MetricsViewProps) {
  const { data: m, error } = usePolling<Metrics>(() => getMetrics(), 5000);
  const [shareOpen, setShareOpen] = useState(false);

  if (!m) {
    if (error) {
      return (
        <div className="scroll-thin flex-1 overflow-y-auto">
          <p className="mx-auto max-w-5xl px-6 py-12 font-mono text-xs text-fg/40">
            Collector offline — metrics unavailable.
          </p>
        </div>
      );
    }
    return <MetricsSkeleton />;
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

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-7 px-6 py-8 sm:px-8">
        <FadeIn className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-extrabold uppercase tracking-tight text-fg">
              Metrics <span className="font-serif lowercase italic text-vermilion">overview</span>
            </h1>
            <p className="font-mono text-xs text-fg/50">
              Aggregated insights across every traced session.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            title="Share a metrics card"
            className="flex shrink-0 items-center gap-2 border border-fg/25 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/75 shadow-brutal-sm transition-colors hover:border-vermilion hover:text-vermilion focus-visible:border-vermilion focus-visible:outline-none">
            <Icon name="share" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Share</span>
          </button>
        </FadeIn>

        {/* Headline stat strip */}
        <FadeIn delay={0.03}>
          <Grid cols="grid-cols-2 sm:grid-cols-4">
            <Stat label="Sessions" value={compact(t.sessions)} hint={`${t.active_sessions} active now`} />
            <Stat label="Events" value={compact(t.events)} />
            <Stat label="Tool calls" value={compact(t.tool_calls)} />
            <Stat label="Tokens" value={compact(m.tokens.total)} hint="Claude only" />
          </Grid>
        </FadeIn>

        <FadeIn delay={0.05}>
          <Section n="01" title="Daily usage">
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-x-7 gap-y-1">
                <span className="font-mono text-sm font-bold tabular-nums text-fg">
                  {compact(t.events)}{' '}
                  <span className="text-[0.55rem] font-normal uppercase tracking-widest text-fg/45">
                    events tracked
                  </span>
                </span>
                <span className="font-mono text-[0.62rem] text-fg/55">
                  {activeDays} active {activeDays === 1 ? 'day' : 'days'}
                </span>
                <span className="font-mono text-[0.62rem] text-fg/55">
                  ~{compact(avgPerActive)} events / day
                </span>
                {fun.busiest_day && (
                  <span className="font-mono text-[0.62rem] text-fg/55">
                    busiest{' '}
                    <span className="font-bold text-fg/80">{niceDay(fun.busiest_day.day)}</span> ·{' '}
                    {compact(fun.busiest_day.events)}
                  </span>
                )}
              </div>
              <ContributionHeatmap data={m.by_day.map((d) => ({ label: d.day, value: d.events }))} />
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.06}>
          <Section n="02" title="Highlights">
            <Grid cols="grid-cols-1 sm:grid-cols-3">
              <Spotlight
                accent="text-vermilion"
                kicker="Peak activity"
                value={fun.peak_hour != null ? hourLabel(fun.peak_hour) : '—'}
                sub="busiest hour of day"
              />
              <Spotlight
                accent="text-cobalt"
                kicker="Busiest day"
                value={fun.busiest_day ? niceDay(fun.busiest_day.day) : '—'}
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
        </FadeIn>

        <FadeIn delay={0.07}>
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
        </FadeIn>

        <FadeIn delay={0.08}>
          <Section n="04" title="Breakdown">
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
                          className="flex items-center justify-between gap-2 font-mono text-[0.62rem]">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="h-2 w-2 shrink-0"
                              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                            />
                            <span className="truncate">{formatModel(model.model)}</span>
                          </span>
                          <span className="shrink-0 text-fg/45">{compact(model.events)}</span>
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
        </FadeIn>

        <FadeIn delay={0.09}>
          <Section n="05" title="Tokens & agents">
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
                      <div key={s.source} className="border-l-2 border-fg/20 pl-2.5">
                        <p className="font-mono text-sm font-bold text-fg">{sourceLabel(s.source)}</p>
                        <p className="font-mono text-[0.55rem] text-fg/45">
                          {s.sessions} sess · {compact(s.events)} ev
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </ChartBox>
            </Grid>
          </Section>
        </FadeIn>

        <FadeIn delay={0.1}>
          <Section n="06" title="Reliability">
            <Grid cols="grid-cols-2 sm:grid-cols-4">
              <Stat label="Error rate" value={`${(fun.error_rate * 100).toFixed(1)}%`} />
              <Stat label="Errors" value={compact(t.errors)} />
              <Stat label="Permissions" value={compact(t.permissions)} />
              <Stat
                label="Avg session"
                value={t.avg_duration_seconds ? formatDuration(null, t.avg_duration_seconds) : '—'}
              />
            </Grid>
          </Section>
        </FadeIn>

        {fun.busiest_day && (
          <FadeIn delay={0.11}>
            <Section n="07" title="By the numbers">
              <Grid cols="grid-cols-2 sm:grid-cols-3">
                <Fact icon="terminal" label="Shell commands" value={compact(fun.shell_commands)} onClick={onHistory} />
                <Fact icon="file" label="Files touched" value={compact(fun.files_touched)} />
                <Fact icon="edit" label="Edits / reads" value={`${compact(fun.files_edited)} / ${compact(fun.files_read)}`} />
                <Fact icon="plug" label="MCP calls" value={compact(fun.mcp_calls)} />
                <Fact icon="globe" label="Web fetches" value={compact(fun.web_calls)} onClick={onHistory} />
                <Fact icon="chat" label="Prompts / replies" value={`${compact(fun.prompts)} / ${compact(fun.responses)}`} />
                <Fact icon="brain" label="Thoughts" value={compact(fun.thoughts)} />
                <Fact icon="search" label="Favorite tool" value={fun.top_tool ?? '—'} />
                <Fact icon="layers" label="Projects" value={compact(t.projects)} />
              </Grid>
            </Section>
          </FadeIn>
        )}

        <FadeIn delay={0.115}>
          <Section n="08" title="Attachments">
            {m.attachments.total > 0 ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-7 gap-y-1">
                  <span className="font-mono text-sm font-bold tabular-nums text-fg">
                    {compact(m.attachments.total)}{' '}
                    <span className="text-[0.55rem] font-normal uppercase tracking-widest text-fg/45">
                      {m.attachments.total === 1 ? 'file' : 'files'}
                    </span>
                  </span>
                  <span className="font-mono text-[0.62rem] text-fg/55">
                    {formatBytes(m.attachments.total_bytes)} total
                  </span>
                  <span className="font-mono text-[0.62rem] text-fg/55">
                    {m.attachments.by_type.length} type
                    {m.attachments.by_type.length === 1 ? '' : 's'}
                  </span>
                </div>
                {m.attachments.by_type.length > 0 && (
                  <div className="flex min-h-[5rem] items-center justify-center border border-fg/15 bg-panel/40 px-4 py-5">
                    <WordCloud data={m.attachments.by_type} />
                  </div>
                )}
              </div>
            ) : (
              <p className="font-mono text-xs text-fg/40">No files attached to prompts yet.</p>
            )}
          </Section>
        </FadeIn>

        <FadeIn delay={0.12}>
          <Section n="09" title="Leaderboards">
            <Grid cols="md:grid-cols-2">
              <div className="bg-bg p-4">
                <p className="mb-3 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
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
                        <p className="font-mono text-[0.55rem] text-fg/40">
                          {p.sessions} sess · {compact(p.events)} ev · {formatRelative(p.last_activity)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-bg p-4">
                <p className="mb-3 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
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
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg/75 transition-colors hover:text-vermilion">
                          {shortPath(s.cwd)} <span className="text-fg/35">{s.session_id.slice(0, 8)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[0.6rem] tabular-nums text-fg/45">
                          {compact(s.events)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </Grid>
          </Section>
        </FadeIn>
      </div>

      {shareOpen && <ShareCardModal metrics={m} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

function Fact({ icon, label, value, onClick }: { icon: IconName; label: string; value: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center border border-fg/20 text-fg/55 ${onClick ? 'transition-colors group-hover:border-vermilion group-hover:text-vermilion' : ''}`}>
        <Icon name={icon} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate font-mono text-sm font-bold text-fg ${onClick ? 'transition-colors group-hover:text-vermilion' : ''}`} title={value}>
          {value}
        </p>
        <p className="font-mono text-[0.5rem] uppercase tracking-widest text-fg/40">{label}</p>
      </div>
      {onClick && (
        <Icon name="chevron-right" className="h-3 w-3 shrink-0 text-fg/20 transition-colors group-hover:text-vermilion" />
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="group flex w-full items-center gap-3 bg-bg px-4 py-3 text-left transition-colors hover:bg-fg/[0.03]">
        {inner}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-3 bg-bg px-4 py-3">
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
          className="font-serif font-extrabold italic leading-none">
          {d.type}
          <span className="ml-1 align-super font-mono text-[0.55rem] not-italic text-fg/40">
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
      className={`flex h-6 w-6 shrink-0 items-center justify-center border border-fg/20 font-mono text-[0.6rem] font-bold tabular-nums ${
        n === 1 ? 'bg-vermilion text-cream' : 'text-fg/55'
      }`}>
      {n}
    </span>
  );
}
