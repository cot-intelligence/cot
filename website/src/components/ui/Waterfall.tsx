import React from 'react';
import { depth } from '../../content';

const barColors = {
  ink: 'bg-ink',
  cream: 'bg-cream border border-ink',
  vermilion: 'bg-vermilion',
};

export function Waterfall() {
  const { trace } = depth;

  return (
    <div className="border border-ink shadow-soft-lg bg-cream overflow-hidden">
      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-72 bg-cream-dark p-6 flex flex-col gap-6 border-b lg:border-b-0 lg:border-r border-ink">
          <div>
            <div className="text-[0.6rem] font-mono font-bold uppercase text-ink-lighter mb-1">TRACE_ID</div>
            <div className="font-mono text-lg font-bold bg-ink text-cream px-2 py-1 inline-block">{trace.id}</div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[0.6rem] font-mono font-bold uppercase text-ink-lighter mb-1">LATENCY</div>
              <div className="font-mono text-xl font-bold">{trace.latency}</div>
            </div>
            <div>
              <div className="text-[0.6rem] font-mono font-bold uppercase text-ink-lighter mb-1">COST</div>
              <div className="font-mono text-xl font-bold text-vermilion">{trace.cost}</div>
            </div>
          </div>
          <div>
            <div className="text-[0.6rem] font-mono font-bold uppercase text-ink-lighter mb-1">EVAL_SCORE</div>
            <div className="inline-flex px-3 py-1.5 border border-ink bg-olive text-cream font-mono font-bold text-sm">
              {trace.eval}
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex justify-between font-mono text-[0.65rem] font-bold uppercase bg-ink text-cream px-4 py-3 border-b border-ink">
            <span>OPERATION</span>
            <span>TIMELINE</span>
          </div>
          {trace.spans.map((span) => (
            <div
              key={span.name}
              className="flex items-center gap-3 px-4 py-3 border-b border-ink/[0.08] hover:bg-cream-dark transition-colors group relative">
              <div
                className={`w-44 shrink-0 font-mono text-xs font-bold uppercase ${span.nested ? 'pl-6 relative' : ''} ${span.color === 'vermilion' ? 'text-vermilion' : ''}`}>
                {span.nested && (
                  <div className="absolute left-2 top-0 bottom-0 w-2 border-l border-b border-ink" />
                )}
                &gt; {span.name}
              </div>
              <div className="flex-1 h-7 relative border-l-2 border-ink pl-3">
                <div
                  className={`absolute left-3 top-1 h-5 border border-ink ${barColors[span.color]}`}
                  style={{ width: span.width, maxWidth: 'calc(100% - 12px)' }}
                />
                {span.tooltip && (
                  <div className="absolute left-1/2 -top-8 border border-ink bg-ink text-cream text-[0.6rem] font-mono font-bold px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                    {span.tooltip}
                  </div>
                )}
              </div>
              <div className="w-16 text-right font-mono text-xs font-bold">{span.duration}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
