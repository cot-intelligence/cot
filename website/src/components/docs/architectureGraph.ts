import type { Edge, Node } from '@xyflow/react';

export const architectureNodes: Node[] = [
  {
    id: 'claude',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'Claude', agent: 'claude' },
  },
  {
    id: 'cursor',
    type: 'agent',
    position: { x: 0, y: 92 },
    data: { label: 'Cursor', agent: 'cursor' },
  },
  {
    id: 'codex',
    type: 'agent',
    position: { x: 0, y: 184 },
    data: { label: 'Codex', agent: 'codex' },
  },
  {
    id: 'bridge',
    type: 'service',
    position: { x: 190, y: 92 },
    data: { label: 'Local Bridge', sub: '~/.cot/bin/cot', tone: 'vermilion' },
  },
  {
    id: 'collector',
    type: 'service',
    position: { x: 390, y: 92 },
    data: { label: 'Collector', sub: 'Docker · FastAPI', tone: 'olive' },
  },
  {
    id: 'storage',
    type: 'service',
    position: { x: 590, y: 20 },
    data: { label: 'SQLite DB', sub: '~/.cot/cot.db', tone: 'cobalt' },
  },
  {
    id: 'dashboard',
    type: 'service',
    position: { x: 590, y: 164 },
    data: { label: 'Dashboard', sub: 'sessions · insights', tone: 'cream' },
  },
  {
    id: 'telemetry',
    type: 'service',
    position: { x: 390, y: 230 },
    data: { label: 'cot.run', sub: 'telemetry only', tone: 'cream-dark' },
  },
];

const edgeDefaults = {
  type: 'smoothstep' as const,
  animated: true,
  sourceHandle: 'right',
  targetHandle: 'left',
  style: { stroke: '#111111', strokeWidth: 2 },
  labelStyle: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    fontWeight: 700,
    fill: '#666666',
    textTransform: 'uppercase' as const,
  },
  labelBgStyle: { fill: '#E8E4DE', fillOpacity: 0.9 },
  labelBgPadding: [6, 4] as [number, number],
  labelBgBorderRadius: 0,
};

export const architectureEdges: Edge[] = [
  {
    id: 'claude-bridge',
    source: 'claude',
    target: 'bridge',
    ...edgeDefaults,
    label: 'hook events',
  },
  {
    id: 'cursor-bridge',
    source: 'cursor',
    target: 'bridge',
    ...edgeDefaults,
  },
  {
    id: 'codex-bridge',
    source: 'codex',
    target: 'bridge',
    ...edgeDefaults,
  },
  {
    id: 'bridge-collector',
    source: 'bridge',
    target: 'collector',
    ...edgeDefaults,
    label: 'POST /v1/ingest',
  },
  {
    id: 'collector-storage',
    source: 'collector',
    target: 'storage',
    ...edgeDefaults,
    label: 'store',
  },
  {
    id: 'collector-dashboard',
    source: 'collector',
    target: 'dashboard',
    ...edgeDefaults,
    label: 'insights',
  },
  {
    id: 'collector-telemetry',
    source: 'collector',
    target: 'telemetry',
    sourceHandle: 'bottom',
    targetHandle: 'top',
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#666666', strokeWidth: 2, strokeDasharray: '6 6' },
    label: 'optional · internet',
    labelStyle: edgeDefaults.labelStyle,
    labelBgStyle: edgeDefaults.labelBgStyle,
    labelBgPadding: edgeDefaults.labelBgPadding,
    labelBgBorderRadius: edgeDefaults.labelBgBorderRadius,
  },
];
