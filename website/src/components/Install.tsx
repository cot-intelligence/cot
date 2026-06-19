import React from 'react';
import { install } from '../content';
import { FadeIn } from './ui/FadeIn';

export function Install() {
  return (
    <section id="install" data-nav-theme="dark" className="section bg-ink text-cream">
      <div
        className="absolute inset-0 pointer-events-none grid-lines opacity-60"
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-4xl mx-auto px-6">
        <FadeIn>
          <span className="inline-block px-3 py-1 border border-olive bg-olive font-mono text-xs font-bold uppercase tracking-widest mb-6">
            {install.label}
          </span>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-[0.9] mb-8">
            {install.heading}
          </h2>
        </FadeIn>

        <FadeIn delay={0.1}>
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
                <span className="text-cream">{install.command}</span>
                {'\n'}
                <span className="text-cream/30"># </span>
                <span className="text-olive">{install.note}</span>
              </code>
            </pre>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
