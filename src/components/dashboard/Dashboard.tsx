import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getInsights, getMetrics, getSettings, getStats, updateSettings, type InsightPillar, type InsightsResponse, type Metrics, type Stats, type Store } from '../../lib/api';
import { userTimeZone } from '../../lib/categoryMeta';
import { useTheme } from '../../lib/theme';
import { usePrefs } from '../../lib/prefs';
import { Icon as FIcon } from '../forest/icons';
import { usePolling } from '../../lib/usePolling';
import { useQueryClient } from '@tanstack/react-query';
import { project as fproject } from '../forest/format';
import { setDocumentTitle } from '../../lib/documentTitle';
import { sessionHref } from '../../lib/sessionStore';
import { readNavCollapsed, readSidebarOpen, writeNavCollapsed, writeSidebarOpen } from '../../lib/settings';
import { MetricsSkeleton } from '../ui/Skeleton';
import { AppSidebar, type NavKey } from './AppSidebar';
import { CommandPalette, type PaletteCommand, type PaletteScope } from './CommandPalette';
import { SessionsView } from './SessionsView';
import { ReplayView } from './ReplayView';
import { SessionDetailView } from './SessionDetailView';
import { SessionList } from './SessionList';
import { SettingsView } from './SettingsView';
import { FindingsView } from './FindingsView';
import { GovernanceView } from './GovernanceView';

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
  | { view: 'settings' }
  | { view: 'findings'; pillar?: InsightPillar }
  | { view: 'governance' };

type MetricsHistoryTab = 'shell' | 'web';

