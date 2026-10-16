import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';

// The Enterprise plan on cot.run. Opened in the default browser: in the Mac app
// every window.open / target=_blank goes there, not into the app's webview.
export const TEAMS_URL = 'https://cot.run/pricing#enterprise';
const TEAMS_LABEL = 'cot.run/pricing#enterprise';

/**
 * Says where "For teams" goes before going there: cot runs locally, so leaving
 * for the web is worth one sentence and one click. Continue has focus, so
 * Enter goes, Escape (or the scrim) stays.
 *
 * Motion: an occasional dialog, so a short, centered entrance (200 ms,
 * opacity + scale 0.96 to 1, strong ease-out) and a quicker exit (140 ms);
 * with reduced motion it only fades.
 */
export function TeamsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduce = useReducedMotion();
  const proceed = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => proceed.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      back?.focus?.();
    };
  }, [open, onClose]);

  const go = () => {
    window.open(TEAMS_URL, '_blank', 'noopener,noreferrer');
    onClose();
  };

  // Rendered at the dashboard root, so no sidebar layout or transform can
  // offset a fixed-position dialog.
  const host = typeof document !== 'undefined' ? document.querySelector('.vf.app') ?? document.body : null;
  if (!host) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            className="scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          />
          <div className="teams-wrap" key="dialog">
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="teams-title"
              aria-describedby="teams-desc"
              className="teams-modal"
              initial={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.96)' }}
              animate={{ opacity: 1, transform: 'scale(1)' }}
              exit={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.98)', transition: { duration: 0.14, ease: EASE_OUT } }}
              transition={{ duration: 0.2, ease: EASE_OUT }}>
              <span className="teams-ic" aria-hidden="true"><Icon name="users" size={18} /></span>
              <span className="label">For teams</span>
              <h2 id="teams-title">Bring cot to your team</h2>
              <p id="teams-desc" className="dim">
                Shared visibility across everyone&rsquo;s agents lives on the Enterprise plan. Continue to read about it and
                tell us where to reach you.
              </p>
              <div className="teams-url mono" title={TEAMS_URL}>
                <Icon name="external" size={14} />
                <span className="truncate">{TEAMS_LABEL}</span>
              </div>
              <p className="teams-note">
                <Icon name="globe" size={14} />
                <span>Opens in your browser and needs an internet connection. Nothing is sent from cot.</span>
              </p>
              <div className="teams-actions">
                <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={onClose}>Cancel</button>
                <button ref={proceed} type="button" className="vbtn vbtn-primary vbtn-sm" onClick={go}>
                  Continue to cot.run <Icon name="arrow" size={14} />
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    host,
  );
}
