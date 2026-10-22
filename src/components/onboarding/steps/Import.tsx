import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '../../../lib/agents';
import { runPassiveNow, updatePassive } from '../../../lib/api';
import { getAgent } from '../../../lib/agents';
import { Icon } from '../../forest/icons';
import { RunStatus } from '../../passive/PassiveParts';
import { Actions, Shell, StatusRow } from './Shell';
import { useConnections, type Setup } from './setup';

/** Last step: save what was picked, start the first import, and let the person in
 *  while it runs. Live agents show whether their hooks came through. */
export function Import({ setup, live, step, onBack, onFinish }: {
  setup: Setup;
  live: AgentId[];
  step: number;
  onBack: () => void;
  onFinish: (origin: { x: number; y: number }) => void;
}) {
  const { p, importAgents, started, setStarted } = setup;
  const [err, setErr] = useState<string | null>(null);
  const once = useRef(false);
  const connected = useConnections(live);

  useEffect(() => {
    if (once.current || started || !p) return;
    once.current = true;
    updatePassive({ enabled: true, agents: importAgents })
      .then(() => runPassiveNow())
      .then(() => setStarted(true))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not start the import'));
  }, [p, started]);

  const schedule = p?.schedule.description;
  return (
    <Shell
      eyebrow={`Set up cot · step ${step}`}
      title="Bringing in your history"
      lead="cot imports session details first, then looks for findings. Big histories take a few minutes; the dashboard is ready to use now.">
      {live.length > 0 && (
        <ul className="onb-status">
          {live.map((id) => {
            const c = connected?.[id];
            return (
              <StatusRow
                key={id}
                id={id}
                name={getAgent(id).product}
                tone={!c ? 'wait' : c.ok ? 'ok' : 'warn'}
                status={!c ? 'Checking' : c.ok ? 'Live' : 'Hooks not connected'}
                detail={c?.ok ? (c.events ? `${c.events.toLocaleString()} events received` : 'Waiting for its first event') : c ? 'Its history is imported; connect it later from Settings' : undefined}
              />
            );
          })}
        </ul>
      )}
      <div className="card"><div className="card-b">
        {p && started ? <RunStatus status={p} /> : err ? null : <div className="onb-skel" aria-hidden="true"><span /></div>}
        {err && <p role="alert" className="onb-note" style={{ color: 'var(--v-alert)' }}>{err}</p>}
      </div></div>
      {schedule && (
        <p className="onb-note"><Icon name="clock" size={14} />After this, cot checks for new sessions {schedule.charAt(0).toLowerCase() + schedule.slice(1)}. Change it in Settings › Passive import.</p>
      )}
      <Actions onBack={started ? undefined : onBack} next={{ label: 'Open dashboard', onClick: onFinish }} />
    </Shell>
  );
}
