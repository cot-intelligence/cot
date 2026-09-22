const SIDEBAR_KEY = 'cot.sidebar.open';
const NAV_COLLAPSED_KEY = 'cot.nav.collapsed';
const ONBOARDED_KEY = 'cot.onboarded';
const AGENTS_KEY = 'cot.onboarding.agents';
const LEGACY_AGENT_KEY = 'cot.onboarding.agent';

export function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Whether the app navigation rail is collapsed to icons. Default: expanded. */
export function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeNavCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function readSavedAgents(): ('claude' | 'cursor' | 'codex')[] {
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (x): x is 'claude' | 'cursor' | 'codex' =>
            x === 'claude' || x === 'cursor' || x === 'codex',
        );
      }
    }
    const legacy = localStorage.getItem(LEGACY_AGENT_KEY);
    if (legacy === 'claude' || legacy === 'cursor' || legacy === 'codex') return [legacy];
  } catch {
    /* ignore */
  }
  return [];
}

export function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Local copy of the onboarding result; the collector holds the durable one. */
export function writeOnboarded(agents: ('claude' | 'cursor' | 'codex')[]): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
    localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
  } catch {
    /* ignore */
  }
}
