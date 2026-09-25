import { lensFor, severityCounts, type SampleRun } from '../../../lib/analysisPreview';
import { PageHeader } from '../../ui/PageHeader';
import { CUSTOM_VERDICT, FindingList, Section, SoonChip } from './parts';

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
        title={run.customQuestion ?? run.sessionTitle}
        description={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1 font-sans text-[13px]">
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

      <Section title="Ask a follow-up">
        <div className="flex items-center gap-3 rounded-[4px] border border-line/20 bg-bg px-3 py-2">
          <input
            type="text"
            disabled
            aria-label="Follow-up question"
            placeholder="e.g. Show me every turn where the agent ignored an instruction"
            className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-fg placeholder:text-fg/45 focus:outline-none disabled:cursor-not-allowed"
          />
          <SoonChip />
        </div>
      </Section>

      <p className="font-sans text-xs text-fg/55">Sample run. Nothing was analyzed and no model was called.</p>
    </div>
  );
}
