import { getHealth, type Health } from '../../lib/api';
import { usePeek } from '../../lib/usePeek';
import { usePolling } from '../../lib/usePolling';
import { Icon, type IconName } from '../ui/icons';

export type NavKey = 'sessions' | 'overview' | 'history' | 'replay' | 'analysis' | 'settings';

const NAV: { key: NavKey; label: string; href: string; icon: IconName }[] = [
  { key: 'sessions', label: 'Sessions', href: '#/sessions', icon: 'list' },
  { key: 'overview', label: 'Overview', href: '#/overview', icon: 'chart' },
  { key: 'history', label: 'Activity', href: '#/metrics-history', icon: 'terminal' },
  { key: 'replay', label: 'Session Replay', href: '#/replay', icon: 'replay' },
  { key: 'analysis', label: 'Analysis', href: '#/analysis', icon: 'brain' },
];

interface AppSidebarProps {
  active: NavKey;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSearch: () => void;
}

/**
 * Primary app navigation. Expanded it shows labels; collapsed (or below `md`)
 * it is an icon rail, with each entry's label kept as a tooltip. Hovering the
 * collapsed rail peeks the full panel over the content without reflowing it.
 */
export function AppSidebar({ active, collapsed: pinnedCollapsed, onToggleCollapsed, onSearch }: AppSidebarProps) {
  const { peek, handlers } = usePeek(pinnedCollapsed);
  const collapsed = pinnedCollapsed && !peek;

  return (
    <div
      {...handlers}
      className={`rail-motion relative z-30 shrink-0 ${pinnedCollapsed ? 'w-14' : 'w-14 md:w-56'}`}>
      {/* Every row pads its icon to the same x as the 56px rail's center, so
          expanding only widens the panel and fades labels in. */}
      <nav
        aria-label="Primary"
        data-expanded={!collapsed}
        className={`rail-motion absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-line/10 ${
          collapsed ? 'w-14' : 'w-14 md:w-56'
        } ${peek ? 'bg-panel shadow-soft-lg' : 'bg-panel/80 shadow-none backdrop-blur-sm'}`}>
        <div className="flex h-14 shrink-0 items-center border-b border-line/10 px-2.5">
          <a href="#/sessions" className="focus-ring flex items-baseline gap-2 rounded-sm" aria-label="cot. home">
            <span className="w-9 text-center font-serif text-2xl italic leading-none tracking-tight text-fg">cot.</span>
            <span className="rail-label eyebrow !tracking-[0.18em]">Intelligence</span>
          </a>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-2">
          <button
            type="button"
            onClick={onSearch}
            title="Search everything (⌘K)"
            aria-label="Search everything"
            className="focus-ring mb-3 flex h-9 shrink-0 items-center gap-3 rounded-[5px] border border-line/10 bg-bg/60 px-[11px] text-fg/45 transition-colors hover:border-line/25 hover:text-fg">
            <Icon name="search" className="h-4 w-4 shrink-0" />
            <span className="rail-label flex-1 text-left font-mono text-[0.68rem] uppercase tracking-[0.14em]">Search</span>
            <kbd className="rail-label rounded-[3px] border border-line/10 px-1.5 py-0.5 font-mono text-[0.55rem] text-fg/40">
              ⌘K
            </kbd>
          </button>

          <p className="rail-label eyebrow px-3 pb-1">Workspace</p>
          {NAV.map((item) => (
            <NavLink
              key={item.key}
              label={item.label}
              href={item.href}
              icon={item.icon}
              current={active === item.key}
            />
          ))}

          <div className="mt-auto flex flex-col gap-1">
            <NavLink label="Settings" href="#/settings" icon="settings" current={active === 'settings'} />
            <CollectorStatus />
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={pinnedCollapsed ? 'Keep navigation open' : 'Collapse navigation'}
              title={pinnedCollapsed ? 'Keep navigation open' : 'Collapse navigation'}
              className="focus-ring hidden h-8 items-center gap-3 rounded-[5px] px-[13px] text-fg/35 transition-colors hover:bg-fg/[0.05] hover:text-fg md:flex">
              <Icon
                name="chevron-left"
                className={`h-3.5 w-3.5 shrink-0 transition-transform duration-300 ${pinnedCollapsed ? 'rotate-180' : ''}`}
              />
              <span className="rail-label font-mono text-[0.6rem] uppercase tracking-[0.14em]">
                {pinnedCollapsed ? 'Keep open' : 'Collapse'}
              </span>
            </button>
          </div>
        </div>
      </nav>
    </div>
  );
}

function NavLink({
  label,
  href,
  icon,
  current,
}: {
  label: string;
  href: string;
  icon: IconName;
  current: boolean;
}) {
  return (
    <a
      href={href}
      title={label}
      aria-current={current ? 'page' : undefined}
      className={`focus-ring group relative flex h-9 shrink-0 items-center gap-3 rounded-[5px] px-3 font-mono text-[0.68rem] font-bold uppercase tracking-[0.14em] transition-colors ${
        current ? 'bg-fg/[0.07] text-fg' : 'text-fg/55 hover:bg-fg/[0.04] hover:text-fg'
      }`}>
      {current && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-vermilion" aria-hidden="true" />}
      <Icon name={icon} className={`h-4 w-4 shrink-0 ${current ? 'text-vermilion' : ''}`} />
      <span className="rail-label">{label}</span>
    </a>
  );
}

function CollectorStatus() {
  const { data: health, error } = usePolling<Health>(['health'], () => getHealth(), 15000);
  const online = !error && health?.status === 'ok';
  const text = error ? 'Collector offline' : health ? 'Collector online' : 'Connecting…';

  return (
    <div
      title={health ? `${text} · v${health.version}` : text}
      className="mt-2 flex h-10 shrink-0 items-center gap-3 border-t border-line/10 px-4 pt-2">
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {online && <span className="absolute inset-0 animate-pulse rounded-full bg-olive/60" />}
        <span className={`relative h-2 w-2 rounded-full ${online ? 'bg-olive' : error ? 'bg-vermilion' : 'bg-fg/30'}`} />
      </span>
      <span className="rail-label min-w-0 flex-1 truncate font-mono text-[0.6rem] uppercase tracking-[0.14em] text-fg/45">
        {text}
      </span>
      {health && <span className="rail-label font-mono text-[0.58rem] text-fg/30">v{health.version}</span>}
    </div>
  );
}
