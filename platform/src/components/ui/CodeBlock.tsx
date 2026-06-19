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
      className={`overflow-hidden border border-fg/20 bg-panel ${className}`}>
      <div className="flex items-center justify-between gap-4 border-b border-fg/15 bg-surface px-4 py-2.5">
        <span className="truncate font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/55">
          {filename}
        </span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="shrink-0 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/40 transition-colors hover:text-vermilion focus-visible:text-vermilion focus-visible:outline-none">
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <pre className="scroll-thin overflow-x-auto px-4 py-4 font-mono text-[0.72rem] leading-relaxed text-fg/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}
