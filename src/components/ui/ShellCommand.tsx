import { useCopy } from './useCopy';

interface ShellCommandProps {
  command: string;
  copiedLabel?: string;
  className?: string;
}

export function ShellCommand({
  command,
  copiedLabel = 'Copied',
  className = '',
}: ShellCommandProps) {
  const { copied, copy } = useCopy();

  return (
    <button
      type="button"
      onClick={() => copy(command)}
      aria-label={`Copy command: ${command}`}
      className={`group relative flex w-full items-center justify-between gap-4 overflow-hidden border border-fg/25 bg-panel px-4 py-3 text-left font-mono text-xs font-bold transition-[border-color,box-shadow] duration-300 hover:border-vermilion focus-visible:border-vermilion focus-visible:outline-none ${className}`}>
      <code className="relative z-10 min-w-0 flex-1 truncate text-fg">
        <span className="text-fg/35 transition-colors duration-300 group-hover:text-fg/70">
          ${' '}
        </span>
        {copied ? copiedLabel : command}
      </code>
      <span className="relative z-10 shrink-0 font-mono text-[0.6rem] uppercase tracking-widest text-fg/40 transition-colors duration-300 group-hover:text-vermilion">
        {copied ? 'OK' : 'COPY'}
      </span>
    </button>
  );
}
