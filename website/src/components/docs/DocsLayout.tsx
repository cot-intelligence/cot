import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Nav } from '../Nav';
import { SiteFooter } from '../SiteFooter';
import { CtaBand } from '../CtaBand';
import { DocsSubnav } from './DocsSubnav';

interface DocsLayoutProps {
  hero: React.ReactNode;
  children: React.ReactNode;
}

export function DocsLayout({ hero, children }: DocsLayoutProps) {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <Nav />
      <main>
        <section
          data-nav-theme="dark"
          className="relative min-h-[45vh] flex flex-col justify-end pt-28 pb-12 grid-lines overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse 80% 60% at 50% 30%, rgba(255,69,0,0.06) 0%, transparent 70%)',
            }}
          />
          <div className="relative z-10 w-full max-w-6xl mx-auto px-6">{hero}</div>
        </section>

        <section
          data-nav-theme="light"
          className="bg-cream-dark text-ink border-y border-ink py-5 grid-lines-dark">
          <div className="max-w-6xl mx-auto px-6">
            <DocsSubnav />
          </div>
        </section>

        <section
          data-nav-theme="light"
          className="section bg-cream text-ink grid-lines-dark">
          <div className="w-full max-w-6xl mx-auto px-6">{children}</div>
        </section>

        <CtaBand variant="docs" />
      </main>
      <SiteFooter />
    </>
  );
}
