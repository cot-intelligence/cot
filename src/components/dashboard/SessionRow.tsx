import type { SessionSummary } from '../../lib/api';
import { AgentMark } from '../ui/AgentMark';
import { formatDuration, formatRelative } from '../../lib/categoryMeta';

interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}

export function SessionRow({ session, selected, onSelect }: SessionRowProps) {
  const isActive = session.status === 'active';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-line/10 px-4 py-3.5 text-left transition-colors hover:bg-surface ${
        selected ? 'bg-surface border-l-2 border-l-vermilion' : 'border-l-2 border-l-transparent'
      }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <AgentMark id={session.source} className="mt-0.5 h-4 w-4 shrink-0 text-fg/50" />
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-bold text-fg">
              {session.title || session.id}
            </p>
            <p className="mt-1 font-mono text-xs text-fg/45">
              {session.event_count} events · {formatDuration(null, session.duration_seconds)}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span
            className={`font-mono text-[0.62rem] uppercase tracking-widest ${
              isActive ? 'text-cobalt' : 'text-fg/40'
            }`}>
            {isActive ? 'Active' : 'Done'}
          </span>
          <p className="mt-0.5 font-mono text-xs text-fg/40">
            {formatRelative(session.last_activity || session.started_at)}
          </p>
        </div>
      </div>
    </button>
  );
}
