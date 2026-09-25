import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { activateOnKey } from '../../lib/a11y';
import {
  getActivity,
  type ActivityAttention,
  type ActivityCategory,
  type ActivityFilters,
  type ActivitySummary,
} from '../../lib/api';
import { formatDuration, formatRelative } from '../../lib/categoryMeta';
import { compact } from '../../lib/format';
import { sourceLabel } from '../../lib/sourceLabels';
import { FadeIn } from '../ui/FadeIn';
import { Icon } from '../ui/icons';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { ActivityLog, type LogStatus } from './activity/ActivityLog';
import { CommandText, Grid, Section, Stat, shortPath } from './activity/parts';

interface MetricsHistoryViewProps {
  onSelect: (sessionId: string, eventId?: number) => void;
  onBack: () => void;
  initialTab?: ActivityCategory;
}

const RANGES: { days: number; label: string }[] = [
  { days: 1, label: '24h' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 0, label: 'All time' },
];

/** How many "Worth a look" entries show before "Show more". */
const ATTENTION_SHOWN = 5;
const MOST_USED_SHOWN = 6;

/**
 * Activity: what agents ran in the shell and fetched from the web. Four
 * numbers, a short ranked list of what is worth a look (measured against the
 * history before the range), what agents rely on, then every command.
 */
export function MetricsHistoryView({ onSelect, onBack, initialTab = 'shell' }: MetricsHistoryViewProps) {
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

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8 sm:px-8">
        <FadeIn>
          <PageHeader
            above={
              <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1.5 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-fg">
                <Icon name="chevron-left" className="h-3 w-3" />
                Overview
              </button>
            }
            title="Activity"
            description="What your agents ran and fetched, and what is worth a look."
          />
        </FadeIn>

        <FadeIn delay={0.03} className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex border border-fg/20">
              <TabBtn active={shell} onClick={() => switchTab('shell')}>
                <Icon name="terminal" className="h-3.5 w-3.5" />
                Shell
              </TabBtn>
              <TabBtn active={!shell} onClick={() => switchTab('web')}>
                <Icon name="globe" className="h-3.5 w-3.5" />
                Web
              </TabBtn>
            </div>
            <div className="seg" role="tablist" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  role="tab"
                  aria-selected={days === r.days}
                  aria-pressed={days === r.days}
                  onClick={() => setDays(r.days)}
                  className="seg-item">
                  {r.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <Select
                aria-label="Project"
                value={project}
                onChange={setProject}
                options={[
                  { value: '', label: 'All projects' },
                  ...(data?.projects ?? []).map((p) => ({ value: p.cwd, label: shortPath(p.cwd) })),
                  ...(project && !data?.projects.some((p) => p.cwd === project)
                    ? [{ value: project, label: shortPath(project) }]
                    : []),
                ]}
              />
              <Select
                aria-label="Agent"
                value={source}
                onChange={setSource}
                options={[
                  { value: '', label: 'All agents' },
                  ...(data?.sources ?? []).map((s) => ({ value: s.source, label: sourceLabel(s.source) })),
                  ...(source && !data?.sources.some((s) => s.source === source)
                    ? [{ value: source, label: sourceLabel(source) }]
                    : []),
                ]}
              />
            </div>
          </div>

          {!isError && (
            <Glance data={data} pending={isPending} shell={shell} onFailed={() => showInLog({ status: 'failed' })} />
          )}
        </FadeIn>

        {isError ? (
          <p className="border border-fg/15 p-8 text-center font-mono text-xs text-fg/50">
            Collector offline. Activity is unavailable.
          </p>
        ) : (
          <FadeIn delay={0.06} className="space-y-8">
            <WorthALook data={data} onSelect={onSelect} />
            <MostUsed data={data} shell={shell} active={group} onPick={(key) => showInLog({ group: key })} />
            <div ref={logRef} className="scroll-mt-4">
              <Section n="03" title={shell ? 'Every command' : 'Every request'}>
                <ActivityLog
                  category={tab}
                  filters={filters}
                  group={group}
                  onClearGroup={() => setGroup(null)}
                  status={status}
                  onStatus={setStatus}
                  onSelect={onSelect}
                />
              </Section>
            </div>
          </FadeIn>
        )}
      </div>
    </div>
  );
}

function Glance({
  data,
  pending,
  shell,
  onFailed,
}: {
  data?: ActivitySummary;
  pending: boolean;
  shell: boolean;
  onFailed: () => void;
}) {
  const s = data?.summary;
  const none = pending ? '…' : '0';
  return (
    <Grid cols="grid-cols-2 lg:grid-cols-4">
      <Stat
        label={shell ? 'Commands' : 'Requests'}
        value={s ? compact(s.runs) : none}
        hint={s ? `in ${s.sessions} sessions` : undefined}
      />
      <button type="button" onClick={onFailed} disabled={!s?.failed} className="bg-bg text-left disabled:cursor-default">
        <Stat
          label="Failed"
          value={s ? compact(s.failed) : none}
          hint={s && s.runs ? `${(s.fail_rate * 100).toFixed(1)}% of runs` : undefined}
          accent={s?.failed ? 'text-vermilion' : undefined}
        />
      </button>
      <Stat label={shell ? 'Time running' : 'Time waiting'} value={s ? formatDuration(s.total_ms) : none} />
      <Stat label={shell ? 'Programs' : 'Domains'} value={s ? compact(s.groups) : none} />
    </Grid>
  );
}

const KIND_LABEL: Record<ActivityAttention['kind'], string> = {
  loop: 'Loop',
  failure_spike: 'Failing more',
  failing: 'Failing',
  risky: 'Risky',
  first_seen: 'New',
  slow: 'Slow',
};

