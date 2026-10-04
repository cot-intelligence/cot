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
              className={`group flex items-center gap-2 font-mono text-label font-semibold uppercase tracking-label transition-colors ${
                reachable ? 'cursor-pointer' : 'cursor-default'
              }`}>
              <span
                className={`flex h-5 w-5 items-center justify-center border text-label tabular-nums transition-colors ${
                  active
                    ? 'border-hot bg-hot text-on-hot'
                    : done
                      ? 'border-line/40 text-fg'
                      : 'border-line/[0.16] text-fg/40'
                }`}>
                {done ? '\u2713' : String(i + 1).padStart(2, '0')}
              </span>
              <span
                className={`hidden sm:inline transition-colors ${
                  active ? 'text-fg' : done ? 'text-fg/60' : 'text-fg/40'
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
