import type { SessionLink, SessionLinks, SessionSummary } from '../../../lib/api';
import { formatDuration, formatRelative } from '../../../lib/categoryMeta';
import { formatCost } from '../../../lib/format';
import { AgentMark } from '../../ui/AgentMark';
import { SessionHash } from '../../ui/SessionHash';
import { useCopy } from '../../ui/useCopy';

interface SessionMetaProps {
  summary: SessionSummary;
  links?: SessionLinks;
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

const PARENT_LABEL: Record<SessionLink['type'], string> = {
  approval_review: 'Approval review for',
  subagent: 'Subagent of',
};

export function SessionMeta({ summary, links }: SessionMetaProps) {
  const isActive = summary.status === 'active';
  const parents = links?.parents ?? [];
  const subagentChildren = (links?.children ?? []).filter((l) => l.type === 'subagent');

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

      {parents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[0.58rem] uppercase tracking-widest text-fg/35">
          {parents.map((link) => (
            <SessionLinkPill
              key={`parent-${link.session_id}`}
              link={link}
              label={PARENT_LABEL[link.type]}
            />
          ))}
        </div>
      )}

      {subagentChildren.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[0.58rem] uppercase tracking-widest text-fg/35">
          <span className="text-fg/30">
            {subagentChildren.length} subagent{subagentChildren.length === 1 ? '' : 's'}
          </span>
          {subagentChildren.map((link) => (
            <SessionLinkPill key={`child-${link.session_id}`} link={link} />
          ))}
        </div>
      )}
    </header>
  );
}

function SessionLinkPill({ link, label }: { link: SessionLink; label?: string }) {
  return (
    <a
      href={`#/session/${encodeURIComponent(link.session_id)}`}
      title={link.title || link.session_id}
      className="inline-flex min-w-0 items-center gap-1 rounded border border-cobalt/25 bg-cobalt/[0.04] px-1.5 py-0.5 text-cobalt transition-colors hover:border-cobalt/45 hover:bg-cobalt/[0.08]"
    >
      {label && <span className="text-fg/35">{label}</span>}
      <span className="max-w-48 truncate">{link.title || link.session_id.slice(0, 8)}</span>
      <span className="text-cobalt/45">{link.event_count} events</span>
    </a>
  );
}
