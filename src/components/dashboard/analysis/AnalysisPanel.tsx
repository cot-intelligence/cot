import { useState } from 'react';
import { LENSES, lensFor, runFor, type FindingSeverity } from '../../../lib/analysisPreview';

// Design preview only: nothing here calls a model or reads the session. The
// lens picker is live so the sample result can be flipped through; every
// action that would spend tokens is disabled behind "Coming soon".

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: 'bg-vermilion text-cream border-vermilion',
  warn: 'border-vermilion/60 text-vermilion',
  info: 'border-cobalt/60 text-cobalt',
};

const HOW_IT_WORKS = [
  [
    'Digest',
    'The session is condensed on your machine. Prompts stay whole; diffs and tool output shrink to what matters. Secrets are masked.',
  ],
  [
    'Analyze',
    'Your chosen lens reads the digest with your own API key. You see the estimated cost first and can cap it.',
  ],
  ['Cite', 'Every finding points at the turns behind it, so you can check the claim instead of trusting it.'],
];

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">
          {String(n).padStart(2, '0')}
        </span>
        <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em] text-fg/65">{title}</h3>
        <span className="ml-1 h-px flex-1 bg-fg/10" />
      </div>
      {children}
    </section>
  );
}

function LensCard({
  name,
  blurb,
  active,
  onClick,
}: {
  name: string;
  blurb: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="relative flex flex-col bg-bg px-4 py-3 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-vermilion/50">
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-vermilion" aria-hidden="true" />}
      <p className={`font-mono text-xs font-bold ${active ? 'text-vermilion' : 'text-fg'}`}>{name}</p>
      <p className="mt-1 font-mono text-[0.65rem] leading-relaxed text-fg/55">{blurb}</p>
    </button>
  );
}

interface AnalysisPanelProps {
  /** A past run opened from the sidebar; preselects its lens and session. */
  runId?: string;
  /** Event count of the session being analyzed, when shown inside a session page. */
  sessionEvents?: number;
  /** Standalone page: show the session picker step. */
  pickSession?: boolean;
}

export function AnalysisPanel({ runId, sessionEvents, pickSession = false }: AnalysisPanelProps) {
  const run = runFor(runId);
  const [lensKey, setLensKey] = useState(run?.lensKey ?? LENSES[0].key);
  const [custom, setCustom] = useState(false);
  const lens = lensFor(lensKey);
  const findings = custom ? LENSES[0].findings : lens.findings;
  let step = 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3 border border-vermilion/40 bg-vermilion/[0.06] px-4 py-3">
        <span className="chip text-vermilion ring-vermilion/50">Coming soon</span>
        <p className="min-w-0 flex-1 font-mono text-[0.68rem] leading-relaxed text-fg/70">
          Agentic analysis is in development. This is a preview of how it will look, with sample output. Nothing here
          reads your data or calls a model.
        </p>
      </div>

      {pickSession && (
        <Section n={++step} title="Pick a session">
          <div className="flex w-full cursor-not-allowed items-center gap-3 border border-line/15 bg-panel px-4 py-3">
            <span className="font-mono text-[0.65rem] tabular-nums text-fg/40">
              {run?.sessionShortId ?? '9028f3d9'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg/80">
              {run?.sessionTitle ?? 'i want to improve the search functionality what can i do?'}
            </span>
            <span className="hidden font-mono text-[0.6rem] tabular-nums text-fg/40 sm:inline">864 events</span>
          </div>
          <p className="font-mono text-[0.6rem] leading-relaxed text-fg/40">
            Pick any traced or replayed session, or start from the Analysis tab on a session page.
          </p>
        </Section>
      )}

      <Section n={++step} title="Pick a lens">
        <div className="grid gap-px bg-fg/10 sm:grid-cols-2 lg:grid-cols-3">
          {LENSES.map((l) => (
            <LensCard
              key={l.key}
              name={l.name}
              blurb={l.blurb}
              active={!custom && l.key === lensKey}
              onClick={() => {
                setCustom(false);
                setLensKey(l.key);
              }}
            />
          ))}
          <LensCard
            name="Custom lens"
            blurb="Describe what you want looked at, in your own words."
            active={custom}
            onClick={() => setCustom(true)}
          />
        </div>

        {custom && (
          <textarea
            rows={3}
            placeholder="e.g. Did the agent follow our testing conventions? Where did it skip them?"
            className="w-full resize-none border border-line/15 bg-panel px-3 py-2.5 font-mono text-[0.7rem] text-fg placeholder:text-fg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50"
          />
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border border-line/10 bg-surface/40 px-4 py-3">
          {[
            // Illustrative only; the real figure comes from the digest.
            ['Digest', sessionEvents ? `~${Math.max(8, Math.round(sessionEvents / 14))}k tokens` : '~62k tokens'],
            ['Estimated cost', '~$0.35'],
            ['Model', 'Your API key'],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
              <p className="mt-0.5 font-mono text-sm font-bold tabular-nums text-fg">{value}</p>
            </div>
          ))}
          <button type="button" disabled title="Coming soon" className="btn-primary ml-auto disabled:cursor-not-allowed">
            Run analysis
            <span className="chip text-cream ring-cream/40">Soon</span>
          </button>
        </div>
      </Section>

      <Section n={++step} title={`Sample result · ${custom ? 'Custom lens' : lens.name}`}>
        <div className="space-y-px bg-fg/10">
          <div className="bg-bg px-4 py-4">
            <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">Summary</p>
            <p className="mt-2 max-w-3xl font-mono text-[0.78rem] leading-relaxed text-fg/85">
              {custom
                ? 'Your question is answered in the same shape: a short verdict first, then findings that each point at the turns they came from.'
                : lens.verdict}
            </p>
          </div>
          {findings.map((f) => (
            <div key={f.title} className="bg-bg px-4 py-3">
              <div className="flex items-start gap-2.5">
                <span
                  className={`shrink-0 border px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest ${SEVERITY_STYLE[f.severity]}`}>
                  {f.severity}
                </span>
                <p className="min-w-0 flex-1 font-mono text-xs font-bold text-fg">{f.title}</p>
              </div>
              <p className="mt-2 max-w-3xl break-words font-mono text-[0.68rem] leading-relaxed text-fg/70">
                {f.detail}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">Evidence</span>
                {f.turns.map((t) => (
                  <span
                    key={t}
                    className="border border-line/15 bg-panel px-1.5 py-0.5 font-mono text-[0.58rem] font-bold tabular-nums text-fg/60">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="font-mono text-[0.6rem] leading-relaxed text-fg/40">
          Sample data. Real results will link each evidence chip to that moment in the Timeline, and every run will be
          saved under Analyses in the sidebar.
        </p>
      </Section>

      <Section n={++step} title="How it will work">
        <div className="grid gap-px bg-fg/10 sm:grid-cols-3">
          {HOW_IT_WORKS.map(([title, body], i) => (
            <div key={title} className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.6rem] font-bold tabular-nums text-vermilion">0{i + 1}</p>
              <p className="mt-1 font-mono text-xs font-bold text-fg">{title}</p>
              <p className="mt-1 font-mono text-[0.65rem] leading-relaxed text-fg/55">{body}</p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
