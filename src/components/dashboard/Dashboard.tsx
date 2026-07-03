import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { setDocumentTitle } from '../../lib/documentTitle';
import { readSidebarOpen, writeSidebarOpen } from '../../lib/settings';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Icon } from '../ui/icons';
import { MetricsSkeleton } from '../ui/Skeleton';
import { CommandPalette, type PaletteCommand, type PaletteScope } from './CommandPalette';
import { DashboardHome } from './DashboardHome';
import { SessionDetailView } from './SessionDetailView';
import { SessionList } from './SessionList';
import { SettingsView } from './SettingsView';

// Code-split: recharts (~heavy) only loads when the Metrics tab is opened.
const MetricsView = lazy(() =>
  import('./MetricsView').then((m) => ({ default: m.MetricsView })),
);
const MetricsHistoryView = lazy(() =>
  import('./MetricsHistoryView').then((m) => ({ default: m.MetricsHistoryView })),
);
const InsightsView = lazy(() =>
  import('./InsightsView').then((m) => ({ default: m.InsightsView })),
);

interface DashboardProps {
  onSetup: () => void;
}

type DashboardRoute =
  | { view: 'list' }
  | { view: 'session'; sessionId: string; focusEventId?: number }
  | { view: 'metrics' }
  | { view: 'metrics-history' }
  | { view: 'insights' }
  | { view: 'settings' };

function parseHash(): DashboardRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'settings') return { view: 'settings' };
  if (hash === 'metrics-history') return { view: 'metrics-history' };
  if (hash === 'metrics') return { view: 'metrics' };
  if (hash === 'insights') return { view: 'insights' };
  // #/session/<id> optionally followed by ?e=<eventId> to focus one event.
  const match = hash.match(/^session\/([^?]+)(?:\?e=(\d+))?$/);
  if (match?.[1]) {
    return {
      view: 'session',
      sessionId: decodeURIComponent(match[1]),
      focusEventId: match[2] ? Number(match[2]) : undefined,
    };
  }
  return { view: 'list' };
}

