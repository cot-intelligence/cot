import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getPassiveRunning, type PassiveRun } from '../../lib/api';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';

const POLL_IDLE_MS = 15000;
const POLL_RUNNING_MS = 2500;
const DONE_SHOWN_MS = 8000;

/**
 * A slim strip under the top bar while a passive import runs: metadata first,
 * then analysis. When it finishes it says what came in, refreshes the lists,
 * and gets out of the way.
 */
export function PassiveBanner() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'metadata' | 'analysis' | null>(null);
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
        } else {
          setPhase(null);
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
              <><b>Importing transcripts</b> · step 1 of 2. Sessions appear as their metadata lands.</>
            ) : (
              <><b>Analysing imported sessions</b> · step 2 of 2. Findings appear when it finishes.</>
            )}
          </span>
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
