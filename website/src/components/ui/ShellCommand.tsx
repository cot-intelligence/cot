import React, { useState } from 'react';

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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = command;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy command: ${command}`}
      className={`group relative block w-fit max-w-full text-left border border-cream/25 bg-ink/40 px-4 py-3 font-mono text-[0.7rem] sm:text-xs font-bold overflow-hidden cursor-pointer transition-[border-color,box-shadow] duration-500 hover:border-vermilion hover:shadow-soft-md focus-visible:outline-none focus-visible:border-vermilion ${className}`}>
      <span className="shell-fluid-fill absolute inset-0 bg-vermilion" aria-hidden="true" />
      <span className="shell-fluid-wave absolute inset-0 bg-vermilion/80" aria-hidden="true" />
      <code className="relative z-10 block text-cream text-[0.7rem] sm:text-xs leading-snug whitespace-nowrap transition-colors duration-300 group-hover:text-cream">
        <span className="text-cream/35 transition-colors duration-300 group-hover:text-cream/70">
          $ {' '}
        </span>
        {copied ? copiedLabel : command}
      </code>
    </button>
  );
}
