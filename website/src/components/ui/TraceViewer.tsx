import React, { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { traceViewer } from '../../content';

const labelPositions = [
  { x: 55, y: 59, w: 120, h: 20, bg: 'fill-ink', text: 'fill-cream' },
  { x: 95, y: 99, w: 150, h: 20, bg: 'fill-cobalt', text: 'fill-cream' },
  { x: 160, y: 139, w: 140, h: 20, bg: 'fill-cream stroke-ink stroke-[2px]', text: 'fill-ink' },
  { x: 310, y: 219, w: 130, h: 20, bg: 'fill-vermilion', text: 'fill-cream' },
  { x: 400, y: 259, w: 130, h: 20, bg: 'fill-olive', text: 'fill-cream' },
  { x: 460, y: 299, w: 140, h: 20, bg: 'fill-ink', text: 'fill-cream' },
];

const VIEWBOX = { w: 600, h: 400 };
const CARD_SIZE = { w: 136, h: 52 };
const EDGE_PAD = 10;
const MAX_ATTEMPTS = 120;

type Rect = { x: number; y: number; w: number; h: number };

function toPixels(rect: Rect, containerW: number, containerH: number): Rect {
  return {
    x: rect.x * containerW,
    y: rect.y * containerH,
    w: rect.w * containerW,
    h: rect.h * containerH,
  };
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function buildForbiddenZones(containerW: number, containerH: number): Rect[] {
  const norm = (x: number, y: number, w: number, h: number) =>
    toPixels({ x: x / VIEWBOX.w, y: y / VIEWBOX.h, w: w / VIEWBOX.w, h: h / VIEWBOX.h }, containerW, containerH);

  const traceZones = [
    norm(25, 52, 155, 48),
    norm(125, 52, 44, 128),
    norm(125, 132, 195, 48),
    norm(275, 132, 44, 128),
    norm(275, 212, 195, 48),
    norm(425, 212, 44, 128),
    norm(425, 292, 155, 48),
  ];

  const labelZones = labelPositions.map((pos) =>
    norm(pos.x - 12, pos.y - 22, pos.w + 24, pos.h + 20),
  );

  return [...traceZones, ...labelZones];
}

function isValidPlacement(
  card: Rect,
  forbidden: Rect[],
  placed: Rect[],
  containerW: number,
  containerH: number,
) {
  if (card.x < EDGE_PAD || card.y < EDGE_PAD) return false;
  if (card.x + card.w > containerW - EDGE_PAD || card.y + card.h > containerH - EDGE_PAD) {
    return false;
  }
  return !forbidden.some((zone) => overlaps(card, zone)) && !placed.some((other) => overlaps(card, other));
}

function placeHudCards(count: number, containerW: number, containerH: number): { left: number; top: number }[] {
  const forbidden = buildForbiddenZones(containerW, containerH);
  const placed: Rect[] = [];
  const results: { left: number; top: number }[] = [];

  const tryPlace = (candidate: Rect) => {
    if (!isValidPlacement(candidate, forbidden, placed, containerW, containerH)) return false;
    placed.push(candidate);
    results.push({ left: candidate.x, top: candidate.y });
    return true;
  };

  for (let i = 0; i < count; i++) {
    let found = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate: Rect = {
        x: EDGE_PAD + Math.random() * (containerW - CARD_SIZE.w - EDGE_PAD * 2),
        y: EDGE_PAD + Math.random() * (containerH - CARD_SIZE.h - EDGE_PAD * 2),
        w: CARD_SIZE.w,
        h: CARD_SIZE.h,
      };
      if (tryPlace(candidate)) {
        found = true;
        break;
      }
    }

    if (found) continue;

    const corners = [
      { left: EDGE_PAD, top: EDGE_PAD },
      { left: containerW - CARD_SIZE.w - EDGE_PAD, top: EDGE_PAD },
      { left: EDGE_PAD, top: containerH - CARD_SIZE.h - EDGE_PAD },
      { left: containerW - CARD_SIZE.w - EDGE_PAD, top: containerH - CARD_SIZE.h - EDGE_PAD },
    ].sort(() => Math.random() - 0.5);

    for (const corner of corners) {
      const candidate: Rect = { x: corner.left, y: corner.top, w: CARD_SIZE.w, h: CARD_SIZE.h };
      if (tryPlace(candidate)) {
        found = true;
        break;
      }
    }

    if (!found) {
      results.push({ left: EDGE_PAD, top: EDGE_PAD + i * (CARD_SIZE.h + 6) });
    }
  }

  return results;
}

interface HudCardProps {
  label: string;
  value: string;
  accent?: boolean;
  position: { left: number; top: number };
  constraintsRef: React.RefObject<HTMLDivElement>;
  nudge?: boolean;
  onDragStart?: () => void;
}

function HudCard({
  label,
  value,
  accent,
  position,
  constraintsRef,
  nudge,
  onDragStart,
}: HudCardProps) {
  return (
    <motion.div
      drag
      dragConstraints={constraintsRef}
      dragElastic={0.08}
      dragMomentum={false}
      onDragStart={onDragStart}
      animate={nudge ? { x: [0, 7, -4, 0] } : undefined}
      transition={
        nudge
          ? { delay: 2.8, duration: 0.55, repeat: 3, repeatDelay: 1.8, ease: 'easeInOut' }
          : undefined
      }
      whileDrag={{ scale: 1.03, zIndex: 30 }}
      className="absolute z-10 cursor-grab active:cursor-grabbing select-none border border-ink bg-ink px-3 py-2 shadow-soft-lg font-mono touch-none"
      style={{ left: position.left, top: position.top }}>
      <div
        className="absolute top-1.5 right-1.5 flex flex-col gap-[3px] opacity-50 pointer-events-none"
        aria-hidden="true">
        <span className="flex gap-[3px]">
          <span className="w-[3px] h-[3px] rounded-full bg-cream" />
          <span className="w-[3px] h-[3px] rounded-full bg-cream" />
        </span>
        <span className="flex gap-[3px]">
          <span className="w-[3px] h-[3px] rounded-full bg-cream" />
          <span className="w-[3px] h-[3px] rounded-full bg-cream" />
        </span>
      </div>
      <div className="text-[0.56rem] font-bold uppercase text-cream/50 mb-0.5 pointer-events-none pr-3">
        {label}
      </div>
      <div
        className={`text-sm font-bold pointer-events-none ${accent ? 'text-vermilion' : 'text-cream'}`}>
        {value}
      </div>
    </motion.div>
  );
}

export function TraceViewer() {
  const graphRef = useRef<HTMLDivElement>(null);
  const [showDragHint, setShowDragHint] = useState(true);
  const [cardPositions, setCardPositions] = useState<{ left: number; top: number }[]>([]);

  useLayoutEffect(() => {
    const el = graphRef.current;
    if (!el) return;

    let placed = false;
    const updatePositions = () => {
      if (placed) return;
      const { width, height } = el.getBoundingClientRect();
      if (width < CARD_SIZE.w || height < CARD_SIZE.h) return;
      setCardPositions(placeHudCards(traceViewer.hud.length, width, height));
      placed = true;
    };

    updatePositions();

    const observer = new ResizeObserver(updatePositions);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleDragStart = () => {
    setShowDragHint(false);
  };

  return (
    <div className="relative w-full border-3 border-cream bg-cream shadow-brutal-vermilion-lg overflow-hidden">
      <div className="h-10 border-b-3 border-ink bg-ink flex items-center px-4 justify-between gap-3">
        <div className="flex gap-2 shrink-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-3 h-3 rounded-full bg-cream" />
          ))}
        </div>
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-cream shrink-0">
          {traceViewer.filename}
        </span>
      </div>

      <div ref={graphRef} className="relative bg-cream-dark aspect-[6/4] min-h-[240px]">
        <svg viewBox="0 0 600 400" className="w-full h-full" preserveAspectRatio="xMidYMid slice">
          <defs>
            <pattern id="trace-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="#111"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#trace-grid)" />

          <g className="stroke-ink fill-none" strokeWidth="5">
            <motion.path
              d="M 50 80 L 150 80"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, delay: 0.5, ease: 'linear' }}
            />
            <rect x="40" y="70" width="20" height="20" className="fill-ink" />
            <rect
              x="140"
              y="70"
              width="20"
              height="20"
              className="fill-cream stroke-ink stroke-[2px]"
            />
            <motion.path
              d="M 150 80 L 150 160 L 300 160"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.6, delay: 1.0, ease: 'linear' }}
            />
            <rect
              x="290"
              y="150"
              width="20"
              height="20"
              className="fill-cream stroke-ink stroke-[2px]"
            />
            <motion.path
              d="M 300 160 L 300 240 L 450 240"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.6, delay: 1.6, ease: 'linear' }}
              className="stroke-vermilion"
            />
            <rect x="440" y="230" width="20" height="20" className="fill-vermilion" />
            <motion.path
              d="M 450 240 L 450 320 L 550 320"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, delay: 2.2, ease: 'linear' }}
            />
            <rect x="540" y="310" width="20" height="20" className="fill-ink" />
          </g>

          <g className="font-mono text-[11px] font-bold uppercase">
            {traceViewer.labels.map((lbl, i) => {
              const pos = labelPositions[i];
              if (!pos) return null;
              return (
                <motion.g
                  key={lbl.text}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: lbl.delay }}>
                  <rect
                    x={pos.x - 5}
                    y={pos.y - 14}
                    width={pos.w}
                    height={pos.h}
                    className={pos.bg}
                  />
                  <text x={pos.x} y={pos.y} className={pos.text}>
                    {lbl.text}
                  </text>
                </motion.g>
              );
            })}
          </g>
        </svg>

        {cardPositions.length === traceViewer.hud.length &&
          traceViewer.hud.map((cell, i) => (
            <HudCard
              key={cell.label}
              label={cell.label}
              value={cell.value}
              accent={cell.accent}
              position={cardPositions[i]}
              constraintsRef={graphRef}
              nudge={showDragHint && i === 0}
              onDragStart={handleDragStart}
            />
          ))}
      </div>
    </div>
  );
}
