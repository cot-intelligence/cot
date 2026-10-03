import { motion } from 'framer-motion';
import { useRef } from 'react';
import { getHealth, type Health } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { Icon } from '../forest/icons';
import { Wordmark } from '../forest/ui';

export type NavKey = 'sessions' | 'overview' | 'history' | 'replay' | 'findings' | 'governance' | 'settings';

// Markup and classes follow the demo's sidebar (demo-variants/src/variants/forest/App.tsx) one to one;
// Session Replay is the one entry the demo doesn't have.
const NAV: { group: string; items: { key: NavKey; label: string; href: string; icon: string }[] }[] = [
  {
    group: 'Monitor',
    items: [
      { key: 'overview', label: 'Overview', href: '#/overview', icon: 'overview' },
      { key: 'sessions', label: 'Sessions', href: '#/sessions', icon: 'sessions' },
      { key: 'history', label: 'Activity', href: '#/metrics-history', icon: 'activity' },
      { key: 'replay', label: 'Session Replay', href: '#/replay', icon: 'replay' },
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

const PILL = { type: 'spring', duration: 0.3, bounce: 0 } as const;

export function AppSidebar({ active, rail, narrow, mobileOpen, onMobileClose, onToggleCollapsed, onSearch, counts }: AppSidebarProps) {
  const { data: health, error } = usePolling<Health>(['health'], () => getHealth(), 15000);
  const warm = useWarmTips();
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
                    {on && <motion.span layoutId="vf-pill" className="pill" transition={PILL} />}
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
              {active === 'settings' && <motion.span layoutId="vf-pill" className="pill" transition={PILL} />}
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
                {active === 'settings' && <motion.span layoutId="vf-pill" className="pill" transition={PILL} />}
                <Icon name="sliders" />
                <span>Settings</span>
              </a>
            </div>
            <div className="side-foot" style={{ marginTop: 0 }} role="status">
              <span className="live" style={error ? { background: 'var(--v-alert)' } : undefined} />
              <span>{foot}</span>
            </div>
          </>
        )}
            {/* Workspace sits at the bottom in both states, like the rail's avatar. */}
        {!rail && (
          <button type="button" className="ws" onClick={onSearch} aria-label={`Workspace: ${ws}`}>
            <span className="av">{ws[0]}</span>
            <span style={{ display: 'grid', minWidth: 0 }}>
              <b className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{ws}</b>
              <span className="mono faint truncate" style={{ fontSize: 11 }}>
                {counts.projects != null ? `${counts.projects} projects` : '…'}
                {counts.agents != null ? ` · ${counts.agents} agents` : ''}
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