const SEVERITY_TAG: Record<ActivityAttention['severity'], string> = {
  critical: 'border-vermilion bg-vermilion text-cream',
  warn: 'border-vermilion/60 text-vermilion',
  info: 'border-line/30 text-fg/60',
};

function WorthALook({
  data,
  onSelect,
}: {
  data?: ActivitySummary;
  onSelect: (sessionId: string, eventId?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const all = data?.attention ?? [];
  const shown = expanded ? all : all.slice(0, ATTENTION_SHOWN);
  return (
    <Section
      n="01"
      title="Worth a look"
      aside={
        all.length > 0 ? <span className="font-mono text-[0.6rem] tabular-nums text-fg/50">{all.length}</span> : undefined
      }>
      <div className="border border-fg/15 bg-bg">
        {!data ? (
          <p className="px-4 py-5 font-mono text-xs text-fg/50">Loading…</p>
        ) : all.length === 0 ? (
          <p className="flex items-center gap-2.5 px-4 py-5 font-mono text-xs text-fg/60">
            <Icon name="check" className="h-4 w-4 text-olive" />
            Nothing unusual in this range.
          </p>
        ) : (
          <ul className="divide-y divide-fg/[0.07]">
            {shown.map((a, i) => (
              <AttentionRow key={`${a.kind}-${a.title}-${i}`} item={a} onSelect={onSelect} />
            ))}
          </ul>
        )}
        {all.length > ATTENTION_SHOWN && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full border-t border-fg/10 px-4 py-2 text-left font-mono text-[0.62rem] font-bold text-fg/55 transition-colors hover:bg-surface/60 hover:text-fg">
            {expanded ? 'Show fewer' : `Show ${all.length - ATTENTION_SHOWN} more`}
          </button>
        )}
      </div>
    </Section>
  );
}

function AttentionRow({
  item: a,
  onSelect,
}: {
  item: ActivityAttention;
  onSelect: (sessionId: string, eventId?: number) => void;
}) {
  const open = () => onSelect(a.ref.session_id, a.ref.event_id);
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => activateOnKey(e, open)}
      title={a.names ? a.names.join(', ') : (a.subject ?? undefined)}
      className="group grid cursor-pointer grid-cols-[5.75rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3 transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion">
      <span
        className={`mt-px justify-self-start border px-1.5 py-0.5 font-mono text-[0.52rem] font-bold uppercase tracking-widest ${SEVERITY_TAG[a.severity]}`}>
        {KIND_LABEL[a.kind]}
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-xs font-bold text-fg">{a.title}</span>
        {a.subject && (
          <span className="mt-1 block truncate font-mono text-[0.68rem]">
            <CommandText core={a.subject} program={a.program ?? undefined} />
          </span>
        )}
        {a.detail && <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-fg/55">{a.detail}</span>}
      </span>
      <span className="flex items-center gap-1.5 pt-px font-mono text-[0.6rem] tabular-nums text-fg/50">
        {a.ref.ts ? formatRelative(a.ref.ts) : ''}
        <Icon name="chevron-right" className="h-3 w-3 text-fg/30 transition-colors group-hover:text-fg/70" />
      </span>
    </li>
  );
}

function MostUsed({
  data,
  shell,
  active,
  onPick,
}: {
  data?: ActivitySummary;
  shell: boolean;
  active: string | null;
  onPick: (key: string) => void;
}) {
  const rows = (data?.groups ?? []).slice(0, MOST_USED_SHOWN);
  const max = rows[0]?.runs ?? 1;
  return (
    <Section
      n="02"
      title={shell ? 'Most used' : 'Top domains'}
      aside={<span className="font-mono text-[0.6rem] text-fg/50">click one to filter the list</span>}>
      <div className="border border-fg/15 bg-bg">
        {!data ? (
          <p className="px-4 py-5 font-mono text-xs text-fg/50">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-5 font-mono text-xs text-fg/55">Nothing in this range.</p>
        ) : (
          <ul className="divide-y divide-fg/[0.06]">
            {rows.map((g) => {
              const pick = () => onPick(g.key);
              const on = active === g.key;
              return (
                <li
                  key={g.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  onClick={pick}
                  onKeyDown={(e) => activateOnKey(e, pick)}
                  title={g.verbs?.length ? g.verbs.map((v) => `${g.key} ${v.key}: ${v.runs}`).join('\n') : undefined}
                  className={`grid cursor-pointer grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3.5rem_4.5rem] items-center gap-4 px-4 py-2 transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion ${
                    on ? 'bg-surface' : ''
                  }`}>
                  <span className="truncate font-mono text-xs font-bold text-fg">
                    {g.key}
                    {g.local && <span className="ml-2 font-normal text-fg/45">local</span>}
                  </span>
                  {/* Share of the top entry; the count carries the scale. */}
                  <span className="block h-1.5" aria-hidden="true">
                    <span className="block h-full bg-fg/45" style={{ width: `${Math.max(3, (g.runs / max) * 100)}%` }} />
                  </span>
                  <span className="text-right font-mono text-xs tabular-nums text-fg/80">{compact(g.runs)}</span>
                  <span className="text-right font-mono text-[0.62rem] tabular-nums text-vermilion/90">
                    {g.failed > 0 ? `${g.failed} failed` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 border-r border-fg/20 px-3 py-2 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion ${
        active ? 'bg-fg text-bg' : 'bg-surface text-fg/55 hover:text-fg'
      }`}>
      {children}
    </button>
  );
}
