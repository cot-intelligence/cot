import { useCopy } from './useCopy';

interface CodeBlockProps {
  /** Shown in the title bar, e.g. a file path. */
  filename: string;
  code: string;
  className?: string;
}

export function CodeBlock({ filename, code, className = '' }: CodeBlockProps) {
  const { copied, copy } = useCopy();

  return (
    <div
      className={`overflow-hidden border border-line/20 bg-panel ${className}`}>
      <div className="flex items-center justify-between gap-4 border-b border-line/10 bg-surface px-4 py-2.5">
        <span className="truncate font-mono text-data font-semibold uppercase tracking-label text-fg/60">
          {filename}
        </span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="shrink-0 font-mono text-label font-semibold uppercase tracking-label text-fg/40 transition-colors hover:text-hot focus-visible:text-hot focus-visible:outline-none">
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <pre className="scroll-thin overflow-x-auto px-4 py-4 font-mono text-code leading-relaxed text-fg/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}
