import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineItem } from '../../../lib/api';
import { formatDateTime, formatDuration, formatTime, getCategoryMeta } from '../../../lib/categoryMeta';
import { buildTurns, flowItems, spanMs, stepName } from '../../../lib/flowGraph';
import { formatModel } from '../../../lib/modelMeta';
import { eventKey } from '../../../lib/sessionView';
import { CATEGORY_ICON, Icon } from '../../forest/icons';
import { EventDetailPanel } from './EventDetailPanel';
import { FlowMap, KIND_ICON, NEUTRAL, TONE } from './FlowMap';

/**
 * Langfuse-style trace view of one session: a searchable tree of turns and
 * their steps with the flow graph under it on the left, and the selected
 * step's detail on the right. Tree, graph and detail share one selection.
 */

interface SessionTraceProps {
  items: TimelineItem[];
  sessionId: string;
  /** Open an event in the session's transcript. */
  onOpen: (item: TimelineItem) => void;
}

const FILE_CATEGORIES = new Set(['file_read', 'file_edit', 'context_read', 'memory']);
const SPLIT_KEY = 'cot.trace.split';
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

/** One line for a step; files by name, since their paths share a long prefix. */
function summary(it: TimelineItem): string {
  const target = it.target && FILE_CATEGORIES.has(it.category) ? it.target.split('/').pop() || it.target : it.target;
  const text = (target || it.detail || '').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function iconOf(it: TimelineItem): { name: string; tone: { tile: string; text: string } } {
  const { kind } = stepName(it);
  return { name: KIND_ICON[kind] ?? CATEGORY_ICON[kind] ?? 'file', tone: TONE[kind] ?? NEUTRAL };
}

function matches(it: TimelineItem, q: string): boolean {
  return [stepName(it).label, it.title, it.tool, it.target, it.category, getCategoryMeta(it.category).label, String(it.id)]
    .some((v) => v?.toLowerCase().includes(q));
}

/** A parallel group takes as long as its slowest step, in the same measure the
 *  step rows show; wall-clock span is the fallback when no step has a duration. */
function groupMs(items: TimelineItem[]): number {
  const slowest = Math.max(0, ...items.map((it) => it.duration_ms ?? 0));
  return slowest || spanMs(items);
}

function rawJson(it: TimelineItem): string {
  let payload: unknown = it.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      /* keep the string */
    }
  }
  return JSON.stringify({ ...it, payload }, null, 2);
}

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= SPLIT_MIN && v <= SPLIT_MAX ? v : 0.45;
  } catch {
    return 0.45;
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line/15 bg-panel px-1 font-mono text-label text-fg/55">
      {children}
    </kbd>
  );
}

