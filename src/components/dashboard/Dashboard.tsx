import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, updateSettings, type Store } from '../../lib/api';
import { setDocumentTitle } from '../../lib/documentTitle';
import { sessionHref } from '../../lib/sessionStore';
import { usePeek } from '../../lib/usePeek';
import { readNavCollapsed, readSidebarOpen, writeNavCollapsed, writeSidebarOpen } from '../../lib/settings';
import { ThemeToggle } from '../ui/ThemeToggle';
import { MetricsSkeleton } from '../ui/Skeleton';
import { AppSidebar, type NavKey } from './AppSidebar';
import { CommandPalette, type PaletteCommand, type PaletteScope } from './CommandPalette';
import { DashboardHome } from './DashboardHome';
import { ReplayView } from './ReplayView';
import { SessionDetailView } from './SessionDetailView';
import { SessionList } from './SessionList';
import { SettingsView } from './SettingsView';

// Code-split: recharts (~heavy) only loads when the Overview tab is opened.
const OverviewView = lazy(() =>
  import('./OverviewView').then((m) => ({ default: m.OverviewView })),
);
const MetricsHistoryView = lazy(() =>
  import('./MetricsHistoryView').then((m) => ({ default: m.MetricsHistoryView })),
);

interface DashboardProps {
  onSetup: () => void;
}

type DashboardRoute =
  | { view: 'list' }
  | { view: 'session'; sessionId: string; focusEventId?: number; focusQuery?: string }
  | { view: 'overview' }
  | { view: 'metrics-history'; tab?: MetricsHistoryTab }
  | { view: 'replay' }
  | { view: 'replay-session'; sessionId: string; focusEventId?: number; focusQuery?: string }
  | { view: 'settings' };

type MetricsHistoryTab = 'shell' | 'web';

function parseHash(): DashboardRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'settings') return { view: 'settings' };
  const historyMatch = hash.match(/^metrics-history(?:\?tab=(shell|web))?$/);
  if (historyMatch) return { view: 'metrics-history', tab: historyMatch[1] as MetricsHistoryTab | undefined };
  // Legacy #/metrics and #/insights merged into the unified Overview page.
  if (hash === 'overview' || hash === 'metrics' || hash === 'insights') return { view: 'overview' };
  if (hash === 'replay') return { view: 'replay' };
  // #/session/<id> optionally followed by ?e=<eventId>[&q=<search>] to focus
  // one event and highlight the search that found it.
  // #/replay/<id> is the same page for a Session Replay import.
  const match = hash.match(/^(session|replay)\/([^?]+)(?:\?e=(\d+)(?:&q=([^&]*))?)?$/);
  if (match?.[2]) {
    return {
      view: match[1] === 'replay' ? 'replay-session' : 'session',
      sessionId: decodeURIComponent(match[2]),
      focusEventId: match[3] ? Number(match[3]) : undefined,
      focusQuery: match[4] ? decodeURIComponent(match[4]) : undefined,
    };
  }
  return { view: 'list' };
}

/** Rewrite legacy hashes to the canonical one (side effect kept out of parseHash). */
function canonicalizeHash(): void {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'metrics' || hash === 'insights') {
    window.history.replaceState(null, '', '#/overview');
  }
}

