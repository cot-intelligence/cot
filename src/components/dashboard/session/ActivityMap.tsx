import { useMemo, useState } from 'react';
import type { TimelineItem } from '../../../lib/api';
import { buildActivityMap, type ActivityGroup, type ActivityKind, type ActivityLeaf } from '../../../lib/activityMap';
import { eventKey } from '../../../lib/sessionView';

interface ActivityMapProps {
  items: TimelineItem[];
  sessionId: string;
  /** Key of the event currently focused in the transcript. */
  activeKey: string | null;
  onJump: (item: TimelineItem) => void;
}

// Geometry (px). Trunk runs down from the agent node; groups hang off it,
// leaves fan out to the right of each group.
const ROW = 28;
const GROUP_GAP = 12;
const AGENT_H = 28;
const TOP = AGENT_H + 16;
const TRUNK_X = 14;
const GROUP_X = 30;
const GROUP_W = 138;
const LEAF_X = GROUP_X + GROUP_W + 30;

const ACCENT: Record<ActivityKind, { stroke: string; dot: string; text: string }> = {
  web: { stroke: 'stroke-cobalt/60', dot: 'bg-cobalt', text: 'text-cobalt' },
  mcp: { stroke: 'stroke-cobalt/60', dot: 'bg-cobalt', text: 'text-cobalt' },
  skill: { stroke: 'stroke-olive/60', dot: 'bg-olive', text: 'text-olive' },
  memory: { stroke: 'stroke-olive/60', dot: 'bg-olive', text: 'text-olive' },
  file_edit: { stroke: 'stroke-vermilion/55', dot: 'bg-vermilion', text: 'text-vermilion' },
  permission: { stroke: 'stroke-vermilion/55', dot: 'bg-vermilion', text: 'text-vermilion' },
  subagent: { stroke: 'stroke-fg/30', dot: 'bg-fg/55', text: 'text-fg/80' },
  shell: { stroke: 'stroke-fg/30', dot: 'bg-fg/55', text: 'text-fg/80' },
  file_read: { stroke: 'stroke-fg/25', dot: 'bg-fg/45', text: 'text-fg/70' },
  context: { stroke: 'stroke-fg/25', dot: 'bg-fg/45', text: 'text-fg/70' },
};

interface Placed {
  group: ActivityGroup;
  y: number;
  cy: number;
  leaves: { leaf: ActivityLeaf; cy: number }[];
}

function layout(groups: ActivityGroup[]): { placed: Placed[]; height: number } {
  let y = TOP;
  const placed = groups.map((group) => {
    const leaves = group.overflow ? [...group.leaves, group.overflow] : group.leaves;
    const h = Math.max(leaves.length, 1) * ROW;
    const p: Placed = {
      group,
      y,
      cy: y + h / 2,
      leaves: leaves.map((leaf, i) => ({ leaf, cy: y + i * ROW + ROW / 2 })),
    };
    y += h + GROUP_GAP;
    return p;
  });
  return { placed, height: y };
}

function strokeWidth(count: number, max: number): number {
  return 1 + 2 * Math.sqrt(count / Math.max(max, 1));
}

