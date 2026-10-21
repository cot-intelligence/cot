import type { TimelineItem } from './api';
import { activityKind, commandName, leafLabel } from './activityMap';

/**
 * Execution-flow graph for one session, after Langfuse's agent graph: nodes are
 * steps, edges are "then". Events are ordered by time and grouped into steps
 * (events whose spans overlap ran in parallel and share a step); consecutive
 * steps are joined by edges, with Start and End nodes around the run.
 *
 *  - aggregated: events with the same step name share one node, so loops show
 *    up as cycles (Read → Edit → Bash → Read …).
 *  - expanded: one node per event, unrolled into a DAG in execution order.
 *
 * Every node keeps its events so the UI can jump into the transcript.
 */

export type FlowMode = 'aggregated' | 'expanded';

export const START_ID = '__start';
export const END_ID = '__end';

export interface FlowNode {
  id: string;
  label: string;
  /** Category-like kind for the node's icon and ring colour. */
  kind: string;
  items: TimelineItem[];
  errors: number;
  system?: 'start' | 'end';
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** Times the run moved along this edge. */
  count: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Expanded mode only: events left out past the node ceiling. */
  truncated: number;
}

// Categories that are steps of the run; lifecycle/meta/notification rows are not.
const STEP_CATEGORIES = new Set([
  'prompt',
  'response',
  'thought',
  'plan',
  'question',
  'file_edit',
  'file_read',
  'context_read',
  'shell',
  'mcp',
  'web',
  'subagent',
  'memory',
  'compaction',
  'permission',
]);

const FIXED_LABEL: Record<string, string> = {
  prompt: 'You',
  response: 'Reply',
  thought: 'Thinking',
  plan: 'Plan',
  question: 'Question',
  file_read: 'Read',
  file_edit: 'Edit',
  memory: 'Memory',
  compaction: 'Compaction',
  permission: 'Permission',
};

/** Past this many events the expanded graph stops; ELK and the eye both give up. */
export const MAX_EXPANDED = 300;

function startMs(it: TimelineItem): number {
  return Date.parse(it.start_ts || it.ts);
}

function endMs(it: TimelineItem): number {
  const end = it.end_ts ? Date.parse(it.end_ts) : NaN;
  return Number.isFinite(end) ? Math.max(end, startMs(it)) : startMs(it);
}

/** The events that make up the run, oldest first. Rows inlined from a subagent
 *  belong to that subagent's own run; its spawn event stands in for them. */
export function flowItems(items: TimelineItem[]): TimelineItem[] {
  return items
    .filter((it) => STEP_CATEGORIES.has(it.category) && !it.provenance)
    .sort((a, b) => startMs(a) - startMs(b) || a.id - b.id);
}

/** Groups time-ordered events into steps. A step is the earliest remaining event
 *  plus every event that starts while it runs, minus any that start after
 *  another member already finished (those wait for a later step). */
export function flowSteps(sorted: TimelineItem[]): TimelineItem[][] {
  const steps: TimelineItem[][] = [];
  let remaining = sorted;
  while (remaining.length) {
    const first = remaining[0];
    const firstEnd = endMs(first);
    const candidates = [first];
    for (let i = 1; i < remaining.length && startMs(remaining[i]) < firstEnd; i++) {
      candidates.push(remaining[i]);
    }
    const step = candidates.filter((it) => candidates.every((o) => o === it || startMs(it) <= endMs(o)));
    const taken = new Set(step);
    steps.push(step);
    remaining = remaining.filter((it) => !taken.has(it));
  }
  return steps;
}

/** The step name events are aggregated by, e.g. "Read", "git", "github.com". */
export function stepName(it: TimelineItem): { key: string; label: string; kind: string } {
  const kind = activityKind(it) ?? it.category;
  const fixed = FIXED_LABEL[it.category];
  let label: string;
  if (fixed) label = fixed;
  else if (it.category === 'shell') label = it.title !== 'Shell command' ? it.title : commandName(it.target ?? '');
  else if (kind === 'context') label = 'Context';
  else if (kind === 'skill') label = `skill: ${leafLabel('skill', it)}`;
  else if (kind === 'web' || kind === 'mcp' || kind === 'subagent') label = leafLabel(kind, it);
  else label = it.title || it.category;
  return { key: `${it.category}:${label}`, label, kind };
}

/** Per-event label for the expanded graph: the step name plus its target. */
function eventLabel(it: TimelineItem): string {
  const { label, kind } = stepName(it);
  if (it.category === 'file_read' || it.category === 'file_edit' || kind === 'context') {
    return `${label} ${leafLabel(kind as 'file_read', it)}`;
  }
  return label;
}

function isError(it: TimelineItem): boolean {
  return it.status === 'error';
}

