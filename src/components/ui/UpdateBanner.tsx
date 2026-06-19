import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getVersionInfo, type VersionInfo } from '../../lib/api';
import { Icon } from './icons';

const DISMISS_KEY = 'cot.update.dismissed';

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(version: string) {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* ignore */
  }
}

/**
 * Polls the collector's /v1/version once on mount and surfaces a dismissible
 * banner when a newer release is published. Dismissal is remembered per
 * version, so dismissing v1.1.0 won't re-nag until v1.2.0 ships.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getVersionInfo()
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        if (data.update_available && data.latest && dismissedVersion() !== data.latest) {
          setVisible(true);
        }
      })
      .catch(() => {
        /* offline or air-gapped — stay quiet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = () => {
    if (info?.latest) rememberDismissed(info.latest);
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && info?.latest && (
        <motion.div
          initial={{ opacity: 0, y: 28, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 340, damping: 26, mass: 0.8 }}
          className="fixed bottom-4 right-4 z-40 max-w-sm">
          <motion.div
            whileHover={{ x: -2, y: -2 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="flex items-start gap-3 border-2 border-ink bg-vermilion px-4 py-3 text-cream shadow-brutal">
            <Icon name="bell" className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-bold uppercase tracking-wide">
                New version available
              </p>
              <p className="mt-0.5 text-sm">
                v{info.current} &rarr; <span className="font-bold">v{info.latest}</span>
              </p>
              {info.url && (
                <a
                  href={info.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block font-mono text-xs underline underline-offset-2 transition-opacity hover:opacity-80">
                  View release notes
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="-mr-1 -mt-1 shrink-0 px-1 text-lg leading-none text-cream/80 transition-colors hover:text-cream">
              &times;
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
