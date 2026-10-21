import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TimelineItem } from '../../../lib/api';
import { START_ID, buildFlow, mainPaths, type FlowGraph, type FlowMode, type FlowNode } from '../../../lib/flowGraph';
import { layoutFlow, truncateLabel, type FlowDirection, type FlowLayout } from '../../../lib/flowLayout';
import { eventKey } from '../../../lib/sessionView';
import { CATEGORY_ICON, Icon } from '../../forest/icons';

interface FlowMapProps {
  items: TimelineItem[];
  sessionId: string;
  /** Key of the selected event; its node wears the selection ring. */
  activeKey: string | null;
  /** A node was clicked: the next of its events after the selected one. */
  onSelect: (item: TimelineItem) => void;
  /** Empty canvas was clicked. */
  onClear?: () => void;
  /** Keys of events that answer the active search; nodes with none fade. */
  matchKeys?: Set<string> | null;
  /** Sizes the whole map (toolbar, canvas, hint); the canvas takes what is left. */
  className?: string;
  hint?: string;
}

// Icon colour + flat tile tint per node kind. Colour means kind only; failures
// get their own chip.
export const TONE: Record<string, { tile: string; text: string }> = {
  prompt: { tile: 'bg-fg/[0.08]', text: 'text-fg' },
  question: { tile: 'bg-fg/[0.08]', text: 'text-fg' },
  web: { tile: 'bg-hot/[0.12]', text: 'text-hot' },
  mcp: { tile: 'bg-hot/[0.12]', text: 'text-hot' },
  skill: { tile: 'bg-olive/[0.13]', text: 'text-olive' },
  memory: { tile: 'bg-olive/[0.13]', text: 'text-olive' },
  file_edit: { tile: 'bg-olive/[0.13]', text: 'text-olive' },
  shell: { tile: 'bg-amber/[0.14]', text: 'text-amber' },
  permission: { tile: 'bg-amber/[0.14]', text: 'text-amber' },
  file_read: { tile: 'bg-cobalt/[0.13]', text: 'text-cobalt' },
};
export const NEUTRAL = { tile: 'bg-fg/[0.06]', text: 'text-fg/55' };

export const KIND_ICON: Record<string, string> = { skill: 'layers', context: 'file' };

const MODE_KEY = 'cot.flowMap.mode';
const DIRECTION_KEY = 'cot.flowMap.direction';
const PAD = 16;
const MIN_K = 0.15;
const MAX_K = 2;
/** Below this zoom labels hide and nodes show only their icon. */
const COMPACT_K = 0.55;

type View = { x: number; y: number; k: number };

function readDirection(): FlowDirection {
  try {
    return localStorage.getItem(DIRECTION_KEY) === 'RIGHT' ? 'RIGHT' : 'DOWN';
  } catch {
    return 'DOWN';
  }
}

function readMode(): FlowMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'expanded' ? 'expanded' : 'aggregated';
  } catch {
    return 'aggregated';
  }
}

/** Fit never shrinks past this: a graph too small to read is not a fit. Wider
 *  or taller graphs keep this size and pan. */
const READABLE_K = 0.72;

/** Fit to the canvas when the graph is readable at that size; otherwise stay
 *  readable and open at Start: centred across the top when the run flows down,
 *  at the left edge, centred vertically, when it flows right. */
function fitView(layout: FlowLayout, w: number, h: number, direction: FlowDirection): View {
  const fitK = Math.min(1, (w - PAD * 2) / Math.max(layout.width, 1), (h - PAD * 2) / Math.max(layout.height, 1));
  const k = Math.max(fitK, READABLE_K);
  const start = layout.nodes.get(START_ID);
  const fitsW = layout.width * k <= w - PAD * 2;
  const fitsH = layout.height * k <= h - PAD * 2;
  const centreX = (w - layout.width * k) / 2;
  const centreY = (h - layout.height * k) / 2;
  if (direction === 'RIGHT') {
    const y = fitsH || !start ? centreY : h / 2 - (start.y + start.height / 2) * k;
    return { x: fitsW ? centreX : PAD, y, k };
  }
  const x = fitsW || !start ? centreX : w / 2 - (start.x + start.width / 2) * k;
  return { x, y: fitsH ? centreY : PAD, k };
}

