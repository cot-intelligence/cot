import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, getStats, updateSettings, type InsightPillar, type Stats, type Store } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { usePrefs } from '../../lib/prefs';
import { Icon as FIcon } from '../forest/icons';
import { usePolling } from '../../lib/usePolling';
import { useQueryClient } from '@tanstack/react-query';
import { project as fproject } from '../forest/format';
import { setDocumentTitle } from '../../lib/documentTitle';
import { sessionHref } from '../../lib/sessionStore';
import { readNavCollapsed, readSidebarOpen, writeNavCollapsed, writeSidebarOpen } from '../../lib/settings';
import { MetricsSkeleton, SessionDetailSkeleton } from '../ui/Skeleton';
import { AppSidebar, type NavKey } from './AppSidebar';
import { CommandPalette, type PaletteCommand, type PaletteScope } from './CommandPalette';
import { PassiveBanner } from '../passive/PassiveBanner';
import { TaskTray } from './TaskTray';
import { FetchBar } from '../ui/FetchBar';
import { SessionsView } from './SessionsView';

// Code-split: the sessions list (the landing view) ships in the main bundle;
// every other view loads on first visit, so the first paint doesn't wait on
// recharts, markdown rendering or views the user may never open.
const OverviewView = lazy(() =>
  import('./OverviewView').then((m) => ({ default: m.OverviewView })),
);
const MetricsHistoryView = lazy(() =>
  import('./MetricsHistoryView').then((m) => ({ default: m.MetricsHistoryView })),
);
const loadSessionDetail = () => import('./SessionDetailView');
const SessionDetailView = lazy(() => loadSessionDetail().then((m) => ({ default: m.SessionDetailView })));
const SessionList = lazy(() => import('./SessionList').then((m) => ({ default: m.SessionList })));
const ReplayView = lazy(() => import('./ReplayView').then((m) => ({ default: m.ReplayView })));
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })));
const FindingsView = lazy(() => import('./FindingsView').then((m) => ({ default: m.FindingsView })));
const GovernanceView = lazy(() => import('./GovernanceView').then((m) => ({ default: m.GovernanceView })));
const ExtensionDetailView = lazy(() =>
  import('./ExtensionsView').then((m) => ({ default: m.ExtensionDetailView })),
);

// Opening a session is the usual next step from the list, so fetch its code
// once the page is idle; the first click then doesn't wait on a download.
function prefetchSessionDetail(): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
  const run = () => void loadSessionDetail().catch(() => {});
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run);
    return () => w.cancelIdleCallback?.(id);
  }
  // WKWebView (the Mac app) has no requestIdleCallback.
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

