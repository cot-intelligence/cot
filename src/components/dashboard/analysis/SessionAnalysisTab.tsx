import { useState } from 'react';
import { lensFor } from '../../../lib/analysisPreview';
import { ComingSoonBanner, Composer, CUSTOM_VERDICT, FindingList, LensRow, Section } from './parts';

/** Analysis tab on a session page: run a lens on this session. */
export function SessionAnalysisTab({ eventCount }: { eventCount: number }) {
  const [lensKey, setLensKey] = useState('coach');
  const lens = lensFor(lensKey);

  return (
    <div className="space-y-8">
      <ComingSoonBanner />
      <div className="space-y-2">
        <Composer
          stats={[
            // Illustrative only; the real figure comes from the digest.
            ['Digest', `~${Math.max(4, Math.round(eventCount / 14))}k tokens`],
            ['Est. cost', '~$0.35'],
            ['Model', 'Your API key'],
          ]}>
          <LensRow lensKey={lensKey} onChange={setLensKey} />
        </Composer>
        <a
          href="#/analysis"
          className="inline-block font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/45 hover:text-fg">
          All analyses →
        </a>
      </div>
      <Section n={1} title={`Example output · ${lensKey === 'custom' ? 'Custom lens' : lens.name}`}>
        <FindingList verdict={lensKey === 'custom' ? CUSTOM_VERDICT : lens.verdict} findings={lens.findings} />
        <p className="font-mono text-[0.6rem] leading-relaxed text-fg/40">
          Sample data. Runs are saved to the Analysis library, and evidence chips will jump to that moment in the
          Timeline.
        </p>
      </Section>
    </div>
  );
}
