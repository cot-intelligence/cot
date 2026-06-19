import React from 'react';
import { FadeIn } from '../ui/FadeIn';

interface DocsHeroProps {
  label: string;
  heading: string | readonly [string, string];
  callout?: string;
}

export function DocsHero({ label, heading, callout }: DocsHeroProps) {
  const isSplit = Array.isArray(heading);

  return (
    <FadeIn className="mb-12 md:mb-16">
      <span className="inline-block px-3 py-1 border border-cobalt bg-cobalt font-mono text-xs font-bold uppercase tracking-widest mb-6">
        {label}
      </span>
      <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold tracking-tighter uppercase leading-[0.9] mb-6">
        {isSplit ? (
          <>
            {heading[0]}
            <br />
            <span className="italic text-vermilion lowercase">{heading[1]}</span>
          </>
        ) : (
          heading
        )}
      </h1>
      {callout && (
        <p className="font-mono text-sm md:text-base font-bold uppercase max-w-2xl leading-relaxed text-cream/80 border-l-3 border-vermilion pl-5">
          {callout}
        </p>
      )}
    </FadeIn>
  );
}
