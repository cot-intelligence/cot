import { AgentMark } from './AgentMark';
import { isKnownAgent, sourceLabel } from '../../lib/sourceLabels';

interface SourceBadgeProps {
  source: string;
  className?: string;
}

/** Source/type indicator: agent mark for known agents, a generic glyph for
 *  custom sources (API, custom apps). */
export function SourceBadge({ source, className = '' }: SourceBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="text-fg/70">
        {isKnownAgent(source) ? (
          <AgentMark id={source} className="h-4 w-4" />
        ) : (
          <GenericMark />
        )}
      </span>
      <span className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/80">
        {sourceLabel(source)}
      </span>
    </span>
  );
}

function GenericMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
