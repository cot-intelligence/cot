import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { nav, site } from '../content';
import { docsNav } from '../docs/content';

const NAV_PROBE_Y = 32;

function NavChip({
  children,
  onLight,
  className = '',
}: {
  children: React.ReactNode;
  onLight: boolean;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center justify-center transition-all duration-300 ${
        onLight ? 'rounded-full bg-vermilion shadow-soft' : ''
      } ${className}`}>
      {children}
    </div>
  );
}

export function Nav() {
  const [open, setOpen] = useState(false);
  const [onLight, setOnLight] = useState(false);
  const location = useLocation();
  const onDocs = location.pathname.startsWith('/docs');

  useEffect(() => {
    const update = () => {
      const sections = document.querySelectorAll<HTMLElement>('[data-nav-theme]');
      let theme: 'light' | 'dark' = 'dark';

      for (const section of sections) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= NAV_PROBE_Y && rect.bottom > NAV_PROBE_Y) {
          theme = section.dataset.navTheme === 'light' ? 'light' : 'dark';
          break;
        }
      }

      setOnLight(theme === 'light');
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <>
      <motion.header
        initial={{ y: -80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.175, 0.885, 0.32, 1.275] }}
        className="fixed top-0 left-0 right-0 z-50 px-6 py-5 flex items-center justify-between pointer-events-none">
        <NavChip onLight={onLight} className={onLight ? 'px-3.5 py-1.5' : ''}>
          <Link
            to="/"
            className="font-serif text-2xl font-bold italic tracking-tighter text-cream pointer-events-auto">
            {site.name}
          </Link>
        </NavChip>

        <NavChip onLight={onLight} className={onLight ? 'w-11 h-11' : ''}>
          <button
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
            className="flex flex-col gap-1.5 p-2 group pointer-events-auto">
            <span
              className={`block h-px bg-cream transition-all duration-300 ${open ? 'w-6 rotate-45 translate-y-[3.5px]' : 'w-8'}`}
            />
            <span
              className={`block h-px bg-cream transition-all duration-300 ${open ? 'w-6 -rotate-45 -translate-y-[3.5px]' : 'w-5'}`}
            />
          </button>
        </NavChip>
      </motion.header>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-ink/95 backdrop-blur-md flex flex-col items-center justify-center gap-8"
            onClick={() => setOpen(false)}>
            {nav.links.map((link, i) => (
              <motion.div
                key={link.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}>
                <Link
                  to={link.href}
                  className="font-mono text-2xl font-bold uppercase tracking-widest text-cream hover:text-vermilion transition-colors"
                  onClick={() => setOpen(false)}>
                  {link.label}
                </Link>
              </motion.div>
            ))}
            {onDocs && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.16 }}
                className="flex flex-col items-center gap-4 pt-2 border-t border-cream/20 w-48">
                {docsNav.links.map((link) => (
                  <Link
                    key={link.href}
                    to={link.href}
                    className={`font-mono text-sm font-bold uppercase tracking-widest transition-colors ${
                      location.pathname === link.href
                        ? 'text-vermilion'
                        : 'text-cream/60 hover:text-cream'
                    }`}
                    onClick={() => setOpen(false)}>
                    {link.label}
                  </Link>
                ))}
              </motion.div>
            )}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.24 }}>
              <Link
                to={nav.cta.href}
                className="mt-4 inline-block px-8 py-4 bg-vermilion text-cream font-mono font-bold uppercase tracking-widest border border-cream hover:opacity-90 transition-opacity"
                onClick={() => setOpen(false)}>
                {nav.cta.label}
              </Link>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
