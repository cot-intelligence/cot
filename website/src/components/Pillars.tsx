import React from 'react';
import { pillars } from '../content';
import { FadeIn } from './ui/FadeIn';

const cardVariants = [
  {
    bg: 'bg-cream',
    heading: 'text-ink',
    body: 'text-ink-light',
    meta: 'text-ink-lighter',
    ghost: 'opacity-[0.07] text-ink',
    border: 'border-ink',
  },
  {
    bg: 'bg-cobalt',
    heading: 'text-cream',
    body: 'text-cream',
    meta: 'text-cream/70',
    ghost: 'opacity-[0.12] text-cream',
    border: 'border-ink',
  },
  {
    bg: 'bg-vermilion',
    heading: 'text-cream',
    body: 'text-cream',
    meta: 'text-cream/70',
    ghost: 'opacity-[0.12] text-cream',
    border: 'border-ink',
  },
];

export function Pillars() {
  return (
    <section id="product" data-nav-theme="light" className="section bg-cream-dark text-ink grid-lines-dark">
      <div className="w-full max-w-6xl mx-auto px-6">
        <FadeIn className="text-center mb-12">
          <span className="inline-block px-3 py-1 border border-ink bg-ink text-cream font-mono text-xs font-bold uppercase tracking-widest mb-4 shadow-brutal">
            {pillars.label}
          </span>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter uppercase">
            {pillars.heading}
          </h2>
        </FadeIn>

        <div className="grid md:grid-cols-3 gap-6">
          {pillars.items.map((pillar, i) => {
            const variant = cardVariants[i];
            return (
              <FadeIn key={pillar.num} delay={i * 0.1}>
                <div
                  className={`h-full border ${variant.border} ${variant.bg} p-8 shadow-brutal hover:-translate-y-2 transition-transform duration-200 relative overflow-hidden`}>
                  <div
                    className={`absolute -top-10 -right-10 text-[150px] font-mono font-bold leading-none select-none ${variant.ghost}`}>
                    {pillar.num}
                  </div>
                  <div
                    className={`font-mono font-bold text-sm mb-8 border-b ${variant.border} pb-4 flex items-center gap-3 ${variant.meta}`}>
                    <span>{pillar.num}</span>
                    <span className="opacity-60 tracking-widest overflow-hidden whitespace-nowrap">
                      // // // // // // // //
                    </span>
                  </div>
                  <h3
                    className={`font-serif text-4xl md:text-5xl font-bold italic mb-6 leading-none tracking-tighter ${variant.heading}`}>
                    {pillar.title}
                  </h3>
                  <p className={`font-mono text-base font-bold uppercase leading-tight ${variant.body}`}>
                    {pillar.description}
                  </p>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}
