import React from 'react';
import { Link } from 'react-router-dom';
import { cta, docsCta } from '../content';
import { FadeIn } from './ui/FadeIn';

interface CtaBandProps {
  variant?: 'landing' | 'docs';
}

export function CtaBand({ variant = 'landing' }: CtaBandProps) {
  const content = variant === 'docs' ? docsCta : cta;
  const accent = variant === 'docs' ? 'agents' : 'observability';
  const [before, after] = content.heading.split(accent);

  return (
    <section data-nav-theme="dark" className="section bg-vermilion text-cream relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(#111 2px, transparent 2px), linear-gradient(90deg, #111 2px, transparent 2px)',
          backgroundSize: '40px 40px',
          opacity: 0.1,
        }}
      />

      <div className="relative z-10 w-full max-w-4xl mx-auto px-6 text-center">
        <FadeIn>
          <h2 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter uppercase leading-[0.9] text-cream mb-10 md:mb-12">
            {before}
            <span className="font-serif italic lowercase text-ink normal-case">{accent}</span>
            {after}
          </h2>

          <div className="flex flex-col items-center gap-4 md:gap-5">
            <span className="inline-block font-mono text-sm md:text-base font-bold uppercase tracking-widest bg-cream text-ink px-6 py-3 border border-ink shadow-brutal">
              {content.callout}
            </span>
            <Link
              to={content.href}
              className="inline-block px-8 py-3.5 bg-ink text-cream font-mono text-sm md:text-base font-bold uppercase tracking-widest border border-ink shadow-brutal-white hover:opacity-90 transition-opacity">
              {content.button}
            </Link>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
