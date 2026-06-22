import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { search, type SearchResult } from '../../lib/api';
import { formatRelative, getCategoryMeta } from '../../lib/categoryMeta';
import { formatModel } from '../../lib/modelMeta';
import { highlight } from '../ui/Highlight';
import { Icon, type IconName } from '../ui/icons';

/** A navigation/action entry shown in the palette, built from the current route. */
export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  /** Extra words to match against, beyond the label. */
  keywords?: string;
  /** True when this points at the view you're already on. */
  active?: boolean;
  run: () => void;
}

/** When set, the palette opens scoped to a single session (reactive to the URL). */
export interface PaletteScope {
  sessionId: string;
  label: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelect: (sessionId: string, eventId?: number) => void;
  /** Navigation/actions relevant to the current location. */
  commands: PaletteCommand[];
  /** Current session scope, or null when not on a session. */
  scope: PaletteScope | null;
}

type PaletteItem =
  | { kind: 'command'; command: PaletteCommand }
  | { kind: 'result'; result: SearchResult };

export function CommandPalette({ open, onClose, onSelect, commands, scope }: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // Whether the search is currently narrowed to `scope`. Defaults on when the
  // palette opens on a session, so ⌘K is reactive to where you are.
  const [scoped, setScoped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset, focus, and inherit the current scope whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      setActive(0);
      setScoped(!!scope);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, scope]);

  const activeScope = scoped && scope ? scope : null;
  const term = q.trim();

  // Debounced search. Pull a few extra rows so client-side scoping still has
  // enough within-session matches to show.
  useEffect(() => {
    if (!open) return;
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await search(term, 60);
        if (live) setResults(r);
      } catch {
        if (live) setResults([]);
      } finally {
        if (live) setLoading(false);
      }
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [term, open]);

  // Commands matching the query (all of them when the box is empty).
  const cmdMatches = useMemo(() => {
    if (!term) return commands;
    const parts = term.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
      return parts.every((p) => hay.includes(p));
    });
  }, [commands, term]);

  const shownResults = useMemo(
    () =>
      activeScope ? results.filter((r) => r.session_id === activeScope.sessionId) : results,
    [results, activeScope],
  );

  const items = useMemo<PaletteItem[]>(
    () => [
      ...cmdMatches.map((command) => ({ kind: 'command' as const, command })),
      ...shownResults.map((result) => ({ kind: 'result' as const, result })),
    ],
    [cmdMatches, shownResults],
  );

  // Keep the active index inside the current item list.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  const choose = (item: PaletteItem) => {
    if (item.kind === 'command') item.command.run();
    else onSelect(item.result.session_id, item.result.event_id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Backspace' && !q && activeScope) {
      // Backspace on an empty box widens the search, like clearing a GitHub scope.
      e.preventDefault();
      setScoped(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      choose(items[active]);
    }
  };

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const noResults = term.length >= 2 && !loading && !shownResults.length;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and navigate"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-fg/15 bg-bg shadow-soft-lg">
        <div className="flex items-center gap-2.5 border-b border-fg/10 px-4 py-3">
          <Icon name="search" className="h-4 w-4 shrink-0 text-fg/45" />
          {activeScope && (
            <span className="flex shrink-0 items-center gap-1 rounded border border-vermilion/30 bg-vermilion/10 px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion">
              <Icon name="event" className="h-3 w-3" />
              {activeScope.label}
            </span>
          )}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              activeScope ? 'Search in this session…' : 'Search prompts, responses, files, commands…'
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-sm text-fg placeholder:text-fg/35 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-fg/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
            Esc
          </kbd>
        </div>

        <ul ref={listRef} className="scroll-thin max-h-[55vh] overflow-y-auto py-1">
          {items.map((item, i) => {
            const prev = items[i - 1];
            const header =
              item.kind === 'command' && !prev
                ? 'Jump to'
                : item.kind === 'result' && (!prev || prev.kind === 'command')
                  ? activeScope
                    ? 'In this session'
                    : 'Sessions'
                  : null;

            return (
              <Fragment key={item.kind === 'command' ? item.command.id : `${item.result.session_id}-${item.result.event_id}`}>
                {header && (
                  <li className="px-4 pb-1 pt-2 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/30">
                    {header}
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    data-idx={i}
                    onClick={() => choose(item)}
                    onMouseMove={() => setActive(i)}
                    className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${
                      i === active
                        ? 'border-l-vermilion bg-surface'
                        : 'border-l-transparent hover:bg-surface'
                    }`}>
                    {item.kind === 'command' ? (
                      <>
                        <Icon name={item.command.icon} className="h-4 w-4 shrink-0 text-fg/45" />
                        <span className="flex-1 truncate font-mono text-sm text-fg/85">
                          {highlight(item.command.label, term)}
                        </span>
                        {item.command.active && (
                          <span className="shrink-0 font-mono text-[0.55rem] uppercase tracking-widest text-fg/30">
                            Current
                          </span>
                        )}
                      </>
                    ) : (
                      (() => {
                        const r = item.result;
                        const meta = getCategoryMeta(r.category);
                        return (
                          <>
                            <span className={`mt-1 h-2 w-2 shrink-0 self-start rounded-full ${meta.dot}`} />
                            <span className="min-w-0 flex-1 space-y-1">
                              <span className="flex items-center gap-2">
                                <span
                                  className={`font-mono text-[0.58rem] font-bold uppercase tracking-widest ${meta.color}`}>
                                  {meta.label}
                                </span>
                                {r.target && (
                                  <span className="truncate font-mono text-[0.62rem] text-fg/50">
                                    {r.target}
                                  </span>
                                )}
                                {r.model && (
                                  <span className="ml-auto shrink-0 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
                                    {formatModel(r.model)}
                                  </span>
                                )}
                                <span
                                  className={`shrink-0 font-mono text-[0.55rem] text-fg/35 ${
                                    r.model ? '' : 'ml-auto'
                                  }`}>
                                  {formatRelative(r.ts)}
                                </span>
                              </span>
                              <span className="block truncate font-mono text-xs text-fg/85">
                                {highlight(r.snippet, term)}
                              </span>
                              <span className="block truncate font-mono text-[0.55rem] text-fg/35">
                                {r.cwd || r.session_id}
                              </span>
                            </span>
                          </>
                        );
                      })()
                    )}
                  </button>
                </li>
              </Fragment>
            );
          })}

          {noResults && (
            <li className="px-4 py-10 text-center font-mono text-xs text-fg/40">
              No matches for “{term}”{activeScope ? ' in this session' : ''}.
            </li>
          )}
          {term.length < 2 && !cmdMatches.length && (
            <li className="px-4 py-10 text-center font-mono text-xs text-fg/35">
              {activeScope
                ? 'Type to search this session — ⌫ to search everything.'
                : 'Type at least 2 characters to search across all sessions.'}
            </li>
          )}
          {loading && !shownResults.length && (
            <li className="px-4 py-6 text-center font-mono text-xs text-fg/40">Searching…</li>
          )}
        </ul>

        <div className="flex items-center gap-4 border-t border-fg/10 px-4 py-2 font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          {activeScope && <span>⌫ search all</span>}
          {!!shownResults.length && (
            <span className="ml-auto tabular-nums">{shownResults.length} results</span>
          )}
        </div>
      </div>
    </div>
  );
}
