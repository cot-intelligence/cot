import type { Metrics } from './api';
import { getCategoryMeta } from './categoryMeta';
import { compact, formatCost, formatMetricsDay, hourLabel } from './format';
import { formatModel } from './modelMeta';
import { sourceLabel } from './sourceLabels';

/** Logical dimensions of the share card (classic Open Graph 1.91:1). */
export const CARD_W = 1200;
export const CARD_H = 630;

export interface ShareStat {
  /** Stable key used for selection state. */
  key: string;
  label: string;
  /** Pre-formatted display value (already compacted). */
  value: string;
}

export type CardTheme = 'light' | 'dark';

/** A chartable series. `line`/`bars` use `data`; `pie` uses `items`. */
export interface ChartSeries {
  key: string;
  label: string;
  kind: 'line' | 'bars' | 'pie';
  data?: number[];
  /** X-axis captions aligned with `data` points. */
  labels?: string[];
  items?: { name: string; value: number }[];
  /** Centre caption for a pie (e.g. 'models'). */
  unit?: string;
}

export interface CardOptions {
  title: string;
  handle: string;
  theme: CardTheme;
  /** Scalar metrics shown in the bento cells (1–6). */
  stats: ShareStat[];
  /** Left chart — a sequential series rendered as a line. */
  lineSeries: ChartSeries;
  /** Right chart — a distribution rendered as bars or a donut. */
  distSeries: ChartSeries;
}

/** Max stats that lay out cleanly in the bento. */
export const MAX_STATS = 6;


/** Every shareable scalar metric, in menu order. */
export function buildStats(m: Metrics): ShareStat[] {
  const t = m.totals;
  const fun = m.fun;
  const activeDays = m.by_day.length;
  const out: (ShareStat | null)[] = [
    { key: 'sessions', label: 'Sessions', value: compact(t.sessions) },
    { key: 'events', label: 'Events', value: compact(t.events) },
    { key: 'tool_calls', label: 'Tool calls', value: compact(t.tool_calls) },
    { key: 'tokens', label: 'Tokens', value: compact(m.tokens.total) },
    m.cost.total > 0 ? { key: 'cost', label: 'Est. cost', value: formatCost(m.cost.total) } : null,
    { key: 'projects', label: 'Projects', value: compact(t.projects) },
    { key: 'active_days', label: 'Active days', value: String(activeDays) },
    { key: 'files', label: 'Files touched', value: compact(fun.files_touched) },
    { key: 'shell', label: 'Shell commands', value: compact(fun.shell_commands) },
    { key: 'mcp', label: 'MCP calls', value: compact(fun.mcp_calls) },
    { key: 'web', label: 'Web fetches', value: compact(fun.web_calls) },
    { key: 'prompts', label: 'Prompts', value: compact(fun.prompts) },
    { key: 'thoughts', label: 'Thoughts', value: compact(fun.thoughts) },
    fun.top_tool ? { key: 'top_tool', label: 'Favorite tool', value: fun.top_tool } : null,
    fun.peak_hour != null ? { key: 'peak_hour', label: 'Peak hour', value: hourLabel(fun.peak_hour) } : null,
    m.by_model[0]
      ? { key: 'top_model', label: 'Top model', value: formatModel(m.by_model[0].model) }
      : null,
  ];
  return out.filter((s): s is ShareStat => s !== null);
}

/** Default scalar selection — a punchy, broadly-impressive set. */
export const DEFAULT_KEYS = ['sessions', 'events', 'tool_calls', 'tokens', 'files'];

const sum = (a: number[]) => a.reduce((n, v) => n + v, 0);

/**
 * Chartable series, split into pools: `line` (sequential, line-eligible) and
 * `dist` (distributions, bars or donut). Empty series are filtered out.
 */
