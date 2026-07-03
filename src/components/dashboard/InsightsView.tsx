import { useState } from 'react';
import {
  dismissInsight,
  getInsights,
  restoreInsight,
  type ActionableInsight,
  type InsightPillar,
  type InsightSeverity,
  type InsightStatus,
  type InsightsResponse,
} from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { usePolling } from '../../lib/usePolling';
import { FadeIn } from '../ui/FadeIn';
import { Icon, type IconName } from '../ui/icons';
import { MetricsSkeleton } from '../ui/Skeleton';

interface InsightsViewProps {
  onSelect: (id: string, eventId?: number) => void;
}

const PILLARS: { key: InsightPillar; n: string; title: string; icon: IconName }[] = [
  { key: 'usability', n: '01', title: 'Usability', icon: 'robot' },
  { key: 'cost', n: '02', title: 'Cost', icon: 'chart' },
  { key: 'security', n: '03', title: 'Security', icon: 'warn' },
];

const WINDOWS: { label: string; days: number }[] = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: 'All', days: 0 },
];

const STATUS_VIEWS: { key: InsightStatus; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
];

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

function SeverityBadge({ severity }: { severity: InsightSeverity }) {
  const styles: Record<InsightSeverity, string> = {
    critical: 'bg-vermilion text-cream border-vermilion',
    warn: 'border-vermilion/60 text-vermilion',
    info: 'border-cobalt/60 text-cobalt',
  };
  return (
    <span
      className={`shrink-0 border px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest ${styles[severity]}`}>
      {severity}
    </span>
  );
}

interface FindingGroupData {
  id: string;
  title: string;
  items: ActionableInsight[];
}

/** Collapse findings of the same rule type into one group (already severity-sorted). */
function groupByRule(findings: ActionableInsight[]): FindingGroupData[] {
  const map = new Map<string, ActionableInsight[]>();
  for (const f of findings) {
    const arr = map.get(f.id);
    if (arr) arr.push(f);
    else map.set(f.id, [f]);
  }
  return [...map.entries()].map(([id, items]) => ({
    id,
    title: items[0].group_title,
    items,
  }));
}

