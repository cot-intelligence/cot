import React from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { FadeIn } from '../ui/FadeIn';
import { architectureNodeTypes } from './ArchitectureNodes';
import { architectureEdges, architectureNodes } from './architectureGraph';

function ArchitectureDiagram() {
  return (
    <ReactFlow
      nodes={architectureNodes}
      edges={architectureEdges}
      nodeTypes={architectureNodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      proOptions={{ hideAttribution: true }}
      className="architecture-flow bg-cream-dark">
      <Background
        variant={BackgroundVariant.Lines}
        gap={40}
        size={1}
        color="rgba(17,17,17,0.06)"
      />
    </ReactFlow>
  );
}

export function ArchitectureFlow() {
  return (
    <FadeIn>
      <div className="border border-ink bg-cream-dark shadow-soft-md overflow-hidden">
        <div className="border-b border-ink bg-ink text-cream px-4 py-2 flex items-center justify-between font-mono text-[0.6rem] font-bold uppercase tracking-widest">
          <span>ARCHITECTURE_FLOW</span>
          <span className="text-cream/50">local · optional telemetry</span>
        </div>

        <div className="h-[300px] md:h-[340px]">
          <ReactFlowProvider>
            <ArchitectureDiagram />
          </ReactFlowProvider>
        </div>

        <div className="border-t border-ink/10 px-4 py-3 grid sm:grid-cols-3 gap-3 font-mono text-[0.65rem] font-bold uppercase text-ink-lighter">
          <span className="flex items-center gap-2">
            <span className="w-6 border-t-2 border-ink" />
            Local data path
          </span>
          <span className="flex items-center gap-2">
            <span className="w-6 border-t-2 border-dashed border-ink-lighter" />
            Optional telemetry
          </span>
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-vermilion animate-pulse" />
            Live flow
          </span>
        </div>
      </div>
    </FadeIn>
  );
}
