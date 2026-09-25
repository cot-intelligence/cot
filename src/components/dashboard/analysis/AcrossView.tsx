import { useState } from 'react';
import { ACROSS_REPORT, type Improvement, type ImprovementArea } from '../../../lib/analysisPreview';
import { PageHeader } from '../../ui/PageHeader';
import { ComingSoonBanner, Composer, ComposerRow, EvidenceChips, Pills, Section, SoonChip } from './parts';

const RANGES = ['7 days', '30 days', '90 days', 'All time'] as const;
const SCOPES = ['All sessions', 'Bookmarked only'] as const;
const FOCUSES: ('Everything' | ImprovementArea)[] = ['Everything', 'Prompting', 'Agent behaviour', 'Cost', 'Security'];

const IMPACT_STYLE: Record<Improvement['impact'], string> = {
  High: 'bg-vermilion text-cream border-vermilion',
  Medium: 'border-vermilion/60 text-vermilion',
  Low: 'border-cobalt/60 text-cobalt',
};

const TREND_LABEL: Record<Improvement['trend'], string> = {
  rising: '↑ rising',
  falling: '↓ falling',
  steady: '→ steady',
};

/** Cross-session report: patterns that repeat across sessions, ranked, with the fix for each. */
export function AcrossView() {
  const [range, setRange] = useState<(typeof RANGES)[number]>('30 days');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('All sessions');
  const [focus, setFocus] = useState<(typeof FOCUSES)[number]>('Everything');
  const r = ACROSS_REPORT;
  const shown = focus === 'Everything' ? r.improvements : r.improvements.filter((i) => i.area === focus);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Agentic analysis"
        title="Across all sessions"
        description="Reads many sessions at once and finds the habits that repeat, so you fix the cause once instead of noticing it session by session."
        actions={<SoonChip label="Coming soon" />}
      />
      <ComingSoonBanner />

      <div className="space-y-2">
        <Composer
          runLabel="Run across sessions"
          stats={[
            ['Sessions', scope === 'Bookmarked only' ? '9' : String(r.sessions)],
            ['Projects', String(r.projects)],
            ['Est. cost', scope === 'Bookmarked only' ? '~$0.60' : '~$2.40'],
            ['Model', 'Your API key'],
          ]}>
          <ComposerRow label="Range">
            <Pills label="Time range" options={RANGES} value={range} onChange={setRange} />
          </ComposerRow>
          <ComposerRow label="Sessions">
            <Pills label="Sessions" options={SCOPES} value={scope} onChange={setScope} />
          </ComposerRow>
          <ComposerRow label="Focus">
            <Pills label="Focus" options={FOCUSES} value={focus} onChange={setFocus} />
          </ComposerRow>
        </Composer>
        <p className="font-mono text-[0.6rem] leading-relaxed text-fg/40">
          Each session is condensed on your machine first and its notes are cached, so re-running only pays for new
          sessions.
        </p>
      </div>

      <Section
        n={1}
        title="Sample report"
        aside={<span className="font-mono text-[0.58rem] text-fg/40">Last run {r.lastRun}</span>}>
        <div className="grid grid-cols-2 gap-px bg-fg/10 sm:grid-cols-4">
          {r.stats.map(([label, value]) => (
            <div key={label} className="bg-bg px-4 py-3">
              <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-fg">{value}</p>
            </div>
          ))}
        </div>

        <div className="space-y-px bg-fg/10">
          <div className="bg-bg px-4 py-3">
            <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
              What to improve, most impact first
            </p>
          </div>
          {shown.map((imp) => (
            <ImprovementRow key={imp.title} imp={imp} rank={r.improvements.indexOf(imp) + 1} total={r.sessions} />
          ))}
          {!shown.length && (
            <p className="bg-bg px-4 py-4 font-mono text-[0.68rem] text-fg/45">Nothing found for this focus.</p>
          )}
        </div>
      </Section>

      <Section n={2} title="What's working">
        <ul className="space-y-px bg-fg/10">
          {r.strengths.map((s) => (
            <li key={s} className="flex items-start gap-3 bg-bg px-4 py-3">
              <span className="mt-0.5 font-mono text-[0.6rem] font-bold text-olive" aria-hidden="true">
                ✓
              </span>
              <span className="font-mono text-[0.68rem] leading-relaxed text-fg/75">{s}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ImprovementRow({ imp, rank, total }: { imp: Improvement; rank: number; total: number }) {
  const extra = Math.max(0, imp.seenIn - imp.examples.length);
  return (
    <div className="bg-bg px-4 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="font-mono text-sm font-bold tabular-nums text-fg/30">{String(rank).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-xs font-bold text-fg">{imp.title}</p>
            <span
              className={`border px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest ${IMPACT_STYLE[imp.impact]}`}>
              {imp.impact}
            </span>
            <span className="chip text-fg/55 ring-line/20">{imp.area}</span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1 w-32 bg-fg/10" aria-hidden="true">
              <div className="h-full bg-vermilion" style={{ width: `${(imp.seenIn / total) * 100}%` }} />
            </div>
            <span className="font-mono text-[0.6rem] tabular-nums text-fg/50">
              in {imp.seenIn} of {total} sessions · {TREND_LABEL[imp.trend]}
            </span>
          </div>
          <p className="mt-2.5 max-w-3xl font-mono text-[0.68rem] leading-relaxed text-fg/70">{imp.detail}</p>
          <div className="mt-2.5 max-w-3xl border-l-2 border-olive/60 bg-olive/[0.06] px-3 py-2">
            <p className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-olive">Try this</p>
            <p className="mt-1 font-mono text-[0.68rem] leading-relaxed text-fg/80">{imp.fix}</p>
          </div>
          <div className="mt-2.5">
            <EvidenceChips label="Seen in" items={extra ? [...imp.examples, `+${extra} more`] : imp.examples} />
          </div>
        </div>
      </div>
    </div>
  );
}
