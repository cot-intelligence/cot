import React from 'react';
import { DocsLayout } from '../../components/docs/DocsLayout';
import { DocsHero } from '../../components/docs/DocsHero';
import { InstallCard } from '../../components/docs/InstallCard';
import { FadeIn } from '../../components/ui/FadeIn';
import { starterGuide } from '../../docs/content';

export function StarterGuide() {
  return (
    <DocsLayout
      hero={
        <DocsHero
          label={starterGuide.label}
          heading={starterGuide.heading}
          callout={starterGuide.callout}
        />
      }>
      <FadeIn delay={0}>
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-3 block">
          PREREQUISITES
        </span>
        <div className="flex flex-wrap gap-3 mb-10">
          {starterGuide.prerequisites.map((item) => (
            <span
              key={item}
              className="px-3 py-1.5 border border-ink bg-cream-dark font-mono text-xs font-bold uppercase text-ink">
              {item}
            </span>
          ))}
        </div>
      </FadeIn>

      <div className="space-y-8 mb-12">
        {starterGuide.steps.map((step, i) => (
          <FadeIn key={step.num} delay={0.08 + i * 0.08}>
            <div className="border-l-3 border-vermilion pl-5">
              <div className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-2">
                {step.num}
              </div>
              <h3 className="font-serif text-2xl font-bold italic mb-2">{step.title}</h3>
              <p className="font-mono text-sm text-ink-light mb-4 max-w-2xl">{step.body}</p>
              {'command' in step && step.command && (
                <InstallCard command={step.command} />
              )}
            </div>
          </FadeIn>
        ))}
      </div>

      <FadeIn delay={0.3}>
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          USEFUL COMMANDS
        </span>
        <div className="space-y-4">
          {starterGuide.commands.map((cmd) => (
            <div key={cmd.label} className="border border-ink p-4 bg-cream-dark shadow-soft">
              <div className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-ink-lighter mb-2">
                {cmd.label}
              </div>
              <code className="font-mono text-sm font-bold text-vermilion block mb-1">
                $ {cmd.command}
              </code>
              <p className="font-mono text-xs text-ink-lighter">{cmd.desc}</p>
            </div>
          ))}
        </div>
      </FadeIn>

      <FadeIn delay={0.35} className="mt-10">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter mb-4 block">
          ENV OVERRIDES
        </span>
        <div className="grid sm:grid-cols-3 gap-4">
          {starterGuide.overrides.map((o) => (
            <div key={o.var} className="border border-ink p-4 bg-cream-dark">
              <code className="font-mono text-sm font-bold text-cobalt">{o.var}</code>
              <p className="font-mono text-xs text-ink-lighter mt-2">{o.desc}</p>
            </div>
          ))}
        </div>
      </FadeIn>
    </DocsLayout>
  );
}
