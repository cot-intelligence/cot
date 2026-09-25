import { useState } from 'react';
import { ACROSS_REPORT, type Improvement, type ImprovementArea } from '../../../lib/analysisPreview';
import { Icon } from '../../ui/icons';
import { PageHeader } from '../../ui/PageHeader';
import { Composer, ComposerRow, EvidenceChips, Pills, Section, SoonChip } from './parts';

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
  const [openTitle, setOpenTitle] = useState<string | null>(ACROSS_REPORT.improvements[0].title);
  const r = ACROSS_REPORT;
  const shown = focus === 'Everything' ? r.improvements : r.improvements.filter((i) => i.area === focus);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Across all sessions"
        description="Finds the habits that repeat across your sessions, so you fix the cause once."
        actions={<SoonChip label="Coming soon" />}
      />

      <div className="space-y-2">
        <Composer
          runLabel="Run report"
          stats={[
            ['Sessions', scope === 'Bookmarked only' ? '9' : String(r.sessions)],
            ['Projects', String(r.projects)],
            ['Est. cost', scope === 'Bookmarked only' ? '~$0.60' : '~$2.40'],
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
        <p className="font-mono text-[0.68rem] leading-relaxed text-fg/55">
          Sessions are condensed on your machine first and their notes are cached, so a re-run only pays for new ones.
        </p>
      </div>

      <Section
        title="Sample report"
        aside={<span className="font-mono text-[0.68rem] text-fg/55">Last run {r.lastRun}</span>}>
        <dl className="grid grid-cols-2 gap-y-4 border border-line/15 bg-bg px-5 py-4 sm:grid-cols-4">
          {r.stats.map(([label, value]) => (
            <div key={label}>
              <dt className="font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-fg/55">{label}</dt>
              <dd className="mt-1 font-mono text-xl font-bold tabular-nums text-fg">{value}</dd>
            </div>
          ))}
        </dl>

        <ol className="divide-y divide-line/[0.08] border border-line/15 bg-bg">
          {shown.map((imp) => (
            <ImprovementRow
              key={imp.title}
              imp={imp}
              rank={r.improvements.indexOf(imp) + 1}
              total={r.sessions}
              open={openTitle === imp.title}
              onToggle={() => setOpenTitle(openTitle === imp.title ? null : imp.title)}
            />
          ))}
          {!shown.length && <li className="px-5 py-5 font-mono text-xs text-fg/60">Nothing found for this focus.</li>}
        </ol>
      </Section>

      <Section title="What's working">
        <ul className="space-y-2.5">
          {r.strengths.map((s) => (
            <li key={s} className="flex items-start gap-3">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-olive" />
              <span className="max-w-[68ch] font-mono text-xs leading-relaxed text-fg/80">{s}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ImprovementRow({
  imp,
  rank,
  total,
  open,
  onToggle,
}: {
  imp: Improvement;
  rank: number;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  const extra = Math.max(0, imp.seenIn - imp.examples.length);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-fg/[0.03] focus-visible:bg-fg/[0.03] focus-visible:outline-none">
        <span className="w-5 shrink-0 font-mono text-xs font-bold tabular-nums text-fg/45">{rank}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[0.78rem] font-bold leading-snug text-fg">{imp.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.68rem] text-fg/60">
            <span>{imp.area}</span>
            <span className="font-mono tabular-nums">
              {imp.seenIn} of {total} sessions
            </span>
            <span className="font-mono">{TREND_LABEL[imp.trend]}</span>
          </span>
        </span>
        {/* Share of sessions affected; no background track, the number carries the scale. */}
        <span className="hidden w-24 shrink-0 sm:block" aria-hidden="true">
          <span className="block h-1 bg-fg/60" style={{ width: `${Math.max(6, (imp.seenIn / total) * 100)}%` }} />
        </span>
        <span
          className={`w-16 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[0.55rem] font-bold uppercase tracking-widest ${IMPACT_STYLE[imp.impact]}`}>
          {imp.impact}
        </span>
        <Icon
          name="chevron-down"
          className={`h-4 w-4 shrink-0 text-fg/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="space-y-3 pb-5 pl-14 pr-5">
          <p className="max-w-[68ch] font-mono text-xs leading-relaxed text-fg/75">{imp.detail}</p>
          <div className="max-w-[68ch] border-l-2 border-olive bg-olive/[0.12] px-3.5 py-2.5">
            <p className="font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-olive">Try this</p>
            <p className="mt-0.5 font-mono text-xs leading-relaxed text-fg/85">{imp.fix}</p>
          </div>
          <EvidenceChips label="Seen in" items={extra ? [...imp.examples, `+${extra} more`] : imp.examples} />
        </div>
      )}
    </li>
  );
}
