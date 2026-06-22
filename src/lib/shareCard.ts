import type { Metrics } from './api';
import { getCategoryMeta } from './categoryMeta';
import { compact, hourLabel } from './format';
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
  const daily = m.by_day.slice(-30).map((d) => d.events);
  const cats = m.by_category.slice(0, 6).map((c) => ({ name: getCategoryMeta(c.category).label, value: c.events }));
  const models = m.by_model.map((x) => ({ name: formatModel(x.model), value: x.events }));
  const sources = m.by_source.map((x) => ({ name: sourceLabel(x.source), value: x.events }));

  const line: ChartSeries[] = ([
    { key: 'line:hour', label: 'By hour', kind: 'line', data: hourly },
    { key: 'line:day', label: 'By day', kind: 'line', data: daily },
  ] as ChartSeries[]).filter((s) => (s.data?.length ?? 0) > 1 && sum(s.data ?? []) > 0);

  const dist: ChartSeries[] = ([
    { key: 'bars:day', label: 'Daily', kind: 'bars', data: daily },
    { key: 'bars:cat', label: 'Categories', kind: 'bars', data: cats.map((c) => c.value) },
    { key: 'pie:models', label: 'Models', kind: 'pie', items: models, unit: 'models' },
    { key: 'pie:source', label: 'Sources', kind: 'pie', items: sources, unit: 'agents' },
  ] as ChartSeries[]).filter((s) =>
    s.kind === 'pie' ? (s.items?.length ?? 0) > 0 : (s.data?.length ?? 0) > 0 && sum(s.data ?? []) > 0,
  );

  return { line, dist };
}

// Brand palette — lifted straight from the website's Tailwind config.
const VERMILION = '#FF4500';
const COBALT = '#2B5CE6';
const OLIVE = '#3A4D39';
const CREAM = '#F4F0EA';
const SURFACE = '#FBFAF7';
const INK = '#111111';

interface Palette {
  dark: boolean;
  bg: string;
  surface: string;
  fg: string;
  sub: string;
  faint: string;
  hair: string;
  cardLine: string;
  grid: string;
  bracket: string;
  crossInk: string;
  glowV: number;
  glowC: number;
}

function palette(theme: CardTheme): Palette {
  return theme === 'dark'
    ? {
        dark: true,
        bg: '#141517',
        surface: '#0C0D0E',
        fg: CREAM,
        sub: 'rgba(244,240,234,0.55)',
        faint: 'rgba(244,240,234,0.42)',
        hair: 'rgba(244,240,234,0.16)',
        cardLine: 'rgba(244,240,234,0.14)',
        grid: 'rgba(244,240,234,0.045)',
        bracket: 'rgba(244,240,234,0.3)',
        crossInk: 'rgba(244,240,234,0.3)',
        glowV: 0.26,
        glowC: 0.3,
      }
    : {
        dark: false,
        bg: CREAM,
        surface: SURFACE,
        fg: INK,
        sub: 'rgba(17,17,17,0.55)',
        faint: 'rgba(17,17,17,0.5)',
        hair: 'rgba(17,17,17,0.16)',
        cardLine: 'rgba(17,17,17,0.12)',
        grid: 'rgba(17,17,17,0.04)',
        bracket: 'rgba(17,17,17,0.28)',
        crossInk: 'rgba(17,17,17,0.25)',
        glowV: 0.2,
        glowC: 0.16,
      };
}

function ls(ctx: CanvasRenderingContext2D, px: number) {
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
  } catch {
    /* no-op */
  }
}

function fitMono(ctx: CanvasRenderingContext2D, t: string, start: number, maxW: number, min = 14) {
  let px = start;
  while (px > min) {
    ctx.font = `800 ${px}px 'JetBrains Mono', monospace`;
    if (ctx.measureText(t).width <= maxW) break;
    px -= 1;
  }
  return px;
}

