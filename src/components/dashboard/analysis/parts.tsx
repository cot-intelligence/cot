import type { ReactNode } from 'react';
import { LENSES, type AnalysisFinding, type FindingSeverity } from '../../../lib/analysisPreview';

// Shared building blocks for the Analysis design preview. The feature is not
// built yet: runs are sample data and anything that would call a model is
// disabled behind "Soon".
//
// Visual rules for this area: mono throughout like the rest of the dashboard,
// with prose (summaries, details, fixes) a step larger and looser than labels.
// Vermilion marks problems and the one primary action only. Controls are
// rounded, containers are square.

export const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: 'bg-vermilion text-cream border-vermilion',
  warn: 'border-vermilion/60 text-vermilion',
  info: 'border-cobalt/60 text-cobalt',
};

const SEVERITY_RANK: FindingSeverity[] = ['critical', 'warn', 'info'];

export function worstSeverity(findings: AnalysisFinding[]): FindingSeverity {
  return SEVERITY_RANK.find((s) => findings.some((f) => f.severity === s)) ?? 'info';
}

export function SoonChip({ label = 'Soon' }: { label?: string }) {
  return <span className="chip text-vermilion ring-vermilion/50">{label}</span>;
}

/** Section heading: one mono label with a hairline, the dashboard's section signature. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-7 items-center gap-3">
        <h3 className="font-mono text-[0.65rem] font-bold uppercase tracking-[0.16em] text-fg/70">{title}</h3>
        <span className="h-px flex-1 bg-fg/10" />
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
    <div className="border border-line/15 bg-surface/60">
      <div className="divide-y divide-line/[0.08]">{children}</div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line/10 bg-panel/60 px-4 py-2.5">
        {stats.map(([name, value]) => (
          <span key={name} className="font-mono text-[0.68rem] text-fg/60">
            {name} <span className="font-mono font-bold tabular-nums text-fg/85">{value}</span>
          </span>
        ))}
        <button
          type="button"
          disabled
          title="Coming soon"
          className="btn-primary ml-auto active:scale-[0.98] disabled:cursor-not-allowed">
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
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 pt-2 font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-fg/55 sm:w-20">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Small single-choice pills. Selection is neutral: vermilion is kept for problems. */
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
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o)}
            className={`rounded-[4px] border px-2.5 py-1 font-mono text-[0.65rem] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50 active:scale-[0.98] ${
              active
                ? 'border-fg bg-fg text-bg'
                : 'border-line/20 text-fg/65 hover:border-line/40 hover:text-fg'
            }`}>
            {display ? display(o) : o}
          </button>
        );
      })}
    </div>
  );
}

const LENS_KEYS = [...LENSES.map((l) => l.key), 'custom'];

/** Lens row for a Composer: pills, then the chosen lens's description (or the custom prompt). */
export function LensRow({ lensKey, onChange }: { lensKey: string; onChange: (key: string) => void }) {
  const lens = LENSES.find((l) => l.key === lensKey);
  return (
    <ComposerRow label="Lens">
      <Pills
        label="Lens"
        options={LENS_KEYS}
        value={lensKey}
        onChange={onChange}
        display={(k) => LENSES.find((l) => l.key === k)?.name ?? 'Custom'}
      />
      {lens ? (
        <p className="mt-2 font-mono text-xs leading-relaxed text-fg/65">{lens.blurb}</p>
      ) : (
        <label className="mt-2 block">
          <span className="sr-only">Your question</span>
          <input
            type="text"
            placeholder="e.g. Did the agent follow our testing conventions?"
            className="w-full rounded-[4px] border border-line/20 bg-bg px-3 py-2 font-mono text-xs text-fg placeholder:text-fg/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50"
          />
        </label>
      )}
    </ComposerRow>
  );
}

/** `fixed` gives every tag the same width so a column of them lines up. */
export function SeverityTag({ severity, fixed = false }: { severity: FindingSeverity; fixed?: boolean }) {
  return (
    <span
      className={`inline-block shrink-0 border px-1.5 py-0.5 text-center font-mono text-[0.55rem] font-bold uppercase tracking-widest ${
        fixed ? 'w-[4.75rem]' : ''
      } ${SEVERITY_STYLE[severity]}`}>
      {severity}
    </span>
  );
}

/** Links to the turns (or sessions) behind a finding. Real results jump to the Timeline. */
export function EvidenceChips({ label = 'Evidence', items }: { label?: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 font-mono text-[0.58rem] font-bold uppercase tracking-[0.14em] text-fg/50">{label}</span>
      {items.map((t) =>
        t.startsWith('+') ? (
          <span key={t} className="font-mono text-[0.62rem] tabular-nums text-fg/55">
            {t}
          </span>
        ) : (
          <span
            key={t}
            title="Will jump to this moment in the Timeline"
            className="inline-flex cursor-default items-center gap-1 rounded-[4px] border border-line/20 bg-panel px-1.5 py-0.5 font-mono text-[0.62rem] font-bold tabular-nums text-fg/75 transition-colors hover:border-line/40 hover:text-fg">
            {t}
            <span aria-hidden="true" className="text-fg/40">
              ↗
            </span>
          </span>
        ),
      )}
    </div>
  );
}

/** Verdict first, then findings that each cite the turns behind them. */
export function FindingList({ verdict, findings }: { verdict: string; findings: AnalysisFinding[] }) {
  return (
    <div className="border border-line/15 bg-bg">
      <p className="max-w-[68ch] px-5 py-4 font-mono text-[0.82rem] leading-relaxed text-fg/90">{verdict}</p>
      <ul className="divide-y divide-line/[0.08] border-t border-line/10">
        {findings.map((f) => (
          <li key={f.title} className="px-5 py-4">
            <div className="flex items-start gap-3">
              <SeverityTag severity={f.severity} />
              <p className="min-w-0 flex-1 font-mono text-[0.78rem] font-bold leading-snug text-fg">{f.title}</p>
            </div>
            <p className="mt-1.5 max-w-[68ch] break-words font-mono text-xs leading-relaxed text-fg/75">
              {f.detail}
            </p>
            <div className="mt-3">
              <EvidenceChips items={f.turns} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const CUSTOM_VERDICT =
  'Your question is answered in the same shape: a short verdict first, then findings that each point at the turns they came from.';
