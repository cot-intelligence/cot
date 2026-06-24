import { useEffect, useRef } from 'react';
import type { TimelineItem } from '../../../lib/api';
import { formatDateTime, formatDuration, getCategoryMeta } from '../../../lib/categoryMeta';
import { itemLane, type SubagentRun } from '../../../lib/sessionView';
import { Icon, type IconName } from '../../ui/icons';
import { AttachmentBadge } from './AttachmentTags';

interface EventListProps {
  items: TimelineItem[];
  selectedId: number | null;
  onSelect: (item: TimelineItem) => void;
  /** Subagent run windows; used to tag rows that ran during a subagent. */
  runs?: SubagentRun[];
  /**
   * Scroll the selected row into view whenever this key changes — e.g. the
   * active filter. Selecting a row within the same list does NOT scroll; the
   * re-center only happens when arriving from another tab/filter.
   */
  scrollKey?: string | number;
}

export function EventList({ items, selectedId, onSelect, runs, scrollKey }: EventListProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [scrollKey]);

  return (
    <ul className="divide-y divide-line/10">
      {items.map((item) => {
        const meta = getCategoryMeta(item.category);
        const active = item.id === selectedId;
        const isSubagent = runs ? itemLane(item, runs) === 'subagent' : false;
        const showTarget = item.category !== 'question' && Boolean(item.target);
        return (
          <li key={item.id}>
            <button
              type="button"
              ref={active ? selectedRef : undefined}
              onClick={() => onSelect(item)}
              className={`flex w-full items-start gap-2.5 border-l-2 px-3.5 py-3 text-left transition-colors ${
                active
                  ? 'border-l-vermilion bg-surface'
                  : 'border-l-transparent hover:bg-surface'
              }`}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`font-mono text-[0.62rem] font-bold uppercase tracking-widest ${meta.color}`}>
                      {meta.label}
                    </span>
                    {isSubagent && <SubagentBadge />}
                    {item.status === 'interrupted' && <InterruptedBadge />}
                    {item.composer_mode && <ComposerModeBadge mode={item.composer_mode} />}
                    {item.is_question && <QaBadge variant="question" />}
                    {item.answers_event_id != null && <QaBadge variant="answer" />}
                  </span>
                  <span className="shrink-0 font-mono text-[0.6rem] tabular-nums text-fg/45">
                    {formatDateTime(item.start_ts || item.ts)}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm font-bold text-fg">
                    {item.title}
                  </span>
                  {item.attachments && <AttachmentBadge attachments={item.attachments} />}
                </span>
                {showTarget && (
                  <span className="block truncate font-mono text-xs text-fg/55">
                    {item.target}
                  </span>
                )}
              </span>
              {item.duration_ms != null && item.duration_ms > 0 && (
                <span className="shrink-0 font-mono text-[0.62rem] tabular-nums text-fg/45">
                  {formatDuration(item.duration_ms)}
                </span>
              )}
            </button>
          </li>
        );
      })}
      {!items.length && (
        <li className="px-3 py-6 text-center font-mono text-xs text-fg/40">No events.</li>
      )}
    </ul>
  );
}

function SubagentBadge() {
  return (
    <span
      title="Ran during a subagent's execution"
      className="flex shrink-0 items-center gap-0.5 rounded border border-cobalt/40 px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest text-cobalt">
      <Icon name="robot" className="h-2.5 w-2.5" />
      Sub
    </span>
  );
}

function InterruptedBadge() {
  return (
    <span
      title="The user stopped the agent mid-output — this thought/response was cut off"
      className="flex shrink-0 items-center gap-0.5 rounded border border-vermilion/50 px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest text-vermilion">
      <Icon name="stop" className="h-2.5 w-2.5" />
      Stopped
    </span>
  );
}

// Cursor composer modes. Keys are the internal `composer_mode` payload values;
// labels are Cursor's user-facing names (e.g. internal "chat" is shown as "Ask").
const COMPOSER_MODES: Record<string, { label: string; icon: IconName; cls: string }> = {
  plan: { label: 'Plan', icon: 'layers', cls: 'border-olive/40 text-olive' },
  chat: { label: 'Ask', icon: 'chat', cls: 'border-fg/20 text-fg/50' },
  debug: { label: 'Debug', icon: 'terminal', cls: 'border-vermilion/40 text-vermilion' },
  triage: { label: 'Triage', icon: 'list', cls: 'border-cobalt/40 text-cobalt' },
  multitask: { label: 'Multitask', icon: 'robot', cls: 'border-cobalt/40 text-cobalt' },
  project: { label: 'Project', icon: 'file', cls: 'border-cobalt/40 text-cobalt' },
};

function ComposerModeBadge({ mode }: { mode: string }) {
  const m = COMPOSER_MODES[mode];
  if (!m) return null;
  return (
    <span
      title={`Cursor ${mode} mode`}
      className={`flex shrink-0 items-center gap-0.5 rounded border px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest ${m.cls}`}>
      <Icon name={m.icon} className="h-2.5 w-2.5" />
      {m.label}
    </span>
  );
}

function QaBadge({ variant }: { variant: 'question' | 'answer' }) {
  const map = {
    question: { label: 'Question', cls: 'border-fg/20 text-fg/50', title: 'This prompt event contains questions' },
    answer: { label: 'Answer', cls: 'border-cobalt/40 text-cobalt', title: 'This prompt event stores the user answer' },
  }[variant];
  return (
    <span
      title={map.title}
      className={`shrink-0 rounded border px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest ${map.cls}`}>
      {map.label}
    </span>
  );
}
