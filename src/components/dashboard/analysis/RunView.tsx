import { lensFor, severityCounts, type SampleRun } from '../../../lib/analysisPreview';
import { PageHeader } from '../../ui/PageHeader';
import { FollowUpThread } from './FollowUpThread';
import { BackToAnalysis, CUSTOM_VERDICT, FindingList, Section, SoonChip } from './parts';

const SEVERITY_TEXT = {
  critical: 'font-bold text-vermilion',
  warn: 'text-vermilion',
  info: 'text-cobalt',
} as const;

/** A saved run, opened from the library. */
export function RunView({ run }: { run: SampleRun }) {
  const lens = lensFor(run.lensKey);
  const counts = severityCounts(lens.findings);
  const when = run.group === 'Today' ? run.when : `${run.group}, ${run.when}`;

  return (
    <div className="space-y-8">
      <PageHeader
        above={<BackToAnalysis />}
        title={run.customQuestion ?? run.sessionTitle}
        description={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs">
            <span>
              <span className="text-fg/55">Lens </span>
              <span className="font-medium text-fg/85">{run.customQuestion ? 'Custom' : lens.name}</span>
            </span>
            <span>
              <span className="text-fg/55">Session </span>
              <span className="font-mono text-xs text-fg/85">{run.sessionShortId}</span>
            </span>
            <span className="text-fg/55">{when}</span>
          </span>
        }
        actions={
          <>
            <button type="button" disabled title="Coming soon" className="btn disabled:cursor-not-allowed">
              Re-run
            </button>
            <button type="button" disabled title="Coming soon" className="btn disabled:cursor-not-allowed">
              Export
            </button>
            <SoonChip label="Coming soon" />
          </>
        }
      />

      <Section
        title="Result"
        aside={
          <span className="flex items-center gap-3 font-mono text-[0.65rem] tabular-nums">
            {(['critical', 'warn', 'info'] as const).map(
              (s) =>
                counts[s] > 0 && (
                  <span key={s} className={SEVERITY_TEXT[s]}>
                    {counts[s]} {s}
                  </span>
                ),
            )}
          </span>
        }>
        <FindingList verdict={run.customQuestion ? CUSTOM_VERDICT : lens.verdict} findings={lens.findings} />
      </Section>

      <FollowUpThread lensName={run.customQuestion ? 'Custom lens' : lens.name} followUps={run.followUps} />

      <p className="font-mono text-[0.68rem] text-fg/55">Sample run. Nothing was analyzed and no model was called.</p>
    </div>
  );
}