/** An orthogonal ELK route with its corners rounded off. */
function edgePath(points: { x: number; y: number }[], radius = 8): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(c.x - p.x, c.y - p.y);
    const outLen = Math.hypot(n.x - c.x, n.y - c.y);
    if (!inLen || !outLen) continue;
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = c.x - ((c.x - p.x) / inLen) * r;
    const ay = c.y - ((c.y - p.y) / inLen) * r;
    const bx = c.x + ((n.x - c.x) / outLen) * r;
    const by = c.y + ((n.y - c.y) / outLen) * r;
    d += ` L${ax},${ay} Q${c.x},${c.y} ${bx},${by}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

export function FlowMap({
  items,
  sessionId,
  activeKey,
  onSelect,
  onClear,
  matchKeys = null,
  className = 'h-[70vh] min-h-[420px]',
  hint = 'Click a step to select it; click again for its next event.',
}: FlowMapProps) {
  const [mode, setMode] = useState<FlowMode>(readMode);
  // Expanded can run either way; Aggregated always flows down, where its loops read best.
  const [expandedDirection, setExpandedDirection] = useState<FlowDirection>(readDirection);
  const direction: FlowDirection = mode === 'expanded' ? expandedDirection : 'DOWN';
  // Aggregated graphs show their main paths unless asked for every transition.
  const [allPaths, setAllPaths] = useState(false);
  const full = useMemo(() => buildFlow(items, mode), [items, mode]);
  const graph = useMemo(() => (mode === 'aggregated' && !allPaths ? mainPaths(full) : full), [full, mode, allPaths]);
  const hiddenPaths = full.edges.length - graph.edges.length;
  const [placed, setPlaced] = useState<{ graph: FlowGraph; layout: FlowLayout; direction: FlowDirection } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Per-node step position for when the selection lives elsewhere: repeated
  // clicks walk through that node's events.
  const [cursor, setCursor] = useState<{ id: string; index: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  // Full screen is an overlay over the app window, not the browser's
  // fullscreen API, which the desktop app's webview may not grant.
  const [fullScreen, setFullScreen] = useState(false);
  const markerId = useId();

  const canvasRef = useRef<HTMLDivElement>(null);
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const worldRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  // The user's last pan/zoom. Without one, the graph re-fits on every layout or resize.
  const overrideRef = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 });

  const changeDirection = (next: FlowDirection) => {
    setExpandedDirection(next);
    overrideRef.current = false;
    try {
      localStorage.setItem(DIRECTION_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  };

  const changeMode = (next: FlowMode) => {
    setMode(next);
    setCursor(null);
    overrideRef.current = false;
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  };

  useEffect(() => {
    if (!graph.nodes.length) {
      setPlaced(null);
      return;
    }
    let live = true;
    layoutFlow(graph, direction)
      .then((layout) => {
        if (!live) return;
        setFailed(false);
        setPlaced({ graph, layout, direction });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [graph, direction, attempt]);

  // Pan/zoom write the transform straight to the DOM; React only hears about the
  // label threshold.
  const applyView = useCallback((v: View) => {
    viewRef.current = v;
    if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    setCompact(v.k < COMPACT_K);
  }, []);

  const fit = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (placed && w) applyView(fitView(placed.layout, w, h, placed.direction));
  }, [placed, applyView]);

  useEffect(() => {
    if (!overrideRef.current) fit();
  }, [fit]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      sizeRef.current = { w: entry.contentRect.width, h: entry.contentRect.height };
      if (!overrideRef.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const v = viewRef.current;
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      overrideRef.current = true;
      applyView({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k });
    },
    [applyView],
  );

  // Scroll pans, pinch / ⌘-scroll zooms. Non-passive so the page doesn't scroll too.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        const v = viewRef.current;
        // A plain mouse wheel only scrolls vertically; on a run that flows
        // right, turn it into travel along the run.
        const along = directionRef.current === 'RIGHT' && !e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY);
        overrideRef.current = true;
        applyView(along ? { ...v, x: v.x - e.deltaY } : { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyView]);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-node]')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    overrideRef.current = true;
    applyView({ ...viewRef.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
  };
  const endDrag = () => {
    // A click on empty canvas (no drag) clears the selection.
    if (drag.current && !drag.current.moved) {
      setCursor(null);
      onClear?.();
    }
    drag.current = null;
  };

  const toggleFull = useCallback(() => {
    overrideRef.current = false;
    setFullScreen((v) => !v);
  }, []);

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleFull();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullScreen, toggleFull]);

  const zoomCentre = (factor: number) => zoomAt(factor, sizeRef.current.w / 2, sizeRef.current.h / 2);
  const refit = () => {
    overrideRef.current = false;
    fit();
  };

  const shown = placed?.graph;
  const nodeOfEvent = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of shown?.nodes ?? []) for (const it of n.items) map.set(eventKey(it, sessionId), n.id);
    return map;
  }, [shown, sessionId]);
  const selected = (activeKey && nodeOfEvent.get(activeKey)) || cursor?.id || null;
  // Where in its node's events the selection sits, when it sits in one.
  const positionIn = (node: FlowNode): number => {
    if (activeKey && nodeOfEvent.get(activeKey) === node.id) {
      return node.items.findIndex((it) => eventKey(it, sessionId) === activeKey);
    }
    return cursor?.id === node.id ? cursor.index : -1;
  };
  const focus = hovered ?? selected;

  // Bring the selected step into view when it was picked elsewhere (the tree,
  // search) and sits off screen. Instant: selection follows the keyboard.
  useEffect(() => {
    const box = selected ? placed?.layout.nodes.get(selected) : null;
    const { w, h } = sizeRef.current;
    if (!box || !w) return;
    const v = viewRef.current;
    const left = v.x + box.x * v.k;
    const top = v.y + box.y * v.k;
    const inside = left >= 0 && top >= 0 && left + box.width * v.k <= w && top + box.height * v.k <= h;
    if (inside) return;
    overrideRef.current = true;
    applyView({
      ...v,
      x: w / 2 - (box.x + box.width / 2) * v.k,
      y: h / 2 - (box.y + box.height / 2) * v.k,
    });
  }, [selected, placed, applyView]);

  const neighbours = useMemo(() => {
    if (!hovered || !shown) return null;
    const ids = new Set([hovered]);
    for (const e of shown.edges) {
      if (e.from === hovered) ids.add(e.to);
      if (e.to === hovered) ids.add(e.from);
    }
    return ids;
  }, [hovered, shown]);

  const step = (node: FlowNode) => {
    if (!node.items.length) return;
    const index = (positionIn(node) + 1) % node.items.length;
    setCursor({ id: node.id, index });
    onSelect(node.items[index]);
  };

  if (!graph.nodes.length) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
        <span className="font-mono text-lg text-fg/10">⦰</span>
        <span className="font-mono text-label text-fg/40">No steps in this session yet</span>
      </div>
    );
  }

  const truncated = mode === 'expanded' ? graph.truncated : 0;

  return (
    <div
      className={`flex min-h-0 flex-col gap-2 ${fullScreen ? 'fixed inset-0 z-50 bg-bg p-4' : className}`}
      role={fullScreen ? 'dialog' : undefined}
      aria-modal={fullScreen || undefined}
      aria-label={fullScreen ? 'Flow graph' : undefined}
    >
      <div className="flex items-center gap-2">
        <div className="seg" role="tablist" aria-label="Graph view">
          {(['aggregated', 'expanded'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              aria-pressed={mode === m}
              onClick={() => changeMode(m)}
              className="seg-item"
            >
              {m === 'aggregated' ? 'Aggregated' : 'Expanded'}
            </button>
          ))}
        </div>
        {mode === 'expanded' && (
          <div className="seg" role="radiogroup" aria-label="Graph direction">
            {(
              [
                { d: 'DOWN', label: 'Top to bottom', rotate: 'rotate-90' },
                { d: 'RIGHT', label: 'Left to right', rotate: '' },
              ] as const
            ).map(({ d, label, rotate }) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={expandedDirection === d}
                aria-pressed={expandedDirection === d}
                aria-label={label}
                title={label}
                onClick={() => changeDirection(d)}
                className="seg-item flex h-7 w-7 items-center justify-center px-0 py-0"
              >
                <Icon name="arrow" size={14} className={rotate} />
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {[
            { icon: 'minus', title: 'Zoom out', run: () => zoomCentre(1 / 1.25) },
            { icon: 'plus', title: 'Zoom in', run: () => zoomCentre(1.25) },
          ].map((b) => (
            <button
              key={b.title}
              type="button"
              title={b.title}
              aria-label={b.title}
              onClick={b.run}
              className="btn-ghost focus-ring h-7 w-7 px-0"
            >
              <Icon name={b.icon} size={14} />
            </button>
          ))}
          <button
            type="button"
            title="Fit the graph to the view"
            onClick={refit}
            className="btn-ghost focus-ring h-7 px-2 text-data"
          >
            Fit
          </button>
          <span className="mx-1 h-4 w-px bg-line/15" aria-hidden />
          <button
            type="button"
            title={fullScreen ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullScreen}
            onClick={toggleFull}
            className="btn-ghost focus-ring h-7 w-7 px-0"
          >
            <Icon name={fullScreen ? 'shrink' : 'expand'} size={14} />
          </button>
        </div>
      </div>

      <div
        ref={canvasRef}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-control border border-line/10 bg-bg active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {!placed && !failed && <GraphSkeleton />}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-small text-fg/60">The graph couldn't be laid out.</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn focus-ring h-7 text-data">
              Try again
            </button>
          </div>
        )}
        {placed && (
          <div
            ref={worldRef}
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: placed.layout.width,
              height: placed.layout.height,
              transform: `translate(${viewRef.current.x}px, ${viewRef.current.y}px) scale(${viewRef.current.k})`,
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={placed.layout.width}
              height={placed.layout.height}
              aria-hidden
            >
              <defs>
                {(['idle', 'on', 'off'] as const).map((s) => (
                  <marker
                    key={s}
                    id={`${markerId}-${s}`}
                    viewBox="0 0 8 8"
                    refX="7.5"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path
                      d="M0,0.5 L8,4 L0,7.5 z"
                      className={s === 'on' ? 'fill-hot' : s === 'off' ? 'fill-fg/10' : 'fill-fg/30'}
                    />
                  </marker>
                ))}
              </defs>
              {[...placed.layout.edges]
                .sort((a, b) => Number(!!focus && (a.from === focus || a.to === focus)) - Number(!!focus && (b.from === focus || b.to === focus)))
                .map((e) => {
                // The focused node's edges take the accent; only hovering fades the rest.
                const touches = !!focus && (e.from === focus || e.to === focus);
                const s = touches ? 'on' : hovered ? 'off' : 'idle';
                return (
                  <path
                    key={e.id}
                    d={edgePath(e.points)}
                    fill="none"
                    className={`transition-[stroke] duration-150 ${s === 'on' ? 'stroke-hot' : s === 'off' ? 'stroke-fg/10' : 'stroke-fg/[0.22]'}`}
                    strokeWidth={s === 'on' ? 1.5 : 1.25}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    markerEnd={`url(#${markerId}-${s})`}
                  />
                );
              })}
            </svg>

            {shown?.nodes.map((node) => {
              const box = placed.layout.nodes.get(node.id);
              if (!box) return null;
              const style = { left: box.x, top: box.y, width: box.width, height: box.height };
              const missed = matchKeys && !node.system && !node.items.some((it) => matchKeys.has(eventKey(it, sessionId)));
              const dim = (neighbours && !neighbours.has(node.id)) || missed ? 'opacity-30' : '';
              const hover = {
                onMouseEnter: () => setHovered(node.id),
                onMouseLeave: () => setHovered(null),
              };
              if (node.system) {
                return (
                  <div
                    key={node.id}
                    data-node
                    style={style}
                    {...hover}
                    className={`absolute flex select-none items-center justify-center rounded-full text-data font-medium transition-opacity duration-150 ${dim} ${
                      node.system === 'start' ? 'bg-hot text-on-hot' : 'border border-line/20 bg-surface text-fg/60'
                    }`}
                  >
                    {!compact && node.label}
                  </div>
                );
              }
              const tone = TONE[node.kind] ?? NEUTRAL;
              const n = node.items.length;
              const at = positionIn(node);
              const counter = at >= 0 && n > 1 ? `${at + 1}/${n}` : n > 1 ? `×${n}` : null;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-node
                  style={style}
                  {...hover}
                  onClick={() => step(node)}
                  aria-pressed={selected === node.id}
                  aria-label={`${node.label}: ${n} event${n === 1 ? '' : 's'}${node.errors ? `, ${node.errors} failed` : ''}`}
                  title={`${node.label} · ${n} event${n === 1 ? '' : 's'}${node.errors ? ` · ${node.errors} failed` : ''}`}
                  className={`focus-ring absolute flex select-none items-center gap-1.5 rounded-[7px] border bg-surface pl-[5px] pr-2 text-left shadow-[0_1px_2px_rgb(var(--shadow)/0.06)] transition-[transform,opacity,border-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] motion-reduce:active:scale-100 ${dim} ${
                    selected === node.id ? 'border-hot ring-2 ring-hot/25' : 'border-line/[0.14] hover:border-line/30'
                  } ${compact ? 'justify-center' : ''}`}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] ${tone.tile}`}>
                    <Icon name={KIND_ICON[node.kind] ?? CATEGORY_ICON[node.kind] ?? 'file'} size={12} stroke={1.8} className={tone.text} />
                  </span>
                  {!compact && (
                    <>
                      <span className="min-w-0 truncate font-mono text-data text-fg/85">{truncateLabel(node.label)}</span>
                      {counter && (
                        <span className="ml-auto shrink-0 font-mono text-data tabular-nums text-fg/40">{counter}</span>
                      )}
                      {node.errors > 0 && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-chip bg-alert/[0.14] px-1 font-mono text-label font-semibold tabular-nums text-alert">
                          <Icon name="close" size={9} stroke={2.4} />
                          {node.errors}
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-data text-fg/40">
        <p className="min-w-0 flex-1 truncate" title={`${hint} Drag to pan, pinch or ⌘-scroll to zoom.`}>
          {truncated > 0
            ? `First ${graph.nodes.length - 2} of ${graph.nodes.length - 2 + truncated} events. Aggregated shows them all.`
            : `${hint} Drag to pan, ⌘-scroll to zoom.`}
        </p>
        {mode === 'aggregated' && (hiddenPaths > 0 || allPaths) && (
          <button
            type="button"
            onClick={() => setAllPaths((v) => !v)}
            aria-pressed={allPaths}
            title={allPaths ? 'Show only the main paths' : 'Show every transition between steps'}
            className="press focus-ring shrink-0 rounded-chip text-fg/60 underline decoration-line/30 underline-offset-2 transition-colors duration-150 hover:text-fg hover:decoration-fg/40"
          >
            {allPaths ? 'Main paths only' : `Show all ${full.edges.length} paths`}
          </button>
        )}
      </div>
    </div>
  );
}


/** Placeholder in the shape of a small top-down graph while ELK works. */
function GraphSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 motion-safe:animate-pulse" aria-label="Laying out graph">
      {[56, 112, 88, 128, 72].map((w, i) => (
        <div key={i} className="flex flex-col items-center gap-3">
          {i > 0 && <span className="-mt-3 h-3 w-px bg-fg/10" />}
          <span className="h-7 rounded-control bg-fg/[0.06]" style={{ width: w }} />
        </div>
      ))}
    </div>
  );
}