function sameRoute(a: DashboardRoute, b: DashboardRoute): boolean {
  const strip = (r: DashboardRoute) => ('focusNonce' in r ? { ...r, focusNonce: undefined } : r);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

interface DashboardProps {
  onSetup: () => void;
}

type DashboardRoute =
  | { view: 'list' }
  | { view: 'session'; sessionId: string; focusEventId?: number; focusQuery?: string; focusNonce?: number }
  | { view: 'overview' }
  | { view: 'metrics-history'; tab?: MetricsHistoryTab; group?: string }
  | { view: 'replay' }
  | { view: 'replay-session'; sessionId: string; focusEventId?: number; focusQuery?: string; focusNonce?: number }
  | { view: 'settings' }
  | { view: 'findings'; pillar?: InsightPillar }
  | { view: 'governance' }
  | { view: 'extension'; key: string };

type MetricsHistoryTab = 'shell' | 'web' | 'mcp' | 'skill' | 'plugin';
const ACTIVITY_LABEL: Record<MetricsHistoryTab, string> = { shell: 'Shell', web: 'Web', mcp: 'MCP', skill: 'Skills', plugin: 'Plugins' };
const ACTIVITY_TABS = Object.keys(ACTIVITY_LABEL) as MetricsHistoryTab[];

/** The Activity page that lists an extension kind (MCP, Skills, Plugins). */
function installedHref(kind: string): string {
  return `#/metrics-history?tab=${kind}`;
}

function parseHash(): DashboardRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'settings') return { view: 'settings' };
  if (hash === 'governance') return { view: 'governance' };
  const extPage = hash.match(/^extensions\/(.+)$/);
  if (extPage) return { view: 'extension', key: decodeURIComponent(extPage[1]) };
  // The old Extensions list now lives in Activity (MCP / Skills → Installed, Plugins).
  if (/^extensions(\?.*)?$/.test(hash)) return { view: 'metrics-history', tab: 'mcp' };
  const findingsMatch = hash.match(/^findings(?:\?pillar=(security|cost|usability))?$/);
  if (findingsMatch) return { view: 'findings', pillar: findingsMatch[1] as InsightPillar | undefined };
  // The workspace opens on the Overview.
  if (hash === '') return { view: 'overview' };
  // #/metrics-history?tab=mcp[&group=<server>][&view=installed]: a tab, optionally with the log
  // narrowed to one group, or the tab's installed list.
  const historyMatch = hash.match(/^metrics-history(?:\?(.*))?$/);
  if (historyMatch) {
    const q = new URLSearchParams(historyMatch[1] ?? '');
    const tab = q.get('tab') as MetricsHistoryTab | null;
    return {
      view: 'metrics-history',
      tab: tab && ACTIVITY_TABS.includes(tab) ? tab : undefined,
      group: q.get('group') ?? undefined,
    };
  }
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
      // A fresh token per navigation, so following the same reference twice still jumps.
      focusNonce: Date.now(),
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
      // In-app navigation sets the route and then the hash; the hashchange that
      // follows parses the same route again. Keep the current one then, or every
      // navigation renders twice (and re-runs focus effects keyed on the nonce).
      const next = parseHash();
      setRoute((prev) => (sameRoute(prev, next) ? prev : next));
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
    else if (route.view === 'metrics-history') setDocumentTitle(`Activity · ${ACTIVITY_LABEL[route.tab ?? 'shell']}`);
    else if (route.view === 'replay') setDocumentTitle('Session Replay');
    else if (route.view === 'findings') setDocumentTitle('Findings');
    else if (route.view === 'governance') setDocumentTitle('Governance');
    else if (route.view === 'extension') setDocumentTitle(route.key.split(':').slice(1).join(':'));
  }, [route.view, route.view === 'metrics-history' ? route.tab : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectSession = useCallback((id: string, eventId?: number, query?: string, store: Store = 'main') => {
    const view = store === 'replay' ? 'replay-session' : 'session';
    setRoute({ view, sessionId: id, focusEventId: eventId, focusQuery: query, focusNonce: Date.now() });
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
    window.location.hash = tab === 'shell' ? '#/metrics-history' : `#/metrics-history?tab=${tab}`;
  }, []);

  const goFindings = useCallback((pillar?: InsightPillar) => {
    setRoute({ view: 'findings', pillar });
    window.location.hash = pillar ? `#/findings?pillar=${pillar}` : '#/findings';
  }, []);

  const goGovernance = useCallback(() => {
    setRoute({ view: 'governance' });
    window.location.hash = '#/governance';
  }, []);

  const goInstalled = useCallback((kind: 'mcp' | 'skill' | 'plugin') => {
    window.location.hash = installedHref(kind);
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
  const extensionKey = route.view === 'extension' ? route.key : null;
  const extensionKind = extensionKey ? (extensionKey.split(':')[0] as 'mcp' | 'skill' | 'plugin') : null;
  const onExtensions = !!extensionKey;
  const onList = !selectedId && !onSettings && !onOverview && !onMetricsHistory && !onReplay && !onFindings && !onGovernance && !onExtensions;

  // Counts for the navigation: sessions traced, and findings that still need a look.
  // /v1/stats carries them all, so the shell never pays for metrics or an insights pass.
  const { data: stats } = usePolling<Stats>(['stats'], () => getStats(), 15000);
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
        keywords: 'shell commands urls web history bash activity mcp calls skills plugins',
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
        id: 'nav-installed',
        label: 'Go to installed MCP servers, skills and plugins',
        icon: 'plug',
        keywords: 'extensions plugins skills mcp servers installed usage scope security scan',
        active: onMetricsHistory && route.view === 'metrics-history' && route.tab === 'mcp',
        run: () => goInstalled('mcp'),
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
      onExtensions,
      goFindings,
      goGovernance,
      goInstalled,
      route,
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
    : extensionKind
      ? (`activity-${extensionKind}` as NavKey)
      : onGovernance
      ? 'governance'
      : onSettings
    ? 'settings'
    : onOverview
      ? 'overview'
      : onMetricsHistory
        ? (`activity-${route.view === 'metrics-history' ? route.tab ?? 'shell' : 'shell'}` as NavKey)
        : onReplay
          ? 'replay'
          : 'sessions';

  const queryClient = useQueryClient();
  useEffect(prefetchSessionDetail, []);
  const cachedSummary = selectedId ? queryClient.getQueryData<{ summary: { cwd: string | null } }>(['sessionDetail', selectedId])?.summary : undefined;
  const crumbs: { label: string; href?: string }[] = selectedId
    ? [{ label: 'Sessions', href: '#/sessions' }, { label: cachedSummary ? `${fproject(cachedSummary.cwd)} · ${selectedId.slice(0, 8)}` : shortSession(selectedId) }]
    : replayId
      ? [{ label: 'Session Replay', href: '#/replay' }, { label: shortSession(replayId) }]
      : route.view === 'replay'
        ? [{ label: 'Session Replay' }]
        : extensionKey
          ? [
              { label: 'Activity', href: '#/metrics-history' },
              { label: ACTIVITY_LABEL[extensionKind!], href: installedHref(extensionKind!) },
              { label: extensionKey.split(':').slice(1).join(':') },
            ]
        : onMetricsHistory
      ? [{ label: 'Activity', href: '#/metrics-history' }, { label: ACTIVITY_LABEL[route.view === 'metrics-history' ? route.tab ?? 'shell' : 'shell'] }]
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
        counts={{ sessions: stats?.sessions, findings: stats?.open_findings ?? 0, projects: stats?.projects, agents: stats ? Object.keys(stats.by_source).length : undefined }}
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
          <TaskTray />
        </header>
        <FetchBar />
        <PassiveBanner />

        <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
          {onSettings ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <SettingsView
                  sidebarOpen={sidebarOpen}
                  onSidebarOpenChange={saveSidebarOpen}
                  navCollapsed={navCollapsed}
                  onNavCollapsedChange={(c) => c !== navCollapsed && toggleNav()}
                  onRunOnboarding={onSetup}
                />
              </Suspense>
            </main>
          ) : onFindings ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <FindingsView onSelect={selectSession} initialPillar={route.view === 'findings' ? route.pillar : undefined} />
              </Suspense>
            </main>
          ) : onExtensions ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <ExtensionDetailView extKey={extensionKey!} onSelect={selectSession} />
              </Suspense>
            </main>
          ) : onGovernance ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <GovernanceView onRunOnboarding={onSetup} onSelect={(id) => selectSession(id)} />
              </Suspense>
            </main>
          ) : onMetricsHistory ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <MetricsHistoryView
                  onSelect={selectSession}
                  onBack={goOverview}
                  initialTab={route.view === 'metrics-history' ? route.tab : undefined}
                  initialGroup={route.view === 'metrics-history' ? route.group : undefined}
                />
              </Suspense>
            </main>
          ) : route.view === 'replay' ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <ReplayView />
              </Suspense>
            </main>
          ) : replayId ? (
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Suspense fallback={<SessionDetailSkeleton />}>
                <SessionDetailView
                  sessionId={replayId}
                  store="replay"
                  focusEventId={route.view === 'replay-session' ? route.focusEventId : undefined}
                  focusQuery={route.view === 'replay-session' ? route.focusQuery : undefined}
                  focusNonce={route.view === 'replay-session' ? route.focusNonce : undefined}
                />
              </Suspense>
            </main>
          ) : onOverview ? (
            <main className="flex min-w-0 flex-1 flex-col">
              <Suspense fallback={<MetricsSkeleton />}>
                <OverviewView onSelect={selectSession} onHistory={goMetricsHistory} onFindings={goFindings} />
              </Suspense>
            </main>
          ) : selectedId ? (
            <>
              {/* The demo's trace page has no side list; it appears only when "Session list: Open" is set in Settings,
                  and only from xl, so beside the nav it never squeezes the trace below a readable width. */}
              {sidebarOpen && (
                <div className="relative z-20 hidden w-80 shrink-0 border-r border-line/10 xl:block">
                  <Suspense fallback={null}>
                    <SessionList selectedId={selectedId} onSelect={selectSession} collapsed={false} peeking={false} onToggle={toggleSidebar} />
                  </Suspense>
                </div>
              )}
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Suspense fallback={<SessionDetailSkeleton />}>
                  <SessionDetailView
                    sessionId={selectedId}
                    focusEventId={route.view === 'session' ? route.focusEventId : undefined}
                    focusQuery={route.view === 'session' ? route.focusQuery : undefined}
                    focusNonce={route.view === 'session' ? route.focusNonce : undefined}
                  />
                </Suspense>
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
