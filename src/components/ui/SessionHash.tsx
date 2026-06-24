import { useCopy } from './useCopy';

interface SessionHashProps {
  id: string;
  /** Visible prefix length — matches the sessions table default. */
  length?: number;
  className?: string;
}

export function SessionHash({ id, length = 6, className = '' }: SessionHashProps) {
  const { copied, copy } = useCopy();

  return (
    <span className="relative inline-flex">
      {copied && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 font-mono text-[0.55rem] font-medium text-bg shadow-soft">
          Copied
        </span>
      )}
      <button
        type="button"
        onClick={() => copy(id)}
        title={id}
        aria-label={copied ? 'Session id copied' : `Copy session id ${id}`}
        className={`shrink-0 font-mono text-[0.62rem] tabular-nums tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion ${
          copied ? 'text-olive' : 'text-fg/35 hover:text-fg/60'
        } ${className}`}>
        {id.slice(0, length)}
      </button>
    </span>
  );
}
