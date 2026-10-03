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
        className={`flex w-full items-center justify-between gap-2 rounded-control border bg-panel px-2.5 py-1.5 text-small font-medium text-fg transition-colors duration-150 ${
          open ? 'border-hot/75' : 'border-line/10 hover:border-line/[0.16]'
        }`}>
        <span className="truncate">{selected?.label}</span>
        <Icon
          name="chevron-down"
          className={`h-3 w-3 shrink-0 text-fg/60 transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="scroll-thin absolute left-0 right-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-cell border border-line/10 bg-surface p-1 shadow-soft-md">
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
                  className={`flex w-full rounded-control px-2.5 py-1.5 text-left text-small transition-colors duration-100 ${
                    active ? 'bg-fg/[0.07] font-medium text-fg' : 'text-fg/70 hover:bg-fg/[0.07] hover:text-fg'
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
