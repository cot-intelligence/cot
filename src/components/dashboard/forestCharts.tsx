import { useId, useState, type ReactNode } from 'react';

/** Flat line sparkline: no fill, no gradient. Colour comes from `currentColor`. */
export function Sparkline({ values, width = 72, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block shrink-0 overflow-visible">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Column chart with a hover readout. Defaults to the latest point. No entrance animation: it's opened many times a day. */
export function Columns({
  data,
  height = 180,
  label,
  format,
}: {
  data: { key: string; value: number }[];
  height?: number;
  label: (key: string) => string;
  format: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const active = hover ?? data.length - 1;
  return (
    <div>
      <div aria-live="polite" className="mb-2 flex justify-between font-mono text-code text-fg/80">
        <span>{data[active] ? label(data[active].key) : ''}</span>
        <span className="tabular-nums">{format(data[active]?.value ?? 0)}</span>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${data.length * 10} ${height}`} preserveAspectRatio="none" role="img" aria-labelledby={id} onMouseLeave={() => setHover(null)}>
        <title id={id}>Column chart, {data.length} points</title>
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (height - 4));
          const dim = hover != null && hover !== i;
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)}>
              <rect x={i * 10} y={0} width={10} height={height} fill="transparent" />
              <rect x={i * 10 + 1.5} width={7} y={height - h} height={h} rx={1.5} className={dim ? 'fill-fg/[0.16]' : 'fill-hot'} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Label, value and a flat proportional bar per row. */
export function ShareBars({ rows, format }: { rows: { key: string; label: ReactNode; value: number; tone?: string }[]; format: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="grid gap-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1.5 flex justify-between gap-3 text-small">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="font-mono text-code tabular-nums text-fg/80">{format(r.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel">
            <div className={`h-full origin-left rounded-full ${r.tone ?? 'bg-hot'}`} style={{ transform: `scaleX(${r.value / max})` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One bar split into segments, e.g. the agent mix of a project. */
export function StackBar({ parts }: { parts: { key: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="flex h-2 gap-0.5">
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div key={p.key} title={`${p.key}: ${p.value}`} className="rounded-[2px]" style={{ flex: p.value / total, background: p.color }} />
        ))}
    </div>
  );
}

/** Agent colours on the forest palette; unknown agents fall back to a quiet ink. */
export const AGENT_COLOR: Record<string, string> = {
  claude: '#d97757',
  cursor: 'rgb(var(--fg))',
  codex: 'rgb(var(--olive))',
  cowork: 'rgb(var(--cobalt))',
};
export const agentColor = (id: string) => AGENT_COLOR[id] ?? 'rgb(var(--fg) / 0.4)';