export function buildChartSeries(m: Metrics): { line: ChartSeries[]; dist: ChartSeries[] } {
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const h of m.by_hour) hourly[h.hour] = h.events;
  const hourLabels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
  const daySlice = m.by_day.slice(-30);
  const daily = daySlice.map((d) => d.events);
  const dayLabels = daySlice.map((d) => formatMetricsDay(d.day));
  const cats = m.by_category.slice(0, 6).map((c) => ({ name: getCategoryMeta(c.category).label, value: c.events }));
  const models = m.by_model.map((x) => ({ name: formatModel(x.model), value: x.events }));
  const sources = m.by_source.map((x) => ({ name: sourceLabel(x.source), value: x.events }));

  const line: ChartSeries[] = ([
    { key: 'line:hour', label: 'By hour', kind: 'line', data: hourly, labels: hourLabels },
    { key: 'line:day', label: 'By day', kind: 'line', data: daily, labels: dayLabels },
  ] as ChartSeries[]).filter((s) => (s.data?.length ?? 0) > 1 && sum(s.data ?? []) > 0);

  const dist: ChartSeries[] = ([
    { key: 'bars:day', label: 'Daily', kind: 'bars', data: daily, labels: dayLabels },
    {
      key: 'bars:cat',
      label: 'Categories',
      kind: 'bars',
      data: cats.map((c) => c.value),
      labels: cats.map((c) => c.name),
    },
    { key: 'pie:models', label: 'Models', kind: 'pie', items: models, unit: 'models' },
    { key: 'pie:source', label: 'Sources', kind: 'pie', items: sources, unit: 'agents' },
  ] as ChartSeries[]).filter((s) =>
    s.kind === 'pie' ? (s.items?.length ?? 0) > 0 : (s.data?.length ?? 0) > 0 && sum(s.data ?? []) > 0,
  );

  return { line, dist };
}

// Signal Forest brand palette (website/.tastemaker/style-lock.md). The card is
// a brand moment, so the accent follows the card's own theme, not the app's:
// forest green on light, lime on dark. Set at the start of each draw.
let HOT = '#0F5B3E';
let COBALT = '#2B5CE6';
const OLIVE_LIGHT = '#4E8C6F';
const OLIVE_DARK = '#8FD3A6';
const MONO = "'Geist Mono', ui-monospace, monospace";
const SANS = "'Geist', system-ui, sans-serif";

interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  fg: string;
  sub: string;
  faint: string;
  hair: string;
  cardLine: string;
  hot: string;
  cobalt: string;
}

function palette(theme: CardTheme): Palette {
  return theme === 'dark'
    ? {
        dark: true,
        bg: '#0A1612',
        surface: '#13261F',
        fg: '#E9F0EA',
        sub: 'rgba(233,240,234,0.6)',
        faint: 'rgba(233,240,234,0.45)',
        hair: 'rgba(233,240,234,0.16)',
        cardLine: 'rgba(233,240,234,0.1)',
        hot: '#C8F169',
        cobalt: '#7FA2F5',
      }
    : {
        dark: false,
        bg: '#F5F6F3',
        surface: '#FFFFFF',
        fg: '#0C1A14',
        sub: 'rgba(12,26,20,0.6)',
        faint: 'rgba(12,26,20,0.5)',
        hair: 'rgba(12,26,20,0.16)',
        cardLine: 'rgba(12,26,20,0.1)',
        hot: '#0F5B3E',
        cobalt: '#2B5CE6',
      };
}

function ls(ctx: CanvasRenderingContext2D, px: number) {
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
  } catch {
    /* no-op */
  }
}






function axisTickIndices(n: number, maxTicks = 5): number[] {
  if (n <= 0) return [];
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  for (let t = 1; t < maxTicks - 1; t++) {
    out.add(Math.round((t * (n - 1)) / (maxTicks - 1)));
  }
  return [...out].sort((a, b) => a - b);
}

function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxW: number, px = 8): string {
  ctx.font = `700 ${px}px ${MONO}`;
  let s = text;
  while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -1);
  if (s !== text && s.length > 1) s = `${s.slice(0, -1)}…`;
  return s;
}

