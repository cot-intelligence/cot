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
      className={`group press relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-control border border-line/10 bg-panel px-4 py-3 text-left font-mono text-code transition-[border-color,transform] duration-150 hover:border-line/[0.16] ${className}`}>
      <code className="relative z-10 min-w-0 flex-1 truncate text-fg">
        <span className="select-none text-fg/40">
          ${' '}
        </span>
        {copied ? copiedLabel : command}
      </code>
      <span className={`relative z-10 shrink-0 font-mono text-code transition-colors duration-150 ${copied ? 'text-olive' : 'text-fg/60 group-hover:text-fg'}`}>
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}
