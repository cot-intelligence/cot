import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSessions, type SessionSummary } from '../../../lib/api';
import { formatRelative } from '../../../lib/categoryMeta';
import { sourceLabel } from '../../../lib/sourceLabels';
import { Icon } from '../../ui/icons';
import { PageHeader } from '../../ui/PageHeader';
import { AnalysisLibrary } from './AnalysisLibrary';
import { Composer, ComposerRow, LensRow, Pills, SoonChip } from './parts';

type PickerFilter = 'All' | 'Bookmarked';

/**
 * Analysis home: start a run (pick a session, bookmarked ones first, and a
 * lens), with the library of saved runs beneath it.
 */
export function AnalysisHome() {
  const [lensKey, setLensKey] = useState('coach');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<PickerFilter>('All');
  const [q, setQ] = useState('');

  // Only the session list is read, to fill the picker; nothing is analyzed.
  const search = q.trim() || undefined;
  const { data: bookmarked } = useQuery({
    queryKey: ['analysisPicker', 'bookmarked', search],
    queryFn: () => getSessions({ bookmarked: true, limit: 25, q: search }),
  });
  const { data: recent } = useQuery({
    queryKey: ['analysisPicker', 'recent', search],
    queryFn: () => getSessions({ limit: 40, q: search }),
  });

  const bookmarkedIds = new Set((bookmarked ?? []).map((s) => s.id));
  const others = (recent ?? []).filter((s) => !bookmarkedIds.has(s.id));
  // Held as the object, not an id, so a search that filters it out of the list keeps it shown.
  const [picked, setPicked] = useState<SessionSummary | undefined>();
  const current = picked ?? bookmarked?.[0] ?? others[0];

  const pick = (s: SessionSummary) => {
    setPicked(s);
    setOpen(false);
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Analysis"
        description="Have an LLM read a session through a lens you choose. Each finding links to the moments behind it."
        actions={<SoonChip label="Coming soon" />}
      />

      <Composer
        stats={[
          // Illustrative only; the real figure comes from the digest.
          ['Digest', current ? `~${Math.max(4, Math.round(current.event_count / 14))}k tokens` : '...'],
          ['Est. cost', '~$0.35'],
          ['Model', 'Your API key'],
        ]}>
        <ComposerRow label="Session">
          <SessionCombo
            current={current}
            pickedId={current?.id}
            open={open}
            setOpen={setOpen}
            filter={filter}
            setFilter={setFilter}
            q={q}
            setQ={setQ}
            bookmarked={bookmarked ?? []}
            others={others}
            onPick={pick}
          />
        </ComposerRow>
        <LensRow lensKey={lensKey} onChange={setLensKey} />
      </Composer>

      <AnalysisLibrary />

      <p className="font-mono text-[0.68rem] text-fg/55">
        Preview with sample runs. Nothing is analyzed and no model is called yet.
      </p>
    </div>
  );
}

/** Session id, agent, size and recency as spaced columns rather than a dot-joined string. */
function SessionMeta({ s }: { s: SessionSummary }) {
  return (
    <span className="flex shrink-0 items-center gap-3 font-mono text-[0.6rem] tabular-nums text-fg/55">
      <span>{s.id.slice(0, 8)}</span>
      <span>{sourceLabel(s.source)}</span>
      <span>{s.event_count} events</span>
      <span className="w-14 text-right">{formatRelative(s.last_activity ?? s.started_at)}</span>
    </span>
  );
}

/** A one-line session field that opens a searchable list, bookmarked sessions first. */
function SessionCombo({
  current,
  pickedId,
  open,
  setOpen,
  filter,
  setFilter,
  q,
  setQ,
  bookmarked,
  others,
  onPick,
}: {
  current?: SessionSummary;
  pickedId?: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  filter: PickerFilter;
  setFilter: (v: PickerFilter) => void;
  q: string;
  setQ: (v: string) => void;
  bookmarked: SessionSummary[];
  others: SessionSummary[];
  onPick: (s: SessionSummary) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-[4px] border border-line/20 bg-bg px-3 py-2 text-left transition-colors hover:border-line/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion/50">
        {current?.bookmarked && <Icon name="bookmark-filled" className="h-3.5 w-3.5 shrink-0 text-fg/70" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
          {current ? current.title?.trim() || current.id : 'Loading sessions...'}
        </span>
        {current && (
          <span className="hidden lg:inline">
            <SessionMeta s={current} />
          </span>
        )}
        <Icon
          name="chevron-down"
          className={`h-3.5 w-3.5 shrink-0 text-fg/55 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 border border-line/20 bg-bg shadow-soft-lg">
          <div className="flex items-center gap-2 border-b border-line/10 p-2">
            <Icon name="search" className="ml-1 h-3.5 w-3.5 shrink-0 text-fg/50" />
            <input
              type="search"
              autoFocus
              aria-label="Search sessions"
              placeholder="Search by title, id or path"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent py-1 font-mono text-xs text-fg placeholder:text-fg/45 focus:outline-none"
            />
            <Pills label="Which sessions" options={['All', 'Bookmarked'] as const} value={filter} onChange={setFilter} />
          </div>
          <div className="scroll-thin max-h-72 overflow-y-auto" role="listbox" aria-label="Sessions">
            <PickerGroup label="Bookmarked" sessions={bookmarked} pickedId={pickedId} onPick={onPick} showEmpty />
            {filter === 'All' && <PickerGroup label="Recent" sessions={others} pickedId={pickedId} onPick={onPick} />}
          </div>
        </div>
      )}
    </div>
  );
}

function PickerGroup({
  label,
  sessions,
  pickedId,
  onPick,
  showEmpty = false,
}: {
  label: string;
  sessions: SessionSummary[];
  pickedId?: string;
  onPick: (s: SessionSummary) => void;
  showEmpty?: boolean;
}) {
  if (!sessions.length && !showEmpty) return null;
  return (
    <div>
      <p className="sticky top-0 z-10 flex items-center gap-2 border-b border-line/[0.08] bg-panel px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-fg/55">
        {label}
        <span className="font-mono text-[0.6rem] tabular-nums text-fg/50">{sessions.length}</span>
      </p>
      {!sessions.length && (
        <div className="flex items-center gap-3 px-3 py-3">
          <Icon name="bookmark" className="h-4 w-4 shrink-0 text-fg/45" />
          <p className="font-mono text-xs leading-snug text-fg/65">
            No bookmarked sessions yet. Bookmark one from its session page and it shows up here first.
          </p>
        </div>
      )}
      {sessions.map((s) => {
        const active = s.id === pickedId;
        return (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => onPick(s)}
            className={`relative flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors focus-visible:bg-surface focus-visible:outline-none ${
              active ? 'bg-surface' : 'hover:bg-fg/[0.04]'
            }`}>
            {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-fg" aria-hidden="true" />}
            {s.bookmarked && <Icon name="bookmark-filled" className="h-3.5 w-3.5 shrink-0 text-fg/70" />}
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg/90">{s.title?.trim() || s.id}</span>
            <span className="hidden sm:inline">
              <SessionMeta s={s} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
