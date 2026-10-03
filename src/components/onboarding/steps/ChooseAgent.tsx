import { AGENTS, type AgentId } from '../../../lib/agents';
import { AgentCard } from '../AgentCard';
import { FadeIn } from '../../ui/FadeIn';

interface ChooseAgentProps {
  selected: AgentId[];
  onToggle: (id: AgentId) => void;
  onContinue: () => void;
}

export function ChooseAgent({ selected, onToggle, onContinue }: ChooseAgentProps) {
  return (
    <FadeIn className="space-y-10">
      <header className="space-y-3">
        <span className="font-mono text-small text-hot">agent source</span>
        <h1 className="text-[2.25rem] font-semibold leading-[1.05] tracking-display text-fg sm:text-[2.75rem]">
          Connect your{' '}
          <span className="text-hot">agents</span>
        </h1>
        <p className="max-w-md text-lead text-fg/60">
          Select the agents you use. cot ingests lifecycle hooks locally — no
          SDK, no code changes, your traces never leave your machine.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {AGENTS.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={selected.includes(agent.id)}
            onSelect={() => onToggle(agent.id)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-data uppercase tracking-label text-fg/40">
          {selected.length === 0
            ? 'Select at least one'
            : `${selected.length} selected`}
        </p>
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={onContinue}
          className="group btn-primary px-5 py-2.5 text-body">
          Continue
          <span className="transition-transform group-enabled:group-hover:translate-x-1">
            {'→'}
          </span>
        </button>
      </div>
    </FadeIn>
  );
}