function accentWords(title: string) {
  const raw = title.trim().split(/\s+/).filter(Boolean);
  const words = raw.length ? raw : ['metrics'];
  const lead = words.slice(0, -1).join(' ').toUpperCase();
  const accent = words[words.length - 1].toLowerCase();
  return { lead, accent };
}

function bracket(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  len: number,
  w: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x + dx * len, y);
  ctx.lineTo(x, y);
  ctx.lineTo(x, y + dy * len);
  ctx.stroke();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, w: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
}

function chartLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  right: number,
  label: string,
  meta: string,
  accent: string,
  P: Palette,
) {
  ctx.font = `700 11px 'JetBrains Mono', monospace`;
  ls(ctx, 2.5);
  ctx.textAlign = 'left';
  ctx.fillStyle = P.sub;
  ctx.fillText(label, x, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  ctx.fillText(meta, right, y);
  ctx.textAlign = 'left';
  ls(ctx, 0);
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
) {
  const max = Math.max(...data, 1);
  const n = data.length;
  const px = (i: number) => x + (n <= 1 ? 0 : (i / (n - 1)) * w);
  const py = (v: number) => y + h - Math.max(0.02, v / max) * h;

  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + h + 0.5);
  ctx.lineTo(x + w, y + h + 0.5);
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
) {
  const max = Math.max(...data, 1);
  const n = data.length || 1;
  const gap = 3;
  const bw = (w - gap * (n - 1)) / n;

  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + h + 0.5);
  ctx.lineTo(x + w, y + h + 0.5);
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, color);
  grad.addColorStop(1, colorSoft);
  data.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * h);
    const bx = x + i * (bw + gap);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, y + h - bh, bw, bh);
  });
}

