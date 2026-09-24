import {
  sessionExportUrl,
  type SessionLink,
  type SessionLinks,
  type SessionSummary,
} from '../../../lib/api';
import { formatDuration, formatRelative } from '../../../lib/categoryMeta';
import { formatCost } from '../../../lib/format';
import { AgentMark } from '../../ui/AgentMark';
import { Icon } from '../../ui/icons';
import { SessionHash } from '../../ui/SessionHash';
import { useCopy } from '../../ui/useCopy';

interface SessionMetaProps {
  summary: SessionSummary;
  links?: SessionLinks;
  onToggleBookmark?: () => void;
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
        className={`min-w-0 truncate font-mono text-[0.68rem] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion ${
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

export function SessionMeta({ summary, links, onToggleBookmark }: SessionMetaProps) {
  const isActive = summary.status === 'active';
  const parents = links?.parents ?? [];
  const subagentChildren = (links?.children ?? []).filter((l) => l.type === 'subagent');

  const sep = <span className="text-fg/20" aria-hidden="true">·</span>;

  return (
    <header className="space-y-2">
      <div className="flex items-start justify-between gap-6">
        <h1
          className="min-w-0 truncate font-serif text-[1.35rem] font-normal leading-tight tracking-[-0.02em] text-fg sm:text-[1.6rem]"
          title={summary.title || summary.id}>
          {summary.title || summary.id}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={sessionExportUrl(summary.id)}
            download
            aria-label="Export session as JSON"
            title="Export as JSON"
            className="btn mt-0.5">
            <Icon name="download" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Export</span>
          </a>
          {onToggleBookmark && (
            <button
              type="button"
              onClick={onToggleBookmark}
              aria-pressed={summary.bookmarked}
              aria-label={summary.bookmarked ? 'Remove bookmark' : 'Bookmark session'}
              title={summary.bookmarked ? 'Remove bookmark' : 'Bookmark session'}
              className={`btn mt-0.5 ${summary.bookmarked ? '!border-vermilion/40 !text-vermilion hover:!border-vermilion/70' : ''}`}>
              <Icon
                name={summary.bookmarked ? 'bookmark-filled' : 'bookmark'}
                className="h-3.5 w-3.5"
              />
              <span className="hidden sm:inline">{summary.bookmarked ? 'Bookmarked' : 'Bookmark'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.68rem] text-fg/45">
        <span className="inline-flex items-center gap-1.5 uppercase tracking-[0.14em]">
          <AgentMark id={summary.source} className="h-3.5 w-3.5 text-fg/60" />
          {summary.source}
        </span>
        {sep}
        <span className={`uppercase tracking-[0.14em] ${isActive ? 'text-cobalt' : ''}`}>{summary.status}</span>
        {sep}
        <SessionHash id={summary.id} />
        {summary.cwd && (
          <>
            {sep}
            <DirectoryName cwd={summary.cwd} />
          </>
        )}
        {sep}
        {formatRelative(summary.started_at)}
        {sep}
        {formatDuration(null, summary.duration_seconds)}
        {sep}
        <span className="tabular-nums">{summary.event_count} events</span>
        {sep}
        <span className="tabular-nums">{summary.tool_count} tools</span>
        {summary.has_cost && (
          <>
            {sep}
            <span className="tabular-nums text-vermilion/80" title="Estimated cost (cache-aware)">
              {formatCost(summary.cost_usd)}
            </span>
          </>
        )}
      </div>

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
