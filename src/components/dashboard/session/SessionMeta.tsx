import type { SessionSummary } from '../../../lib/api';
import { formatDuration, formatRelative } from '../../../lib/categoryMeta';
import { formatCost } from '../../../lib/format';
import { AgentMark } from '../../ui/AgentMark';
import { SessionHash } from '../../ui/SessionHash';

interface SessionMetaProps {
  summary: SessionSummary;
}

function PathCrumbs({ cwd }: { cwd: string }) {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return (
    <span className="font-mono text-xs text-fg/55">
      {parts.join(' / ')}
    </span>
  );
}

export function SessionMeta({ summary }: SessionMetaProps) {
  const isActive = summary.status === 'active';

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <AgentMark id={summary.source} className="h-4 w-4 text-fg/60" />
        <span className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/50">
          {summary.source}
        </span>
        <span className="text-fg/25">·</span>
        <span
          className={`font-mono text-[0.65rem] uppercase tracking-widest ${
            isActive ? 'text-cobalt' : 'text-fg/50'
          }`}>
          {summary.status}
        </span>
        <span className="text-fg/25">·</span>
        <SessionHash id={summary.id} />
      </div>

      <h1 className="font-serif text-xl font-bold leading-snug text-fg sm:text-2xl">
        {summary.title || summary.id}
      </h1>

      {summary.cwd && <PathCrumbs cwd={summary.cwd} />}

      <p className="font-mono text-xs text-fg/50">
        {formatRelative(summary.started_at)}
        {' · '}
        {formatDuration(null, summary.duration_seconds)}
        {' · '}
        {summary.event_count} events
        {' · '}
        {summary.tool_count} tools
        {summary.has_cost && (
          <>
            {' · '}
            <span className="text-vermilion/80" title="Estimated cost (cache-aware)">
              {formatCost(summary.cost_usd)}
            </span>
          </>
        )}
      </p>
    </header>
  );
}
