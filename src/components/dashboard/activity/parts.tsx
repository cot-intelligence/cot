import type { ReactNode } from 'react';
import type { ActivityRisk } from '../../../lib/api';

// Building blocks for the Activity page. Section / Grid / Stat mirror the
// Overview page's so the two read as one product (Overview's are private to
// its lazily loaded chunk, which also carries the chart library).

export function Section({
  n,
  title,
  aside,
  children,
}: {
  n: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3.5">
      <div className="flex min-h-7 items-center gap-2.5">
        <span className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">{n}</span>
        <h2 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em] text-fg/65">{title}</h2>
        <span className="ml-1 h-px flex-1 bg-fg/10" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Seamless ruled grid: cells share single hairlines, no outer box. */
export function Grid({ cols, children }: { cols: string; children: ReactNode }) {
  return <div className={`grid gap-px bg-fg/10 ${cols}`}>{children}</div>;
}

export function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="bg-bg px-4 py-3">
      <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/50">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold tabular-nums ${accent ?? 'text-fg'}`}>{value}</p>
      {hint && <p className="mt-0.5 font-mono text-[0.58rem] text-fg/50">{hint}</p>}
    </div>
  );
}

export function shortPath(p: string | null | undefined): string {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/**
 * A shell command with the program that does the work in full strength and
 * the wrappers before it (`rtk`, `FOO=1`) dimmed. Privilege elevation is the
 * exception: `sudo` is the most important word in a prefix, so it stands out.
 */
export function CommandText({ core, program, className = '' }: { core: string; program?: string; className?: string }) {
  const at = program ? findProgram(core, program) : -1;
  if (at < 0) return <span className={className}>{core}</span>;
  return (
    <span className={className}>
      {at > 0 && <Prefix text={core.slice(0, at)} />}
      <span className="font-bold text-fg">{core.slice(at, at + program!.length)}</span>
      <span className="text-fg/75">{core.slice(at + program!.length)}</span>
    </span>
  );
}

const ELEVATION = /(\b(?:sudo|doas|pkexec)\b)/;

function Prefix({ text }: { text: string }) {
  const parts = text.split(ELEVATION);
  return (
    <>
      {parts.map((part, i) =>
        ELEVATION.test(part) ? (
          <span key={i} className="font-bold text-vermilion">
            {part}
          </span>
        ) : (
          <span key={i} className="text-fg/45">
            {part}
          </span>
        ),
      )}
    </>
  );
}

function findProgram(core: string, program: string): number {
  const re = new RegExp(`(^|[\\s/(])${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  const m = re.exec(core);
  return m ? m.index + m[1].length : -1;
}

export function RiskTag({ risk }: { risk: ActivityRisk }) {
  return (
    <span
      className={`inline-block shrink-0 border px-1.5 py-0.5 font-mono text-[0.52rem] font-bold uppercase tracking-widest ${
        risk.severity === 'critical' ? 'border-vermilion bg-vermilion text-cream' : 'border-vermilion/60 text-vermilion'
      }`}>
      {risk.label}
    </span>
  );
}

/** Small ✕ marking a failed run; failures are the one thing in vermilion. */
export function FailMark() {
  return (
    <span
      aria-label="Failed"
      title="Failed"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-vermilion/15 font-mono text-[0.6rem] font-bold text-vermilion">
      ✕
    </span>
  );
}
