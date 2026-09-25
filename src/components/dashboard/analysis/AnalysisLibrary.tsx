import { useState } from 'react';
import { RUN_GROUPS, SAMPLE_RUNS, lensFor, type SampleRun } from '../../../lib/analysisPreview';
import { Icon } from '../../ui/icons';
import { Section, SeverityTag, worstSeverity } from './parts';

/**
 * The Analysis library, shown under the composer on the Analysis home page:
 * the entry to the cross-session report and every saved run, grouped by day.
 */
export function AnalysisLibrary() {
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
      <a
        href="#/analysis/across"
        className="focus-ring group flex items-center gap-4 border border-line/15 bg-bg px-5 py-4 transition-colors hover:border-line/30 hover:bg-surface">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] border border-line/15 bg-panel">
          <Icon name="layers" className="h-4 w-4 text-fg/75" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[0.78rem] font-bold text-fg">Across all sessions</span>
          <span className="mt-0.5 block font-mono text-xs leading-snug text-fg/65">
            Find the habits that repeat across your sessions, ranked, with a fix for each.
          </span>
        </span>
        <span className="font-mono text-base text-fg/55 transition-transform group-hover:translate-x-0.5 group-hover:text-fg">
          →
        </span>
      </a>

      <Section
        title="Saved analyses"
        aside={
          <label className="flex items-center gap-2 rounded-[4px] border border-line/20 bg-bg px-2.5 py-1 focus-within:border-line/40">
            <Icon name="search" className="h-3 w-3 shrink-0 text-fg/50" />
            <input
              type="search"
              aria-label="Search saved analyses"
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-32 bg-transparent font-mono text-[0.68rem] text-fg placeholder:text-fg/45 focus:outline-none sm:w-44"
            />
          </label>
        }>
        <div className="border border-line/15 bg-bg">
          {RUN_GROUPS.map((group) => {
            const inGroup = runs.filter((r) => r.group === group);
            if (!inGroup.length) return null;
            return (
              <div key={group}>
                <p className="border-b border-line/[0.08] bg-panel/70 px-5 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-fg/55">
                  {group}
                </p>
                <ul className="divide-y divide-line/[0.07]">
                  {inGroup.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </ul>
              </div>
            );
          })}
          {!runs.length && (
            <p className="px-5 py-6 font-mono text-xs text-fg/60">No saved analyses match “{q}”.</p>
          )}
        </div>
      </Section>
    </>
  );
}

function RunRow({ run }: { run: SampleRun }) {
  const lens = lensFor(run.lensKey);
  return (
    <li>
      <a
        href={`#/analysis/${run.id}`}
        title={`Session ${run.sessionShortId}`}
        className="focus-ring group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-fg/[0.03]">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[0.75rem] font-bold text-fg">
            {run.customQuestion ?? run.sessionTitle}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-fg/55">
            {run.customQuestion ? 'Custom lens' : lens.name}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <SeverityTag severity={worstSeverity(lens.findings)} fixed />
          <span className="hidden font-mono text-[0.62rem] tabular-nums text-fg/60 sm:inline">
            {lens.findings.length} findings
          </span>
        </span>
        <span className="w-12 shrink-0 text-right font-mono text-[0.62rem] tabular-nums text-fg/55">{run.when}</span>
      </a>
    </li>
  );
}
