import { getStats, type Stats } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { formatDuration } from '../../lib/categoryMeta';
import { sourceLabel } from '../../lib/sourceLabels';

function StatCard({
  label,
  value,
  hint,
  accent = false,
  className = '',
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={`bg-surface px-4 py-4 ${className}`}>
      <p className="eyebrow">{label}</p>
      <p
        className="mt-1.5 flex items-center gap-2 font-mono text-xl font-semibold leading-tight tracking-[-0.02em] tabular-nums text-fg">
        {accent && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-signal" aria-hidden="true" />}
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint && (
        <p className="mt-1 truncate font-mono text-data text-fg/60" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function TelemetryPanel() {
  const { data: stats } = usePolling<Stats>(['stats'], () => getStats(), 3000);

  const sourceHint = stats
    ? Object.entries(stats.by_source)
        .map(([s, n]) => `${sourceLabel(s)} ${n}`)
        .join(' · ')
    : undefined;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line/10 bg-line/10 lg:grid-cols-5">
      <StatCard
        label="Sessions"
        value={stats?.sessions ?? '—'}
        hint={sourceHint || undefined}
      />
      <StatCard
        label="Active now"
        value={stats?.active_sessions ?? '—'}
        accent={(stats?.active_sessions ?? 0) > 0}
        hint={stats ? `${stats.by_status?.completed ?? 0} completed` : undefined}
      />
      <StatCard label="Events" value={stats?.events ?? '—'} />
      <StatCard label="Tool calls" value={stats?.tool_calls ?? '—'} />
      <StatCard
        className="col-span-2 lg:col-span-1"
        label="Avg duration"
        value={stats ? formatDuration(null, stats.avg_duration_seconds) : '—'}
      />
    </div>
  );
}
