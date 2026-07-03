import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineItem } from '../../../../lib/api';
import { formatClock, formatDateTime, getCategoryMeta } from '../../../../lib/categoryMeta';
import {
  eventKey,
  sortEventsByTime,
  type SubagentRun,
  type TimeSort,
} from '../../../../lib/sessionView';
import { Icon } from '../../../ui/icons';
import { ChatTimeline, type ChatTimelineHandle, type ExpansionRequest } from '../ChatTimeline';
import { SubagentNestedList } from '../SubagentNestedList';

interface TimelineTabProps {
  items: TimelineItem[];
  runs: SubagentRun[];
  focusEventId?: number;
  sessionId: string;
}

export function TimelineTab({ items, runs, focusEventId, sessionId }: TimelineTabProps) {
  // Hidden categories / models — toggle to hide, empty set = show all
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [timeSort, setTimeSort] = useState<TimeSort>('asc');
  const [expansionRequest, setExpansionRequest] = useState<ExpansionRequest>({ open: false, nonce: 0 });
  const [activeKey, setActiveKey] = useState<string | null>(
    focusEventId != null ? `${sessionId}:${focusEventId}` : null,
  );
  const chatRef = useRef<ChatTimelineHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarRaf = useRef(0);

  useEffect(() => {
    if (focusEventId != null) {
      setHidden(new Set());
      const key = `${sessionId}:${focusEventId}`;
      setActiveKey(key);
      requestAnimationFrame(() => chatRef.current?.scrollToAndExpand(key));
    }
  }, [focusEventId, sessionId]);

  // Build per-category counts from the actual data
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    return [...counts.entries()]
      .map(([cat, count]) => ({ cat, label: getCategoryMeta(cat).label, count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  // Build per-model counts
  const models = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.model) counts.set(it.model, (counts.get(it.model) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([model, count]) => ({ model, label: shortModel(model), count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  const filtered = useMemo(() => {
    if (hidden.size === 0 && hiddenModels.size === 0) return items;
    return items.filter((it) => {
      if (hidden.size > 0 && hidden.has(it.category)) return false;
      if (hiddenModels.size > 0 && it.model && hiddenModels.has(it.model)) return false;
      return true;
    });
  }, [items, hidden, hiddenModels]);

  const sorted = useMemo(
    () => sortEventsByTime(filtered, timeSort),
    [filtered, timeSort],
  );

  // Auto-select first if current is gone
  useEffect(() => {
    if (!sorted.some((it) => eventKey(it, sessionId) === activeKey)) {
      setActiveKey(sorted[0] ? eventKey(sorted[0], sessionId) : null);
    }
  }, [sorted, activeKey, sessionId]);

  const toggleFilter = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const toggleModel = useCallback((key: string) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const allOn = hidden.size === 0 && hiddenModels.size === 0;
    if (allOn) {
      setHidden(new Set(categories.map((c) => c.cat)));
      setHiddenModels(new Set(models.map((m) => m.model)));
    } else {
      setHidden(new Set());
      setHiddenModels(new Set());
    }
  }, [hidden, hiddenModels, categories, models]);

  const setAllExpanded = useCallback((open: boolean) => {
    setExpansionRequest((prev) => ({ open, nonce: prev.nonce + 1 }));
  }, []);

  // Card click in chat body → highlight in sidebar
  const onCardClick = useCallback((key: string) => {
    setActiveKey(key);
  }, []);

  // Sidebar click → scroll chat + expand
  const onSidebarSelect = useCallback((item: TimelineItem) => {
    const key = eventKey(item, sessionId);
    setActiveKey(key);
    chatRef.current?.scrollToAndExpand(key);
  }, [sessionId]);

  // Smooth sidebar auto-scroll — debounced with rAF to prevent jumpiness
  useEffect(() => {
    if (activeKey == null || !sidebarRef.current) return;
    cancelAnimationFrame(sidebarRaf.current);
    sidebarRaf.current = requestAnimationFrame(() => {
      const el = sidebarRef.current?.querySelector(`[data-sidebar-key="${CSS.escape(activeKey)}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(sidebarRaf.current);
  }, [activeKey]);

  // Subagent nested mode: only when subagent is the sole visible category
  const hasSubagents = categories.some((c) => c.cat === 'subagent');
  const nested = hasSubagents && runs.length > 0
    && !hidden.has('subagent')
    && categories.every((c) => c.cat === 'subagent' || hidden.has(c.cat));

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="shrink-0 border-b border-line/10 px-6 py-2 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center gap-2">
          <span className="font-mono text-[0.58rem] tabular-nums text-fg/35">
            {sorted.length}/{items.length} events
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {/* Model pills */}
            <div className="scroll-thin flex min-w-0 items-center gap-1.5 overflow-x-auto">
              {models.map((m) => {
                const on = !hiddenModels.has(m.model);
                return (
                  <button
                    key={m.model}
                    type="button"
                    onClick={() => toggleModel(m.model)}
                    className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[0.55rem] tabular-nums transition-colors ${
                      on
                        ? 'bg-vermilion/10 text-vermilion'
                        : 'bg-fg/5 text-fg/25 line-through decoration-fg/15'
                    }`}
                    title={m.model}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            <FilterDropdown
              categories={categories}
              models={models}
              hidden={hidden}
              hiddenModels={hiddenModels}
              onToggle={toggleFilter}
              onToggleModel={toggleModel}
              onToggleAll={toggleAll}
              total={items.length}
            />
            <button
              type="button"
              onClick={() => setAllExpanded(!expansionRequest.open)}
              title={expansionRequest.open ? 'Collapse all session events' : 'Expand all session events'}
              aria-label={expansionRequest.open ? 'Collapse all session events' : 'Expand all session events'}
              aria-pressed={expansionRequest.open}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-line/15 px-2.5 py-1.5 font-mono text-[0.62rem] uppercase tracking-widest text-fg/70 transition-colors hover:border-line/30 hover:text-fg"
            >
              <Icon name={expansionRequest.open ? 'chevron-up' : 'chevron-down'} className="h-3 w-3" />
              {expansionRequest.open ? 'Collapse' : 'Expand'}
            </button>
            <button
              type="button"
              onClick={() => setTimeSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
              title={timeSort === 'asc' ? 'Oldest first — click for newest' : 'Newest first — click for oldest'}
              className="flex items-center gap-1.5 rounded-md border border-line/15 px-2.5 py-1.5 font-mono text-[0.62rem] uppercase tracking-widest text-fg/70 transition-colors hover:border-line/30 hover:text-fg"
            >
              <Icon name={timeSort === 'asc' ? 'chevron-up' : 'chevron-down'} className="h-3 w-3" />
              {timeSort === 'asc' ? 'Oldest' : 'Newest'}
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar + Chat body */}
      <div className="min-h-0 flex-1 px-6 py-3 sm:px-8">
        <div className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-lg border border-line/10">
          {/* Sidebar */}
          <div
            ref={sidebarRef}
            className="scroll-thin hidden w-60 shrink-0 overflow-y-auto border-r border-line/10 bg-bg lg:block"
          >
            {nested ? (
              <SubagentNestedList
                items={items}
                runs={runs}
                selectedKey={activeKey}
                sessionId={sessionId}
                onSelect={onSidebarSelect}
              />
            ) : (
              <SidebarList
                items={sorted}
                activeKey={activeKey}
                sessionId={sessionId}
                onSelect={onSidebarSelect}
              />
            )}
          </div>

          {/* Chat body */}
          <div className="min-w-0 flex-1">
            {sorted.length === 0 && items.length > 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <span className="font-mono text-3xl text-fg/10">⦰</span>
                <p className="font-mono text-xs text-fg/35">
                  {items.length} event{items.length === 1 ? '' : 's'} in this session
                </p>
                <p className="font-mono text-[0.65rem] text-fg/25">
                  Use the filters to choose which event types to show
                </p>
              </div>
            ) : (
              <ChatTimeline
                ref={chatRef}
                items={sorted}
                runs={runs}
                sessionId={sessionId}
                expansionRequest={expansionRequest}
                onCardClick={onCardClick}
              />
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-line/10 bg-bg px-6 py-1.5 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/30">
            {sorted.length} event{sorted.length === 1 ? '' : 's'}
            {hidden.size > 0 && ` · ${items.length - sorted.length} hidden`}
          </span>
          <span className="font-mono text-[0.55rem] tabular-nums text-fg/25">
            {activeKey != null && `#${activeKey.split(':').pop()}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SidebarList({
  items,
  activeKey,
  sessionId,
  onSelect,
}: {
  items: TimelineItem[];
  activeKey: string | null;
  sessionId: string;
  onSelect: (item: TimelineItem) => void;
}) {
  return (
    <ul className="divide-y divide-line/10">
      {items.map((item) => {
        const meta = getCategoryMeta(item.category);
        const key = eventKey(item, sessionId);
        const active = key === activeKey;
        return (
          <li key={key} className="[content-visibility:auto] [contain-intrinsic-size:auto_44px]">
            <button
              type="button"
              data-sidebar-key={key}
              onClick={() => onSelect(item)}
              className={`flex w-full items-start gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
                active
                  ? 'border-l-vermilion bg-surface'
                  : 'border-l-transparent hover:bg-surface/50'
              }`}
            >
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center justify-between gap-1">
                  <span className={`truncate font-mono text-[0.5rem] font-bold uppercase tracking-widest ${meta.color}`}>
                    {meta.label}
                    {item.inlined_approval_review ? ' · review' : ''}
                    {item.inlined_reviewed_session ? ' · reviewed' : ''}
                    {item.inlined_subagent ? ' · subagent' : ''}
                  </span>
                  <span className="shrink-0 font-mono text-[0.48rem] tabular-nums text-fg/25" title={formatDateTime(item.start_ts || item.ts)}>
                    {formatClock(item.start_ts || item.ts)}
                  </span>
                </span>
                <span className="block truncate font-mono text-[0.68rem] font-bold text-fg">
                  {item.title}
                </span>
              </span>
            </button>
          </li>
        );
      })}
      {!items.length && (
        <li className="flex flex-col items-center gap-1 px-3 py-10 text-center">
          <span className="font-mono text-lg text-fg/10">⦰</span>
          <span className="font-mono text-[0.6rem] text-fg/25">Use filters to show events</span>
        </li>
      )}
    </ul>
  );
}

function shortModel(model: string): string {
  return model
    .replace(/^(claude-|gpt-|gemini-)/, '')
    .replace(/-\d{8}$/, '');
}

function FilterDropdown({
  categories,
  models,
  hidden,
  hiddenModels,
  onToggle,
  onToggleModel,
  onToggleAll,
  total,
}: {
  categories: { cat: string; label: string; count: number }[];
  models: { model: string; label: string; count: number }[];
  hidden: Set<string>;
  hiddenModels: Set<string>;
  onToggle: (cat: string) => void;
  onToggleModel: (model: string) => void;
  onToggleAll: () => void;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allOn = hidden.size === 0 && hiddenModels.size === 0;
  const totalFilters = categories.length + models.length;
  const activeFilters = categories.filter((c) => !hidden.has(c.cat)).length
    + models.filter((m) => !hiddenModels.has(m.model)).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-line/15 px-2.5 py-1.5 font-mono text-[0.62rem] uppercase tracking-widest text-fg/70 transition-colors hover:border-line/30 hover:text-fg"
      >
        <Icon name="list" className="h-3 w-3" />
        Filter
        {!allOn && (
          <span className="rounded bg-vermilion/15 px-1 py-px font-bold text-vermilion">
            {activeFilters}/{totalFilters}
          </span>
        )}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="h-2.5 w-2.5 text-fg/40" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-line/15 bg-bg py-1 shadow-soft-md">
          {/* Select all */}
          <button
            type="button"
            onClick={onToggleAll}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[0.62rem] uppercase tracking-widest text-fg/60 transition-colors hover:bg-surface"
          >
            <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
              allOn ? 'border-vermilion bg-vermilion text-cream' : 'border-fg/25'
            }`}>
              {allOn && <span className="text-[0.5rem]">✓</span>}
            </span>
            All
            <span className="ml-auto tabular-nums text-fg/30">{total}</span>
          </button>

          <div className="my-1 border-t border-line/10" />

          {/* Categories */}
          <div className="px-3 py-1 font-mono text-[0.5rem] uppercase tracking-widest text-fg/25">Categories</div>
          {categories.map((c) => {
            const on = !hidden.has(c.cat);
            const meta = getCategoryMeta(c.cat);
            return (
              <button
                key={c.cat}
                type="button"
                onClick={() => onToggle(c.cat)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[0.62rem] transition-colors hover:bg-surface"
              >
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                  on ? 'border-vermilion bg-vermilion text-cream' : 'border-fg/25'
                }`}>
                  {on && <span className="text-[0.5rem]">✓</span>}
                </span>
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                <span className={`uppercase tracking-widest ${on ? 'text-fg/70' : 'text-fg/30'}`}>
                  {c.label}
                </span>
                <span className="ml-auto tabular-nums text-fg/30">{c.count}</span>
              </button>
            );
          })}

          {/* Models */}
          {models.length > 0 && (
            <>
              <div className="my-1 border-t border-line/10" />
              <div className="px-3 py-1 font-mono text-[0.5rem] uppercase tracking-widest text-fg/25">Models</div>
              {models.map((m) => {
                const on = !hiddenModels.has(m.model);
                return (
                  <button
                    key={m.model}
                    type="button"
                    onClick={() => onToggleModel(m.model)}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[0.62rem] transition-colors hover:bg-surface"
                  >
                    <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                      on ? 'border-vermilion bg-vermilion text-cream' : 'border-fg/25'
                    }`}>
                      {on && <span className="text-[0.5rem]">✓</span>}
                    </span>
                    <span className={`rounded-full px-1.5 py-px text-[0.5rem] ${on ? 'bg-vermilion/10 text-vermilion' : 'bg-fg/5 text-fg/30'}`}>
                      {m.label}
                    </span>
                    <span className="ml-auto tabular-nums text-fg/30">{m.count}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