/** Donut chart + legend for a categorical breakdown. */
function donutChart(
  ctx: CanvasRenderingContext2D,
  slot: { x: number; y: number; w: number; h: number },
  items: { name: string; value: number }[],
  unit: string,
  P: Palette,
) {
  const total = items.reduce((n, it) => n + it.value, 0) || 1;
  const colors = [
    VERMILION,
    COBALT,
    OLIVE,
    P.dark ? 'rgba(244,240,234,0.5)' : 'rgba(17,17,17,0.5)',
    P.dark ? 'rgba(244,240,234,0.28)' : 'rgba(17,17,17,0.28)',
  ];
  const top = items.slice(0, 5);

  const r = Math.min(slot.h / 2, 54);
  const cx = slot.x + r + 2;
  const cy = slot.y + slot.h / 2;
  const th = r * 0.42;
  const rr = r - th / 2;

  let a = -Math.PI / 2;
  top.forEach((it, i) => {
    const sweep = (it.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, a + 0.03, a + sweep - 0.03);
    ctx.strokeStyle = colors[i % colors.length];
    ctx.lineWidth = th;
    ctx.lineCap = 'butt';
    ctx.stroke();
    a += sweep;
  });

  // Centre: count + unit.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 22px 'JetBrains Mono', monospace`;
  ctx.fillStyle = P.fg;
  ctx.fillText(String(items.length), cx, cy - 4);
  ctx.font = `700 8px 'JetBrains Mono', monospace`;
  ls(ctx, 2);
  ctx.fillStyle = P.faint;
  ctx.fillText(unit.toUpperCase(), cx, cy + 12);
  ls(ctx, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Legend.
  const lx = cx + r + 22;
  const lRight = slot.x + slot.w;
  const rowH = Math.min(20, slot.h / top.length);
  top.forEach((it, i) => {
    const ly = slot.y + rowH * (i + 0.5) + 4;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, ly - 9, 9, 9);
    ctx.font = `700 11px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = P.faint;
    const pct = `${Math.round((it.value / total) * 100)}%`;
    ctx.fillText(pct, lRight, ly);
    const pctW = ctx.measureText(pct).width;
    ctx.textAlign = 'left';
    ctx.fillStyle = P.sub;
    let name = it.name;
    const nameMax = lRight - (lx + 16) - pctW - 12;
    while (name.length > 1 && ctx.measureText(name).width > nameMax) name = name.slice(0, -1);
    if (name !== it.name) name = name.slice(0, -1) + '…';
    ctx.fillText(name, lx + 16, ly);
  });
}

/** Column/row split for the metrics bento, minimising empty cells. */
function gridDims(n: number): [number, number] {
  if (n <= 1) return [1, 1];
  if (n === 2) return [2, 1];
  if (n === 3) return [3, 1];
  if (n === 4) return [2, 2];
  return [3, 2];
}

/**
 * Draw the share card onto `canvas` at high resolution. Resolves once web
 * fonts are ready so JetBrains Mono / Newsreader render in the export too.
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

  // ── Background + colour pops in opposite corners ──
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const popV = ctx.createRadialGradient(40, 40, 0, 40, 40, 560);
  popV.addColorStop(0, `rgba(255,69,0,${P.glowV})`);
  popV.addColorStop(1, 'rgba(255,69,0,0)');
  ctx.fillStyle = popV;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const popC = ctx.createRadialGradient(CARD_W - 40, CARD_H - 40, 0, CARD_W - 40, CARD_H - 40, 560);
  popC.addColorStop(0, `rgba(43,92,230,${P.glowC})`);
  popC.addColorStop(1, 'rgba(43,92,230,0)');
  ctx.fillStyle = popC;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Faint grid texture.
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 0; gx <= CARD_W; gx += 48) {
    ctx.moveTo(gx + 0.5, 0);
    ctx.lineTo(gx + 0.5, CARD_H);
  }
  for (let gy = 0; gy <= CARD_H; gy += 48) {
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(CARD_W, gy + 0.5);
  }
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';

  // ── Frame + corner marks ──
  const CM = 52;
  const cR = CARD_W - CM;
  const cB = CARD_H - CM;
  bracket(ctx, CM, CM, 1, 1, 26, 2, P.bracket);
  bracket(ctx, cR, CM, -1, 1, 26, 2, P.bracket);
  bracket(ctx, CM, cB, 1, -1, 26, 2, P.bracket);
  bracket(ctx, cR, cB, -1, -1, 26, 2, P.bracket);
  cross(ctx, CARD_W / 2, CM, 6, 1.5, 'rgba(255,69,0,0.6)');
  cross(ctx, CARD_W / 2, cB, 6, 1.5, 'rgba(43,92,230,0.6)');
  ctx.strokeStyle = P.bracket;
  ctx.lineWidth = 1;
  for (let tx = CM + 60; tx < cR - 60; tx += 40) {
    ctx.beginPath();
    ctx.moveTo(tx, CM);
    ctx.lineTo(tx, CM + 6);
    ctx.stroke();
  }

  // ── Layout ──
  const pad = 22;
  const x0 = CM + pad;
  const y0 = CM + pad;
  const x1 = cR - pad;
  const y1 = cB - pad;
  const leftW = 432;
  const gap = 34;
  const rx0 = x0 + leftW + gap;
  const rw = x1 - rx0;

  // ── Masthead: cot. + tagline (left) · cot.run (right) ──
  const { lead, accent } = accentWords(opts.title);
  const handle = opts.handle.trim();

  ctx.font = `italic 800 40px 'Newsreader', serif`;
  ctx.fillStyle = P.fg;
  ctx.fillText('cot', x0, y0 + 38);
  const cw = ctx.measureText('cot').width;
  ctx.fillStyle = VERMILION;
  ctx.fillText('.', x0 + cw + 2, y0 + 38);
  ctx.font = `italic 400 18px 'Newsreader', serif`;
  ctx.fillStyle = P.sub;
  ctx.fillText('Every session, fully traced.', x0 + cw + 24, y0 + 36);

  ctx.font = `700 12px 'JetBrains Mono', monospace`;
  ls(ctx, 2.5);
  ctx.textAlign = 'right';
  ctx.fillStyle = VERMILION;
  ctx.fillText('COT.RUN', x1, y0 + 34);
  ctx.textAlign = 'left';
  ls(ctx, 0);

  const headBand = y0 + 60;
  ctx.fillStyle = P.cardLine;
  ctx.fillRect(x0, headBand, x1 - x0, 1);

  const rowTop = headBand + 28;
  const rowBottom = y1;
  const topH = 226;
  const chartsTop = rowTop + topH + 26;

  // ── Neo-brutalist title card with background design ──
  const card = { x: x0, y: rowTop, w: leftW, h: topH };
  const SH = 9;
  ctx.fillStyle = VERMILION;
  ctx.fillRect(card.x + SH, card.y + SH, card.w, card.h);
  ctx.fillStyle = P.surface;
  ctx.fillRect(card.x, card.y, card.w, card.h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(card.x + 3, card.y + 3, card.w - 6, card.h - 6);
  ctx.clip();
  ctx.fillStyle = P.dark ? 'rgba(244,240,234,0.055)' : 'rgba(17,17,17,0.05)';
  for (let dy = card.y + 16; dy < card.y + card.h - 6; dy += 19) {
    for (let dx = card.x + 16; dx < card.x + card.w - 6; dx += 19) {
      ctx.fillRect(dx, dy, 1.5, 1.5);
    }
  }
  ctx.strokeStyle = 'rgba(255,69,0,0.12)';
  ctx.lineWidth = 2;
  for (let rr = 52; rr <= 300; rr += 42) {
    ctx.beginPath();
    ctx.arc(card.x + card.w - 6, card.y + card.h - 6, rr, Math.PI, 1.5 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = P.fg;
  ctx.lineWidth = 3;
  ctx.strokeRect(card.x + 1.5, card.y + 1.5, card.w - 3, card.h - 3);

  const cp = 30;
  const cx = card.x + cp;
  const cInnerW = card.w - cp * 2;

  ctx.fillStyle = VERMILION;
  ctx.fillRect(cx, card.y + 27, 7, 7);
  ctx.font = `700 11px 'JetBrains Mono', monospace`;
  ls(ctx, 2);
  ctx.fillStyle = P.faint;
  ctx.fillText('TRACED WITH COT', cx + 15, card.y + 34);
  ls(ctx, 0);

  let hpx = 50;
  ctx.font = `800 ${hpx}px 'Newsreader', serif`;
  while (hpx > 26 && ctx.measureText(lead).width > cInnerW) {
    hpx -= 1;
    ctx.font = `800 ${hpx}px 'Newsreader', serif`;
  }
  const lineH = hpx * 0.98;
  const regionTop = 46;
  const regionBottom = card.h - 50;
  const blockH = lineH + hpx * 0.74;
  const capTop = regionTop + (regionBottom - regionTop - blockH) / 2;
  const hb = card.y + capTop + hpx * 0.74;
  ctx.fillStyle = P.fg;
  ctx.fillText(lead, cx, hb);
  ctx.font = `italic 800 ${hpx}px 'Newsreader', serif`;
  ctx.fillStyle = VERMILION;
  ctx.fillText(accent, cx, hb + lineH);

  ctx.fillStyle = P.cardLine;
  ctx.fillRect(cx, card.y + card.h - 44, cInnerW, 1);
  ctx.font = `700 12px 'JetBrains Mono', monospace`;
  ls(ctx, 2);
  ctx.fillStyle = P.faint;
  ctx.fillText((handle || '@you').toUpperCase(), cx, card.y + card.h - 22);
  ls(ctx, 0);

  // ── Metrics bento (hairline-segregated, adaptive grid) ──
  const metrics = { x: rx0, y: rowTop, w: rw, h: topH };
  const stats = opts.stats.slice(0, MAX_STATS);
  const [gCols, gRows] = gridDims(stats.length || 1);
  const cellW = metrics.w / gCols;
  const cellH = metrics.h / gRows;
  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.strokeRect(metrics.x + 0.5, metrics.y + 0.5, metrics.w - 1, metrics.h - 1);
  ctx.beginPath();
  for (let c = 1; c < gCols; c++) {
    const gx = metrics.x + c * cellW;
    ctx.moveTo(gx + 0.5, metrics.y);
    ctx.lineTo(gx + 0.5, metrics.y + metrics.h);
  }
  for (let r = 1; r < gRows; r++) {
    const gy = metrics.y + r * cellH;
    ctx.moveTo(metrics.x, gy + 0.5);
    ctx.lineTo(metrics.x + metrics.w, gy + 0.5);
  }
  ctx.stroke();
  stats.forEach((s, i) => {
    const r = Math.floor(i / gCols);
    const c = i % gCols;
    const gx = metrics.x + c * cellW;
    const gy = metrics.y + r * cellH;
    const px = gx + 20;
    ctx.font = `700 11px 'JetBrains Mono', monospace`;
    ls(ctx, 1.5);
    ctx.fillStyle = P.faint;
    ctx.fillText(s.label.toUpperCase(), px, gy + 32);
    ls(ctx, 0);
    const vpx = fitMono(ctx, s.value, Math.min(cellH * 0.4, 56), cellW - 40, 22);
    ctx.font = `800 ${vpx}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = P.fg;
    ctx.fillText(s.value, px, gy + cellH - 24);
  });

  // ── Two charts at the bottom corners ──
  const charts = { y: chartsTop, h: rowBottom - chartsTop };
  const left = { x: x0, y: charts.y, w: leftW, h: charts.h };
  const rightC = { x: rx0, y: charts.y, w: rw, h: charts.h };

  ctx.strokeStyle = P.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const midX = x0 + leftW + gap / 2;
  ctx.moveTo(midX + 0.5, charts.y + 4);
  ctx.lineTo(midX + 0.5, charts.y + charts.h);
  ctx.stroke();

  const labelY = left.y + 12;
  const plotTop = labelY + 22;
  const plotH = left.y + left.h - plotTop;

  // Bottom-left: vermilion line (sequential series).
  const lineS = opts.lineSeries;
  chartLabel(ctx, left.x, labelY, left.x + left.w, lineS.label.toUpperCase(), 'LINE', VERMILION, P);
  lineChart(ctx, left.x, plotTop, left.w, plotH, lineS.data ?? [0], VERMILION, P);

  // Bottom-right: a distribution — bars or a donut.
  const distS = opts.distSeries;
  if (distS.kind === 'pie' && distS.items?.length) {
    chartLabel(ctx, rightC.x, labelY, rightC.x + rightC.w, distS.label.toUpperCase(), 'PIE', COBALT, P);
    donutChart(ctx, { x: rightC.x, y: plotTop, w: rightC.w, h: plotH }, distS.items, distS.unit ?? 'items', P);
  } else {
    chartLabel(ctx, rightC.x, labelY, rightC.x + rightC.w, distS.label.toUpperCase(), 'BARS', COBALT, P);
    barChart(ctx, rightC.x, plotTop, rightC.w, plotH, distS.data ?? [], COBALT, 'rgba(43,92,230,0.45)', P);
  }

  cross(ctx, x0, chartsTop - 13, 4, 1, 'rgba(255,69,0,0.7)');
  cross(ctx, x1, chartsTop - 13, 4, 1, 'rgba(43,92,230,0.7)');
}

/** Compose the share copy from the headline + first few selected stats. */
export function buildShareText(opts: CardOptions): string {
  const parts = opts.stats
    .slice(0, 3)
    .map((s) => `${s.value} ${s.label.toLowerCase()}`)
    .join(' · ');
  const lead = opts.title.trim() || 'My coding footprint';
  return `${lead}, traced with cot${parts ? `: ${parts}` : ''}. Self-hosted agent observability → cot.run`;
}
