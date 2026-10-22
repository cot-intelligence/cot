import { useEffect, useState } from 'react';
import { AGENTS, type AgentId } from '../../../lib/agents';
import { getHookStatus, getPassive, PassiveUnsupportedError, type PassiveAgent, type PassiveStatus } from '../../../lib/api';

/** Agents cot can capture live through a hook or plugin; every other agent is read from disk. */
export const LIVE_AGENTS: AgentId[] = AGENTS.map((a) => a.id);
export const isLiveAgent = (id: string): id is AgentId => (LIVE_AGENTS as string[]).includes(id);

/**
 * Everything setup decides, held by the onboarding shell (each step remounts
 * for its page transition): what the scan found, which agents get live hooks,
 * which are imported, and whether the first import has started.
 */
export function useSetup() {
  const [p, setP] = useState<PassiveStatus | null>(null);
  const [failed, setFailed] = useState<'unsupported' | 'offline' | false>(false);
  const [live, setLive] = useState<AgentId[] | null>(null);
  const [skipped, setSkipped] = useState<PassiveAgent[]>([]);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([getPassive(), getHookStatus().catch(() => null)])
        .then(([status, hooks]) => {
          if (!active) return;
          setP(status);
          // First look: go live for every hookable agent that's on this machine
          // (it has sessions, or its hooks are already in).
          setLive((cur) => cur ?? LIVE_AGENTS.filter((id) => {
            const d = status.agents_detail.find((x) => x.agent === id);
            const h = hooks?.agents.find((x) => x.source === id);
            return (d && d.readable && d.transcripts > 0) || (h && h.health !== 'not_installed');
          }));
        })
        .catch((e) => active && setFailed(e instanceof PassiveUnsupportedError ? 'unsupported' : 'offline'));
    load();
    // While the first import runs, keep its progress moving on screen.
    const t = started ? window.setInterval(load, 2000) : 0;
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [started]);

  /** Agents to import: all of them, less any the person switched off. Agents not
   *  on this machine stay on, so installing one later needs no trip to Settings. */
  const importAgents = (p?.agents_detail ?? []).map((d) => d.agent).filter((a) => !skipped.includes(a));
  return { p, failed, live, setLive, skipped, setSkipped, importAgents, started, setStarted };
}

export type Setup = ReturnType<typeof useSetup>;

const POLL_MS = 2000;

/** Whether each live agent's hooks are in, kept current while a step is open. */
export function useConnections(agentIds: AgentId[]) {
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
  }, [agentIds.join(',')]);
  return connected;
}