export function SessionTrace({ items, sessionId, onOpen }: SessionTraceProps) {
  const turns = useMemo(() => buildTurns(items), [items]);
  const byKey = useMemo(() => new Map(flowItems(items).map((it) => [eventKey(it, sessionId), it])), [items, sessionId]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [split, setSplit] = useState(readSplit);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const matchKeys = useMemo(() => {
    if (!q) return null;
    const keys = new Set<string>();
    for (const [key, it] of byKey) if (matches(it, q)) keys.add(key);
    return keys;
  }, [byKey, q]);

  // The tree as rendered: turns with their visible steps, search applied.
  const visible = useMemo(
    () =>
      turns
        .map((t, n) => {
          const promptHit = !matchKeys || (t.prompt && matchKeys.has(eventKey(t.prompt, sessionId)));
          // Search narrows each group but keeps it a group: a hit that ran in
          // parallel still shows what it ran alongside.
          const groups = t.steps
            .map((all) => ({
              all,
              shown: matchKeys ? all.filter((it) => matchKeys.has(eventKey(it, sessionId))) : all,
            }))
            .filter((g) => g.shown.length > 0);
          return { turn: t, n, groups, show: promptHit || groups.length > 0 };
        })
        .filter((v) => v.show),
    [turns, matchKeys, sessionId],
  );

  // Row order for arrow-key navigation.
  const order = useMemo(() => {
    const keys: string[] = [];
    for (const { turn, groups } of visible) {
      if (turn.prompt) keys.push(eventKey(turn.prompt, sessionId));
      if (q || !collapsed.has(turn.id)) for (const g of groups) for (const it of g.shown) keys.push(eventKey(it, sessionId));
    }
    return keys;
  }, [visible, collapsed, q, sessionId]);

  const select = (it: TimelineItem) => {
    setSelectedKey(eventKey(it, sessionId));
    // A step picked in the graph may sit in a collapsed turn.
    const turn = turns.find((t) => t.items.includes(it));
    if (turn && collapsed.has(turn.id)) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(turn.id);
        return next;
      });
    }
  };

  useEffect(() => {
    if (!selectedKey) return;
    treeRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  // "/" jumps to search from anywhere in the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !isTyping(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onTreeKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = selectedKey ? order.indexOf(selectedKey) : -1;
    const next = order[Math.max(0, Math.min(order.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    const it = next ? byKey.get(next) : null;
    if (it) {
      select(it);
      treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
    }
  };

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saveSplit = (v: number) => {
    const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));
    setSplit(clamped);
    try {
      localStorage.setItem(SPLIT_KEY, String(clamped));
    } catch {
      /* per-viewer convenience only */
    }
  };
  const onSplitDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSplitMove = (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = splitRef.current?.getBoundingClientRect();
    if (box) saveSplit((e.clientY - box.top) / box.height);
  };

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;

  if (!turns.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-16 text-center">
        <Icon name="trace" size={20} className="text-fg/25" />
        <p className="text-small text-fg/70">No steps yet</p>
        <p className="max-w-[40ch] text-data text-fg/40">Steps appear here as soon as the agent reads, runs or edits something.</p>
      </div>
    );
  }

  const row = (
    it: TimelineItem,
    depth: number,
    head?: { open: boolean; turnId: string; n: number; count: number; durationMs: number; errors: number },
  ) => {
    const key = eventKey(it, sessionId);
    const { name, tone } = iconOf(it);
    const isSel = key === selectedKey;
    const ms = head ? head.durationMs : it.duration_ms;
    const failed = head ? head.errors : it.status === 'error' ? 1 : 0;
    return (
      <div key={key} role="treeitem" aria-selected={isSel} className="flex items-center" style={{ paddingLeft: depth * 18 }}>
        {head ? (
          <button
            type="button"
            onClick={() => toggle(head.turnId)}
            aria-label={head.open ? 'Collapse turn' : 'Expand turn'}
            aria-expanded={head.open}
            className="focus-ring flex h-8 w-6 shrink-0 items-center justify-center rounded-chip text-fg/35 transition-colors duration-150 hover:text-fg"
          >
            <Icon
              name="chevron"
              size={13}
              stroke={2}
              className={`transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${head.open ? 'rotate-90' : ''}`}
            />
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <button
          type="button"
          data-key={key}
          aria-current={isSel}
          onClick={() => select(it)}
          className={`focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-chip px-2 text-left transition-colors duration-150 ${
            head ? 'h-8' : 'h-7'
          } ${isSel ? 'bg-fg/[0.07] ring-1 ring-inset ring-line/20' : 'hover:bg-fg/[0.04]'}`}
        >
          <Icon name={name} size={13} className={`shrink-0 ${tone.text}`} />
          {head && <span className="shrink-0 font-mono text-label tabular-nums text-fg/30">{String(head.n).padStart(2, '0')}</span>}
          <span className={`min-w-0 max-w-[55%] shrink-0 truncate font-mono text-data ${head ? 'font-medium text-fg' : 'text-fg/85'}`}>
            {stepName(it).label}
          </span>
          <span className={`min-w-0 flex-1 truncate text-data ${head ? 'text-fg/65' : 'font-mono text-fg/40'}`} title={summary(it)}>
            {summary(it)}
          </span>
          {failed > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-label font-semibold tabular-nums text-alert">
              <Icon name="close" size={9} stroke={2.4} />
              {failed}
            </span>
          )}
          {head && (
            <span className="shrink-0 font-mono text-label tabular-nums text-fg/35" title={`${head.count} steps`}>
              {head.count}
            </span>
          )}
          <span className="w-12 shrink-0 text-right font-mono text-label tabular-nums text-fg/40">
            {ms != null && ms > 0 ? formatDuration(ms) : ''}
          </span>
        </button>
      </div>
    );
  };

  return (
    <div className="grid gap-3 lg:h-[calc(100dvh-12rem)] lg:min-h-[600px] lg:grid-cols-2">
      <section className="flex h-[720px] min-h-0 flex-col overflow-hidden rounded-control border border-line/10 bg-surface lg:h-auto">
        <div className="border-b border-line/10 p-2">
          <label className="flex h-8 items-center gap-2 rounded-control border border-line/10 bg-panel px-2.5 transition-colors duration-150 focus-within:border-hot/75 hover:border-line/[0.16]">
            <Icon name="search" size={14} className="shrink-0 text-fg/40" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search steps by name, type, target or id"
              aria-label="Search steps"
              className="min-w-0 flex-1 bg-transparent text-small text-fg placeholder:text-fg/35 focus:outline-none"
            />
            {matchKeys ? (
              <span className="shrink-0 font-mono text-label tabular-nums text-fg/45">
                {matchKeys.size} of {byKey.size}
              </span>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
        </div>

        <div
          ref={splitRef}
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]"
          style={{ gridTemplateRows: `minmax(0, ${split}fr) 9px minmax(0, ${1 - split}fr)` }}
        >
          <div
            ref={treeRef}
            role="tree"
            aria-label="Session steps"
            onKeyDown={onTreeKey}
            className="scroll-thin min-h-0 overflow-y-auto px-1.5 py-1.5"
          >
            {visible.map(({ turn, n, groups }, i) => {
              const open = !!q || !collapsed.has(turn.id);
              const head = { open, turnId: turn.id, n: n + 1, count: turn.items.length, durationMs: turn.durationMs, errors: turn.errors };
              return (
                <div key={turn.id} role="group" className={i ? 'mt-1 border-t border-line/[0.06] pt-1' : ''}>
                  {turn.prompt ? (
                    row(turn.prompt, 0, head)
                  ) : (
                    <div className="flex h-8 items-center pl-8 font-mono text-label uppercase tracking-label text-fg/35">
                      Before the first prompt
                    </div>
                  )}
                  {open &&
                    groups.map(({ all, shown }) =>
                      all.length === 1 ? (
                        row(shown[0], 1)
                      ) : (
                        <div key={`par:${all[0].id}`} role="group" aria-label={`${all.length} steps in parallel`}>
                          <div className="flex h-7 items-center gap-2 pl-[50px] pr-2" title="These steps ran at the same time">
                            <Icon name="branch" size={13} className="shrink-0 text-fg/40" />
                            <span className="font-mono text-data text-fg/55">Parallel</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-label tabular-nums text-fg/35">
                              {all.length} steps
                            </span>
                            <span className="w-12 shrink-0 text-right font-mono text-label tabular-nums text-fg/40">
                              {groupMs(all) > 0 ? formatDuration(groupMs(all)) : ''}
                            </span>
                          </div>
                          {shown.map((it) => row(it, 2))}
                        </div>
                      ),
                    )}
                </div>
              );
            })}
            {!visible.length && (
              <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                <p className="text-small text-fg/70">No steps match “{query.trim()}”</p>
                <button type="button" onClick={() => setQuery('')} className="btn-ghost focus-ring h-7 text-data">
                  Clear search
                </button>
              </div>
            )}
          </div>

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize steps and graph"
            aria-valuenow={Math.round(split * 100)}
            aria-valuemin={SPLIT_MIN * 100}
            aria-valuemax={SPLIT_MAX * 100}
            tabIndex={0}
            onPointerDown={onSplitDown}
            onPointerMove={onSplitMove}
            onDoubleClick={() => saveSplit(0.45)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                saveSplit(split + (e.key === 'ArrowDown' ? 0.05 : -0.05));
              }
            }}
            className="focus-ring group flex cursor-row-resize touch-none items-center"
            title="Drag to resize. Double-click to reset."
          >
            <span className="h-px w-full bg-line/10 transition-colors duration-150 group-hover:bg-line/30 group-active:bg-hot/70" />
          </div>

          <FlowMap
            items={items}
            sessionId={sessionId}
            activeKey={selectedKey}
            onSelect={select}
            onClear={() => setSelectedKey(null)}
            matchKeys={matchKeys}
            className="min-h-0 px-3 pb-2.5 pt-1.5"
          />
        </div>
      </section>

      <StepDetail item={selected} sessionId={sessionId} onOpen={onOpen} />
    </div>
  );
}

