import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { docsNav } from '../../docs/content';

export function DocsSubnav() {
  const location = useLocation();

  return (
    <nav className="flex flex-wrap gap-2 md:gap-3">
      {docsNav.links.map((link) => {
        const active = location.pathname === link.href;
        return (
          <Link
            key={link.href}
            to={link.href}
            className={`px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest border border-ink transition-all ${
              active
                ? 'bg-ink text-cream shadow-brutal-sm'
                : 'bg-cream text-ink hover:bg-cream-dark'
            }`}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
