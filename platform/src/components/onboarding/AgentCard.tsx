import type { Agent } from '../../lib/agents';
import { AgentMark } from '../ui/AgentMark';

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}

export function AgentCard({ agent, selected, onSelect }: AgentCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative flex h-full flex-col gap-5 border p-6 text-left transition-all duration-200 focus-visible:outline-none ${
        selected
          ? 'border-vermilion bg-vermilion/[0.06] shadow-brutal-vermilion -translate-y-0.5'
          : 'border-fg/20 bg-surface hover:-translate-y-0.5 hover:border-fg/40 hover:shadow-soft-md'
      }`}>
      <div className="flex items-start justify-between">
        <span
          className={`flex h-11 w-11 items-center justify-center border transition-colors ${
            selected
              ? 'border-vermilion text-vermilion'
              : 'border-fg/25 text-fg/70 group-hover:text-fg'
          }`}>
          <AgentMark id={agent.id} className="h-6 w-6" variant="25d" />
        </span>
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.6rem] transition-colors ${
            selected
              ? 'border-vermilion bg-vermilion text-cream'
              : 'border-fg/25 text-transparent'
          }`}>
          {'\u2713'}
        </span>
      </div>

      <div className="space-y-2">
        <h3 className="font-serif text-2xl font-bold italic text-fg">
          {agent.product}
        </h3>
        <p className="font-mono text-[0.7rem] leading-relaxed text-fg/55">
          {agent.tagline}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
        {agent.events.map((event) => (
          <span
            key={event}
            className={`border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider transition-colors ${
              selected
                ? 'border-vermilion/40 text-vermilion'
                : 'border-fg/15 text-fg/40'
            }`}>
            {event}
          </span>
        ))}
      </div>
    </button>
  );
}
