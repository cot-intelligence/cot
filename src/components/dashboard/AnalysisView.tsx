import { runFor } from '../../lib/analysisPreview';
import { FadeIn } from '../ui/FadeIn';
import { AcrossView } from './analysis/AcrossView';
import { AnalysisHome } from './analysis/AnalysisHome';
import { RunView } from './analysis/RunView';

/**
 * Analysis page (design preview; the feature is not built yet). `#/analysis`
 * is home: start a run, then the library of saved runs beneath it.
 * `#/analysis/across` is the cross-session report, `#/analysis/<runId>` a saved run.
 */
export function AnalysisView({ runId }: { runId?: string }) {
  const run = runFor(runId);
  const activeId = runId === 'across' ? 'across' : run?.id;

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8">
      <FadeIn key={activeId ?? 'home'} className="mx-auto max-w-6xl">
        {activeId && (
          <a
            href="#/analysis"
            className="mb-5 inline-block font-mono text-[0.68rem] font-bold text-fg/60 transition-colors hover:text-fg">
            ← All analyses
          </a>
        )}
        {activeId === 'across' ? <AcrossView /> : run ? <RunView run={run} /> : <AnalysisHome />}
      </FadeIn>
    </div>
  );
}
