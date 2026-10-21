import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { FlowGraph } from './flowGraph';

/**
 * Lays a flow graph out with ELK's layered algorithm (orthogonal edges, cycles
 * broken depth-first), the same setup Langfuse's agent graph uses. ELK runs in
 * a web worker so a large session never blocks the transcript.
 */

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

export interface FlowLayout {
  nodes: Map<string, PlacedNode>;
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export const NODE_H = 30;
const CHAR_W = 6.7; // Geist Mono at text-data (11px)
const PAD_X = 18; // 5px before the icon tile, 8px after the text, borders, rounding
const ICON_W = 20 + 6;
export const MAX_LABEL = 28;

export function truncateLabel(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** Box width for a node: icon, label, and room for an "12/34" counter or error chip. */
export function nodeWidth(label: string, count: number, errors: number, system: boolean): number {
  const text = truncateLabel(label).length * CHAR_W;
  if (system) return Math.ceil(text + 28);
  const counter = count > 1 ? (String(count).length * 2 + 1) * CHAR_W + 6 : 0;
  const chip = errors ? String(errors).length * CHAR_W + 25 : 0;
  return Math.ceil(PAD_X + ICON_W + text + counter + chip);
}

const LAYOUT_OPTIONS = {
  'elk.algorithm': 'org.eclipse.elk.layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.mergeEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
  'elk.spacing.nodeNode': '24',
  'elk.spacing.edgeNode': '16',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
};

let elk: Promise<ELK> | null = null;

function getElk(): Promise<ELK> {
  elk ??= Promise.all([import('elkjs/lib/elk-api'), import('elkjs/lib/elk-worker.min.js?url')]).then(
    ([api, worker]) => new api.default({ workerUrl: worker.default }),
  );
  return elk;
}

/** Top to bottom in both modes: the graph sits in a column beside the tree. */
export async function layoutFlow(graph: FlowGraph): Promise<FlowLayout> {
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      'elk.direction': 'DOWN',
      'elk.padding': '[top=8,left=8,bottom=8,right=8]',
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: nodeWidth(n.label, n.items.length, n.errors, !!n.system),
      height: NODE_H,
      // Keep Start first and End last whatever the cycles do.
      ...(n.system && {
        layoutOptions: {
          'elk.layered.layering.layerConstraint': n.system === 'start' ? 'FIRST_SEPARATE' : 'LAST_SEPARATE',
        },
      }),
    })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const out = await (await getElk()).layout(root);
  const nodes = new Map<string, PlacedNode>();
  for (const c of out.children ?? []) {
    nodes.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? NODE_H });
  }
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const edges: PlacedEdge[] = [];
  for (const e of out.edges ?? []) {
    const src = byId.get(e.id);
    const section = e.sections?.[0];
    if (!src || !section) continue;
    edges.push({
      id: e.id,
      from: src.from,
      to: src.to,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    });
  }
  return { nodes, edges, width: out.width ?? 0, height: out.height ?? 0 };
}
