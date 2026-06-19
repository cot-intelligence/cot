export interface StepMeta {
  id: string;
  label: string;
}

interface StepperProps {
  steps: StepMeta[];
  current: number;
  onJump?: (index: number) => void;
}

export function Stepper({ steps, current, onJump }: StepperProps) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = i <= current && !!onJump;
        return (
          <li key={step.id} className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onJump?.(i)}
              className={`group flex items-center gap-2 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors ${
                reachable ? 'cursor-pointer' : 'cursor-default'
              }`}>
              <span
                className={`flex h-5 w-5 items-center justify-center border text-[0.6rem] tabular-nums transition-colors ${
                  active
                    ? 'border-vermilion bg-vermilion text-cream'
                    : done
                      ? 'border-fg/40 text-fg'
                      : 'border-fg/20 text-fg/30'
                }`}>
                {done ? '\u2713' : String(i + 1).padStart(2, '0')}
              </span>
              <span
                className={`hidden sm:inline transition-colors ${
                  active ? 'text-fg' : done ? 'text-fg/60' : 'text-fg/30'
                }`}>
                {step.label}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                className={`h-px w-4 sm:w-8 transition-colors ${
                  done ? 'bg-fg/40' : 'bg-fg/15'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
