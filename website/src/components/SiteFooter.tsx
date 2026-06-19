import React from 'react';
import { Link } from 'react-router-dom';
import { footer, site } from '../content';

function LinkColumn({
  title,
  links,
  hover,
}: {
  title: string;
  links: readonly { label: string; href: string }[];
  hover: string;
}) {
  return (
    <div>
      <h4 className="font-mono text-xs font-bold uppercase tracking-widest mb-5 border-b border-ink pb-2 inline-block text-ink-lighter">
        {title}
      </h4>
      <ul className="space-y-3 font-mono text-sm font-bold uppercase">
        {links.map((link) => (
          <li key={link.label}>
            {link.href.startsWith('/') ? (
              <Link to={link.href} className={`hover:pl-1 transition-all ${hover}`}>
                {link.label}
              </Link>
            ) : (
              <a href={link.href} className={`hover:pl-1 transition-all ${hover}`}>
                {link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer data-nav-theme="light" className="bg-cream text-ink py-16 px-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-10">
        <div className="md:col-span-5">
          <Link to="/" className="font-serif text-5xl font-bold italic tracking-tighter block mb-5">
            {site.name}
          </Link>
          <p className="font-mono text-sm font-bold uppercase border-l-3 border-ink pl-4 text-ink-light max-w-xs">
            {site.tagline}
          </p>
        </div>

        <div className="md:col-span-7">
          <LinkColumn title="RESOURCES" links={footer.resources} hover="hover:text-cobalt" />
        </div>
      </div>

      <div className="max-w-6xl mx-auto mt-10 pt-6 border-t border-ink font-mono text-xs font-bold uppercase text-ink-lighter">
        © {new Date().getFullYear()} COT // {footer.legal}
      </div>
    </footer>
  );
}
