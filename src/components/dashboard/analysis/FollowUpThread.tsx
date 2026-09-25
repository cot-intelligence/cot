import { useState } from 'react';
import type { FollowUp } from '../../../lib/analysisPreview';
import { Icon } from '../../ui/icons';
import { EvidenceChips, Section } from './parts';

const SUGGESTIONS = [
  'Show every turn where the agent ignored an instruction',
  'Which finding cost the most time?',
  'Write a project rule that prevents this',
];

/**
 * Follow-up questions about a finished run, answered from the same digest and
 * citing turns like the findings do. Design preview: typing works, sending is
 * disabled.
 */
export function FollowUpThread({ lensName, followUps = [] }: { lensName: string; followUps?: FollowUp[] }) {
  const [draft, setDraft] = useState('');

  return (
    <Section
      title="Follow-ups"
      aside={
        followUps.length > 0 && (
          <span className="font-mono text-[0.62rem] tabular-nums text-fg/55">{followUps.length} asked</span>
        )
      }>
      {followUps.length > 0 && (
        <div className="space-y-5">
          {followUps.map((f) => (
            <div key={f.question} className="space-y-3">
              {/* Same shape as the session timeline's user bubble, flat tint instead of a gradient. */}
              <div className="flex flex-col items-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-cobalt/[0.1] px-4 py-2.5 ring-1 ring-inset ring-cobalt/30">
                  <p className="font-mono text-xs leading-relaxed text-fg">{f.question}</p>
                </div>
                <span className="mt-1 pr-1 font-mono text-[0.58rem] tabular-nums text-fg/50">You, {f.when}</span>
              </div>

              <div className="max-w-[92%] rounded-2xl rounded-tl-md border border-line/15 bg-surface px-5 py-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line/20 bg-panel">
                    <Icon name="brain" className="h-3 w-3 text-fg/70" />
                  </span>
                  <span className="font-mono text-[0.68rem] font-bold text-fg">{lensName}</span>
                </div>
                <p className="max-w-[68ch] font-mono text-xs leading-relaxed text-fg/85">{f.answer}</p>
                {f.points && (
                  <ol className="mt-2.5 max-w-[68ch] space-y-1.5">
                    {f.points.map((pt, i) => (
                      <li key={pt} className="flex gap-2.5 font-mono text-xs leading-relaxed text-fg/80">
                        <span className="shrink-0 tabular-nums text-fg/45">{i + 1}.</span>
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-3">
                  <EvidenceChips items={f.evidence} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2.5 pt-1">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setDraft(s)}
              className="rounded-full border border-line/20 px-3 py-1 font-mono text-[0.62rem] text-fg/70 transition-colors hover:border-line/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50">
              {s}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => e.preventDefault()}
          className="flex items-end gap-2 rounded-[5px] border border-line/20 bg-bg p-2 focus-within:border-line/40">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Ask a follow-up about this analysis</span>
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about this analysis. Answers cite the turns they come from."
              className="block w-full resize-none bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed text-fg placeholder:text-fg/45 focus:outline-none"
            />
          </label>
          <button type="submit" disabled title="Coming soon" className="btn-primary disabled:cursor-not-allowed">
            Send
            <span className="chip text-cream ring-cream/40">Soon</span>
          </button>
        </form>
        <p className="font-mono text-[0.62rem] text-fg/55">
          Follow-ups reuse this run's digest, so each one costs about $0.02.
        </p>
      </div>
    </Section>
  );
}
