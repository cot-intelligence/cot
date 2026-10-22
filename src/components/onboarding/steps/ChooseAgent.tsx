import { useEffect, useState } from 'react';
import { AGENTS, type AgentId } from '../../../lib/agents';
import { getPassive } from '../../../lib/api';
import { AgentMark } from '../../forest/AgentMark';
import { fmt } from '../../forest/format';
import { Actions, Shell } from './Shell';

interface ChooseAgentProps {
  selected: AgentId[];
  onToggle: (id: AgentId) => void;
  onBack: () => void;
  onContinue: () => void;
}

/** What the passive scan found on disk per agent, so people can see which ones they actually use. */
function useFoundOnDisk(): Record<string, number> | null {
  const [found, setFound] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    getPassive()
      .then((p) => live && setFound(Object.fromEntries(p.agents_detail.map((d) => [d.agent, d.readable ? d.transcripts : 0]))))
      .catch(() => live && setFound({}));
    return () => {
      live = false;
    };
  }, []);
  return found;
}

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

export function ChooseAgent({ selected, onToggle, onBack, onContinue }: ChooseAgentProps) {
  const found = useFoundOnDisk();
  return (
    <Shell
      eyebrow="Live hooks · step 1 of 3"
      title="Choose agents to connect"
      lead="cot adds a small hook to each agent you pick. No SDK, no code changes, and your traces never leave this machine.">
      <ul className="onb-agents" role="group" aria-label="Agents to connect">
        {AGENTS.map((agent) => {
          const on = selected.includes(agent.id);
          const n = found?.[agent.id] ?? 0;
          return (
            <li key={agent.id}>
              <button type="button" role="checkbox" aria-checked={on} aria-label={agent.product} className="onb-agent" onClick={() => onToggle(agent.id)}>
                <span className="onb-agent-mark"><AgentMark id={agent.id} size={20} /></span>
                <span className="onb-agent-t">
                  <b>{agent.product}</b>
                  <span className="dim">{firstSentence(agent.tagline)}</span>
                </span>
                <span className="onb-agent-m mono">
                  {found === null ? '' : n > 0 ? `${fmt.n(n)} sessions found` : 'None found'}
                </span>
                <span className="onb-check" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" /></svg>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Actions
        onBack={onBack}
        extra={<span className="mono faint onb-count">{selected.length === 0 ? 'Pick at least one' : `${selected.length} selected`}</span>}
        next={{ label: 'Continue', disabled: selected.length === 0, onClick: onContinue }}
      />
    </Shell>
  );
}