export function ActivityMap({ items, sessionId, activeKey, onJump }: ActivityMapProps) {
  const groups = useMemo(() => buildActivityMap(items), [items]);
  const { placed, height } = useMemo(() => layout(groups), [groups]);
  // Per-node step position: repeated clicks walk through that node's events.
  const [cursor, setCursor] = useState<{ id: string; index: number } | null>(null);

  const maxGroup = Math.max(1, ...groups.map((g) => g.items.length));
  const maxLeaf = Math.max(1, ...groups.flatMap((g) => g.leaves.map((l) => l.items.length)));

  const activeNodes = useMemo(() => {
    const ids = new Set<string>();
    if (!activeKey) return ids;
    for (const g of groups) {
      for (const leaf of g.overflow ? [...g.leaves, g.overflow] : g.leaves) {
        if (leaf.items.some((it) => eventKey(it, sessionId) === activeKey)) {
          ids.add(g.id);
          ids.add(leaf.id);
        }
      }
    }
    return ids;
  }, [groups, activeKey, sessionId]);

  const step = (id: string, list: TimelineItem[]) => {
    if (!list.length) return;
    const index = cursor?.id === id ? (cursor.index + 1) % list.length : 0;
    setCursor({ id, index });
    onJump(list[index]);
  };

  if (!groups.length) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
        <span className="font-mono text-lg text-fg/10">⦰</span>
        <span className="font-mono text-[0.6rem] text-fg/25">No tool activity in this session yet</span>
      </div>
    );
  }

  const position = (id: string, total: number) =>
    cursor?.id === id ? `${cursor.index + 1}/${total}` : null;

  return (
    <div className="px-3 pb-4 pt-3">
      <p className="mb-3 font-mono text-[0.55rem] leading-relaxed text-fg/35">
        Click a node to jump to its events in the transcript. Click again for the next one.
      </p>
      <div className="relative" style={{ height }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {/* Trunk */}
          <line
            x1={TRUNK_X}
            y1={AGENT_H}
            x2={TRUNK_X}
            y2={placed[placed.length - 1].cy}
            className="stroke-fg/20"
            strokeWidth={1.5}
          />
          {placed.map(({ group, cy, leaves }) => {
            const accent = ACCENT[group.id];
            return (
              <g key={group.id} fill="none">
                <path
                  d={`M${TRUNK_X},${cy - 8} Q${TRUNK_X},${cy} ${TRUNK_X + 8},${cy} L${GROUP_X},${cy}`}
                  className={accent.stroke}
                  strokeWidth={strokeWidth(group.items.length, maxGroup)}
                />
                {leaves.map(({ leaf, cy: ly }) => {
                  const x1 = GROUP_X + GROUP_W;
                  const mid = (x1 + LEAF_X) / 2;
                  return (
                    <path
                      key={leaf.id}
                      d={`M${x1},${cy} C${mid},${cy} ${mid},${ly} ${LEAF_X},${ly}`}
                      className={accent.stroke}
                      strokeWidth={strokeWidth(leaf.items.length, maxLeaf)}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* Agent root */}
        <div
          className="absolute left-0 top-0 flex items-center gap-1.5 rounded-[5px] border border-line/15 bg-surface px-2 font-mono text-[0.58rem] font-bold uppercase tracking-[0.12em] text-fg/80"
          style={{ height: AGENT_H }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-vermilion" />
          Agent
          <span className="font-normal tabular-nums text-fg/35">{items.length}</span>
        </div>

        {placed.map(({ group, cy, leaves }) => {
          const accent = ACCENT[group.id];
          const groupPos = position(group.id, group.items.length);
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => step(group.id, group.items)}
                title={`${group.label}: ${group.items.length} event${group.items.length === 1 ? '' : 's'}`}
                className={`focus-ring absolute flex items-center gap-1.5 rounded-[5px] border bg-surface px-2 text-left transition-colors hover:border-line/30 ${
                  activeNodes.has(group.id) ? 'border-vermilion/60' : 'border-line/15'
                }`}
                style={{ left: GROUP_X, top: cy - 12, width: GROUP_W, height: 24 }}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
                <span className={`truncate font-mono text-[0.56rem] font-bold uppercase tracking-[0.12em] ${accent.text}`}>
                  {group.label}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[0.55rem] tabular-nums text-fg/40">
                  {groupPos ?? group.items.length}
                </span>
              </button>

              {leaves.map(({ leaf, cy: ly }) => {
                const leafPos = position(leaf.id, leaf.items.length);
                const isMore = leaf.id.endsWith(':__more');
                return (
                  <button
                    key={leaf.id}
                    type="button"
                    onClick={() => step(leaf.id, leaf.items)}
                    title={`${leaf.label}: ${leaf.items.length} event${leaf.items.length === 1 ? '' : 's'}${
                      leaf.errors ? `, ${leaf.errors} failed` : ''
                    }`}
                    className={`focus-ring absolute flex items-center gap-1.5 rounded-[3px] px-1.5 text-left transition-colors hover:bg-fg/[0.06] ${
                      activeNodes.has(leaf.id) ? 'bg-vermilion/10 ring-1 ring-inset ring-vermilion/40' : ''
                    }`}
                    style={{ left: LEAF_X, right: 0, top: ly - 10, height: 20 }}
                  >
                    <span
                      className={`min-w-0 truncate font-mono text-[0.62rem] ${
                        isMore ? 'italic text-fg/40' : 'text-fg/80'
                      }`}
                    >
                      {leaf.label}
                    </span>
                    {leaf.errors > 0 && (
                      <span className="shrink-0 rounded-[3px] bg-vermilion/15 px-1 font-mono text-[0.5rem] font-bold text-vermilion">
                        {leaf.errors}✕
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[0.55rem] tabular-nums text-fg/35">
                      {leafPos ?? `×${leaf.items.length}`}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