function FindingGroup({
  group,
  view,
  onSelect,
  onLifecycle,
}: {
  group: FindingGroupData;
  view: InsightStatus;
  onSelect: (id: string, eventId?: number) => void;
  onLifecycle: (fingerprint: string, action: 'dismiss' | 'restore') => void;
}) {
  const [open, setOpen] = useState(false);
  // Items are severity-sorted, so the first item carries the group's max severity.
  const severity = group.items[0].severity;
  return (
    <div className="min-w-0 bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
        title={open ? 'Collapse group' : 'Expand group'}>
        <SeverityBadge severity={severity} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-fg transition-colors hover:text-vermilion">
          {group.title}
        </span>
        <span className="shrink-0 border border-fg/20 px-1.5 py-0.5 font-mono text-[0.55rem] font-bold tabular-nums text-fg/55">
          {group.items.length}
        </span>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          className="h-3 w-3 shrink-0 text-fg/40"
        />
      </button>
      {open && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-px border-t border-fg/10 bg-fg/10">
          {group.items.map((f) => (
            <FindingCard
              key={f.fingerprint}
              finding={f}
              view={view}
              onSelect={onSelect}
              onLifecycle={onLifecycle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  view,
  onSelect,
  onLifecycle,
}: {
  finding: ActionableInsight;
  view: InsightStatus;
  onSelect: (id: string, eventId?: number) => void;
  onLifecycle: (fingerprint: string, action: 'dismiss' | 'restore') => void;
}) {
  const compact = finding.tier === 2;
  const [expanded, setExpanded] = useState(!compact);
  return (
    <div className="min-w-0 bg-bg px-4 py-3">
      <div className="flex items-start gap-2.5">
        <SeverityBadge severity={finding.severity} />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 text-left"
          title={expanded ? 'Collapse' : 'Expand'}>
          <p className="font-mono text-xs font-bold text-fg transition-colors hover:text-vermilion">
            {finding.title}
          </p>
          {view === 'resolved' && finding.resolved_at && (
            <p className="mt-0.5 font-mono text-[0.55rem] uppercase tracking-widest text-olive">
              <Icon name="check" className="mr-1 inline h-2.5 w-2.5" />
              fixed {formatRelative(finding.resolved_at)}
            </p>
          )}
        </button>
        {finding.first_seen && view === 'active' && (
          <span className="hidden shrink-0 font-mono text-[0.55rem] text-fg/35 sm:inline">
            since {formatRelative(finding.first_seen)}
          </span>
        )}
        {view !== 'resolved' && (
          <button
            type="button"
            onClick={() => onLifecycle(finding.fingerprint, view === 'dismissed' ? 'restore' : 'dismiss')}
            title={view === 'dismissed' ? 'Restore this finding' : 'Dismiss this finding'}
            className="shrink-0 border border-fg/20 px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:border-fg/50 hover:text-fg focus-visible:border-vermilion focus-visible:outline-none">
            {view === 'dismissed' ? 'Restore' : '×'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 pl-0.5">
          <p className="break-words font-mono text-[0.68rem] leading-relaxed text-fg/70">
            {finding.detail}
          </p>
          <p className="border-l-[3px] border-vermilion pl-2.5 font-mono text-[0.68rem] font-bold leading-relaxed text-fg/85">
            {finding.recommendation}
          </p>
          {finding.evidence.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {finding.evidence.map((ev, i) => (
                <li key={`${ev.session_id}-${ev.event_id ?? i}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(ev.session_id, ev.event_id ?? undefined)}
                    className="group flex w-full items-center gap-2 text-left">
                    <Icon
                      name="chevron-right"
                      className="h-2.5 w-2.5 shrink-0 text-fg/25 transition-colors group-hover:text-vermilion"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.62rem] text-fg/55 transition-colors group-hover:text-vermilion">
                      {ev.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-[0.55rem] text-fg/35">
                      {ev.value && <span>{ev.value}</span>}
                      <span>{ev.session_id.slice(0, 8)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function InsightsView({ onSelect }: InsightsViewProps) {
  const [days, setDays] = useState(30);
  const [view, setView] = useState<InsightStatus>('active');
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error } = usePolling<InsightsResponse>(
    () => getInsights(days, 'all'),
    60000,
    [days, refreshKey],
  );

  const onLifecycle = async (fingerprint: string, action: 'dismiss' | 'restore') => {
    try {
      await (action === 'dismiss' ? dismissInsight(fingerprint) : restoreInsight(fingerprint));
    } finally {
      setRefreshKey((k) => k + 1);
    }
  };

  if (!data) {
    if (error) {
      return (
        <div className="scroll-thin flex-1 overflow-y-auto">
          <p className="mx-auto max-w-5xl px-6 py-12 font-mono text-xs text-fg/40">
            Collector offline — insights unavailable.
          </p>
        </div>
      );
    }
    return <MetricsSkeleton />;
  }

  const byStatus = (status: InsightStatus) => data.insights.filter((f) => f.status === status);
  const shown = byStatus(view);
  const active = byStatus('active');
  const criticals = active.filter((f) => f.severity === 'critical').length;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-7 px-6 py-8 sm:px-8">
        <FadeIn className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-extrabold uppercase tracking-tight text-fg">
              Insights <span className="font-serif lowercase italic text-vermilion">findings</span>
            </h1>
            <p className="font-mono text-xs text-fg/50">
              What to do with your traces — actionable, computed locally from your data.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setDays(w.days)}
                aria-pressed={days === w.days}
                className={`border px-2.5 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors focus-visible:outline-none ${
                  days === w.days
                    ? 'border-vermilion bg-vermilion text-cream'
                    : 'border-fg/20 text-fg/55 hover:border-fg/50 hover:text-fg'
                }`}>
                {w.label}
              </button>
            ))}
          </div>
        </FadeIn>

        <FadeIn delay={0.03}>
          <div className="grid grid-cols-2 gap-px bg-fg/10 sm:grid-cols-4">
            <div className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
                Active findings
              </p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-fg">
                {active.length}
              </p>
            </div>
            <div className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
                Critical
              </p>
              <p
                className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
                  criticals ? 'text-vermilion' : 'text-fg'
                }`}>
                {criticals}
              </p>
            </div>
            <div className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
                Fixed this week
              </p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-olive">
                {data.counts.resolved_recently}
              </p>
            </div>
            <div className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">Window</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-fg">
                {days === 0 ? 'All' : `${days}d`}
              </p>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.05}>
          <div className="flex items-center gap-1">
            {STATUS_VIEWS.map((s) => {
              const n = byStatus(s.key).length;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setView(s.key)}
                  aria-pressed={view === s.key}
                  className={`border px-2.5 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors focus-visible:outline-none ${
                    view === s.key
                      ? 'border-fg/60 bg-fg/10 text-fg'
                      : 'border-fg/20 text-fg/55 hover:border-fg/50 hover:text-fg'
                  }`}>
                  {s.label} <span className="tabular-nums text-fg/45">{n}</span>
                </button>
              );
            })}
          </div>
        </FadeIn>

        {PILLARS.map((pillar, i) => {
          const findings = shown.filter((f) => f.pillar === pillar.key);
          const groups = groupByRule(findings);
          return (
            <FadeIn key={pillar.key} delay={0.06 + i * 0.02}>
              <Section n={pillar.n} title={pillar.title}>
                {groups.length ? (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-px bg-fg/10">
                    {groups.map((g) =>
                      g.items.length === 1 ? (
                        <FindingCard
                          key={g.items[0].fingerprint}
                          finding={g.items[0]}
                          view={view}
                          onSelect={onSelect}
                          onLifecycle={onLifecycle}
                        />
                      ) : (
                        <FindingGroup
                          key={g.id}
                          group={g}
                          view={view}
                          onSelect={onSelect}
                          onLifecycle={onLifecycle}
                        />
                      ),
                    )}
                  </div>
                ) : (
                  <p className="font-mono text-xs text-olive">
                    {view === 'active' ? 'No findings — clean.' : `Nothing ${view}.`}
                  </p>
                )}
              </Section>
            </FadeIn>
          );
        })}

        <FadeIn delay={0.12}>
          <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">
            Rule-based · computed on your machine · never leaves it · findings auto-resolve when
            the signal stops firing
          </p>
        </FadeIn>
      </div>
    </div>
  );
}
