import { useEffect, useState } from 'react';
import { getStats, type Stats } from '../../lib/api';
import { formatDuration } from '../../lib/categoryMeta';
import { sourceLabel } from '../../lib/sourceLabels';

function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-bg px-4 py-3.5">
      <p className="font-mono text-[0.58rem] uppercase tracking-widest text-fg/40">{label}</p>
      <p
        className={`mt-1 font-mono text-lg font-bold leading-tight tabular-nums ${
          accent ? 'text-vermilion' : 'text-fg'
        }`}>
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 truncate font-mono text-[0.55rem] text-fg/40" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function TelemetryPanel() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getStats();
        if (active) setStats(data);
      } catch {
        /* collector offline */
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

  const sourceHint = stats
    ? Object.entries(stats.by_source)
        .map(([s, n]) => `${sourceLabel(s)} ${n}`)
        .join(' · ')
    : undefined;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden border border-fg/15 bg-fg/10 sm:grid-cols-3 lg:grid-cols-5">
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
        label="Avg duration"
        value={stats ? formatDuration(null, stats.avg_duration_seconds) : '—'}
      />
    </div>
  );
}
