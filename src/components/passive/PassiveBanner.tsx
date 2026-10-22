import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getPassivePending,
  getPassiveRunning,
  runPassiveNow,
  type PassiveAgent,
  type PassiveAnalysis,
  type PassivePending,
  type PassiveProgress,
  type PassiveRun,
} from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';

const POLL_IDLE_MS = 15000;
const POLL_RUNNING_MS = 1000;
const PENDING_POLL_MS = 60000;
const DONE_SHOWN_MS = 8000;
const DISMISSED_KEY = 'cot.importPrompt.dismissed';
/** How far the bar may run ahead of the last reported value while it waits for the next one. */
const CREEP_AHEAD = 6;

function readDismissed(): number {
  try {
    return Number(window.localStorage.getItem(DISMISSED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeDismissed(n: number) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(n));
  } catch {
    /* private mode: the prompt just comes back next load */
  }
}

/**
 * The reported percent, eased so the bar never sits still: it catches up to
 * each new report and, between reports, creeps a little further (never more
 * than CREEP_AHEAD past the last real value) with ever smaller steps.
 */
function useSmoothPercent(target: number): number {
  const [shown, setShown] = useState(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    const id = window.setInterval(() => {
      setShown((cur) => {
        const t = targetRef.current;
        if (t < cur - 25) return t; // a new run started over
        if (t > cur) return cur + Math.max(0.4, (t - cur) * 0.25);
        const cap = Math.min(99, t + CREEP_AHEAD);
        return cur < cap ? cur + (cap - cur) * 0.02 : cur;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, []);
  return Math.min(100, shown);
}

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
  const target = (ingest * INGEST_SHARE + enrich * (100 - INGEST_SHARE)) / 100;
  const overall = useSmoothPercent(target);
  // Split the eased overall value back into the two segments.
  const ingestShown = Math.min(100, (overall / INGEST_SHARE) * 100);
  const enrichShown = Math.max(0, Math.min(100, ((overall - INGEST_SHARE) / (100 - INGEST_SHARE)) * 100));
  const stageNow = phase === 'analysis' ? enrichShown : ingestShown;
  return (
    <span className="psv-progress">
      <span className="psv-progress-track" role="progressbar" aria-label="Transcript import" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(99, Math.round(overall))}>
        <span className="psv-progress-seg" style={{ width: `${INGEST_SHARE}%` }} title="Ingestion">
          <span className="psv-progress-fill" style={{ transform: `scaleX(${ingestShown / 100})` }} />
        </span>
        <span className="psv-progress-split" aria-hidden="true" />
        <span className="psv-progress-seg" style={{ width: `${100 - INGEST_SHARE}%` }} title="Enrichment">
          <span className="psv-progress-fill" style={{ transform: `scaleX(${enrichShown / 100})` }} />
        </span>
      </span>
      <span className="psv-progress-pct" aria-hidden="true">
        {phase === 'analysis' ? 'Enrichment' : 'Ingestion'} {Math.min(99, Math.floor(stageNow))}%
      </span>
    </span>
  );
}

const pendingText = (p: PassivePending) =>
  (Object.entries(p.by_agent) as [PassiveAgent, number][])
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${agentLabel(a)} ${fmt.n(n)}`)
    .join(' · ');

/**
 * A slim strip under the top bar. While a passive import runs it shows the two
 * phases with live progress; when it finishes it says what came in. When
 * nothing is running and transcripts on disk aren't in cot yet, it offers to
 * import them.
 */
export function PassiveBanner() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'metadata' | 'analysis' | null>(null);
  const [progress, setProgress] = useState<PassiveProgress | null>(null);
  const [analysis, setAnalysis] = useState<PassiveAnalysis | null>(null);
  const [done, setDone] = useState<PassiveRun | null>(null);
  const [pending, setPending] = useState<PassivePending | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let timer = 0;
    const checkPending = (fresh = false) =>
      getPassivePending(fresh)
        .then((p) => live && setPending(p))
        .catch(() => {});
    const tick = async () => {
      window.clearTimeout(timer);
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
            void checkPending(true);
            window.setTimeout(() => live && setDone(null), DONE_SHOWN_MS);
          }
        }
      } catch {
        /* collector briefly unreachable; try again next tick */
      }
      if (live) timer = window.setTimeout(tick, wasRunning.current ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };
    poke.current = () => void tick();
    void tick();
    void checkPending();
    const pendingTimer = window.setInterval(() => !wasRunning.current && void checkPending(), PENDING_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.clearInterval(pendingTimer);
    };
  }, [queryClient]);

  const importNow = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await runPassiveNow();
      wasRunning.current = true;
      setPhase('metadata');
      setProgress(null);
      setAnalysis(null);
      setPending(null);
      poke.current();
    } catch {
      setStartError("Couldn't start the import. Is the collector running?");
    } finally {
      setStarting(false);
    }
  };
  const notNow = () => {
    if (!pending) return;
    writeDismissed(pending.total);
    setDismissed(pending.total);
  };

  const offer = !phase && !done && pending && pending.total > dismissed ? pending : null;
  if (!phase && !done && !offer) return null;
  return (
    <div className="psv-banner" role="status" aria-live="polite" data-done={!!done || undefined} data-offer={!!offer || undefined}>
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
      ) : offer ? (
        <>
          <Icon name="download" size={14} />
          <span className="psv-offer-t">
            <b>
              cot found {fmt.n(offer.total)} session{offer.total === 1 ? '' : 's'} it hasn't imported yet.
            </b>{' '}
            <span className="mono dim" style={{ fontSize: 12 }}>{pendingText(offer)}</span>
            {startError && <span className="psv-offer-err"> {startError}</span>}
          </span>
          <span className="psv-offer-actions">
            <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={() => void importNow()} disabled={starting}>
              {starting ? 'Starting…' : 'Import now'}
            </button>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={notNow}>
              Not now
            </button>
          </span>
        </>
      ) : null}
      {!offer && (
        <a className="psv-banner-a" href="#/settings/passive">
          Passive import <Icon name="arrow" size={13} />
        </a>
      )}
    </div>
  );
}
