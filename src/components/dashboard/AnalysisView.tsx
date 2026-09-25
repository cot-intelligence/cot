import { lensFor, runFor } from '../../lib/analysisPreview';
import { FadeIn } from '../ui/FadeIn';
import { PageHeader } from '../ui/PageHeader';
import { AnalysisPanel } from './analysis/AnalysisPanel';

/**
 * Standalone Analysis page. A design preview: the feature is not built yet, so
 * everything shown is sample data. `runId` opens a past run from the sidebar.
 */
export function AnalysisView({ runId }: { runId?: string }) {
  const run = runFor(runId);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8">
      <FadeIn className="mx-auto max-w-7xl space-y-8">
        <PageHeader
          eyebrow="Agentic analysis"
          title={run ? lensFor(run.lensKey).name : 'Analysis'}
          description={
            run
              ? `Session ${run.sessionShortId} · ${run.when}`
              : 'Have an LLM read a session through a lens you choose, and point at the moments behind every finding.'
          }
          actions={<span className="chip text-vermilion ring-vermilion/50">Coming soon</span>}
        />
        {/* Keyed so opening another run resets the lens picker to that run's lens. */}
        <AnalysisPanel key={runId ?? 'new'} runId={runId} pickSession />
      </FadeIn>
    </div>
  );
}
