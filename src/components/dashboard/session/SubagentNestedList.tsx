import { useState } from 'react';
import type { TimelineItem } from '../../../lib/api';
import { formatDateTime, formatDuration } from '../../../lib/categoryMeta';
import { actionsInRun, runsOverlap, type SubagentRun } from '../../../lib/sessionView';
import { Icon } from '../../ui/icons';
import { EventList } from './EventList';

interface SubagentNestedListProps {
  /** Action universe to nest (typically the unmerged session events). */
  items: TimelineItem[];
  runs: SubagentRun[];
  selectedId: number | null;
  onSelect: (item: TimelineItem) => void;
}

/**
 * Subagent runs as collapsible groups, each nesting the actions captured during
 * its window. Windows of parallel subagents overlap, so a shared action can
 * appear under more than one run — the hook data can't attribute it to a single
 * subagent.
 */
export function SubagentNestedList({ items, runs, selectedId, onSelect }: SubagentNestedListProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const parallel = runsOverlap(runs);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div>
      {parallel && (
        <p className="border-b border-line/10 px-3.5 py-2 font-mono text-[0.58rem] leading-relaxed text-fg/40">
          Subagents ran in parallel — overlapping windows mean a shared action may appear under
          more than one.
        </p>
      )}
      <ul className="divide-y divide-line/10">
        {runs.map((run) => {
          const actions = actionsInRun(items, run);
          const open = !collapsed.has(run.item.id);
          return (
            <li key={run.item.id}>
              <button
                type="button"
                onClick={() => toggle(run.item.id)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface">
                <Icon
                  name={open ? 'chevron-down' : 'chevron-right'}
                  className="h-3 w-3 shrink-0 text-fg/40"
                />
                <Icon name="robot" className="h-3.5 w-3.5 shrink-0 text-cobalt" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-fg">
                  {run.label}
                </span>
                <span className="shrink-0 font-mono text-[0.58rem] tabular-nums text-fg/45">
                  {actions.length} action{actions.length === 1 ? '' : 's'}
                </span>
                {run.durationMs != null && run.durationMs > 0 && (
                  <span className="shrink-0 font-mono text-[0.58rem] tabular-nums text-fg/35">
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[0.55rem] tabular-nums text-fg/35">
                  {formatDateTime(run.start)}
                </span>
              </button>
              {open && (
                <div className="border-l-2 border-cobalt/20 pl-1">
                  {actions.length ? (
                    <EventList items={actions} selectedId={selectedId} onSelect={onSelect} />
                  ) : (
                    <p className="px-3.5 py-3 font-mono text-[0.62rem] text-fg/35">
                      No actions captured during this run.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
