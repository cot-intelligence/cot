import { Fragment, useEffect, useMemo, useState } from 'react';
import { activateOnKey } from '../../lib/a11y';
import { getMetricsHistory, type MetricsHistoryItem } from '../../lib/api';
import { formatRelative, formatTime } from '../../lib/categoryMeta';
import { FadeIn } from '../ui/FadeIn';
import { highlight } from '../ui/Highlight';
import { Icon } from '../ui/icons';
import { Select } from '../ui/Select';
import { SourceBadge } from '../ui/SourceBadge';
import { TableRowsSkeleton } from '../ui/Skeleton';

interface MetricsHistoryViewProps {
  onSelect: (sessionId: string, eventId?: number) => void;
  onBack: () => void;
}

interface GroupedEntry {
  target: string;
  occurrences: MetricsHistoryItem[];
}

type Tab = 'shell' | 'web';
type SortKey = 'recent' | 'frequent';

const COLS = 6;

const TD = 'px-3 py-3 align-middle';
const SUB_TD = 'px-3 py-1 align-middle';
const TH =
  'px-3 py-2.5 text-left font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40';

function shortPath(p: string | null): string {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function groupByTarget(items: MetricsHistoryItem[]): GroupedEntry[] {
  const map = new Map<string, MetricsHistoryItem[]>();
  const order: string[] = [];
  for (const item of items) {
    if (!map.has(item.target)) {
      map.set(item.target, []);
      order.push(item.target);
    }
    map.get(item.target)!.push(item);
  }
  return order.map((target) => ({ target, occurrences: map.get(target)! }));
}

function sortGroups(groups: GroupedEntry[], sort: SortKey): GroupedEntry[] {
  const copy = [...groups];
  if (sort === 'frequent') {
    copy.sort((a, b) => b.occurrences.length - a.occurrences.length);
  } else {
    copy.sort((a, b) => (b.occurrences[0]?.ts ?? '').localeCompare(a.occurrences[0]?.ts ?? ''));
  }
  return copy;
}

function groupBg(expanded: boolean) {
  return expanded ? 'bg-surface/25' : '';
}

export function MetricsHistoryView({ onSelect, onBack }: MetricsHistoryViewProps) {
  const [tab, setTab] = useState<Tab>('shell');
  const [items, setItems] = useState<MetricsHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setExpanded(new Set());
    getMetricsHistory(tab, 500)
      .then((data) => {
        if (active) {
          setItems(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [tab]);

  const grouped = useMemo(() => {
    const base = filter
      ? items.filter((i) => i.target.toLowerCase().includes(filter.toLowerCase()))
      : items;
    return sortGroups(groupByTarget(base), sort);
  }, [items, filter, sort]);

  const totalRuns = grouped.reduce((n, g) => n + g.occurrences.length, 0);

  const toggle = (target: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });

  const switchTab = (next: Tab) => {
    setTab(next);
    setFilter('');
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8 sm:px-8">
        <FadeIn className="space-y-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-vermilion">
            <Icon name="chevron-left" className="h-3 w-3" />
            Metrics
          </button>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1.5">
              <h1 className="text-3xl font-extrabold uppercase tracking-tight text-fg">
                Activity{' '}
                <span className="font-serif lowercase italic text-vermilion">history</span>
              </h1>
              <p className="font-mono text-sm text-fg/50">
                Click a row to open its event in the session timeline.
              </p>
            </div>
            {!loading && !error && grouped.length > 0 && (
              <p className="font-mono text-[0.62rem] tabular-nums text-fg/40">
                {grouped.length} unique · {totalRuns} runs
              </p>
            )}
          </div>
        </FadeIn>

        <FadeIn delay={0.03}>
          <div className="border border-fg/15 bg-bg">
            <div className="flex flex-wrap items-center gap-2 border-b border-fg/15 p-3">
              <div className="flex border border-fg/20">
                <TabBtn active={tab === 'shell'} onClick={() => switchTab('shell')}>
                  <Icon name="terminal" className="h-3.5 w-3.5" />
                  Shell
                </TabBtn>
                <TabBtn active={tab === 'web'} onClick={() => switchTab('web')}>
                  <Icon name="globe" className="h-3.5 w-3.5" />
                  Web
                </TabBtn>
              </div>

              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={tab === 'shell' ? 'Filter commands…' : 'Filter URLs…'}
                className="min-w-[12rem] flex-1 border border-fg/20 bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
              />

              <Select
                aria-label="Sort entries"
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={[
                  { value: 'recent', label: 'Recent' },
                  { value: 'frequent', label: 'Most used' },
                ]}
              />
            </div>

            <div className="scroll-thin overflow-x-auto">
              {error ? (
                <p className="p-8 text-center font-mono text-xs text-fg/40">
                  Collector offline — activity log unavailable.
                </p>
              ) : (
                <table className="w-full min-w-[36rem] border-collapse border-spacing-0">
                  <colgroup>
                    <col className="w-9" />
                    <col />
                    <col className="w-16" />
                    <col className="w-28" />
                    <col />
                    <col className="w-24" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-fg/15 bg-surface/40">
                      <th className={`${TH} w-9`} aria-hidden="true" />
                      <th className={TH}>{tab === 'shell' ? 'Command' : 'URL'}</th>
                      <th className={`${TH} text-right`}>Runs</th>
                      <th className={`${TH} hidden sm:table-cell`}>Agent</th>
                      <th className={`${TH} hidden md:table-cell`}>Project</th>
                      <th className={`${TH} text-right`}>Last</th>
                    </tr>
                  </thead>

                  <tbody>
                    {loading ? (
                      <TableRowsSkeleton rows={10} cols={COLS} />
                    ) : grouped.length === 0 ? (
                      <tr>
                        <td colSpan={COLS} className="px-3 py-16 text-center">
                          <Icon
                            name={tab === 'shell' ? 'terminal' : 'globe'}
                            className="mx-auto mb-3 h-7 w-7 text-fg/15"
                          />
                          <p className="font-mono text-xs text-fg/40">
                            {filter
                              ? 'No matches for that filter.'
                              : tab === 'shell'
                                ? 'No shell commands recorded yet.'
                                : 'No web requests recorded yet.'}
                          </p>
                        </td>
                      </tr>
                    ) : (
                      grouped.map((group) => (
                        <GroupRows
                          key={group.target}
                          group={group}
                          tab={tab}
                          filter={filter}
                          expanded={expanded.has(group.target)}
                          onToggle={() => toggle(group.target)}
                          onSelect={onSelect}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  tab,
  filter,
  expanded,
  onToggle,
  onSelect,
}: {
  group: GroupedEntry;
  tab: Tab;
  filter: string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (sessionId: string, eventId?: number) => void;
}) {
  const latest = group.occurrences[0];
  const count = group.occurrences.length;
  const hasMore = count > 1;
  const openLatest = () => onSelect(latest.session_id, latest.event_id);
  const bg = groupBg(expanded);
  const groupBorder = expanded && hasMore ? '' : 'border-b border-fg/15';

  return (
    <Fragment>
      <tr
        role="button"
        tabIndex={0}
        onClick={openLatest}
        onKeyDown={(e) => activateOnKey(e, openLatest)}
        className={`group cursor-pointer transition-colors duration-150 hover:bg-surface/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion ${groupBorder} ${bg}`}>
        <td className={`w-9 px-2 py-0 ${bg}`} onClick={(e) => e.stopPropagation()}>
          {hasMore ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse runs' : `Expand ${count} runs`}
              className="flex h-9 w-9 items-center justify-center rounded-sm transition-colors duration-150 hover:bg-fg/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion">
              <Icon
                name="chevron-right"
                className={`h-4 w-4 text-fg/40 transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none ${
                  expanded ? 'rotate-90' : ''
                }`}
              />
            </button>
          ) : (
            <span className="block h-9 w-9" aria-hidden="true" />
          )}
        </td>
        <td className={`${TD} ${bg}`}>
          <span
            className="block max-w-md truncate font-mono text-sm font-medium text-fg transition-colors duration-150 group-hover:text-vermilion sm:max-w-xl"
            title={group.target}>
            {tab === 'shell' && <span className="select-none text-vermilion/70">$ </span>}
            {filter ? highlight(group.target, filter) : group.target}
          </span>
        </td>
        <td className={`${TD} text-right font-mono text-sm tabular-nums text-fg/70 ${bg}`}>
          {count}
        </td>
        <td className={`${TD} hidden sm:table-cell ${bg}`}>
          <SourceBadge source={latest.source} />
        </td>
        <td className={`${TD} hidden md:table-cell ${bg}`}>
          <span
            className="block max-w-[10rem] truncate font-mono text-xs text-fg/55"
            title={latest.cwd ?? undefined}>
            {shortPath(latest.cwd)}
          </span>
        </td>
        <td className={`${TD} text-right font-mono text-xs text-fg/45 ${bg}`}>
          {latest.ts ? formatRelative(latest.ts) : '—'}
        </td>
      </tr>

      {hasMore && (
        <tr className={`border-0 ${expanded ? `border-b border-fg/15 ${bg}` : 'h-0 leading-[0]'}`}>
          <td colSpan={COLS} className={`border-0 p-0 ${expanded ? bg : 'h-0 p-0 leading-[0]'}`}>
            <ExpandPanel open={expanded}>
              <table className="w-full border-collapse border-spacing-0">
                <colgroup>
                  <col className="w-9" />
                  <col />
                  <col className="w-16" />
                  <col className="w-28" />
                  <col />
                  <col className="w-24" />
                </colgroup>
                <tbody>
                  {group.occurrences.map((item, i) => (
                    <OccurrenceRow
                      key={`${item.session_id}-${item.event_id}`}
                      item={item}
                      onSelect={onSelect}
                      isLast={i === count - 1}
                      bg={bg}
                    />
                  ))}
                </tbody>
              </table>
            </ExpandPanel>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ExpandPanel({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function OccurrenceRow({
  item,
  onSelect,
  isLast,
  bg,
}: {
  item: MetricsHistoryItem;
  onSelect: (sessionId: string, eventId?: number) => void;
  isLast: boolean;
  bg: string;
}) {
  const open = () => onSelect(item.session_id, item.event_id);

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => activateOnKey(e, open)}
      className={`group cursor-pointer transition-colors duration-150 hover:bg-surface/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion ${bg} ${
        isLast ? '' : 'border-b border-fg/[0.06]'
      }`}>
      <td className={`w-9 ${bg}`} aria-hidden="true" />
      <td className={`${SUB_TD} pl-6 ${bg}`}>
        <span className="font-mono text-[0.58rem] tabular-nums text-fg/35">
          {item.session_id.slice(0, 8)}
        </span>
      </td>
      <td className={`${SUB_TD} ${bg}`} aria-hidden="true" />
      <td className={`${SUB_TD} hidden sm:table-cell ${bg}`}>
        <SourceBadge source={item.source} className="scale-90 origin-left" />
      </td>
      <td className={`${SUB_TD} hidden md:table-cell ${bg}`}>
        <span
          className="block max-w-[10rem] truncate font-mono text-[0.62rem] text-fg/55"
          title={item.cwd ?? undefined}>
          {shortPath(item.cwd)}
        </span>
      </td>
      <td className={`${SUB_TD} text-right ${bg}`}>
        <span className="font-mono text-[0.62rem] tabular-nums text-fg/45">
          {item.ts ? formatTime(item.ts) : '—'}
        </span>
        <Icon
          name="chevron-right"
          className="ml-1.5 inline h-2.5 w-2.5 text-fg/15 transition-colors duration-150 group-hover:text-vermilion"
        />
      </td>
    </tr>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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
