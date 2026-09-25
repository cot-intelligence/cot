import { useState } from 'react';
import {
  RUN_GROUPS,
  SAMPLE_RUNS,
  lensFor,
  severityCounts,
  type SampleRun,
} from '../../../lib/analysisPreview';
import { Icon } from '../../ui/icons';
import { Section, SoonChip } from './parts';

/**
 * The Analysis library, shown under the composer on the Analysis home page:
 * the entry to the cross-session report and every saved run, grouped by day.
 */
export function AnalysisLibrary({ startAt }: { startAt: number }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const runs = needle
    ? SAMPLE_RUNS.filter((r) =>
        [lensFor(r.lensKey).name, r.sessionTitle, r.sessionShortId, r.customQuestion ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : SAMPLE_RUNS;

  return (
    <>
      <Section n={startAt} title="Across all sessions">
        <a
          href="#/analysis/across"
          className="focus-ring group flex items-center gap-4 border border-line/15 bg-surface/40 px-4 py-3.5 transition-colors hover:border-line/30 hover:bg-surface">
          <Icon name="layers" className="h-5 w-5 shrink-0 text-vermilion" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-fg">What to improve across every session</span>
              <SoonChip />
            </span>
            <span className="mt-1 block font-mono text-[0.62rem] leading-relaxed text-fg/50">
              Reads all your sessions in a time range and ranks the habits worth changing, with a fix for each.
            </span>
          </span>
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/40 group-hover:text-fg">
            Set up →
          </span>
        </a>
      </Section>

      <Section
        n={startAt + 1}
        title={`Your analyses · ${SAMPLE_RUNS.length}`}
        aside={
          <input
            type="search"
            placeholder="Search analyses…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-48 border border-line/15 bg-bg px-2.5 py-1 font-mono text-[0.65rem] text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
          />
        }>
        <div className="border border-line/15">
          {RUN_GROUPS.map((group) => {
            const inGroup = runs.filter((r) => r.group === group);
            if (!inGroup.length) return null;
            return (
              <div key={group}>
                <p className="border-b border-line/[0.08] bg-panel px-4 py-1.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40">
                  {group}
                </p>
                {inGroup.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </div>
            );
          })}
          {!runs.length && <p className="p-6 font-mono text-xs text-fg/40">No analyses match “{q}”.</p>}
        </div>
      </Section>
    </>
  );
}

function RunRow({ run }: { run: SampleRun }) {
  const lens = lensFor(run.lensKey);
  const counts = severityCounts(lens.findings);
  return (
    <a
      href={`#/analysis/${run.id}`}
      className="focus-ring block border-b border-line/[0.06] px-4 py-2.5 transition-colors last:border-b-0 hover:bg-fg/[0.03]">
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.68rem] font-bold text-fg">
          {run.customQuestion ? 'Custom lens' : lens.name}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[0.58rem] tabular-nums">
          {counts.critical > 0 && <span className="font-bold text-vermilion">{counts.critical} critical</span>}
          {counts.warn > 0 && <span className="text-vermilion/80">{counts.warn} warn</span>}
          {counts.info > 0 && <span className="text-cobalt">{counts.info} info</span>}
        </span>
        <span className="hidden w-16 shrink-0 font-mono text-[0.58rem] tabular-nums text-fg/40 sm:inline">
          {run.sessionShortId}
        </span>
        <span className="w-12 shrink-0 text-right font-mono text-[0.58rem] tabular-nums text-fg/40">{run.when}</span>
      </span>
      <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-fg/60">
        {run.customQuestion ?? run.sessionTitle}
      </span>
    </a>
  );
}
