import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '../../lib/agents';
import { getSessions, type SessionSummary } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { Icon } from '../ui/icons';
import { Select } from '../ui/Select';
import { SessionRow } from './SessionRow';

interface SessionListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  /** Shown temporarily on hover while the sidebar is collapsed. */
  peeking?: boolean;
  onToggle?: () => void;
}

export function SessionList({
  selectedId,
  onSelect,
  collapsed = false,
  peeking = false,
  onToggle,
}: SessionListProps) {
  const [status, setStatus] = useState<string>('');
  const [source, setSource] = useState<AgentId | ''>('');
  const [q, setQ] = useState('');

  const { data: sessions } = usePolling<SessionSummary[]>(
    ['sessions', status, source, q],
    () => getSessions({ limit: 100, status: status || undefined, source: source || undefined, q: q || undefined }),
    3000,
  );

  // Both states stay mounted and crossfade, so collapsing never swaps the
  // panel out in a single frame. The hidden side is inert (no focus, no a11y).
  const panelRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = collapsed;
    if (railRef.current) railRef.current.inert = !collapsed;
  }, [collapsed]);

  return (
    <div className="relative h-full w-80">
      <div
        ref={railRef}
        className={`rail-swap absolute inset-y-0 left-0 z-10 flex w-10 flex-col items-center border-r border-line/10 bg-bg py-3 ${
          collapsed ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sessions sidebar"
          title="Show sessions"
          className="rounded-md p-1.5 text-fg/45 transition-colors hover:bg-surface hover:text-fg">
          <Icon name="chevron-right" className="h-4 w-4" />
        </button>
        <span
          className="mt-3 font-mono text-[0.55rem] uppercase tracking-widest text-fg/30 [writing-mode:vertical-rl]"
          aria-hidden="true">
          Sessions
        </span>
      </div>
      <aside
        ref={panelRef}
        className={`rail-swap flex h-full w-80 flex-col border-r border-line/10 bg-bg ${collapsed ? 'opacity-0' : 'opacity-100'}`}>
        <div className="space-y-3 border-b border-line/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/50">
              Sessions
            </h2>
            <button
              type="button"
              onClick={onToggle}
              aria-label={peeking ? 'Keep sessions sidebar open' : 'Collapse sessions sidebar'}
              title={peeking ? 'Keep open' : 'Hide sessions'}
              className="rounded-md p-1 text-fg/40 transition-colors hover:bg-surface hover:text-fg">
              <Icon name={peeking ? 'chevron-right' : 'chevron-left'} className="h-4 w-4" />
            </button>
          </div>
          <input
            type="search"
            placeholder="Search id or cwd…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full border border-fg/20 bg-surface px-3 py-2 font-mono text-xs text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
          />
          <div className="flex gap-2">
            <Select
              className="min-w-0 flex-1"
              aria-label="Filter by status"
              value={status}
              onChange={setStatus}
              options={[
                { value: '', label: 'All status' },
                { value: 'active', label: 'Active' },
                { value: 'completed', label: 'Completed' },
              ]}
            />
            <Select
              className="min-w-0 flex-1"
              aria-label="Filter by source"
              value={source}
              onChange={(v) => setSource(v as AgentId | '')}
              options={[
                { value: '', label: 'All sources' },
                { value: 'claude', label: 'Claude' },
                { value: 'cursor', label: 'Cursor' },
                { value: 'codex', label: 'Codex' },
              ]}
            />
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {(sessions ?? []).map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              selected={s.id === selectedId}
              onSelect={() => onSelect(s.id)}
            />
          ))}
          {sessions && !sessions.length && (
            <p className="p-6 font-mono text-xs text-fg/40">
              No sessions yet. Run an agent with hooks configured.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
