// Recharts wrappers themed to the platform's neo-brutalist language:
// hard-edged tooltips, mono axes, brand colors. All interactive (hover/tooltip).
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_COLORS, type Datum } from './chartConstants';

export type { Datum };

const AXIS = 'rgb(var(--fg) / 0.4)';
const GRID = 'rgb(var(--fg) / 0.07)';
const MONO = 'JetBrains Mono, monospace';

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function BrutalTooltip({ active, payload, label, unit = 'events' }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-fg bg-surface px-2.5 py-1.5 font-mono text-[0.6rem] shadow-brutal-sm">
      {label != null && label !== '' && (
        <p className="mb-0.5 font-bold uppercase tracking-widest text-fg/60">{label}</p>
      )}
      {payload.map((p: any, i: number) => (
        <p key={i} className="flex items-center gap-1.5 text-fg">
          <span
            className="inline-block h-2 w-2"
            style={{ background: p.payload?.color || p.color || p.fill }}
          />
          <span className="tabular-nums font-bold">{Number(p.value).toLocaleString()}</span>
          <span className="text-fg/45">{p.name || unit}</span>
        </p>
      ))}
    </div>
  );
}

const CURSOR = { fill: 'rgb(var(--fg) / 0.06)' };

export function DailyArea({ data }: { data: { day: string; events: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="cot-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2B5CE6" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#2B5CE6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="day"
          tick={{ fill: AXIS, fontSize: 9, fontFamily: MONO }}
          tickFormatter={(d: string) => d.slice(5)}
          axisLine={{ stroke: AXIS }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis hide />
        <Tooltip content={<BrutalTooltip />} cursor={CURSOR} />
        <Area
          type="monotone"
          dataKey="events"
          name="events"
          stroke="#2B5CE6"
          strokeWidth={2}
          fill="url(#cot-grad)"
          activeDot={{ r: 4, fill: '#2B5CE6', stroke: 'rgb(var(--bg))', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AreaTrend({ data, height = 120 }: { data: { label: string; value: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="cot-trend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2B5CE6" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#2B5CE6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="label"
          tick={{ fill: AXIS, fontSize: 9, fontFamily: MONO }}
          axisLine={{ stroke: AXIS }}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis hide />
        <Tooltip content={<BrutalTooltip />} cursor={CURSOR} />
        <Area
          type="monotone"
          dataKey="value"
          name="events"
          stroke="#2B5CE6"
          strokeWidth={2}
          fill="url(#cot-trend)"
          activeDot={{ r: 3.5, fill: '#2B5CE6', stroke: 'rgb(var(--bg))', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function HourBars({ data, peak }: { data: { hour: number; events: number }[]; peak: number | null }) {
  const byHour = new Map(data.map((d) => [d.hour, d.events]));
  const filled = Array.from({ length: 24 }, (_, h) => ({
    name: `${h}:00`,
    hour: h,
    value: byHour.get(h) ?? 0,
  }));
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={filled} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="hour"
          tick={{ fill: AXIS, fontSize: 9, fontFamily: MONO }}
          tickFormatter={(h: number) => (h % 6 === 0 ? `${h}` : '')}
          axisLine={{ stroke: AXIS }}
          tickLine={false}
          interval={0}
        />
        <YAxis hide />
        <Tooltip content={<BrutalTooltip />} cursor={CURSOR} />
        <Bar dataKey="value" name="events" radius={[2, 2, 0, 0]}>
          {filled.map((d) => (
            <Cell key={d.hour} fill={d.hour === peak ? '#FF4500' : '#2B5CE6'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function HBars({ data, height = 200 }: { data: Datum[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={96}
          tick={{ fill: AXIS, fontSize: 10, fontFamily: MONO }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<BrutalTooltip />} cursor={CURSOR} />
        <Bar dataKey="value" name="events" radius={[0, 3, 3, 0]}>
          {data.map((d, i) => (
            <Cell key={d.name} fill={d.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => compact(v)}
            style={{ fill: AXIS, fontFamily: MONO, fontSize: 10 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({
  data,
  centerLabel,
  centerSub,
}: {
  data: Datum[];
  centerLabel?: string;
  centerSub?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Tooltip content={<BrutalTooltip />} />
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={48}
          outerRadius={72}
          paddingAngle={2}
          stroke="rgb(var(--bg))"
          strokeWidth={2}>
          {data.map((d, i) => (
            <Cell key={d.name} fill={d.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        {centerLabel && (
          <text x="50%" y="48%" textAnchor="middle" className="fill-fg font-mono text-lg font-bold">
            {centerLabel}
          </text>
        )}
        {centerSub && (
          <text
            x="50%"
            y="59%"
            textAnchor="middle"
            className="fill-fg/45 font-mono"
            style={{ fontSize: 9, letterSpacing: 1 }}>
            {centerSub}
          </text>
        )}
      </PieChart>
    </ResponsiveContainer>
  );
}
