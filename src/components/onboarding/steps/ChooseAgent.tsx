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
        <span className="inline-block border border-fg bg-fg px-3 py-1 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-bg">
          AGENT_SOURCE
        </span>
        <h1 className="text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-fg sm:text-5xl">
          Connect your{' '}
          <span className="font-serif lowercase italic text-vermilion">agents</span>
        </h1>
        <p className="max-w-md font-mono text-xs leading-relaxed text-fg/55">
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
        <p className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/30">
          {selected.length === 0
            ? 'Select at least one'
            : `${selected.length} selected`}
        </p>
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={onContinue}
          className="group inline-flex items-center gap-3 border border-fg bg-fg px-7 py-3.5 font-mono text-xs font-bold uppercase tracking-widest text-bg shadow-brutal transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:border-fg/20 disabled:bg-transparent disabled:text-fg/30 disabled:shadow-none">
          Continue
          <span className="transition-transform group-enabled:group-hover:translate-x-1">
            {'→'}
          </span>
        </button>
      </div>
    </FadeIn>
  );
}
