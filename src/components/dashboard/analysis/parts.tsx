import type { ReactNode } from 'react';
import { LENSES, type AnalysisFinding, type FindingSeverity } from '../../../lib/analysisPreview';

// Shared building blocks for the Analysis design preview. The feature is not
// built yet: runs are sample data and anything that would call a model is
// disabled behind "Coming soon".

export const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: 'bg-vermilion text-cream border-vermilion',
  warn: 'border-vermilion/60 text-vermilion',
  info: 'border-cobalt/60 text-cobalt',
};

export function SoonChip({ label = 'Soon' }: { label?: string }) {
  return <span className="chip text-vermilion ring-vermilion/50">{label}</span>;
}

export function ComingSoonBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border border-vermilion/40 bg-vermilion/[0.06] px-4 py-3">
      <SoonChip label="Coming soon" />
      <p className="min-w-0 flex-1 font-mono text-[0.68rem] leading-relaxed text-fg/70">
        {children ??
          'Agentic analysis is in development. This is a preview of how it will look, with sample output. Nothing is analyzed and no model is called.'}
      </p>
    </div>
  );
}

export function Section({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">
          {String(n).padStart(2, '0')}
        </span>
        <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em] text-fg/65">{title}</h3>
        <span className="ml-1 h-px flex-1 bg-fg/10" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One compact card holding a run's inputs, with the estimate and run button in its footer. */
export function Composer({
  children,
  stats,
  runLabel = 'Run analysis',
}: {
  children: ReactNode;
  stats: [string, string][];
  runLabel?: string;
}) {
  return (
    <div className="border border-line/15 bg-surface/40">
      <div className="divide-y divide-line/[0.08]">{children}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line/10 bg-panel/60 px-3 py-2">
        {stats.map(([name, value]) => (
          <span key={name} className="font-mono text-[0.6rem] text-fg/45">
            {name} <span className="font-bold tabular-nums text-fg/80">{value}</span>
          </span>
        ))}
        <button
          type="button"
          disabled
          title="Coming soon"
          className="btn-primary ml-auto !py-1.5 disabled:cursor-not-allowed">
          {runLabel}
          <span className="chip text-cream ring-cream/40">Soon</span>
        </button>
      </div>
    </div>
  );
}

/** A labeled line inside a Composer; the label column keeps rows aligned. */
export function ComposerRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="shrink-0 pt-1.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40 sm:w-16">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Small single-choice pills. */
export function Pills<T extends string>({
  label,
  options,
  value,
  onChange,
  display,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  display?: (v: T) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o)}
            className={`rounded-[4px] border px-2 py-1 font-mono text-[0.62rem] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50 ${
              active
                ? 'border-vermilion/60 bg-vermilion/[0.08] text-vermilion'
                : 'border-line/15 text-fg/60 hover:border-line/30 hover:text-fg'
            }`}>
            {display ? display(o) : o}
          </button>
        );
      })}
    </div>
  );
}

const LENS_KEYS = [...LENSES.map((l) => l.key), 'custom'];

/** Lens row for a Composer: pills, then the chosen lens's one-line description (or the custom prompt). */
export function LensRow({ lensKey, onChange }: { lensKey: string; onChange: (key: string) => void }) {
  const lens = LENSES.find((l) => l.key === lensKey);
  return (
    <ComposerRow label="Lens">
      <Pills
        label="Lens"
        options={LENS_KEYS}
        value={lensKey}
        onChange={onChange}
        display={(k) => LENSES.find((l) => l.key === k)?.name ?? 'Custom…'}
      />
      {lens ? (
        <p className="mt-1.5 font-mono text-[0.6rem] leading-relaxed text-fg/45">{lens.blurb}</p>
      ) : (
        <input
          type="text"
          placeholder="Ask anything, e.g. Did the agent follow our testing conventions?"
          className="mt-1.5 w-full border border-line/15 bg-panel px-2.5 py-1.5 font-mono text-[0.65rem] text-fg placeholder:text-fg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50"
        />
      )}
    </ComposerRow>
  );
}

export function SeverityTag({ severity }: { severity: FindingSeverity }) {
  return (
    <span
      className={`shrink-0 border px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest ${SEVERITY_STYLE[severity]}`}>
      {severity}
    </span>
  );
}

export function EvidenceChips({ label = 'Evidence', items }: { label?: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">{label}</span>
      {items.map((t) => (
        <span
          key={t}
          className="border border-line/15 bg-panel px-1.5 py-0.5 font-mono text-[0.58rem] font-bold tabular-nums text-fg/60">
          {t}
        </span>
      ))}
    </div>
  );
}

/** Verdict first, then findings that each cite the turns behind them. */
export function FindingList({ verdict, findings }: { verdict: string; findings: AnalysisFinding[] }) {
  return (
    <div className="space-y-px bg-fg/10">
      <div className="bg-bg px-4 py-4">
        <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">Summary</p>
        <p className="mt-2 max-w-3xl font-mono text-[0.78rem] leading-relaxed text-fg/85">{verdict}</p>
      </div>
      {findings.map((f) => (
        <div key={f.title} className="bg-bg px-4 py-3">
          <div className="flex items-start gap-2.5">
            <SeverityTag severity={f.severity} />
            <p className="min-w-0 flex-1 font-mono text-xs font-bold text-fg">{f.title}</p>
          </div>
          <p className="mt-2 max-w-3xl break-words font-mono text-[0.68rem] leading-relaxed text-fg/70">{f.detail}</p>
          <div className="mt-2.5">
            <EvidenceChips items={f.turns} />
          </div>
        </div>
      ))}
    </div>
  );
}

export const CUSTOM_VERDICT =
  'Your question is answered in the same shape: a short verdict first, then findings that each point at the turns they came from.';
