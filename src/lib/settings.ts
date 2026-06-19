const SIDEBAR_KEY = 'cot.sidebar.open';
const ONBOARDED_KEY = 'cot.onboarded';
const AGENT_KEY = 'cot.onboarding.agent';

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

export function readSavedAgent(): 'claude' | 'cursor' | 'codex' | null {
  try {
    const v = localStorage.getItem(AGENT_KEY);
    return v === 'claude' || v === 'cursor' || v === 'codex' ? v : null;
  } catch {
    return null;
  }
}

export function clearOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* ignore */
  }
}
