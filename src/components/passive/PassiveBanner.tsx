import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getPassiveRunning, type PassiveAnalysis, type PassiveProgress, type PassiveRun } from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';

const POLL_IDLE_MS = 15000;
const POLL_RUNNING_MS = 2500;
const DONE_SHOWN_MS = 8000;

// Share of the bar each stage gets; ingestion is most of the wall-clock time.
const INGEST_SHARE = 75;

const pct = (done: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0);

/** Percent through the current stage: ingestion by bytes read, enrichment by analysis steps. */
export function stagePercent(phase: 'metadata' | 'analysis', progress?: PassiveProgress | null, analysis?: PassiveAnalysis | null): number | null {
  if (phase === 'analysis') return analysis ? Math.min(99, pct(analysis.done, analysis.total)) : null;
  return progress ? Math.min(99, pct(progress.bytes_done, progress.bytes_total)) : null;
}

/** One long bar in two parts, ingestion then enrichment, split by a hairline. */
function ImportBar({ phase, progress, analysis }: { phase: 'metadata' | 'analysis'; progress: PassiveProgress | null; analysis: PassiveAnalysis | null }) {
  const ingest = phase === 'analysis' ? 100 : progress ? pct(progress.bytes_done, progress.bytes_total) : 0;
  const enrich = phase === 'analysis' && analysis ? pct(analysis.done, analysis.total) : 0;
  const now = stagePercent(phase, progress, analysis);
  const overall = Math.round((ingest * INGEST_SHARE + enrich * (100 - INGEST_SHARE)) / 100);
  return (
    <span className="psv-progress">
      <span className="psv-progress-track" role="progressbar" aria-label="Transcript import" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(99, overall)}>
        <span className="psv-progress-seg" style={{ width: `${INGEST_SHARE}%` }} title="Ingestion">
          <span className="psv-progress-fill" style={{ width: `${ingest}%` }} />
        </span>
        <span className="psv-progress-split" aria-hidden="true" />
        <span className="psv-progress-seg" style={{ width: `${100 - INGEST_SHARE}%` }} title="Enrichment">
          <span className="psv-progress-fill" style={{ width: `${enrich}%` }} />
        </span>
      </span>
      <span className="psv-progress-pct" aria-hidden="true">
        {phase === 'analysis' ? 'Enrichment' : 'Ingestion'}{now != null ? ` ${now}%` : ''}
      </span>
    </span>
  );
}

/**
 * A slim strip under the top bar while a passive import runs: metadata first,
 * then analysis. When it finishes it says what came in, refreshes the lists,
 * and gets out of the way.
 */
export function PassiveBanner() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'metadata' | 'analysis' | null>(null);
  const [progress, setProgress] = useState<PassiveProgress | null>(null);
  const [analysis, setAnalysis] = useState<PassiveAnalysis | null>(null);
  const [done, setDone] = useState<PassiveRun | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await getPassiveRunning();
        if (!live) return;
        if (r.running.running) {
          wasRunning.current = true;
          setDone(null);
          setPhase(r.running.phase ?? 'metadata');
          setProgress(r.running.progress ?? null);
          setAnalysis(r.running.analysis ?? null);
        } else {
          setPhase(null);
          setProgress(null);
          setAnalysis(null);
          if (wasRunning.current && r.last_run) {
            wasRunning.current = false;
            setDone(r.last_run);
            void queryClient.invalidateQueries();
            window.setTimeout(() => live && setDone(null), DONE_SHOWN_MS);
          }
        }
      } catch {
        /* collector briefly unreachable; try again next tick */
      }
      if (live) timer = window.setTimeout(tick, wasRunning.current ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [queryClient]);

  if (!phase && !done) return null;
  return (
    <div className="psv-banner" role="status" aria-live="polite" data-done={!!done || undefined}>
      {phase ? (
        <>
          <span className="psv-banner-dot" aria-hidden="true" />
          <span>
            {phase === 'metadata' ? (
              <><b>Importing transcripts</b> · step 1 of 2{progress ? ` · ${agentLabel(progress.agent)}` : ''}. Sessions appear as their metadata lands.</>
            ) : (
              <><b>Analysing imported sessions</b> · step 2 of 2. Findings appear when it finishes.</>
            )}
          </span>
          <ImportBar phase={phase} progress={progress} analysis={analysis} />
        </>
      ) : done ? (
        <>
          <Icon name="check" size={14} />
          <span>
            <b>Import finished.</b>{' '}
            {[
              `${fmt.n(done.new_sessions ?? 0)} new session${done.new_sessions === 1 ? '' : 's'}`,
              done.findings !== undefined ? `${fmt.n(done.findings)} findings` : null,
              done.held_back ? `${done.held_back} still running, next run` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </>
      ) : null}
      <a className="psv-banner-a" href="#/settings" onClick={() => window.setTimeout(() => document.getElementById('set-passive')?.scrollIntoView({ block: 'start' }), 60)}>
        Passive import <Icon name="arrow" size={13} />
      </a>
    </div>
  );
}
