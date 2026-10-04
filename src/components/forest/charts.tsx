import { motion, useInView, useReducedMotion } from 'framer-motion';
import { useId, useRef, useState } from 'react';
import { EASE_IN_OUT, EASE_OUT, intro } from './motion';

/** Line sparkline. Draws itself in once; flat stroke, no fill gradients. */
export function Sparkline({ values, width = 120, height = 32, stroke = 'currentColor', strokeWidth = 1.5, fill }: {
  values: number[]; width?: number; height?: number; stroke?: string; strokeWidth?: number; fill?: string;
}) {
  const [first] = useState(intro);
  const rm = useReducedMotion();
  const reduce = !first || rm;
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref, { once: true });
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * width, height - 2 - (v / max) * (height - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <svg ref={ref} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
      {fill && <path d={`${d} L${width},${height} L0,${height} Z`} fill={fill} />}
      <motion.path
        d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round"
        initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: seen || reduce ? 1 : 0 }}
        transition={{ duration: 1, ease: EASE_OUT }}
      />
    </svg>
  );
}

/** Column chart with hover readout. Columns rise in once with a short stagger. */
export function Columns({ data, height = 140, color = 'currentColor', muted, label, format, highlight }: {
  data: { key: string; value: number }[];
  height?: number;
  color?: string;
  muted?: string;
  label: (key: string) => string;
  format: (v: number) => string;
  highlight?: (key: string) => boolean;
}) {
  const [first] = useState(intro);
  const rm = useReducedMotion();
  const reduce = !first || rm;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  const active = hover ?? data.length - 1;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <div aria-live="polite" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8, opacity: 0.85 }}>
        <span className="mono">{label(data[active]?.key ?? '')}</span>
        <span className="mono tnum">{format(data[active]?.value ?? 0)}</span>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${data.length * 10} ${height}`} preserveAspectRatio="none" role="img" aria-labelledby={id} onMouseLeave={() => setHover(null)}>
        <title id={id}>Column chart, {data.length} points</title>
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (height - 4));
          const on = hover === i || (highlight?.(d.key) ?? false);
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)}>
              <rect x={i * 10} y={0} width={10} height={height} fill="transparent" />
              <motion.rect
                x={i * 10 + 1.5} width={7} y={height - h} height={h} rx={1.5}
                fill={on || hover == null ? color : muted ?? color}
                style={{ transformOrigin: `0px ${height}px`, transformBox: 'view-box' }}
                initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: seen || reduce ? 1 : 0 }}
                transition={{ duration: 0.6, delay: i * 0.012, ease: EASE_OUT }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Horizontal share bars: label, value, a flat proportional bar. */
export function ShareBars({ rows, color = 'currentColor', track, format }: {
  rows: { label: React.ReactNode; value: number; key: string; color?: string }[];
  color?: string; track: string; format: (v: number) => string;
}) {
  const [first] = useState(intro);
  const reduce = useReducedMotion();
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  const ref = useRef<HTMLUListElement>(null);
  const seen = useInView(ref, { once: true });
  const grow = first && !reduce;
  const seenOnce = useRef(!grow);
  return (
    <ul ref={ref} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
      {rows.map((r, i) => (
        <li key={r.key}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, marginBottom: 5 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            <span className="mono tnum" style={{ opacity: 0.8 }}>{format(r.value)}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: track, overflow: 'hidden' }}>
            <motion.div
              style={{ height: '100%', width: '100%', background: r.color ?? color, borderRadius: 3, transformOrigin: 'left' }}
              initial={grow ? { scaleX: 0 } : false} animate={{ scaleX: seen || !grow ? r.value / max : 0 }}
              transition={grow && !seenOnce.current ? { duration: 0.7, delay: i * 0.05, ease: EASE_OUT } : { duration: 0.3, ease: EASE_IN_OUT }}
              onAnimationComplete={() => { seenOnce.current = true; }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One stacked bar split into segments (e.g. agent mix). */
export function StackBar({ parts, height = 8, gap = 2 }: { parts: { key: string; value: number; color: string }[]; height?: number; gap?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div style={{ display: 'flex', gap, height }}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <div key={p.key} title={`${p.key}: ${p.value}`} style={{ flex: p.value / total, background: p.color, borderRadius: 2 }} />
      ))}
    </div>
  );
}
