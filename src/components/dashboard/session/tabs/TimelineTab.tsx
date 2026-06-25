import { useEffect, useMemo, useState } from 'react';
import type { TimelineItem } from '../../../../lib/api';
import {
  actionsInRun,
  activityTabsFor,
  itemsForTab,
  sortEventsByTime,
  type SubagentRun,
  type TimeSort,
} from '../../../../lib/sessionView';
import { Icon } from '../../../ui/icons';
import { EventList } from '../EventList';
import { EventDetailPanel } from '../EventDetailPanel';
import { SubagentNestedList } from '../SubagentNestedList';

interface TimelineTabProps {
  items: TimelineItem[];
  /** Subagent run windows, derived from the merged timeline by the parent. */
  runs: SubagentRun[];
  /** Event to select and scroll to on arrival (e.g. from a search result). */
  focusEventId?: number;
  /** Session id, for lazy-loading a selected event's full detail. */
  sessionId: string;
}

export function TimelineTab({ items, runs, focusEventId, sessionId }: TimelineTabProps) {
  const [filter, setFilter] = useState('all');
  const [timeSort, setTimeSort] = useState<TimeSort>('desc');
  // null lets the effect below pick the first row in the current sort order.
  const [selectedId, setSelectedId] = useState<number | null>(focusEventId ?? null);

  // When a deep-link focus arrives, clear any filter and jump to that event.
  useEffect(() => {
    if (focusEventId != null) {
      setFilter('all');
      setSelectedId(focusEventId);
    }
  }, [focusEventId]);

  const activity = useMemo(() => activityTabsFor(items), [items]);

  // The "Subagents" filter switches to a nested tree (each subagent → the
  // actions captured during its window) instead of a flat list.
  const nested = filter === 'subagents' && runs.length > 0;

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return itemsForTab(items, activity.find((t) => t.key === filter)?.cats ?? []);
  }, [items, filter, activity]);

  const sorted = useMemo(
    () => sortEventsByTime(filtered, timeSort),
    [filtered, timeSort],
  );

  // Selectable rows differ by mode: flat list rows, or the (deduped) actions
  // nested under the subagent runs.
  const selectable = useMemo(() => {
    if (!nested) return sorted;
    const seen = new Set<number>();
    const out: TimelineItem[] = [];
    for (const run of runs) {
      for (const a of actionsInRun(items, run)) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          out.push(a);
        }
      }
    }
    return out;
  }, [nested, sorted, runs, items]);

  useEffect(() => {
    if (!selectable.some((it) => it.id === selectedId)) {
      setSelectedId(selectable[0]?.id ?? null);
    }
  }, [selectable, selectedId]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {activity.length > 0 && (
          <>
            <FilterChip
              label="All"
              count={items.length}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {activity.map((tab) => (
              <FilterChip
                key={tab.key}
                label={tab.label}
                // The raw count double-counts subagents (Pre+Post events); show
                // the number of distinct subagent runs instead.
                count={tab.key === 'subagents' ? runs.length : tab.count}
                active={filter === tab.key}
                onClick={() => setFilter(tab.key)}
              />
            ))}
          </>
        )}
        {!nested && (
          <button
            type="button"
            onClick={() => setTimeSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
            title={timeSort === 'asc' ? 'Oldest first — click for newest' : 'Newest first — click for oldest'}
            className={`ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-widest transition-colors ${
              timeSort === 'desc'
                ? 'bg-surface text-fg shadow-soft'
                : 'text-fg/45 hover:text-fg/70'
            }`}>
            <Icon name={timeSort === 'asc' ? 'chevron-down' : 'chevron-up'} className="h-3 w-3" />
            {timeSort === 'asc' ? 'Oldest' : 'Newest'}
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="scroll-thin max-h-[32rem] overflow-y-auto rounded-lg border border-line/10 bg-bg">
          {nested ? (
            <SubagentNestedList
              items={items}
              runs={runs}
              selectedId={selectedId}
              onSelect={(it) => setSelectedId(it.id)}
            />
          ) : (
            <EventList
              items={sorted}
              selectedId={selectedId}
              onSelect={(it) => setSelectedId(it.id)}
              runs={runs}
              scrollKey={`${filter}:${focusEventId ?? ''}`}
            />
          )}
        </div>
        <div className="scroll-thin max-h-[32rem] overflow-y-auto rounded-lg bg-surface p-4 shadow-soft sm:p-5">
          <EventDetailPanel
            item={selected}
            sessionId={sessionId}
            onViewInAll={filter !== 'all' ? () => setFilter('all') : undefined}
            onJump={(id) => {
              setFilter('all');
              setSelectedId(id);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-widest transition-colors ${
        active ? 'bg-surface text-fg shadow-soft' : 'text-fg/45 hover:text-fg/70'
      }`}>
      {label}
      <span className="ml-1 tabular-nums text-fg/40">{count}</span>
    </button>
  );
}
