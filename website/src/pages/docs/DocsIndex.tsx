import React from 'react';
import { Link } from 'react-router-dom';
import { DocsLayout } from '../../components/docs/DocsLayout';
import { DocsHero } from '../../components/docs/DocsHero';
import { InstallCard } from '../../components/docs/InstallCard';
import { FadeIn } from '../../components/ui/FadeIn';
import { docsIndex } from '../../docs/content';

const cardBgs = ['bg-cream', 'bg-cobalt text-cream', 'bg-vermilion text-cream'];

export function DocsIndex() {
  return (
    <DocsLayout
      hero={
        <DocsHero
          label={docsIndex.label}
          heading={docsIndex.heading}
          callout={docsIndex.callout}
        />
      }>
      <InstallCard
        command={docsIndex.installCommand}
        note={docsIndex.installNote}
        delay={0}
      />

      <div className="grid md:grid-cols-3 gap-6 mt-12">
        {docsIndex.cards.map((card, i) => (
          <FadeIn key={card.num} delay={0.08 + i * 0.08}>
            <div
              className={`h-full border border-ink p-6 shadow-brutal ${cardBgs[i]} hover:-translate-y-1 transition-transform`}>
              <div className="font-mono text-xs font-bold uppercase tracking-widest opacity-60 mb-4">
                {card.num}
              </div>
              <h3 className="font-serif text-2xl font-bold italic mb-3">{card.title}</h3>
              <p className="font-mono text-sm font-bold uppercase leading-relaxed opacity-80">
                {card.description}
              </p>
            </div>
          </FadeIn>
        ))}
      </div>

      <FadeIn delay={0.3} className="mt-12">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          SUPPORTED AGENTS
        </span>
        <div className="flex flex-wrap gap-3">
          {docsIndex.agents.map((agent) => (
            <span
              key={agent}
              className="px-4 py-2 border border-ink bg-cream-dark font-mono text-xs font-bold uppercase tracking-widest text-ink">
              {agent}
            </span>
          ))}
        </div>
      </FadeIn>

      <FadeIn delay={0.35} className="mt-12">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          READ MORE
        </span>
        <div className="grid sm:grid-cols-3 gap-4">
          {docsIndex.quickLinks.map((link) => (
            <Link
              key={link.href}
              to={link.href}
              className="group border border-ink p-5 bg-cream-dark shadow-soft hover:shadow-soft-md hover:-translate-y-0.5 transition-all">
              <div className="font-mono text-sm font-bold uppercase text-ink group-hover:text-vermilion transition-colors mb-2">
                {link.label} →
              </div>
              <div className="font-mono text-xs text-ink-lighter">{link.desc}</div>
            </Link>
          ))}
        </div>
      </FadeIn>
    </DocsLayout>
  );
}
