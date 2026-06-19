import { FadeIn } from '../ui/FadeIn';
import { SessionsTable } from './SessionsTable';
import { TelemetryPanel } from './TelemetryPanel';

interface DashboardHomeProps {
  onSelect: (id: string) => void;
}

export function DashboardHome({ onSelect }: DashboardHomeProps) {
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-10 px-6 py-10 sm:px-8">
        <FadeIn className="space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-3xl font-extrabold uppercase tracking-tight text-fg">
              Session{' '}
              <span className="font-serif lowercase italic text-vermilion">telemetry</span>
            </h1>
            <p className="font-mono text-sm text-fg/50">
              Live overview of every traced agent session.
            </p>
          </div>
          <TelemetryPanel />
        </FadeIn>

        <FadeIn delay={0.05} className="space-y-4">
          <h2 className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/45">
            Sessions
          </h2>
          <SessionsTable onSelect={onSelect} />
        </FadeIn>
      </div>
    </div>
  );
}
