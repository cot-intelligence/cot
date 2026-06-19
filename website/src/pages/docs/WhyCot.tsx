import React from 'react';
import { DocsLayout } from '../../components/docs/DocsLayout';
import { DocsHero } from '../../components/docs/DocsHero';
import { ArchitectureFlow } from '../../components/docs/ArchitectureFlow';
import { FadeIn } from '../../components/ui/FadeIn';
import { DataPanel } from '../../components/ui/DataPanel';
import { whyCot } from '../../docs/content';

export function WhyCot() {
  return (
    <DocsLayout
      hero={
        <DocsHero
          label={whyCot.label}
          heading={whyCot.heading}
          callout={whyCot.callout}
        />
      }>
      <FadeIn delay={0} className="mb-12">
        <h3 className="font-serif text-3xl font-bold italic mb-4">{whyCot.name.title}</h3>
        <p className="font-mono text-sm leading-relaxed text-ink-light max-w-2xl border-l-3 border-ink pl-5">
          {whyCot.name.body}
        </p>
      </FadeIn>

      <FadeIn delay={0.08} className="mb-12">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          USE CASES
        </span>
        <div className="grid md:grid-cols-3 gap-6">
          {whyCot.useCases.map((uc, i) => (
            <div
              key={uc.title}
              className={`border border-ink p-6 shadow-brutal ${
                i === 0 ? 'bg-cream' : i === 1 ? 'bg-cobalt text-cream' : 'bg-vermilion text-cream'
              }`}>
              <h4 className="font-serif text-xl font-bold italic mb-3">{uc.title}</h4>
              <p className="font-mono text-xs font-bold uppercase leading-relaxed opacity-80">
                {uc.body}
              </p>
            </div>
          ))}
        </div>
      </FadeIn>

      <FadeIn delay={0.15} className="mb-6">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          {whyCot.architecture.title.toUpperCase()}
        </span>
        <ArchitectureFlow />
      </FadeIn>

      <div className="grid md:grid-cols-2 gap-6 mt-10">
        <FadeIn delay={0.2}>
          <DataPanel
            header="COLLECTED_LOCALLY"
            context="per session"
            cells={whyCot.architecture.collected.map((item, i) => ({
              label: `ITEM_${i + 1}`,
              value: item,
              accent: i % 2 === 0 ? ('cobalt' as const) : undefined,
            }))}
          />
        </FadeIn>
        <FadeIn delay={0.25}>
          <DataPanel
            header="NOT_SENT"
            context="by default"
            cells={whyCot.architecture.notCollected.map((item, i) => ({
              label: `ITEM_${i + 1}`,
              value: item,
              accent: i === 0 ? ('olive' as const) : undefined,
            }))}
          />
        </FadeIn>
      </div>
    </DocsLayout>
  );
}
