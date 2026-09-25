import { lensFor, severityCounts, type SampleRun } from '../../../lib/analysisPreview';
import { PageHeader } from '../../ui/PageHeader';
import { ComingSoonBanner, CUSTOM_VERDICT, FindingList, Section, SoonChip } from './parts';

/** A saved run, opened from the library. */
export function RunView({ run }: { run: SampleRun }) {
  const lens = lensFor(run.lensKey);
  const counts = severityCounts(lens.findings);
  const stats: [string, string, boolean?][] = [
    ['Findings', String(lens.findings.length)],
    ['Critical', String(counts.critical), counts.critical > 0],
    ['Digest', '~62k tokens'],
    ['Cost', '$0.31'],
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${run.customQuestion ? 'Custom lens' : lens.name} · ${run.group === 'Today' ? run.when : `${run.group}, ${run.when}`}`}
        title={run.customQuestion ?? run.sessionTitle}
        description={
          <span className="font-mono text-[0.7rem]">
            Session {run.sessionShortId}
            {run.customQuestion ? ` · ${run.sessionTitle}` : ''}
          </span>
        }
        actions={
          <>
            <button type="button" disabled className="btn disabled:cursor-not-allowed">
              Re-run
            </button>
            <button type="button" disabled className="btn disabled:cursor-not-allowed">
              Export
            </button>
            <SoonChip label="Coming soon" />
          </>
        }
      />
      <ComingSoonBanner>
        This is a sample saved run. Once the feature ships, every analysis you run is kept here so you can come back to
        it, re-run it after new work, or compare runs.
      </ComingSoonBanner>

      <div className="grid grid-cols-2 gap-px bg-fg/10 sm:grid-cols-4">
        {stats.map(([label, value, accent]) => (
          <div key={label} className="bg-bg px-4 py-3">
            <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
            <p className={`mt-1 font-mono text-xl font-bold tabular-nums ${accent ? 'text-vermilion' : 'text-fg'}`}>
              {value}
            </p>
          </div>
        ))}
      </div>

      <Section n={1} title="Result">
        <FindingList verdict={run.customQuestion ? CUSTOM_VERDICT : lens.verdict} findings={lens.findings} />
      </Section>

      <Section n={2} title="Ask a follow-up">
        <div className="flex items-center gap-3 border border-line/15 bg-panel px-3 py-2.5">
          <input
            type="text"
            disabled
            placeholder="e.g. Show me every turn where the agent ignored an instruction"
            className="min-w-0 flex-1 bg-transparent font-mono text-[0.7rem] text-fg placeholder:text-fg/35 focus:outline-none disabled:cursor-not-allowed"
          />
          <SoonChip />
        </div>
      </Section>
    </div>
  );
}
