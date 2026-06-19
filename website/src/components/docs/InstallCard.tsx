import React from 'react';
import { FadeIn } from '../ui/FadeIn';

interface InstallCardProps {
  command: string;
  note?: string;
  delay?: number;
}

export function InstallCard({ command, note, delay = 0 }: InstallCardProps) {
  return (
    <FadeIn delay={delay}>
      <div className="border border-cream/30 shadow-soft-lg bg-[#0a0a0a]">
        <div className="border-b border-cream/20 flex items-center justify-between px-4 py-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-2.5 h-2.5 rounded-full bg-cream/60" />
            ))}
          </div>
          <span className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-cream/40">
            ~/cot
          </span>
        </div>
        <pre className="p-6 md:p-8 overflow-x-auto font-mono text-sm md:text-base font-bold leading-relaxed">
          <code>
            <span className="text-cream/30">$ </span>
            <span className="text-cream">{command}</span>
            {note && (
              <>
                {'\n'}
                <span className="text-cream/30"># </span>
                <span className="text-olive">{note}</span>
              </>
            )}
          </code>
        </pre>
      </div>
    </FadeIn>
  );
}
