import { motion, useReducedMotion } from 'framer-motion';
import { useRef } from 'react';
import { getHealth, type Health } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { Icon } from '../forest/icons';
import { Wordmark } from '../forest/ui';

export type ActivityTab = 'shell' | 'web' | 'mcp' | 'skill' | 'plugin';
export type NavKey =
  | 'sessions' | 'overview' | 'replay' | 'findings' | 'governance' | 'settings'
  | `activity-${ActivityTab}`;

// Markup and classes follow the demo's sidebar (demo-variants/src/variants/forest/App.tsx) one to one;
// Session Replay and the Activity section (one entry per Activity tab) are additions.
const NAV: { group: string; items: { key: NavKey; label: string; href: string; icon: string }[] }[] = [
  {
    group: 'Monitor',
    items: [
      { key: 'overview', label: 'Overview', href: '#/overview', icon: 'overview' },
      { key: 'sessions', label: 'Sessions', href: '#/sessions', icon: 'sessions' },
      { key: 'replay', label: 'Session Replay', href: '#/replay', icon: 'replay' },
    ],
  },
  {
    group: 'Activity',
    items: [
      { key: 'activity-shell', label: 'Shell', href: '#/metrics-history', icon: 'shell' },
      { key: 'activity-web', label: 'Web', href: '#/metrics-history?tab=web', icon: 'globe' },
      { key: 'activity-mcp', label: 'MCP', href: '#/metrics-history?tab=mcp', icon: 'plug' },
      { key: 'activity-skill', label: 'Skills', href: '#/metrics-history?tab=skill', icon: 'layers' },
      { key: 'activity-plugin', label: 'Plugins', href: '#/metrics-history?tab=plugin', icon: 'puzzle' },
    ],
  },
  {
    group: 'Govern',
    items: [
      { key: 'findings', label: 'Findings', href: '#/findings', icon: 'findings' },
      { key: 'governance', label: 'Governance', href: '#/governance', icon: 'governance' },
    ],
  },
];

interface AppSidebarProps {
  active: NavKey;
  /** The icon rail (desktop only; phones always get the full drawer). */
  rail: boolean;
  narrow: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  counts: { sessions?: number; findings?: number; projects?: number; agents?: number };
}

// The active pill slides between entries. Navigation happens many times a day, so it is quick,
// and it jumps without sliding when the OS asks for reduced motion.
const PILL = { type: 'spring', duration: 0.22, bounce: 0 } as const;
const PILL_INSTANT = { duration: 0 } as const;

