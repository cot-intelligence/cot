import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AgentMark } from './AgentMark';

type AgentId = 'claude' | 'cursor' | 'codex';

type Tone = 'cream' | 'vermilion' | 'olive' | 'cobalt' | 'cream-dark';

const tones: Record<Tone, { bg: string; text: string; sub: string }> = {
  cream: { bg: 'bg-cream', text: 'text-ink', sub: 'text-ink-lighter' },
  'cream-dark': { bg: 'bg-cream-dark', text: 'text-ink', sub: 'text-ink-lighter' },
  vermilion: { bg: 'bg-vermilion', text: 'text-cream', sub: 'text-cream/70' },
  olive: { bg: 'bg-olive', text: 'text-cream', sub: 'text-cream/70' },
  cobalt: { bg: 'bg-cobalt', text: 'text-cream', sub: 'text-cream/70' },
};

function FlowNode({
  label,
  sub,
  tone,
  children,
}: {
  label: string;
  sub?: string;
  tone: Tone;
  children?: React.ReactNode;
}) {
  const palette = tones[tone];

  return (
    <div
      className={`border-2 border-ink ${palette.bg} px-3 py-2.5 shadow-brutal-sm text-center min-w-[108px] max-w-[148px]`}>
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-ink !border-ink opacity-0"
      />
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-vermilion !border-ink"
      />
      {children && <div className="flex justify-center mb-1.5">{children}</div>}
      <div className={`font-mono text-[0.6rem] font-bold uppercase tracking-wide ${palette.text}`}>
        {label}
      </div>
      {sub && (
        <div className={`font-mono text-[0.55rem] font-bold uppercase mt-0.5 ${palette.sub}`}>
          {sub}
        </div>
      )}
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-vermilion !border-ink"
      />
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-ink !border-ink opacity-0"
      />
    </div>
  );
}

export function AgentFlowNode({ data }: NodeProps) {
  const agent = data.agent as AgentId;
  return (
    <FlowNode label={data.label as string} sub="hooks" tone="cream">
      <AgentMark id={agent} className={`h-7 w-7 ${agent === 'codex' ? 'text-ink' : ''}`} />
    </FlowNode>
  );
}

export function ServiceFlowNode({ data }: NodeProps) {
  return (
    <FlowNode
      label={data.label as string}
      sub={data.sub as string | undefined}
      tone={(data.tone as Tone) ?? 'cream'}
    />
  );
}

export const architectureNodeTypes = {
  agent: AgentFlowNode,
  service: ServiceFlowNode,
};