function parseHash(): DashboardRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'settings') return { view: 'settings' };
  if (hash === 'governance') return { view: 'governance' };
  const findingsMatch = hash.match(/^findings(?:\?pillar=(security|cost|usability))?$/);
  if (findingsMatch) return { view: 'findings', pillar: findingsMatch[1] as InsightPillar | undefined };
  // The workspace opens on the Overview.
  if (hash === '') return { view: 'overview' };
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
        return;
      }
      // "/" opens it too, unless the key is going into a field.
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (route.view === 'list') setDocumentTitle('Sessions');
    else if (route.view === 'settings') setDocumentTitle('Settings');
    else if (route.view === 'overview') setDocumentTitle('Overview');
    else if (route.view === 'metrics-history') setDocumentTitle('Activity');
    else if (route.view === 'replay') setDocumentTitle('Session Replay');
    else if (route.view === 'findings') setDocumentTitle('Findings');
    else if (route.view === 'governance') setDocumentTitle('Governance');
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

  const goFindings = useCallback((pillar?: InsightPillar) => {
    setRoute({ view: 'findings', pillar });
    window.location.hash = pillar ? `#/findings?pillar=${pillar}` : '#/findings';
  }, []);

  const goGovernance = useCallback(() => {
    setRoute({ view: 'governance' });
    window.location.hash = '#/governance';
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
  const onFindings = route.view === 'findings';
  const onGovernance = route.view === 'governance';
  const onList = !selectedId && !onSettings && !onOverview && !onMetricsHistory && !onReplay && !onFindings && !onGovernance;

  // Counts for the navigation: sessions traced, and findings that still need a look.
  const { data: stats } = usePolling<Stats>(['stats'], () => getStats(), 15000);
  // Same query key as Overview and Findings use for their default window, so the collector computes findings once.
  const { data: openInsights } = usePolling<InsightsResponse>(['insights', 30], () => getInsights(30, 'all'), 60000);
  const openFindings = openInsights?.insights.filter((f) => f.status === 'active' && f.severity !== 'info').length ?? 0;
  const tz = userTimeZone();
  // Same key as the Overview's metrics, so it is shared rather than fetched twice.
  const { data: metrics } = usePolling<Metrics>(['metrics', tz], () => getMetrics(tz), 60000);
  const { theme } = useTheme();
  const { density } = usePrefs();
  const narrow = useNarrow();
  const [mobileOpen, setMobileOpen] = useState(false);
  const rail = navCollapsed && !narrow;

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
        label: 'Go to Activity',
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
        id: 'nav-findings',
        label: 'Go to Findings',
        icon: 'warn',
        keywords: 'findings insights security cost usability rules triage dismiss',
        active: onFindings,
        run: () => goFindings(),
      },
      {
        id: 'nav-governance',
        label: 'Go to Governance',
        icon: 'plug',
        keywords: 'governance hooks coverage retention audit residency',
        active: onGovernance,
        run: goGovernance,
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
      onFindings,
      onGovernance,
      goFindings,
      goGovernance,
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

  const activeNav: NavKey = onFindings
    ? 'findings'
    : onGovernance
      ? 'governance'
      : onSettings
    ? 'settings'
    : onOverview
      ? 'overview'
      : onMetricsHistory
        ? 'history'
        : onReplay
          ? 'replay'
          : 'sessions';

  const queryClient = useQueryClient();
  const cachedSummary = selectedId ? queryClient.getQueryData<{ summary: { cwd: string | null } }>(['sessionDetail', selectedId])?.summary : undefined;
  const crumbs: { label: string; href?: string }[] = selectedId
    ? [{ label: 'Sessions', href: '#/sessions' }, { label: cachedSummary ? `${fproject(cachedSummary.cwd)} · ${selectedId.slice(0, 8)}` : shortSession(selectedId) }]
    : replayId
      ? [{ label: 'Session Replay', href: '#/replay' }, { label: shortSession(replayId) }]
      : route.view === 'replay'
        ? [{ label: 'Session Replay' }]
        : onMetricsHistory
      ? [{ label: 'Activity' }]
      : [{ label: onFindings ? 'Findings' : onGovernance ? 'Governance' : onSettings ? 'Settings' : onOverview ? 'Overview' : 'Sessions' }];
  const trail = [{ label: 'Local workspace', href: '#/overview' }, ...crumbs];

  return (
    <div className="vf app" data-theme={theme} data-rail={rail} data-density={density}>
      <AppSidebar
        active={activeNav}
        rail={rail}
        narrow={narrow}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onToggleCollapsed={toggleNav}
        onSearch={() => setPaletteOpen(true)}
        counts={{ sessions: stats?.sessions, findings: openFindings, projects: metrics?.totals.projects, agents: stats ? Object.keys(stats.by_source).length : undefined }}
      />
      <div className="main">
        <header className="top">
          <button type="button" className="iconbtn show-sm" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><FIcon name="menu" /></button>
          <nav aria-label="Breadcrumb" className="crumbs">
            {trail.map((c, i) => (
              <span key={c.label} style={{ display: 'contents' }}>
                {i > 0 && <FIcon name="chevron" size={14} className={i === 1 ? 'hide-sm' : undefined} />}
                {i === trail.length - 1 ? (
                  <b className={`truncate ${i > 1 ? 'mono' : ''}`} style={i > 1 ? { fontSize: 12 } : undefined} aria-current="page">{c.label}</b>
                ) : (
                  <a href={c.href} className={i === 0 ? 'hide-sm' : undefined} style={{ textDecoration: 'none' }}>{c.label}</a>
                )}
              </span>
            ))}
          </nav>
          <button type="button" className="search" onClick={() => setPaletteOpen(true)} aria-label="Search sessions, findings" aria-keyshortcuts="/ Meta+K" title="Search (/ or ⌘K)">
            <FIcon name="search" size={15} />
            <kbd className="kbd"><svg aria-hidden="true" width="8" height="10" viewBox="0 0 8 10"><path d="M6 1 2 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" fill="none" /></svg></kbd>
          </button>
        </header>

        <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
          {onSettings ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <SettingsView
                sidebarOpen={sidebarOpen}
                onSidebarOpenChange={saveSidebarOpen}
                navCollapsed={navCollapsed}
                onNavCollapsedChange={(c) => c !== navCollapsed && toggleNav()}
                onRunOnboarding={onSetup}
              />
            </main>
          ) : onFindings ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <FindingsView onSelect={selectSession} initialPillar={route.view === 'findings' ? route.pillar : undefined} />
            </main>
          ) : onGovernance ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <GovernanceView onRunOnboarding={onSetup} onSelect={(id) => selectSession(id)} />
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
                <OverviewView onSelect={selectSession} onHistory={goMetricsHistory} onFindings={goFindings} />
              </Suspense>
            </main>
          ) : selectedId ? (
            <>
              {/* The demo's trace page has no side list; it appears only when "Session list: Open" is set in Settings. */}
              {sidebarOpen && (
                <div className="relative z-20 hidden w-80 shrink-0 border-r border-line/10 md:block">
                  <SessionList selectedId={selectedId} onSelect={selectSession} collapsed={false} peeking={false} onToggle={toggleSidebar} />
                </div>
              )}
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <SessionDetailView
                  sessionId={selectedId}
                  focusEventId={route.view === 'session' ? route.focusEventId : undefined}
                  focusQuery={route.view === 'session' ? route.focusQuery : undefined}
                />
              </main>
            </>
          ) : (
            <SessionsView onSelect={selectSession} />
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

/** Below 900px the sidebar is a drawer (the demo's breakpoint). */
function useNarrow() {
  const q = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  return narrow;
}