function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  positions: { x: number; text: string }[],
  baselineY: number,
  P: Palette,
) {
  if (!positions.length) return;
  ctx.font = `700 8px ${MONO}`;
  ctx.fillStyle = P.faint;
  ctx.textBaseline = 'top';
  positions.forEach(({ x, text }, i) => {
    if (!text) return;
    // Pin the end labels inside the plot so they don't spill past its edges.
    const last = positions.length - 1;
    ctx.textAlign = last > 0 && i === 0 ? 'left' : last > 0 && i === last ? 'right' : 'center';
    ctx.fillText(text, x, baselineY);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function lineChart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  data: number[],
  color: string,
  P: Palette,
  labels?: string[],
) {
  const labelH = labels?.length ? 16 : 0;
  const plotH = h - labelH;
  const max = Math.max(...data, 1);
  const n = data.length;
  const px = (i: number) => x + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const py = (v: number) => y + plotH - Math.max(0.02, v / max) * plotH;

  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + plotH + 0.5);
  ctx.lineTo(x + w, y + plotH + 0.5);
  ctx.stroke();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const lx = px(n - 1);
  const lyy = py(data[n - 1]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lx, lyy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = P.bg;
  ctx.beginPath();
  ctx.arc(lx, lyy, 1.6, 0, Math.PI * 2);
  ctx.fill();

  if (labels?.length) {
    const ticks = axisTickIndices(n, n > 12 ? 5 : Math.min(n, 6));
    // Each label may use the gap between neighbouring ticks, not one data slot.
    const tickW = (w / Math.max(1, ticks.length - 1)) * 0.9;
    drawAxisLabels(
      ctx,
      ticks.map((i) => ({
        x: px(i),
        text: fitLabel(ctx, labels[i] ?? '', tickW),
      })),
      y + plotH + 4,
      P,
    );
  }
}

function barChart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  data: number[],
  color: string,
  colorSoft: string,
  P: Palette,
  labels?: string[],
) {
  const labelH = labels?.length ? 16 : 0;
  const plotH = h - labelH;
  const max = Math.max(...data, 1);
  const n = data.length || 1;
  const gap = 3;
  const bw = (w - gap * (n - 1)) / n;

  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + plotH + 0.5);
  ctx.lineTo(x + w, y + plotH + 0.5);
  ctx.stroke();

  data.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * plotH);
    const bx = x + i * (bw + gap);
    // Flat fill; the tallest bar gets the full accent, the rest a softer tint.
    ctx.fillStyle = v === max ? color : colorSoft;
    ctx.fillRect(bx, y + plotH - bh, bw, bh);
  });

  if (labels?.length) {
    const ticks = axisTickIndices(n, n > 8 ? 5 : n);
    const tickW = (w / Math.max(1, ticks.length)) * 0.9;
    drawAxisLabels(
      ctx,
      ticks.map((i) => ({
        x: x + i * (bw + gap) + bw / 2,
        text: fitLabel(ctx, labels[i] ?? '', tickW),
      })),
      y + plotH + 4,
      P,
    );
  }
}

