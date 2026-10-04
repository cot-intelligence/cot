import type { ReactNode } from 'react';

/** Raised card with an optional title row: the one container every dashboard page is built from. */
export function Card({
  title,
  aside,
  children,
  className = '',
  bodyClassName = 'px-5 pb-5 pt-4',
  id,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`min-w-0 overflow-hidden rounded-card border border-line/10 bg-surface ${className}`}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          {title && <h2 className="truncate text-body font-semibold tracking-[-0.01em] text-fg">{title}</h2>}
          {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Small mono label used on the right of a card title ("by spend", "all time"). */
export function CardNote({ children }: { children: ReactNode }) {
  return <span className="font-mono text-label font-semibold uppercase tracking-label text-fg/40">{children}</span>;
}

export function Seg<K extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: K;
  options: { k: K; l: ReactNode }[];
  onChange: (k: K) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.k)} type="button" aria-pressed={value === o.k} onClick={() => onChange(o.k)} className="seg-item">
          {o.l}
        </button>
      ))}
    </div>
  );
}

/** On/off switch. The knob slides on a short ease-out transition, so rapid toggles retarget instead of restarting. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className="switch focus-ring">
      <span className="switch-knob" />
    </button>
  );
}

/** Label + hint on the left, control on the right; hairline between rows. */
export function SettingRow({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex gap-x-6 gap-y-2.5 border-b border-line/10 py-3.5 last:border-b-0 ${wide ? 'flex-wrap items-center' : 'flex-col sm:flex-row sm:items-center sm:justify-between'}`}>
      <div className="min-w-0">
        <p className="text-body font-medium text-fg">{label}</p>
        {hint && <p className="max-w-[48ch] text-small text-fg/60 [overflow-wrap:anywhere]">{hint}</p>}
      </div>
      <div className={`flex min-w-0 items-center gap-2 ${wide ? 'flex-[1_1_320px]' : 'shrink-0'}`}>{children}</div>
    </div>
  );
}