export function AppSidebar({ active, rail, narrow, mobileOpen, onMobileClose, onToggleCollapsed, onSearch, counts }: AppSidebarProps) {
  const { data: health, error } = usePolling<Health>(['health'], () => getHealth(), 15000);
  const warm = useWarmTips();
  const pill = useReducedMotion() ? PILL_INSTANT : PILL;
  const ws = 'Local workspace';
  const foot = error ? 'Collector offline' : `Collector on :31337${health ? ` · v${health.version}` : ''}`;

  return (
    <>
      <aside className="side" data-open={mobileOpen} data-rail={rail} aria-label="Workspace navigation" {...warm}
        onClick={rail ? (e) => {
          // Collapsed rail: a click on empty space expands it; links and buttons keep their own job.
          if (!(e.target as Element).closest('a, button, input, select, textarea')) onToggleCollapsed();
        } : undefined}>
        <div className="side-top">
          {rail ? (
            <button type="button" className="rail-logo" onClick={onToggleCollapsed} aria-label="Expand sidebar" data-tip="Expand sidebar">
              <span className="wordmark">c<i>.</i></span>
              <Icon name="sidebar" size={18} />
            </button>
          ) : (
            <>
              <a href="#/overview" aria-label="cot overview" style={{ textDecoration: 'none' }}><Wordmark /></a>
              <button type="button" className="iconbtn" onClick={() => (narrow ? onMobileClose() : onToggleCollapsed())} aria-label={narrow ? 'Close navigation' : 'Collapse sidebar'}>
                <Icon name={narrow ? 'close' : 'sidebar'} />
              </button>
            </>
          )}
        </div>
        <nav className="side-nav">
          {NAV.map((g) => (
            <div className="nav-g" key={g.group}>
              {!rail && <span className="label">{g.group}</span>}
              {g.items.map((it) => {
                const on = it.key === active;
                const badge = it.key === 'findings' && !!counts.findings;
                return (
                  <a
                    key={it.key}
                    href={it.href}
                    className="nav-i"
                    aria-current={on ? 'page' : undefined}
                    onClick={onMobileClose}
                    aria-label={rail ? (badge ? `${it.label}, ${counts.findings} open` : it.label) : undefined}
                    data-tip={rail ? it.label : undefined}>
                    {on && <motion.span layoutId="vf-pill" className="pill" transition={pill} />}
                    <Icon name={it.icon} />
                    {rail ? (
                      badge && <span className="badge" aria-hidden="true" />
                    ) : (
                      <>
                        <span>{it.label}</span>
                        {badge && <span className="ct hot">{counts.findings}</span>}
                        {it.key === 'sessions' && counts.sessions != null && <span className="ct">{counts.sessions}</span>}
                      </>
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        {rail ? (
          <div className="rail-foot">
            <a href="#/settings" className="nav-i" aria-current={active === 'settings' ? 'page' : undefined} aria-label="Settings" data-tip="Settings">
              {active === 'settings' && <motion.span layoutId="vf-pill" className="pill" transition={pill} />}
              <Icon name="sliders" />
            </a>
            <span className="rail-btn" tabIndex={0} data-tip={foot} aria-label={foot}>
              <span className="live" style={error ? { background: 'var(--v-alert)' } : undefined} />
            </span>
            <button type="button" className="rail-btn" onClick={onSearch} data-tip={ws} aria-label={`Workspace: ${ws}`}>
              <span className="av">{ws[0]}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="nav-g" style={{ marginTop: 'auto', paddingBottom: 8 }}>
              <a href="#/settings" className="nav-i" aria-current={active === 'settings' ? 'page' : undefined} onClick={onMobileClose}>
                {active === 'settings' && <motion.span layoutId="vf-pill" className="pill" transition={pill} />}
                <Icon name="sliders" />
                <span>Settings</span>
              </a>
            </div>
          </>
        )}
            {/* Workspace sits at the bottom in both states, like the rail's avatar. */}
        {!rail && (
          <button type="button" className="ws" onClick={onSearch} aria-label={`Workspace: ${ws}. ${foot}`} title={foot}>
            <span className="av">
              {ws[0]}
              {/* Collector status rides on the avatar, like presence, instead of a row of its own. */}
              <span className="live" data-off={error || undefined} aria-hidden="true" />
            </span>
            <span style={{ display: 'grid', minWidth: 0 }}>
              <b className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{ws}</b>
              <span className="mono faint truncate" style={{ fontSize: 11, color: error ? 'var(--v-alert)' : undefined }} role="status">
                {error ? 'Collector offline' : (
                  <>
                    {counts.projects != null ? `${counts.projects} projects` : '…'}
                    {counts.agents != null ? ` · ${counts.agents} agents` : ''}
                  </>
                )}
              </span>
            </span>
          </button>
        )}
      </aside>
      {mobileOpen && <div className="scrim" style={{ zIndex: 55 }} onClick={onMobileClose} />}
    </>
  );
}

/** Rail tooltips wait 400ms the first time; once one has shown, the rest open instantly until the pointer leaves the rail. */
function useWarmTips() {
  const t = useRef<number>();
  return {
    onPointerOver(e: React.PointerEvent<HTMLElement>) {
      if (e.currentTarget.dataset.warm || !(e.target as HTMLElement).closest('[data-tip]')) return;
      const el = e.currentTarget;
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => {
        el.dataset.warm = 'true';
      }, 400);
    },
    onPointerLeave(e: React.PointerEvent<HTMLElement>) {
      window.clearTimeout(t.current);
      delete e.currentTarget.dataset.warm;
    },
  };
}
