import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { AVATARS, AvatarArt, avatarById } from './avatars';
import { Icon } from './icons';
import { EASE_OUT } from './motion';

const COLS = 4;

/**
 * Workspace mark picker: a dropdown trigger that opens a grid of marks rather than a list,
 * so the choice is made by looking. Arrow keys move through the grid, Enter picks, Esc closes.
 */
export function MarkPicker({ value, initial, onChange }: { value: string; initial: string; onChange: (id: string) => void }) {
  const choices = [{ id: 'initial', label: 'Initial' }, ...AVATARS.map((a) => ({ id: a.id, label: a.label }))];
  const currentId = avatarById(value) ? value : 'initial';
  const current = choices.find((c) => c.id === currentId)!;
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, choices.findIndex((c) => c.id === currentId)));
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.focus();
  }, [hi, open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      setHi((h) => Math.min(choices.length - 1, Math.max(0, h + move)));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  const art = (id: string) => {
    const d = avatarById(id);
    return d ? <AvatarArt design={d} /> : <span className="dd-ic-initial">{initial}</span>;
  };

  return (
    <div className="dd mkp" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dd-t"
        data-set
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Workspace mark: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}>
        <span className="dd-ic" aria-hidden="true">{art(current.id)}</span>
        <span className="truncate">{current.label}</span>
        <Icon name="down" size={14} className="dd-chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="dd-pop mkp-pop"
            role="dialog"
            aria-label="Choose a workspace mark"
            initial={{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease: EASE_OUT }}>
            <div ref={grid} className="mkp-grid" role="radiogroup" aria-label="Workspace mark" onKeyDown={onKey}>
              {choices.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={c.id === currentId}
                  data-i={i}
                  tabIndex={i === hi ? 0 : -1}
                  className="mkp-o"
                  onClick={() => pick(c.id)}
                  onFocus={() => setHi(i)}>
                  <span className="mkp-art" aria-hidden="true">{art(c.id)}</span>
                  <span className="mkp-l">{c.label}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
