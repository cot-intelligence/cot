import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export interface DropdownOption {
  value: string;
  label: string;
  /** Right-aligned secondary text, e.g. a count. */
  meta?: string | number;
  /** A small visual shown before the label, in the trigger and the list (e.g. a workspace mark). */
  icon?: ReactNode;
}

/** Lists longer than this get a search field. */
const SEARCH_AT = 7;

/**
 * Themed replacement for a native <select>: a trigger styled like the toolbar fields and a
 * listbox popover with type-to-filter search. Keyboard: arrows move, Enter picks, Esc closes.
 */
export function Dropdown({
  value,
  options,
  onChange,
  label,
  placeholder,
  searchable,
  width,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Project". */
  label: string;
  /** Trigger text when nothing matches `value`. */
  placeholder?: string;
  searchable?: boolean;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const withSearch = searchable ?? options.length > SEARCH_AT;
  const current = options.find((o) => o.value === value);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[hi]) pick(shown[hi].value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="dd" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="dd-t"
        data-set={value !== '' || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? placeholder ?? ''}`}
        style={width ? { width } : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); }
          else if (open) onKey(e);
        }}>
        {current?.icon && <span className="dd-ic" aria-hidden="true">{current.icon}</span>}
        <span className="truncate">{current?.label ?? placeholder}</span>
        <Icon name="down" size={14} className="dd-chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="dd-pop"
            initial={{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}>
            {withSearch && (
              <div className="dd-s">
                <Icon name="search" size={14} />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onKey}
                  placeholder={`Search ${label.toLowerCase()}s`}
                  aria-label={`Search ${label.toLowerCase()}s`}
                  aria-controls={id}
                  aria-activedescendant={shown[hi] ? `${id}-${hi}` : undefined}
                />
              </div>
            )}
            <ul ref={list} id={id} role="listbox" aria-label={label} className="dd-l" tabIndex={withSearch ? -1 : 0} onKeyDown={onKey} autoFocus={!withSearch}>
              {shown.map((o, i) => (
                <li
                  key={o.value || '__all'}
                  id={`${id}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  data-hi={i === hi}
                  className="dd-o"
                  onMouseMove={() => setHi(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.value)}>
                  <Icon name="check" size={14} className="dd-ck" />
                  {o.icon && <span className="dd-ic" aria-hidden="true">{o.icon}</span>}
                  <span className="truncate">{o.label}</span>
                  {o.meta !== undefined && <span className="dd-m">{o.meta}</span>}
                </li>
              ))}
              {shown.length === 0 && <li className="dd-none">No matches</li>}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
