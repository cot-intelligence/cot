import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { activateOnKey } from '../../../lib/a11y';
import { getActivityLog, type ActivityCategory, type ActivityFilters, type ActivityItem } from '../../../lib/api';
import { formatDuration, formatRelative, formatDateTime } from '../../../lib/categoryMeta';
import { Icon } from '../../ui/icons';
import { Select } from '../../ui/Select';
import { sourceLabel } from '../../../lib/sourceLabels';
import { CommandText, FailMark, RiskTag } from './parts';

export type LogStatus = 'all' | 'failed' | 'risky';

const PAGE = 20;

interface ActivityLogProps {
  category: ActivityCategory;
  filters: ActivityFilters;
  /** Program (shell) or domain (web) picked from Most used; cleared with ×. */
  group: string | null;
  onClearGroup: () => void;
  status: LogStatus;
  onStatus: (s: LogStatus) => void;
  /** Wrapper counts for the window, for the Via filter (shell only). */
  viaOptions?: { key: string; runs: number }[];
  onSelect: (sessionId: string, eventId?: number) => void;
}

export function viaLabel(key: string): string {
  if (key === 'env') return 'env vars';
  if (key === 'sudo') return 'sudo (as root)';
  return key;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ActivityLog({
  category,
  filters,
  group,
  onClearGroup,
  status,
  onStatus,
  viaOptions = [],
  onSelect,
}: ActivityLogProps) {
  const [q, setQ] = useState('');
  const [via, setVia] = useState('');
  const query = useDebounced(q.trim(), 250);
  useEffect(() => {
    setQ('');
    setVia('');
  }, [category]);

  const log = useInfiniteQuery({
    queryKey: ['activityLog', category, filters, group, status, query, via],
    queryFn: ({ pageParam }) =>
      getActivityLog(category, {
        ...filters,
        q: query || undefined,
        group: group ?? undefined,
        failed: status === 'failed',
        risky: status === 'risky',
        via: via || undefined,
        offset: pageParam,
        limit: PAGE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const total = log.data?.pages[0]?.total ?? 0;
  const noun = category === 'shell' ? 'commands' : 'requests';
  const statuses: LogStatus[] = category === 'shell' ? ['all', 'failed', 'risky'] : ['all', 'failed'];

  return (
    <div className="border border-fg/15 bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-fg/15 p-3">
        <label className="flex min-w-[14rem] flex-1 items-center gap-2 border border-fg/20 bg-surface px-3 py-1.5 focus-within:border-vermilion">
          <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-fg/45" />
          <span className="sr-only">Filter {noun}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={category === 'shell' ? 'Filter commands' : 'Filter URLs and searches'}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg placeholder:text-fg/40 focus:outline-none"
          />
        </label>
        <div className="seg" role="tablist" aria-label="Status">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              aria-pressed={status === s}
              onClick={() => onStatus(s)}
              className="seg-item">
              {s === 'all' ? 'All' : s === 'failed' ? 'Failed' : 'Risky'}
            </button>
          ))}
        </div>
        {category === 'shell' && viaOptions.length > 0 && (
          <Select
            className="min-w-[13rem]"
            aria-label="Ran through"
            value={via}
            onChange={setVia}
            options={[
              { value: '', label: 'Via: any' },
              ...viaOptions.map((v) => ({ value: v.key, label: `Via ${viaLabel(v.key)} (${v.runs.toLocaleString()})` })),
              ...(via && !viaOptions.some((v) => v.key === via) ? [{ value: via, label: `Via ${viaLabel(via)}` }] : []),
            ]}
          />
        )}
        {group && (
          <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-fg/30 bg-surface py-1 pl-2.5 pr-1 font-mono text-[0.65rem] font-bold text-fg">
            {group}
            <button
              type="button"
              onClick={onClearGroup}
              aria-label={`Show all, not just ${group}`}
              className="flex h-5 w-5 items-center justify-center rounded-[3px] text-fg/55 hover:bg-fg/10 hover:text-fg">
              ×
            </button>
          </span>
        )}
        <span className="ml-auto font-mono text-[0.62rem] tabular-nums text-fg/55">
          {log.isPending ? 'Loading…' : `${total.toLocaleString()} ${noun}`}
        </span>
      </div>

      {log.isError ? (
        <p className="p-8 text-center font-mono text-xs text-fg/50">Collector offline. Activity is unavailable.</p>
      ) : log.isPending ? (
        <div className="divide-y divide-fg/[0.06]">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <span className="h-3 w-12 animate-pulse bg-fg/10" />
              <span className="h-3 flex-1 animate-pulse bg-fg/10" />
              <span className="h-3 w-16 animate-pulse bg-fg/10" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-14 text-center">
          <Icon name={category === 'shell' ? 'terminal' : 'globe'} className="mx-auto mb-3 h-7 w-7 text-fg/20" />
          <p className="font-mono text-xs text-fg/55">
            {query || group || via || status !== 'all'
              ? `No ${noun} match these filters.`
              : `No ${noun} in this time range. Try a longer range.`}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-fg/[0.07]">
          {items.map((item) => (
            <LogRow key={item.event_id} item={item} category={category} onSelect={onSelect} />
          ))}
        </ul>
      )}

      {log.hasNextPage && (
        <div className="border-t border-fg/10 p-3 text-center">
          <button
            type="button"
            onClick={() => log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
            className="btn">
            {log.isFetchingNextPage ? 'Loading…' : `Show ${Math.min(PAGE, total - items.length)} more`}
          </button>
        </div>
      )}
    </div>
  );
}

function LogRow({
  item,
  category,
  onSelect,
}: {
  item: ActivityItem;
  category: ActivityCategory;
  onSelect: (sessionId: string, eventId?: number) => void;
}) {
  const open = () => onSelect(item.session_id, item.event_id);
  const isSearch = category === 'web' && item.kind === 'search';
  // Project and agent live in the tooltip: both have filters above, and a
  // logo on every row was the noisiest thing on the page.
  const tip = [
    item.target,
    `${sourceLabel(item.source)} in ${item.cwd ?? 'unknown project'}`,
    item.via?.length ? `Via ${item.via.map(viaLabel).join(', ')}` : '',
    item.env_names?.length ? `Sets ${item.env_names.join(', ')}` : '',
    item.ts ? formatDateTime(item.ts) : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => activateOnKey(e, open)}
      title={tip}
      className="group grid cursor-pointer grid-cols-[4rem_1rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2 transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vermilion">
      <span className="pt-px font-mono text-[0.62rem] tabular-nums text-fg/50">
        {item.ts ? formatRelative(item.ts) : ''}
      </span>
      <span className="pt-px">
        {item.failed ? (
          <FailMark />
        ) : item.no_match ? (
          <span title="Exit 1: no match" className="font-mono text-[0.6rem] text-fg/40">
            ∅
          </span>
        ) : category === 'web' ? (
          <Icon name={isSearch ? 'search' : 'globe'} className="h-3.5 w-3.5 text-fg/40" />
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs">
            {category === 'shell' && !item.tool ? (
              <CommandText core={item.core || item.target} program={item.program} />
            ) : (
              <span className="text-fg/85">
                {item.tool && category === 'shell' && <span className="mr-1.5 font-bold text-fg/55">{item.tool}</span>}
                {item.target}
              </span>
            )}
          </span>
          {item.risk && <RiskTag risk={item.risk} />}
        </span>
        {item.failed && item.error?.message && (
          <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-vermilion/90">
            {item.error.exit_code != null && <span className="mr-1.5 text-vermilion/70">exit {item.error.exit_code}</span>}
            {item.error.message}
          </span>
        )}
      </span>
      <span className="pt-px text-right font-mono text-[0.62rem] tabular-nums text-fg/50">
        {item.duration_ms ? formatDuration(item.duration_ms) : ''}
      </span>
    </li>
  );
}
