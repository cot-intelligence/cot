import React, { useState } from 'react';
import { FadeIn } from '../ui/FadeIn';

interface FaqItem {
  q: string;
  a: string;
}

export function FaqList({ items }: { items: readonly FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <FadeIn key={item.q} delay={i * 0.04}>
          <div className="border border-ink bg-cream-dark shadow-soft">
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              className="w-full text-left px-5 py-4 flex items-center justify-between gap-4 hover:bg-cream transition-colors">
              <span className="font-mono text-sm font-bold uppercase tracking-wide text-ink">
                {item.q}
              </span>
              <span className="font-mono text-ink-lighter text-lg shrink-0">
                {open === i ? '−' : '+'}
              </span>
            </button>
            {open === i && (
              <div className="px-5 pb-5 border-t border-ink/10">
                <p className="font-mono text-sm leading-relaxed text-ink-light pt-4">{item.a}</p>
              </div>
            )}
          </div>
        </FadeIn>
      ))}
    </div>
  );
}
