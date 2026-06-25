import { Fragment, useEffect, useMemo, useState } from 'react';
import { activateOnKey } from '../../lib/a11y';
import { getSessions, setSessionArchived, type SessionSummary } from '../../lib/api';
import { formatRelative, toTimestampString } from '../../lib/categoryMeta';
import { sourceLabel } from '../../lib/sourceLabels';
import { Icon } from '../ui/icons';
import { SourceBadge } from '../ui/SourceBadge';
import { Select } from '../ui/Select';

interface SessionsTableProps {
  onSelect: (id: string) => void;
}

type SortKey = 'recent' | 'events' | 'duration';
type GroupKey = 'project' | 'status' | 'source' | 'day';

const GROUPBY_STORE = 'cot.sessions.groupBy';

function readGroupBy(): GroupKey {
  try {
    const v = localStorage.getItem(GROUPBY_STORE);
    if (v === 'project' || v === 'status' || v === 'source' || v === 'day') return v;
  } catch {
    /* ignore */
  }
  return 'project';
}

export function SessionsTable({ onSelect }: SessionsTableProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [groupBy, setGroupBy] = useState<GroupKey>(readGroupBy);
  const [showArchived, setShowArchived] = useState(false);
  // Explicit expand/collapse choices by group key. Absent ⇒ use the default,
  // which is "only the most recent group is open".
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getSessions({
          limit: 200,
          status: status || undefined,
          source: source || undefined,
          q: q || undefined,
          archived: showArchived,
        });
        if (active) {
          setSessions(data);
          setLoaded(true);
        }
      } catch {
        /* collector offline */
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [status, source, q, showArchived]);

  const changeGroupBy = (g: GroupKey) => {
    setGroupBy(g);
    setExpandOverrides({}); // a new grouping invalidates the old open/closed set
    try {
      localStorage.setItem(GROUPBY_STORE, g);
    } catch {
      /* ignore */
    }
  };

  const toggleArchive = async (s: SessionSummary) => {
    // Active view → archive; archived view → restore. Either way the row leaves
    // the current list, so drop it optimistically; the poll reconciles.
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    try {
      await setSessionArchived(s.id, !showArchived);
    } catch {
      /* poll will restore the row if it failed */
    }
  };

  const sourceOptions = useMemo(() => {
    const set = new Set<string>(['claude', 'cursor', 'codex']);
    sessions.forEach((s) => set.add(s.source));
    return Array.from(set);
  }, [sessions]);

  // Bucket sessions by the active grouping dimension. Items are ordered by the
  // selected sort; groups float to the top by their most recent session.
  const groups = useMemo(() => {
    const map = new Map<string, GroupBucket>();
    for (const s of sessions) {
      const g = groupOf(s, groupBy);
      let bucket = map.get(g.key);
      if (!bucket) {
        bucket = { key: g.key, label: g.label, title: g.title, items: [] };
        map.set(g.key, bucket);
      }
      bucket.items.push(s);
    }

    const sortItems = (items: SessionSummary[]) => {
      const copy = [...items];
      if (sort === 'events') copy.sort((a, b) => b.event_count - a.event_count);
      else if (sort === 'duration')
        copy.sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0));
      else copy.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)));
      return copy;
    };

    return Array.from(map.values())
      .map((b) => ({
        ...b,
        items: sortItems(b.items),
        lastActivity: b.items.reduce((m, s) => (recencyOf(s) > m ? recencyOf(s) : m), ''),
        activeCount: b.items.filter((s) => s.status === 'active').length,
      }))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }, [sessions, groupBy, sort]);

  const mostRecentKey = groups[0]?.key;
  const isExpanded = (key: string) => expandOverrides[key] ?? key === mostRecentKey;
  const toggleGroup = (key: string) =>
    setExpandOverrides((prev) => ({ ...prev, [key]: !isExpanded(key) }));

  // Adaptive pill: the first slot shows source, except when you're already
  // grouped by source (then it's redundant) — show the project instead.
  const slot1: 'source' | 'project' = groupBy === 'source' ? 'project' : 'source';

  return (
    <div className="border border-line/10 bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/10 p-3">
        <input
          type="search"
          placeholder="Search id or path…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-[12rem] flex-1 border border-fg/20 bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
        />
        <Select
          aria-label="Group sessions by"
          value={groupBy}
          onChange={(v) => changeGroupBy(v as GroupKey)}
          options={[
            { value: 'project', label: 'Group: Project' },
            { value: 'status', label: 'Group: Status' },
            { value: 'source', label: 'Group: Source' },
            { value: 'day', label: 'Group: Day' },
          ]}
        />
        <Select
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
          aria-label="Filter by source"
          value={source}
          onChange={setSource}
          options={[
            { value: '', label: 'All sources' },
            ...sourceOptions.map((s) => ({ value: s, label: sourceLabel(s) })),
          ]}
        />
        <Select
          aria-label="Sort sessions"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'events', label: 'Most events' },
            { value: 'duration', label: 'Longest' },
          ]}
        />
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          aria-pressed={showArchived}
          title={showArchived ? 'Show active sessions' : 'Show archived sessions'}
          className={`flex h-8 items-center gap-1.5 border px-2.5 font-mono text-[0.6rem] uppercase tracking-widest transition-colors focus-visible:border-vermilion focus-visible:outline-none ${
            showArchived
              ? 'border-fg/50 bg-surface text-fg'
              : 'border-fg/20 text-fg/55 hover:border-fg/50 hover:text-fg'
          }`}>
          <Icon name="archive" className="h-3.5 w-3.5" />
          Archived
        </button>
      </div>

      <div className="scroll-thin overflow-x-auto">
        {!loaded && <BoardSkeleton />}

        {loaded &&
          groups.map((g) => {
            const expanded = isExpanded(g.key);
            return (
              <Fragment key={g.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(g.key)}
                  onKeyDown={(e) => activateOnKey(e, () => toggleGroup(g.key))}
                  className="flex cursor-pointer items-center gap-2.5 border-b border-line/10 bg-surface/40 px-3 py-2.5 transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion">
                  <Icon
                    name={expanded ? 'chevron-down' : 'chevron-right'}
                    className="h-4 w-4 shrink-0 text-fg/40"
                  />
                  <span
                    className="truncate font-mono text-sm font-bold text-fg"
                    title={g.title || g.label}>
                    {g.label}
                  </span>
                  <span className="shrink-0 font-mono text-[0.6rem] tabular-nums text-fg/40">
                    {g.items.length}
                  </span>
                  {g.activeCount > 0 && (
                    <span className="shrink-0 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-cobalt">
                      {g.activeCount} active
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[0.65rem] text-fg/45">
                    {formatRelative(g.lastActivity)}
                  </span>
                </div>

                {expanded &&
                  g.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      slot1={slot1}
                      showArchived={showArchived}
                      onSelect={onSelect}
                      onArchive={toggleArchive}
                    />
                  ))}
              </Fragment>
            );
          })}

        {loaded && !sessions.length && (
          <p className="p-8 text-center font-mono text-xs text-fg/40">
            No sessions match. Run an agent with hooks configured, or adjust filters.
          </p>
        )}
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  slot1: 'source' | 'project';
  showArchived: boolean;
  onSelect: (id: string) => void;
  onArchive: (s: SessionSummary) => void;
}