function systemNodes(): [FlowNode, FlowNode] {
  return [
    { id: START_ID, label: 'Start', kind: 'system', items: [], errors: 0, system: 'start' },
    { id: END_ID, label: 'End', kind: 'system', items: [], errors: 0, system: 'end' },
  ];
}

/** Edges between every node of each step and every node of the next (fork/join),
 *  counted per pair. Self-loops are dropped: the node's count already says it repeated. */
function stepEdges(stepIds: string[][]): FlowEdge[] {
  const counts = new Map<string, FlowEdge>();
  const chain = [[START_ID], ...stepIds, [END_ID]];
  for (let s = 0; s < chain.length - 1; s++) {
    for (const from of chain[s]) {
      for (const to of chain[s + 1]) {
        if (from === to) continue;
        const id = `${from}->${to}`;
        const edge = counts.get(id);
        if (edge) edge.count++;
        else counts.set(id, { id, from, to, count: 1 });
      }
    }
  }
  return [...counts.values()];
}

export function buildAggregatedFlow(items: TimelineItem[]): FlowGraph {
  const sorted = flowItems(items);
  if (!sorted.length) return { nodes: [], edges: [], truncated: 0 };
  const nodes = new Map<string, FlowNode>();
  const stepIds = flowSteps(sorted).map((step) => {
    const ids = new Set<string>();
    for (const it of step) {
      const { key, label, kind } = stepName(it);
      let node = nodes.get(key);
      if (!node) nodes.set(key, (node = { id: key, label, kind, items: [], errors: 0 }));
      node.items.push(it);
      if (isError(it)) node.errors++;
      ids.add(key);
    }
    return [...ids];
  });
  const [start, end] = systemNodes();
  return { nodes: [start, ...nodes.values(), end], edges: stepEdges(stepIds), truncated: 0 };
}

export function buildExpandedFlow(items: TimelineItem[], max = MAX_EXPANDED): FlowGraph {
  const all = flowItems(items);
  if (!all.length) return { nodes: [], edges: [], truncated: 0 };
  const sorted = all.slice(0, max);
  const nodes: FlowNode[] = [];
  const stepIds = flowSteps(sorted).map((step) =>
    step.map((it) => {
      const id = `e:${it.id}`;
      nodes.push({ id, label: eventLabel(it), kind: stepName(it).kind, items: [it], errors: isError(it) ? 1 : 0 });
      return id;
    }),
  );
  const [start, end] = systemNodes();
  return { nodes: [start, ...nodes, end], edges: stepEdges(stepIds), truncated: all.length - sorted.length };
}

export function buildFlow(items: TimelineItem[], mode: FlowMode): FlowGraph {
  return mode === 'expanded' ? buildExpandedFlow(items) : buildAggregatedFlow(items);
}

/** One turn of the conversation for the trace tree: the prompt that opened it
 *  (null for anything before the first prompt) and the steps that followed. */
export interface FlowTurn {
  id: string;
  prompt: TimelineItem | null;
  items: TimelineItem[];
  errors: number;
  /** Wall time from the prompt to the turn's last step finishing. */
  durationMs: number;
}

export function buildTurns(items: TimelineItem[]): FlowTurn[] {
  const turns: FlowTurn[] = [];
  let turn: FlowTurn | null = null;
  for (const it of flowItems(items)) {
    if (it.category === 'prompt' || !turn) {
      turn = { id: `turn:${it.id}`, prompt: it.category === 'prompt' ? it : null, items: [], errors: 0, durationMs: 0 };
      turns.push(turn);
      if (it.category === 'prompt') continue;
    }
    turn.items.push(it);
    if (isError(it)) turn.errors++;
  }
  for (const t of turns) {
    const first = t.prompt ?? t.items[0];
    const last = Math.max(...[t.prompt, ...t.items].filter((x): x is TimelineItem => !!x).map(endMs));
    t.durationMs = first ? last - startMs(first) : 0;
  }
  return turns;
}

/**
 * The main paths of an aggregated graph, as a process-mining tool would show
 * them: per node, its strongest outgoing transitions (at most `maxOut`, each at
 * least `share` of the strongest), plus every node's strongest incoming one so
 * nothing is left floating. Agent sessions connect almost every step to almost
 * every other; drawn whole, the graph is a hairball.
 */
export function mainPaths(graph: FlowGraph, share = 0.5, maxOut = 1): FlowGraph {
  const keep = new Set<string>();
  const out = new Map<string, FlowEdge[]>();
  const into = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e);
  }
  const byCount = (a: FlowEdge, b: FlowEdge) => b.count - a.count || a.id.localeCompare(b.id);
  for (const list of out.values()) {
    list.sort(byCount);
    list.slice(0, maxOut).forEach((e, i) => {
      if (i === 0 || e.count >= list[0].count * share) keep.add(e.id);
    });
  }
  for (const list of into.values()) keep.add(list.sort(byCount)[0].id);
  return { ...graph, edges: graph.edges.filter((e) => keep.has(e.id)) };
}