export function Dashboard({ onSetup }: DashboardProps) {
  const [route, setRoute] = useState(parseHash);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open;
      writeSidebarOpen(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
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
    else if (route.view === 'metrics') setDocumentTitle('Metrics');
    else if (route.view === 'metrics-history') setDocumentTitle('Activity History');
    else if (route.view === 'insights') setDocumentTitle('Insights');
  }, [route.view]);

  const selectSession = useCallback((id: string, eventId?: number) => {
    setRoute({ view: 'session', sessionId: id, focusEventId: eventId });
    const base = `#/session/${encodeURIComponent(id)}`;
    window.location.hash = eventId != null ? `${base}?e=${eventId}` : base;
  }, []);

  const goSessions = useCallback(() => {
    setRoute({ view: 'list' });
    window.location.hash = '#/sessions';
  }, []);

  const goSettings = useCallback(() => {
    setRoute({ view: 'settings' });
    window.location.hash = '#/settings';
  }, []);

  const goMetrics = useCallback(() => {
    setRoute({ view: 'metrics' });
    window.location.hash = '#/metrics';
  }, []);

  const goMetricsHistory = useCallback(() => {
    setRoute({ view: 'metrics-history' });
    window.location.hash = '#/metrics-history';
  }, []);

  const goInsights = useCallback(() => {
    setRoute({ view: 'insights' });
    window.location.hash = '#/insights';
  }, []);

  const selectedId = route.view === 'session' ? route.sessionId : null;
  const onSettings = route.view === 'settings';
  const onMetrics = route.view === 'metrics';
  const onMetricsHistory = route.view === 'metrics-history';
  const onInsights = route.view === 'insights';
  const onList = !selectedId && !onSettings && !onMetrics && !onMetricsHistory && !onInsights;

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
        id: 'nav-metrics',
        label: 'Go to Metrics',
        icon: 'layers',
        keywords: 'metrics charts analytics usage',
        active: onMetrics,
        run: goMetrics,
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
        id: 'nav-insights',
        label: 'Go to Insights',
        icon: 'warn',
        keywords: 'insights findings recommendations actionable security cost usability',
        active: onInsights,
        run: goInsights,
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
    [selectedId, onList, onMetrics, onMetricsHistory, onInsights, onSettings, goSessions, goMetrics, goMetricsHistory, goInsights, goSettings],
  );

  // On a session, ⌘K opens scoped to it (clearable to search everything).
  const paletteScope = useMemo<PaletteScope | null>(
    () =>
      selectedId
        ? { sessionId: selectedId, label: shortSession(selectedId) }
        : null,
    [selectedId],
  );

  return (
    <div className="relative flex h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 grid-bg" aria-hidden="true" />
      <header className="relative z-10 flex items-center justify-between border-b border-line/10 px-6 py-4">
        <div className="flex items-center gap-3">
          <a href="#/sessions" className="font-serif text-2xl font-bold italic text-fg">
            cot.
          </a>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search everything"
            title="Search everything (⌘K)"
            className="flex h-8 items-center gap-2 border border-fg/20 px-2.5 text-fg/60 transition-colors hover:border-fg/50 hover:text-fg focus-visible:border-vermilion focus-visible:outline-none">
            <Icon name="search" className="h-3.5 w-3.5" />
            <kbd className="hidden font-mono text-[0.55rem] uppercase tracking-widest text-fg/40 sm:inline">
              ⌘K
            </kbd>
          </button>
          <button
            type="button"
            onClick={goInsights}
            aria-label="Insights"
            aria-current={onInsights ? 'page' : undefined}
            title="Insights"
            className={`flex h-8 w-8 items-center justify-center border border-vermilion bg-vermilion text-cream transition-all focus-visible:outline-none focus-visible:border-vermilion ${
              onInsights ? '' : 'brightness-90 hover:brightness-100'
            }`}>
            <Icon name="brain" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goMetrics}
            aria-label="Metrics"
            aria-current={onMetrics ? 'page' : undefined}
            title="Metrics"
            className={`flex h-8 w-8 items-center justify-center border border-cobalt bg-cobalt text-cream transition-all focus-visible:outline-none focus-visible:border-cobalt ${
              onMetrics ? '' : 'brightness-90 hover:brightness-100'
            }`}>
            <Icon name="chart" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goSettings}
            aria-label="Settings"
            aria-current={onSettings ? 'page' : undefined}
            title="Settings"
            className={`flex h-8 w-8 items-center justify-center border transition-colors focus-visible:outline-none focus-visible:border-vermilion ${
              onSettings
                ? 'border-fg/50 text-fg'
                : 'border-fg/20 text-fg/60 hover:border-fg/50 hover:text-fg'
            }`}>
            <Icon name="settings" className="h-4 w-4" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-10 flex flex-1 overflow-hidden">
        {onSettings ? (
          <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
            <SettingsView
              sidebarOpen={sidebarOpen}
              onSidebarOpenChange={(open) => {
                setSidebarOpen(open);
                writeSidebarOpen(open);
              }}
              onRunOnboarding={onSetup}
            />
          </main>
        ) : onMetricsHistory ? (
          <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
            <Suspense fallback={<MetricsSkeleton />}>
              <MetricsHistoryView onSelect={selectSession} onBack={goMetrics} />
            </Suspense>
          </main>
        ) : onMetrics ? (
          <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
            <Suspense fallback={<MetricsSkeleton />}>
              <MetricsView onSelect={selectSession} onHistory={goMetricsHistory} />
            </Suspense>
          </main>
        ) : onInsights ? (
          <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
            <Suspense fallback={<MetricsSkeleton />}>
              <InsightsView onSelect={selectSession} />
            </Suspense>
          </main>
        ) : selectedId ? (
          <>
            <div
              className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out md:block ${
                sidebarOpen ? 'w-80' : 'w-10'
              }`}>
              <SessionList
                selectedId={selectedId}
                onSelect={selectSession}
                collapsed={!sidebarOpen}
                onToggle={toggleSidebar}
              />
            </div>
            <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
              <SessionDetailView
                sessionId={selectedId}
                focusEventId={route.view === 'session' ? route.focusEventId : undefined}
              />
            </main>
          </>
        ) : (
          <DashboardHome onSelect={selectSession} />
        )}
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
