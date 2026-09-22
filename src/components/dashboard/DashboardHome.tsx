import { FadeIn } from '../ui/FadeIn';
import { PageHeader } from '../ui/PageHeader';
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
          <PageHeader
            eyebrow="Telemetry"
            title="Sessions"
            description="Every traced agent session, live as it happens."
          />
          <TelemetryPanel />
        </FadeIn>

        <FadeIn delay={0.05} className="space-y-4">
          <h2 className="eyebrow">All sessions</h2>
          <SessionsTable onSelect={onSelect} />
        </FadeIn>
      </div>
    </div>
  );
}