function StepDetail({ item, sessionId, onOpen }: { item: TimelineItem | null; sessionId: string; onOpen: (item: TimelineItem) => void }) {
  const [view, setView] = useState<'formatted' | 'json'>('formatted');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (!item) {
    return (
      <section className="flex min-h-0 flex-col items-center justify-center gap-3 rounded-control border border-line/10 bg-surface p-8 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line/15 text-fg/40">
          <Icon name="trace" size={18} />
        </span>
        <div className="space-y-1">
          <p className="text-small font-medium text-fg/80">No step selected</p>
          <p className="mx-auto max-w-[36ch] text-data leading-relaxed text-fg/45">
            Pick a step in the tree or the graph to see what it did: its input, output, timing and status.
          </p>
        </div>
        <div className="flex items-center gap-3 text-data text-fg/45">
          <span className="inline-flex items-center gap-1">
            <Kbd>
              <Icon name="down" size={11} stroke={2} className="rotate-180" />
            </Kbd>
            <Kbd>
              <Icon name="down" size={11} stroke={2} />
            </Kbd>
            move
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>/</Kbd>
            search
          </span>
        </div>
      </section>
    );
  }

  const { name, tone } = iconOf(item);
  const failed = item.status === 'error' || item.status === 'blocked';
  const label = stepName(item).label;
  const meta = [
    formatTime(item.start_ts || item.ts),
    item.duration_ms != null && item.duration_ms > 0 ? formatDuration(item.duration_ms) : null,
    item.model ? formatModel(item.model) : null,
    `#${item.id}`,
  ].filter(Boolean);

  const copy = () => {
    if (!item.target) return;
    void navigator.clipboard?.writeText(item.target).then(() => setCopied(true));
  };

  return (
    <section className="flex max-h-[720px] min-h-0 flex-col overflow-hidden rounded-control border border-line/10 bg-surface lg:max-h-none">
      <header className="space-y-3 border-b border-line/10 px-5 pb-4 pt-4">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${tone.tile}`}>
            <Icon name={name} size={15} className={tone.text} />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="mr-1 truncate text-[15px] font-semibold leading-tight tracking-tight text-fg">{label}</h3>
              <span className="chip bg-fg/[0.04] text-fg/55 ring-line/10">{getCategoryMeta(item.category).label}</span>
              {item.tool && item.tool !== label && !item.tool.includes('__') && item.tool.length <= 20 && (
                <span className="chip bg-fg/[0.04] text-fg/55 ring-line/10">{item.tool}</span>
              )}
              {failed && <span className="chip bg-alert/[0.14] text-alert ring-alert/[0.32]">{item.status}</span>}
              {item.ongoing && <span className="chip bg-hot/[0.12] text-hot ring-hot/30">Running</span>}
            </div>
            <p className="truncate font-mono text-data tabular-nums text-fg/45" title={formatDateTime(item.start_ts || item.ts)}>
              {meta.join('  ·  ')}
            </p>
          </div>
          <button type="button" onClick={() => onOpen(item)} className="btn focus-ring h-8 text-data">
            <Icon name="external" size={13} />
            Open in transcript
          </button>
        </div>
        {item.target && (
          <div className="group flex items-start gap-2 rounded-control border border-line/10 bg-panel px-3 py-2">
            <p className="min-w-0 flex-1 break-all font-mono text-data leading-relaxed text-fg/70">{item.target}</p>
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? 'Copied' : 'Copy'}
              title={copied ? 'Copied' : 'Copy'}
              className="press focus-ring -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-chip text-fg/40 transition-colors duration-150 hover:text-fg"
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
          </div>
        )}
      </header>

      <div className="flex items-center justify-between border-b border-line/10 px-5 py-2">
        <span className="font-mono text-label font-semibold uppercase tracking-label text-fg/40">Detail</span>
        <div className="seg" role="tablist" aria-label="Detail format">
          {(['formatted', 'json'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className="seg-item py-0.5 text-data"
            >
              {v === 'formatted' ? 'Formatted' : 'JSON'}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {view === 'formatted' ? (
          <EventDetailPanel key={item.id} item={item} sessionId={sessionId} compact />
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-control border border-line/10 bg-panel p-3 font-mono text-data leading-relaxed text-fg/80">
            {rawJson(item)}
          </pre>
        )}
      </div>
    </section>
  );
}
