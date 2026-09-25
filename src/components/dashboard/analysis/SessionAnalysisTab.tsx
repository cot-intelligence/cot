import { useState } from 'react';
import { lensFor } from '../../../lib/analysisPreview';
import { Composer, CUSTOM_VERDICT, FindingList, LensRow, Section, SoonChip } from './parts';

/** Analysis tab on a session page: run a lens on this session. */
export function SessionAnalysisTab({ eventCount }: { eventCount: number }) {
  const [lensKey, setLensKey] = useState('coach');
  const lens = lensFor(lensKey);

  return (
    <div className="space-y-8">
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <p className="font-sans text-sm text-fg/75">Have an LLM read this session through a lens you choose.</p>
          <SoonChip label="Coming soon" />
          <a href="#/analysis" className="ml-auto font-sans text-xs font-medium text-fg/60 hover:text-fg">
            All analyses →
          </a>
        </div>
        <Composer
          stats={[
            // Illustrative only; the real figure comes from the digest.
            ['Digest', `~${Math.max(4, Math.round(eventCount / 14))}k tokens`],
            ['Est. cost', '~$0.35'],
            ['Model', 'Your API key'],
          ]}>
          <LensRow lensKey={lensKey} onChange={setLensKey} />
        </Composer>
      </div>
      <Section title={`Example output: ${lensKey === 'custom' ? 'Custom lens' : lens.name}`}>
        <FindingList verdict={lensKey === 'custom' ? CUSTOM_VERDICT : lens.verdict} findings={lens.findings} />
        <p className="font-sans text-xs text-fg/55">
          Sample data. Runs will be saved to the Analysis library, and evidence links will jump to the Timeline.
        </p>
      </Section>
    </div>
  );
}