/** A distribution as one stacked bar and a legend: easier to read than a donut. */
function stackedShare(
  ctx: CanvasRenderingContext2D,
  slot: { x: number; y: number; w: number; h: number },
  items: { name: string; value: number }[],
  P: Palette,
) {
  const colors = [HOT, COBALT, P.dark ? OLIVE_DARK : OLIVE_LIGHT, P.dark ? 'rgba(233,240,234,0.45)' : 'rgba(12,26,20,0.42)', P.dark ? 'rgba(233,240,234,0.22)' : 'rgba(12,26,20,0.2)'];
  const top = items.slice(0, 4);
  const rest = items.slice(4).reduce((n, it) => n + it.value, 0);
  const parts = rest > 0 ? [...top, { name: 'Other', value: rest }] : top;
  const total = parts.reduce((n, it) => n + it.value, 0) || 1;

  // The bar: flat segments with a 2px gap, rounded ends.
  const barH = 12;
  let bx = slot.x;
  ctx.save();
  roundRect(ctx, slot.x, slot.y, slot.w, barH, barH / 2);
  ctx.clip();
  parts.forEach((it, i) => {
    const w = (it.value / total) * slot.w;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(bx, slot.y, Math.max(0, w - 2), barH);
    bx += w;
  });
  ctx.restore();

  // Legend: two columns of swatch, name, share.
  const rowH = 26;
  const colW = slot.w / 2;
  parts.forEach((it, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const lx = slot.x + col * colW;
    const ly = slot.y + barH + 30 + row * rowH;
    if (ly > slot.y + slot.h) return;
    ctx.fillStyle = colors[i % colors.length];
    roundRect(ctx, lx, ly - 9, 9, 9, 2);
    ctx.fill();
    const pct = `${Math.round((it.value / total) * 100)}%`;
    ctx.font = `500 13px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = P.faint;
    const right = lx + colW - 18;
    ctx.fillText(pct, right, ly);
    const pctW = ctx.measureText(pct).width;
    ctx.textAlign = 'left';
    ctx.font = `500 14px ${SANS}`;
    ctx.fillStyle = P.fg;
    let name = it.name;
    const nameMax = right - pctW - 12 - (lx + 18);
    while (name.length > 1 && ctx.measureText(name).width > nameMax) name = name.slice(0, -1);
    if (name !== it.name) name = `${name.slice(0, -1)}…`;
    ctx.fillText(name, lx + 18, ly);
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** Fit `text` to `maxW` by shrinking the font from `start` to at least `min`. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, start: number, maxW: number, min: number): number {
  let px = start;
  ctx.font = `${weight} ${px}px ${family}`;
  while (px > min && ctx.measureText(text).width > maxW) {
    px -= 1;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

/** Break `text` into at most `maxLines` lines that fit `maxW` (the last one ellipsized). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

function mono(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, px = 12, track = 2) {
  ctx.font = `500 ${px}px ${MONO}`;
  ls(ctx, track);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ls(ctx, 0);
}

/**
 * Draw the share card onto `canvas` at high resolution. Resolves once web
 * fonts are ready so Geist / Geist Mono / Newsreader render in the export too.
 *
 * One hero number with the rest in a hairline-separated row on the left; on the
 * right, one flat panel with the activity line and the breakdown. Flat fills and
 * hairlines only (no textures, glows or gradients), so it reads at a glance in a
 * feed and matches the dashboard.
 */
export async function drawShareCard(canvas: HTMLCanvasElement, opts: CardOptions): Promise<void> {
  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* fall through and draw with whatever is available */
    }
  }
  const scale = 2;
  canvas.width = CARD_W * scale;
  canvas.height = CARD_H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  const P = palette(opts.theme);
  HOT = P.hot;
  COBALT = P.cobalt;
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const M = 64; // outer margin
  const x0 = M;
  const x1 = CARD_W - M;
  const handle = opts.handle.trim();

  // ── Masthead: wordmark + line (left), handle · cot.run (right) ──
  ctx.font = `italic 700 34px 'Newsreader', serif`;
  ctx.fillStyle = P.fg;
  ctx.fillText('cot', x0, 92);
  const cw = ctx.measureText('cot').width;
  ctx.fillStyle = HOT;
  ctx.fillText('.', x0 + cw + 1, 92);
  ctx.font = `400 15px ${SANS}`;
  ctx.fillStyle = P.sub;
  ctx.fillText('Every session, fully traced.', x0 + cw + 22, 89);
  ctx.textAlign = 'right';
  ctx.font = `500 13px ${MONO}`;
  ls(ctx, 1.5);
  ctx.fillStyle = HOT;
  ctx.fillText('COT.RUN', x1, 88);
  const runW = ctx.measureText('COT.RUN').width;
  if (handle) {
    ctx.fillStyle = P.faint;
    ctx.fillText(`${handle.toUpperCase()}  ·`, x1 - runW - 8, 88);
  }
  ls(ctx, 0);
  ctx.textAlign = 'left';
  ctx.fillStyle = P.cardLine;
  ctx.fillRect(x0, 116, x1 - x0, 1);

  // ── Left: title, hero number, the rest ──
  const leftW = 520;
  const stats = opts.stats.slice(0, MAX_STATS);
  const hero = stats[0];
  const rest = stats.slice(1);

  mono(ctx, 'TRACED WITH COT', x0, 168, P.faint, 12, 2.4);
  const titlePx = fitFont(ctx, opts.title || 'My coding footprint', '600', SANS, 40, leftW * 1.6, 30);
  ctx.font = `600 ${titlePx}px ${SANS}`;
  ls(ctx, -0.6);
  ctx.fillStyle = P.fg;
  const titleLines = wrapLines(ctx, opts.title || 'My coding footprint', leftW, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, x0, 214 + i * titlePx * 1.12));
  ls(ctx, 0);

  if (hero) {
    const heroY = 214 + titleLines.length * titlePx * 1.12 + 118;
    const heroPx = fitFont(ctx, hero.value, '600', SANS, 132, leftW, 56);
    ctx.font = `600 ${heroPx}px ${SANS}`;
    ls(ctx, -heroPx * 0.04);
    ctx.fillStyle = P.fg;
    ctx.fillText(hero.value, x0 - heroPx * 0.04, heroY);
    ls(ctx, 0);
    mono(ctx, hero.label.toUpperCase(), x0, heroY + 30, HOT, 13, 2.2);
  }

  if (rest.length) {
    const rowTop = 488;
    const cellW = leftW / rest.length;
    ctx.fillStyle = P.cardLine;
    ctx.fillRect(x0, rowTop, leftW, 1);
    rest.forEach((st, i) => {
      const cx = x0 + i * cellW;
      if (i > 0) {
        ctx.fillStyle = P.cardLine;
        ctx.fillRect(cx, rowTop + 18, 1, 58);
      }
      const pad = i === 0 ? 0 : 18;
      mono(ctx, st.label.toUpperCase(), cx + pad, rowTop + 36, P.faint, 11, 1.6);
      const vPx = fitFont(ctx, st.value, '600', MONO, 30, cellW - pad - 12, 16);
      ctx.font = `600 ${vPx}px ${MONO}`;
      ctx.fillStyle = P.fg;
      ctx.fillText(st.value, cx + pad, rowTop + 74);
    });
  }

  // ── Right: one panel, activity over its breakdown ──
  const panel = { x: x0 + leftW + 48, y: 146, w: 0, h: CARD_H - M - 146 };
  panel.w = x1 - panel.x;
  ctx.fillStyle = P.surface;
  roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 20);
  ctx.fill();
  ctx.strokeStyle = P.cardLine;
  ctx.lineWidth = 1;
  roundRect(ctx, panel.x + 0.5, panel.y + 0.5, panel.w - 1, panel.h - 1, 20);
  ctx.stroke();

  const ip = 28;
  const ix = panel.x + ip;
  const iw = panel.w - ip * 2;

  const lineS = opts.lineSeries;
  const data = lineS.data ?? [0];
  mono(ctx, `ACTIVITY · ${lineS.label.toUpperCase()}`, ix, panel.y + 40, P.sub, 11, 2);
  ctx.textAlign = 'right';
  mono(ctx, `PEAK ${compact(Math.max(...data, 0))}`, ix + iw, panel.y + 40, P.faint, 11, 1.6);
  ctx.textAlign = 'left';
  const plot = { x: ix, y: panel.y + 60, w: iw, h: 140 };
  // A flat tint under the line (no gradient), then the line itself.
  const maxV = Math.max(...data, 1);
  const n = data.length;
  const px = (i: number) => plot.x + (n <= 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
  const py = (v: number) => plot.y + plot.h - 16 - Math.max(0.02, v / maxV) * (plot.h - 16);
  ctx.beginPath();
  ctx.moveTo(px(0), plot.y + plot.h - 16);
  data.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(n - 1), plot.y + plot.h - 16);
  ctx.closePath();
  ctx.fillStyle = P.dark ? 'rgba(200,241,105,0.10)' : 'rgba(15,91,62,0.08)';
  ctx.fill();
  lineChart(ctx, plot.x, plot.y, plot.w, plot.h, data, HOT, P, lineS.labels);

  const divY = plot.y + plot.h + 22;
  ctx.fillStyle = P.cardLine;
  ctx.fillRect(ix, divY, iw, 1);

  const distS = opts.distSeries;
  mono(ctx, distS.label.toUpperCase(), ix, divY + 36, P.sub, 11, 2);
  const slot = { x: ix, y: divY + 54, w: iw, h: panel.y + panel.h - (divY + 54) - 24 };
  if (distS.kind === 'pie' && distS.items?.length) {
    stackedShare(ctx, slot, distS.items, P);
  } else {
    barChart(ctx, slot.x, slot.y, slot.w, slot.h, distS.data ?? [], COBALT, P.dark ? 'rgba(127,162,245,0.45)' : 'rgba(43,92,230,0.42)', P, distS.labels);
  }
}

/** Compose the share copy from the headline + selected stats + cot tagline. */
export type SharePlatform = 'x' | 'linkedin';

const SHARE_HOOKS = [
  'The agents have been putting in work.',
  'Checked my coding footprint — worth sharing.',
  'This is what my AI workflow actually looks like.',
  'Another week in the traces.',
  'Ship mode: quantified.',
];

const COT_TAGLINES = [
  'Every prompt, every tool call — still on your machine. cot.run',
  'Your agents leave footprints. cot keeps them local. cot.run',
  'Like a flight recorder, but for Claude, Cursor, and Codex. cot.run',
  'See everything your coding agents did. Nothing leaves your laptop. cot.run',
  'Hooks in, traces out. All local. cot.run',
  'Who ran what, when, and how much it cost — on your machine. cot.run',
  'Agent observability without the SaaS bill. cot.run',
  'Your Claude, Cursor, and Codex sessions — finally in one place. cot.run',
  'Prompts, tools, tokens, timelines — traced locally. cot.run',
  'Know what your agents actually did today. cot.run',
  'Spoiler: your traces never left localhost. cot.run',
  'If it happened in your IDE, cot probably caught it. cot.run',
  'Turn agent chaos into a readable timeline. cot.run',
  'Ship faster, debug smarter, keep the receipts local. cot.run',
  'The dashboard for people who code with agents daily. cot.run',
  'Self-hosted observability — your traces, your SQLite, your rules. cot.run',
  'Every session traced. Zero cloud required. cot.run',
  'What if you could replay your agent’s whole day? cot.run',
];

function shareSeed(opts: CardOptions): number {
  let n = opts.title.length;
  for (const s of opts.stats) n += s.key.length + s.value.length;
  return Math.abs(n);
}

function truncateShareText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function buildShareText(opts: CardOptions, platform: SharePlatform = 'x'): string {
  const seed = shareSeed(opts);
  const customTitle = opts.title.trim();
  const hook =
    customTitle && customTitle.toLowerCase() !== 'my coding footprint'
      ? customTitle
      : SHARE_HOOKS[seed % SHARE_HOOKS.length];
  const tagline = COT_TAGLINES[seed % COT_TAGLINES.length];
  const limit = platform === 'x' ? 270 : 2800;

  for (let count = Math.min(opts.stats.length, 4); count >= 1; count--) {
    const highlights = opts.stats
      .slice(0, count)
      .map((s) => `${s.value} ${s.label.toLowerCase()}`)
      .join(' · ');
    const body = [hook, highlights, tagline].filter(Boolean).join('\n\n');
    if (body.length <= limit) return body;
  }
  return truncateShareText([hook, tagline].join('\n\n'), limit);
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** Copy PNG to clipboard. Starts write synchronously so the user-gesture is preserved. */
export async function copyCanvasImage(canvas: HTMLCanvasElement): Promise<boolean> {
  if (!navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': canvasPngBlob(canvas) }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Copy PNG + caption. Falls back to image-only if the browser rejects multi-type clipboards. */
export async function copyCanvasSharePayload(
  canvas: HTMLCanvasElement,
  text: string,
): Promise<boolean> {
  if (!navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': canvasPngBlob(canvas),
        'text/plain': Promise.resolve(new Blob([text], { type: 'text/plain' })),
      }),
    ]);
    return true;
  } catch {
    return copyCanvasImage(canvas);
  }
}
