import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  'aria-label'?: string;
}

export function Select({
  value,
  onChange,
  options,
  className = '',
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center justify-between gap-2 border bg-surface px-2.5 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors focus-visible:outline-none ${
          open ? 'border-vermilion text-fg' : 'border-fg/20 text-fg hover:border-fg/35'
        }`}>
        <span className="truncate">{selected?.label}</span>
        <Icon
          name="chevron-down"
          className={`h-3 w-3 shrink-0 text-fg/45 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto scroll-thin border border-line/15 bg-surface py-1 shadow-soft">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value || '__empty'} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`flex w-full px-2.5 py-2 text-left font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors ${
                    active
                      ? 'bg-panel text-fg'
                      : 'text-fg/70 hover:bg-panel/60 hover:text-fg'
                  }`}>
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
