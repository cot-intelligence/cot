import { useState } from 'react';
import type { TimelineItem } from '../../lib/api';
import { formatDuration, formatTime, getCategoryMeta } from '../../lib/categoryMeta';

interface TimelineItemRowProps {
  item: TimelineItem;
}

function DiffView({ detail }: { detail: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return (
      <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-relaxed text-fg/85">
        {detail}
      </pre>
    );
  }
  const obj = parsed as Record<string, unknown>;
  const input = obj.input ?? obj.command ?? obj.arguments;
  const response = obj.response ?? obj.result ?? obj.output ?? obj.edits;
  return (
    <div className="space-y-3">
      {input != null && (
        <div>
          <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">Input</span>
          <pre className="scroll-thin mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-fg/10 bg-panel p-3 font-mono text-[0.72rem] text-fg/85">
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {response != null && (
        <div>
          <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">Output</span>
          <pre className="scroll-thin mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-fg/10 bg-panel p-3 font-mono text-[0.72rem] text-fg/85">
            {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
          </pre>
        </div>
      )}
      {!input && !response && (
        <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-relaxed text-fg/85">
          {detail}
        </pre>
      )}
    </div>
  );
}

function QaPill({ item }: { item: TimelineItem }) {
  if (item.is_question) {
    return (
      <span
        title="This prompt event contains questions"
        className="rounded border border-fg/20 px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest text-fg/50">
        Question
      </span>
    );
  }
  if (item.answers_event_id != null) {
    return (
      <span
        title="This prompt event stores the user answer"
        className="rounded border border-cobalt/40 px-1 py-px font-mono text-[0.5rem] font-bold uppercase tracking-widest text-cobalt">
        Answer
      </span>
    );
  }
  return null;
}

export function TimelineItemRow({ item }: TimelineItemRowProps) {
  const [open, setOpen] = useState(false);
  const meta = getCategoryMeta(item.category);
  const showTarget = item.category !== 'question' && Boolean(item.target);

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      <div className="flex flex-col items-center">
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
        <span className="mt-2 w-px flex-1 bg-fg/10" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-start justify-between gap-3 text-left">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[0.55rem] tabular-nums text-fg/40">
                {formatTime(item.start_ts || item.ts)}
              </span>
              <span className={`font-mono text-[0.6rem] font-bold uppercase tracking-widest ${meta.color}`}>
                {meta.label}
              </span>
              <QaPill item={item} />
              {item.ongoing && (
                <span className="font-mono text-[0.55rem] uppercase text-cobalt">ongoing</span>
              )}
            </div>
            <p className="font-mono text-xs font-bold text-fg">{item.title}</p>
            {showTarget && (
              <p className="truncate font-mono text-[0.65rem] text-fg/50">{item.target}</p>
            )}
          </div>
          <span className="shrink-0 font-mono text-[0.6rem] tabular-nums text-fg/40">
            {formatDuration(item.duration_ms)}
          </span>
        </button>
        {open && item.detail && (
          <div className="mt-3 border border-fg/15 bg-surface p-4">
            <DiffView detail={item.detail} />
          </div>
        )}
      </div>
    </li>
  );
}
