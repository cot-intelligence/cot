import React from 'react';
import { hero, install } from '../content';
import { FadeIn } from './ui/FadeIn';
import { ShellCommand } from './ui/ShellCommand';
import { TraceViewer } from './ui/TraceViewer';
import { Marquee } from './Marquee';

export function Hero() {
  return (
    <section data-nav-theme="dark" className="relative min-h-screen flex flex-col grid-lines overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 50% 40%, rgba(255,69,0,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 flex-1 flex items-center w-full max-w-6xl mx-auto px-6 pt-20 pb-8">
        <div className="w-full grid lg:grid-cols-12 gap-10 lg:gap-12 items-center">
          <div className="lg:col-span-6">
            <FadeIn>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-cobalt text-cream border border-ink font-mono text-xs font-bold uppercase tracking-widest mb-6 shadow-soft">
                <span className="w-2 h-2 bg-cream animate-pulse" />
                {hero.badge}
              </div>
            </FadeIn>

            <FadeIn delay={0.1}>
              <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-[88px] leading-[0.9] tracking-tighter uppercase mb-6">
                {hero.headline[0]}
                <br />
                <span className="italic text-vermilion lowercase">{hero.headline[1]}</span>
              </h1>
            </FadeIn>

            <FadeIn delay={0.2}>
              <p className="font-mono text-sm font-bold uppercase max-w-md leading-relaxed text-cream/80 border-l-3 border-vermilion pl-5 mb-7">
                {hero.callout}
              </p>
            </FadeIn>

            <FadeIn delay={0.3}>
              <div className="flex flex-col items-start gap-4 w-fit max-w-full">
                <div className="flex flex-col items-start gap-2 w-fit max-w-full">
                  <span className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-cream/50 block">
                    {hero.dockerLabel}
                  </span>
                  <ShellCommand command={install.command} />
                </div>
                <a
                  href="/docs"
                  className="inline-flex font-mono text-sm font-bold uppercase tracking-widest text-cream/70 hover:text-cobalt transition-colors items-center gap-2 group">
                  {hero.ghostCta}
                  <span className="group-hover:translate-x-1 transition-transform">→</span>
                </a>
              </div>
            </FadeIn>
          </div>

          <FadeIn delay={0.2} className="lg:col-span-6">
            <TraceViewer />
          </FadeIn>
        </div>
      </div>

      <Marquee />
    </section>
  );
}