function SessionRow({ session: s, slot1, showArchived, onSelect, onArchive }: SessionRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => activateOnKey(e, () => onSelect(s.id))}
      className="group flex cursor-pointer items-center gap-3 border-b border-line/10 px-3 py-2.5 transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion">
      <StatusGlyph status={s.status} archived={s.archived} />
      <span className="shrink-0 font-mono text-[0.65rem] tabular-nums text-fg/35">
        {s.id.slice(0, 6)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-fg">
        {s.title || `Session ${s.id.slice(0, 8)}`}
      </span>

      <div className="flex shrink-0 items-center gap-3">
        {slot1 === 'source' ? (
          <SourceBadge source={s.source} />
        ) : (
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/55">
            {basename(s.cwd || '—')}
          </span>
        )}

        <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] tabular-nums text-fg/45">
          <Icon name="event" className="h-3 w-3" />
          {s.event_count}
        </span>

        <span className="w-12 shrink-0 text-right font-mono text-[0.65rem] text-fg/45">
          {formatRelative(s.last_activity || s.started_at)}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive(s);
          }}
          aria-label={showArchived ? 'Unarchive session' : 'Archive session'}
          title={showArchived ? 'Unarchive session' : 'Archive session'}
          className="rounded p-1 text-fg/35 opacity-0 transition hover:bg-panel hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100">
          <Icon name={showArchived ? 'unarchive' : 'archive'} className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** A small Linear-like state circle: filled+pulsing for active, ring for done. */
function StatusGlyph({ status, archived }: { status: string; archived: boolean }) {
  if (archived) {
    return <span className="h-3 w-3 shrink-0 rounded-full border-2 border-fg/20" aria-label="Archived" />;
  }
  if (status === 'active') {
    return (
      <span className="relative grid h-3 w-3 shrink-0 place-items-center rounded-full border-2 border-cobalt" aria-label="Active">
        <span className="h-1 w-1 animate-pulse rounded-full bg-cobalt" />
      </span>
    );
  }
  return <span className="h-3 w-3 shrink-0 rounded-full border-2 border-fg/30 bg-fg/20" aria-label="Done" />;
}

function BoardSkeleton() {
  return (
    <div className="divide-y divide-line/10">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <span className="h-3 w-3 shrink-0 rounded-full bg-fg/10" />
          <span className="h-3 w-2/5 rounded bg-fg/10" />
          <span className="ml-auto h-3 w-16 rounded bg-fg/10" />
        </div>
      ))}
    </div>
  );
}

interface GroupBucket {
  key: string;
  label: string;
  title: string;
  items: SessionSummary[];
}

const recencyOf = (s: SessionSummary) => toTimestampString(s.last_activity || s.started_at);

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function dayLabel(iso: string): { key: string; label: string } {
  if (!iso) return { key: 'zzzz', label: 'Unknown date' };
  const d = new Date(iso);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (diff <= 0) return { key, label: 'Today' };
  if (diff === 1) return { key, label: 'Yesterday' };
  if (diff < 7) return { key, label: d.toLocaleDateString(undefined, { weekday: 'long' }) };
  return { key, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
}

function groupOf(
  s: SessionSummary,
  by: GroupKey,
): { key: string; label: string; title: string } {
  if (by === 'status') {
    if (s.archived) return { key: 'archived', label: 'Archived', title: '' };
    if (s.status === 'active') return { key: 'active', label: 'Active', title: '' };
    return { key: 'done', label: 'Done', title: '' };
  }
  if (by === 'source') {
    return { key: s.source, label: sourceLabel(s.source), title: '' };
  }
  if (by === 'day') {
    const { key, label } = dayLabel(recencyOf(s));
    return { key, label, title: '' };
  }
  const cwd = s.cwd || '(unknown path)';
  return { key: cwd, label: basename(cwd), title: cwd };
}

