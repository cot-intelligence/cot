import React from 'react';
import { depth } from '../content';
import { FadeIn } from './ui/FadeIn';
import { Waterfall } from './ui/Waterfall';

export function Depth() {
  return (
    <section data-nav-theme="light" className="section bg-cream-dark text-ink grid-lines-dark">
      <div className="w-full max-w-6xl mx-auto px-6">
        <FadeIn className="mb-10 max-w-2xl">
          <span className="inline-block px-3 py-1 border border-ink bg-ink text-cream font-mono text-xs font-bold uppercase tracking-widest mb-4">
            {depth.label}
          </span>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter uppercase leading-[0.9] mb-4">
            {depth.heading[0]}
            <br />
            <span className="italic text-cobalt lowercase">{depth.heading[1]}</span>
          </h2>
          <p className="font-mono text-sm md:text-base font-bold uppercase border-l-3 border-ink pl-5 text-ink-light">
            {depth.callout}
          </p>
        </FadeIn>

        <FadeIn delay={0.15}>
          <Waterfall />
        </FadeIn>
      </div>
    </section>
  );
}
