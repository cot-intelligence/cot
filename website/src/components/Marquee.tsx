import React from 'react';
import { marquee } from '../content';

export function Marquee() {
  const facts = [...marquee.facts, ...marquee.facts];

  return (
    <section className="relative shrink-0 brutal-border-b bg-olive overflow-hidden py-4 flex items-center">
      <div className="absolute left-4 z-10 bg-olive px-4 brutal-border text-cream font-mono font-bold uppercase text-sm shadow-brutal hidden md:block">
        {marquee.pin}
      </div>
      <div className="flex whitespace-nowrap animate-marquee" aria-hidden="true">
        {facts.map((fact, i) => (
          <div key={i} className="flex items-center mx-8">
            <span className="font-serif text-4xl font-bold italic text-cream tracking-tighter">
              {fact}
            </span>
            <span className="mx-8 text-cream/50 font-mono text-2xl">*</span>
          </div>
        ))}
      </div>
    </section>
  );
}
