import { AGENTS, type AgentId } from '../../../lib/agents';
import { AgentCard } from '../AgentCard';
import { Icon } from '../../forest/icons';

interface ChooseAgentProps {
  selected: AgentId[];
  onToggle: (id: AgentId) => void;
  onContinue: () => void;
}

export function ChooseAgent({ selected, onToggle, onContinue }: ChooseAgentProps) {
  return (
    <div>
      <span className="label">Live hooks · step 1</span>
      <h1 className="onb-t">Choose agents to connect</h1>
      <p className="onb-lead dim">
        cot adds a small hook to each agent you pick. No SDK, no code changes, and your traces never leave this machine.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {AGENTS.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={selected.includes(agent.id)}
            onSelect={() => onToggle(agent.id)}
          />
        ))}
      </div>

      <div className="onb-actions">
        <span className="mono faint" style={{ fontSize: 12 }}>
          {selected.length === 0 ? 'Select at least one' : `${selected.length} selected`}
        </span>
        <button type="button" className="vbtn vbtn-primary" disabled={selected.length === 0} onClick={onContinue}>
          Continue <Icon name="arrow" size={15} />
        </button>
      </div>
    </div>
  );
}
