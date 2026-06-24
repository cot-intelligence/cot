// GitHub-style daily contribution heatmap. (Other charts use Recharts via
// chartTheme.tsx; this stays custom since Recharts has no calendar heatmap.)

import { formatMetricsDay } from '../../lib/format';

const HEAT_LEVELS = [
  'bg-fg/[0.07]',
  'bg-vermilion/25',
  'bg-vermilion/50',
  'bg-vermilion/75',
  'bg-vermilion',
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function ContributionHeatmap({
  data,
  weeks = 53,
}: {
  data: { label: string; value: number }[];
  weeks?: number;
}) {
  const counts = new Map(data.map((d) => [d.label, d.value]));
  const max = Math.max(1, ...data.map((d) => d.value));
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const columns: ({ key: string; count: number; date: Date } | null)[][] = [];
  const cur = new Date(start);
  while (cur <= today) {
    const col: ({ key: string; count: number; date: Date } | null)[] = [];
    for (let i = 0; i < 7; i++) {
      if (cur > today) {
        col.push(null);
      } else {
        const key = localISO(cur);
        col.push({ key, count: counts.get(key) ?? 0, date: new Date(cur) });
      }
      cur.setDate(cur.getDate() + 1);
    }
    columns.push(col);
  }

  const level = (c: number) =>
    c === 0 ? 0 : c <= max * 0.25 ? 1 : c <= max * 0.5 ? 2 : c <= max * 0.75 ? 3 : 4;

  let lastMonth = -1;
  const monthLabels = columns.map((col) => {
    const first = col.find((c) => c)?.date;
    if (first && first.getDate() <= 7 && first.getMonth() !== lastMonth) {
      lastMonth = first.getMonth();
      return MONTHS[first.getMonth()];
    }
    return '';
  });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-[2px]">
          {monthLabels.map((label, i) => (
            <span
              key={i}
              className="min-w-0 flex-1 font-mono text-[0.5rem] text-fg/40"
              style={{ overflow: 'visible', whiteSpace: 'nowrap' }}>
              {label}
            </span>
          ))}
        </div>
        <div className="flex gap-[2px]">
          {columns.map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-[2px]">
              {col.map((cell, ri) =>
                cell ? (
                  <span
                    key={ri}
                    title={`${formatMetricsDay(cell.key)}: ${cell.count.toLocaleString()} events`}
                    className={`aspect-square rounded-[2px] ${HEAT_LEVELS[level(cell.count)]} ${
                      cell.count ? 'ring-1 ring-inset ring-vermilion/10' : ''
                    }`}
                  />
                ) : (
                  <span key={ri} className="aspect-square" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 font-mono text-[0.5rem] uppercase tracking-widest text-fg/40">
        Less
        {HEAT_LEVELS.map((l, i) => (
          <span key={i} className={`h-2.5 w-2.5 rounded-[2px] ${l}`} />
        ))}
        More
      </div>
    </div>
  );
}
