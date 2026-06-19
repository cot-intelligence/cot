import React from 'react';

type Accent = 'vermilion' | 'olive' | 'cobalt';

interface Cell {
  label: string;
  value: string;
  accent?: Accent;
}

interface DataPanelProps {
  header: string;
  context?: string;
  cells: readonly Cell[];
  dark?: boolean;
}

const accents: Record<Accent, string> = {
  vermilion: 'text-vermilion',
  olive: 'text-olive',
  cobalt: 'text-cobalt',
};

export function DataPanel({ header, context, cells, dark }: DataPanelProps) {
  const bg = dark ? 'bg-ink' : 'bg-cream';
  const text = dark ? 'text-cream' : 'text-ink';
  const border = dark ? 'border-cream/20' : 'border-ink';
  const headerBg = dark ? 'bg-cream/10' : 'bg-ink';
  const headerText = dark ? 'text-cream' : 'text-cream';
  const labelColor = dark ? 'text-cream/50' : 'text-ink-lighter';
  const sep = dark ? 'border-cream/10' : 'border-ink/[0.08]';

  return (
    <div className={`border ${border} shadow-soft-md ${bg} overflow-hidden`}>
      <div
        className={`${headerBg} ${headerText} px-4 py-3 flex items-center justify-between font-mono font-bold uppercase text-xs tracking-widest`}>
        <span>{header}</span>
        {context && <span className="opacity-50">{context}</span>}
      </div>
      <div className="grid grid-cols-2">
        {cells.map((cell, i) => (
          <div
            key={cell.label}
            className={`p-4 ${i < cells.length - 2 ? `border-b ${sep}` : ''} ${i % 2 === 0 ? `border-r ${sep}` : ''}`}>
            <div className={`text-[0.56rem] font-mono font-bold uppercase ${labelColor} mb-1`}>
              {cell.label}
            </div>
            <div
              className={`text-sm font-mono font-bold ${text} ${cell.accent ? accents[cell.accent] : ''}`}>
              {cell.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
