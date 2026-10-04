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
      className={`group press relative flex h-full flex-col gap-5 rounded-card border p-5 text-left transition-colors duration-150 ${
        selected
          ? 'border-hot/75 bg-hot/[0.06] ring-1 ring-inset ring-hot/40'
          : 'border-line/10 bg-surface hover:border-line/[0.16]'
      }`}>
      <div className="flex items-start justify-between">
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-cell border transition-colors ${
            selected
              ? 'border-hot text-hot'
              : 'border-line/[0.16] text-fg/70 group-hover:text-fg'
          }`}>
          <AgentMark id={agent.id} className="h-6 w-6" variant="25d" />
        </span>
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 items-center justify-center rounded-full border text-label transition-colors ${
            selected
              ? 'border-hot bg-hot text-on-hot'
              : 'border-line/[0.16] text-transparent'
          }`}>
          {'\u2713'}
        </span>
      </div>

      <div className="space-y-2">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-fg">
          {agent.product}
        </h3>
        <p className="font-mono text-data leading-relaxed text-fg/60">
          {agent.tagline}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
        {agent.events.map((event) => (
          <span
            key={event}
            className={`border px-1.5 py-0.5 font-mono text-label uppercase tracking-wider transition-colors ${
              selected
                ? 'border-hot/40 text-hot'
                : 'border-line/15 text-fg/40'
            }`}>
            {event}
          </span>
        ))}
      </div>
    </button>
  );
}
