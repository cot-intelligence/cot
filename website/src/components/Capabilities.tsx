import React, { useEffect, useState } from 'react';
import { capabilities } from '../content';
import { FadeIn } from './ui/FadeIn';
import { DataPanel } from './ui/DataPanel';

const ROTATE_MS = 5000;

export function Capabilities() {
  const [active, setActive] = useState(0);
  const item = capabilities.items[active];

  useEffect(() => {
    const id = window.setInterval(() => {
      setActive((prev) => (prev + 1) % capabilities.items.length);
    }, ROTATE_MS);

    return () => window.clearInterval(id);
  }, []);

  return (
    <section data-nav-theme="light" className="section bg-cream text-ink grid-lines-dark">
      <div className="w-full max-w-6xl mx-auto px-6">
        <FadeIn className="text-center mb-12">
          <span className="inline-block px-3 py-1 border border-ink bg-ink text-cream font-mono text-xs font-bold uppercase tracking-widest mb-4">
            {capabilities.label}
          </span>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter uppercase">
            {capabilities.heading}
          </h2>
        </FadeIn>

        <div className="grid lg:grid-cols-2 gap-10 items-center">
          <FadeIn>
            <DataPanel
              header={item.panel.header}
              context={item.panel.context}
              cells={item.panel.cells}
            />
          </FadeIn>

          <FadeIn delay={0.1}>
            <span className="inline-block px-3 py-1 border border-ink bg-ink text-cream font-mono text-xs font-bold uppercase tracking-widest mb-5">
              {item.label}
            </span>
            <h3 className="text-4xl md:text-5xl font-bold tracking-tighter uppercase leading-none mb-5">
              {item.title}
            </h3>
            <p className="font-mono text-sm font-bold uppercase border-l-3 border-ink pl-5 text-ink-light mb-6">
              {item.description}
            </p>

            <div className="flex items-center gap-3">
              {capabilities.items.map((f, i) => (
                <button
                  key={f.label}
                  onClick={() => setActive(i)}
                  aria-label={`Show ${f.label}`}
                  className={`h-1.5 border border-ink transition-all duration-300 ${
                    i === active ? 'w-10 bg-ink' : 'w-2 bg-cream hover:bg-cream-dark'
                  }`}
                />
              ))}
              <span className="font-mono text-xs font-bold uppercase text-ink-lighter ml-2">
                {active + 1} / {capabilities.items.length}
              </span>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
