import { useEffect, useState } from 'react';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getHookStatus } from '../../../lib/api';
import { Icon } from '../../forest/icons';
import { HistorySummary, useImportHistory } from './HistorySummary';
import { Actions, Shell, StatusRow } from './Shell';

interface VerifyProps {
  agents: AgentId[];
  onBack: () => void;
  onSetup: () => void;
  onFinish: (origin: { x: number; y: number }) => void;
}

const POLL_MS = 2000;

/** Whether each picked agent's hooks are in, kept current while the summary is open. */
function useConnections(agentIds: AgentId[]) {
  const [connected, setConnected] = useState<Record<string, { ok: boolean; events: number }> | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const hooks = await getHookStatus();
        if (!active) return;
        setConnected(Object.fromEntries(agentIds.map((id) => {
          const a = hooks.agents.find((x) => x.source === id);
          return [id, { ok: !!a && a.health !== 'not_installed' && a.health !== 'missing_hooks', events: a?.events ?? 0 }];
        })));
      } catch {
        /* the collector may still be starting */
      }
      if (active) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [agentIds]);
  return connected;
}

export function Verify({ agents: agentIds, onBack, onSetup, onFinish }: VerifyProps) {
  const { summary, state } = useImportHistory();
  const connected = useConnections(agentIds);
  return (
    <Shell
      eyebrow="Live hooks · step 3 of 3"
      title={state === 'found' ? 'Your history is in' : state === 'scanning' ? 'Bringing in your history' : 'You’re set'}
      lead={
        state === 'found'
          ? 'cot found your past sessions and imported them. New ones arrive live from your hooks.'
          : state === 'scanning'
            ? 'Looking for sessions your agents saved before cot. This takes a few seconds.'
            : 'Sessions will appear as you use your agents.'
      }>
      <ul className="onb-status">
        {agentIds.map((id) => {
          const c = connected?.[id];
          return (
            <StatusRow
              key={id}
              id={id}
              name={getAgent(id).product}
              tone={!c ? 'wait' : c.ok ? 'ok' : 'warn'}
              status={!c ? 'Checking' : c.ok ? 'Connected' : 'Not connected'}
              detail={c?.ok && c.events ? `${c.events.toLocaleString()} events received` : undefined}
            />
          );
        })}
      </ul>
      <HistorySummary summary={summary} state={state} />
      <p className="onb-note"><Icon name="clock" size={14} />Transcript import turns on too when you continue, for agents without a hook.</p>
      <Actions
        onBack={onBack}
        backLabel="Change agents"
        extra={<button type="button" className="vbtn vbtn-ghost" onClick={onSetup}>Manual setup</button>}
        next={{ label: 'Open dashboard', onClick: onFinish }}
      />
    </Shell>
  );
}