export function Dashboard({ onSetup }: DashboardProps) {
  const [route, setRoute] = useState(() => {
    canonicalizeHash();
    return parseHash();
  });
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  // Set once the user toggles a sidebar, so a slow settings fetch never
  // overwrites a choice made after the page opened.
  const layoutTouched = useRef(false);

  // localStorage gives an instant first paint; the collector's copy is the
  // source of truth because browser storage is per-origin (127.0.0.1 vs
  // localhost vs the dev server).
  useEffect(() => {
    getSettings()
      .then((s) => {
        // Older collectors don't return these fields; keep the local copy then.
        if (layoutTouched.current) return;
        if (typeof s.ui_nav_collapsed === 'boolean') {
          setNavCollapsed(s.ui_nav_collapsed);
          writeNavCollapsed(s.ui_nav_collapsed);
        }
        if (typeof s.ui_sidebar_open === 'boolean') {
          setSidebarOpen(s.ui_sidebar_open);
          writeSidebarOpen(s.ui_sidebar_open);
        }
      })
      .catch(() => {
        /* collector unreachable — keep the local copy */
      });
  }, []);

  const saveSidebarOpen = useCallback((open: boolean) => {
    layoutTouched.current = true;
    setSidebarOpen(open);
    writeSidebarOpen(open);
    updateSettings({ ui_sidebar_open: open }).catch(() => {});
  }, []);

  const toggleNav = useCallback(() => {
    const next = !navCollapsed;
    layoutTouched.current = true;
    setNavCollapsed(next);
    writeNavCollapsed(next);
    updateSettings({ ui_nav_collapsed: next }).catch(() => {});
  }, [navCollapsed]);

  const toggleSidebar = useCallback(() => saveSidebarOpen(!sidebarOpen), [saveSidebarOpen, sidebarOpen]);
  const { peek: sessionsPeek, handlers: sessionsPeekHandlers } = usePeek(!sidebarOpen);

  useEffect(() => {
    const onHash = () => {
      canonicalizeHash();
      setRoute(parseHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Cmd/Ctrl+K toggles the global search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (route.view === 'list') setDocumentTitle('Sessions');
    else if (route.view === 'settings') setDocumentTitle('Settings');
    else if (route.view === 'overview') setDocumentTitle('Overview');
    else if (route.view === 'metrics-history') setDocumentTitle('Activity History');
    else if (route.view === 'replay') setDocumentTitle('Session Replay');
  }, [route.view]);

  const selectSession = useCallback((id: string, eventId?: number, query?: string, store: Store = 'main') => {
    const view = store === 'replay' ? 'replay-session' : 'session';
    setRoute({ view, sessionId: id, focusEventId: eventId, focusQuery: query });
    const base = sessionHref(id, store);
    const q = query ? `&q=${encodeURIComponent(query)}` : '';
    window.location.hash = eventId != null ? `${base}?e=${eventId}${q}` : base;
  }, []);

  const goSessions = useCallback(() => {
    setRoute({ view: 'list' });
    window.location.hash = '#/sessions';
  }, []);

  const goSettings = useCallback(() => {
    setRoute({ view: 'settings' });
    window.location.hash = '#/settings';
  }, []);

  const goOverview = useCallback(() => {
    setRoute({ view: 'overview' });
    window.location.hash = '#/overview';
  }, []);

  const goMetricsHistory = useCallback((tab: MetricsHistoryTab = 'shell') => {
    setRoute({ view: 'metrics-history', tab });
    window.location.hash = tab === 'web' ? '#/metrics-history?tab=web' : '#/metrics-history';
  }, []);

  const goReplay = useCallback(() => {
    setRoute({ view: 'replay' });
    window.location.hash = '#/replay';
  }, []);

  const selectedId = route.view === 'session' ? route.sessionId : null;
  const replayId = route.view === 'replay-session' ? route.sessionId : null;
  const onSettings = route.view === 'settings';
  const onOverview = route.view === 'overview';
  const onMetricsHistory = route.view === 'metrics-history';
  const onReplay = route.view === 'replay' || replayId !== null;
  const onList = !selectedId && !onSettings && !onOverview && !onMetricsHistory && !onReplay;

  // Navigation entries shown in the palette, marked active for the current view.
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: 'nav-sessions',
        label: selectedId ? 'Back to all sessions' : 'Go to Sessions',
        icon: 'list',
        keywords: 'home list sessions back',
        active: onList,
        run: goSessions,
      },
      {
        id: 'nav-overview',
        label: 'Go to Overview',
        icon: 'chart',
        keywords: 'overview metrics charts analytics usage insights findings recommendations security cost usability',
        active: onOverview,
        run: goOverview,
      },
      {
        id: 'nav-metrics-history',
        label: 'Activity History',
        icon: 'terminal',
        keywords: 'shell commands urls web history bash activity',
        active: onMetricsHistory,
        run: goMetricsHistory,
      },
      {
        id: 'nav-replay',
        label: 'Go to Session Replay',
        icon: 'replay',
        keywords: 'replay import imported json upload export',
        active: onReplay,
        run: goReplay,
      },
      {
        id: 'nav-settings',
        label: 'Go to Settings',
        icon: 'settings',
        keywords: 'settings config preferences hooks',
        active: onSettings,
        run: goSettings,
      },
    ],
    [
      selectedId,
      onList,
      onOverview,
      onMetricsHistory,
      onReplay,
      onSettings,
      goSessions,
      goOverview,
      goMetricsHistory,
      goReplay,
      goSettings,
    ],
  );

  // On a session, ⌘K opens scoped to it (clearable to search everything).
  const paletteScope = useMemo<PaletteScope | null>(
    () =>
      selectedId
        ? { sessionId: selectedId, label: shortSession(selectedId) }
        : replayId
          ? { sessionId: replayId, label: shortSession(replayId), store: 'replay' }
          : null,
    [selectedId, replayId],
  );

  const activeNav: NavKey = onSettings
    ? 'settings'
    : onOverview
      ? 'overview'
      : onMetricsHistory
        ? 'history'
        : onReplay
          ? 'replay'
          : 'sessions';

  const crumbs: { label: string; href?: string }[] = selectedId
    ? [{ label: 'Sessions', href: '#/sessions' }, { label: shortSession(selectedId) }]
    : replayId
      ? [{ label: 'Session Replay', href: '#/replay' }, { label: shortSession(replayId) }]
      : route.view === 'replay'
        ? [{ label: 'Session Replay' }]
        : onMetricsHistory
      ? [{ label: 'Overview', href: '#/overview' }, { label: 'Activity history' }]
      : [{ label: onSettings ? 'Settings' : onOverview ? 'Overview' : 'Sessions' }];

  return (
    <div className="relative flex h-screen">
      <AppSidebar
        active={activeNav}
        collapsed={navCollapsed}
        onToggleCollapsed={toggleNav}
        onSearch={() => setPaletteOpen(true)}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute inset-0 grid-bg" aria-hidden="true" />
        <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line/10 bg-bg/70 px-6 backdrop-blur-sm">
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-2.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.16em]">
              {crumbs.map((c, i) => (
                <li key={c.label} className="flex min-w-0 items-center gap-2">
                  {i > 0 && <span className="text-fg/20" aria-hidden="true">/</span>}
                  {c.href ? (
                    <a href={c.href} className="focus-ring shrink-0 rounded-sm text-fg/45 transition-colors hover:text-fg">
                      {c.label}
                    </a>
                  ) : (
                    <span aria-current="page" className="truncate font-medium text-fg">
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <ThemeToggle />
        </header>

        <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
          {onSettings ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <SettingsView
                sidebarOpen={sidebarOpen}
                onSidebarOpenChange={saveSidebarOpen}
                onRunOnboarding={onSetup}
              />
            </main>
          ) : onMetricsHistory ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <MetricsHistoryView
                  onSelect={selectSession}
                  onBack={goOverview}
                  initialTab={route.view === 'metrics-history' ? route.tab : undefined}
                />
              </Suspense>
            </main>
          ) : route.view === 'replay' ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <ReplayView />
            </main>
          ) : replayId ? (
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <SessionDetailView
                sessionId={replayId}
                store="replay"
                focusEventId={route.view === 'replay-session' ? route.focusEventId : undefined}
                focusQuery={route.view === 'replay-session' ? route.focusQuery : undefined}
              />
            </main>
          ) : onOverview ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <OverviewView onSelect={selectSession} onHistory={goMetricsHistory} />
              </Suspense>
            </main>
          ) : selectedId ? (
            <>
              {/* The slot keeps the pinned width; a hover peek overlays the timeline. */}
              <div
                {...sessionsPeekHandlers}
                className={`rail-motion relative z-20 hidden shrink-0 md:block ${
                  sidebarOpen ? 'w-80' : 'w-10'
                }`}>
                <div
                  className={`rail-motion absolute inset-y-0 left-0 overflow-hidden ${
                    sidebarOpen || sessionsPeek ? 'w-80' : 'w-10'
                  } ${sessionsPeek ? 'shadow-soft-lg' : 'shadow-none'}`}>
                  <SessionList
                    selectedId={selectedId}
                    onSelect={selectSession}
                    collapsed={!sidebarOpen && !sessionsPeek}
                    peeking={sessionsPeek}
                    onToggle={toggleSidebar}
                  />
                </div>
              </div>
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <SessionDetailView
                  sessionId={selectedId}
                  focusEventId={route.view === 'session' ? route.focusEventId : undefined}
                  focusQuery={route.view === 'session' ? route.focusQuery : undefined}
                />
              </main>
            </>
          ) : (
            <DashboardHome onSelect={selectSession} />
          )}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={selectSession}
        commands={paletteCommands}
        scope={paletteScope}
      />
    </div>
  );
}

/** Compact, readable label for a session id used as the palette scope chip. */
function shortSession(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return tail.length > 12 ? `${tail.slice(0, 10)}…` : tail;
}
