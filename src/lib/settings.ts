const SIDEBAR_KEY = 'cot.sidebar.open';
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

export function clearOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* ignore */
  }
}
