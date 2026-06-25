import type { SessionSummary } from '../../../lib/api';
import { formatDuration, formatRelative } from '../../../lib/categoryMeta';
import { formatCost } from '../../../lib/format';
import { AgentMark } from '../../ui/AgentMark';
import { SessionHash } from '../../ui/SessionHash';
import { useCopy } from '../../ui/useCopy';

interface SessionMetaProps {
  summary: SessionSummary;
}

function DirectoryName({ cwd }: { cwd: string }) {
  const { copied, copy } = useCopy();
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts[parts.length - 1] || cwd;

  return (
    <span className="relative inline-flex min-w-0">
      {copied && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 font-mono text-[0.55rem] font-medium text-bg shadow-soft">
          Copied
        </span>
      )}
      <button
        type="button"
        onClick={() => copy(cwd)}
        title={cwd}
        aria-label={copied ? 'Directory path copied' : `Copy directory path ${cwd}`}
        className={`min-w-0 truncate font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion ${
          copied ? 'text-olive' : 'text-fg/65 hover:text-fg'
        }`}>
        {name}
      </button>
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

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-fg/50">
        {summary.cwd && (
          <>
            <DirectoryName cwd={summary.cwd} />
            <span className="text-fg/25">·</span>
          </>
        )}
        {formatRelative(summary.started_at)}
        <span className="text-fg/25">·</span>
        {formatDuration(null, summary.duration_seconds)}
        <span className="text-fg/25">·</span>
        {summary.event_count} events
        <span className="text-fg/25">·</span>
        {summary.tool_count} tools
        {summary.has_cost && (
          <>
            <span className="text-fg/25">·</span>
            <span className="text-vermilion/80" title="Estimated cost (cache-aware)">
              {formatCost(summary.cost_usd)}
            </span>
          </>
        )}
      </p>
    </header>
  );
}
