import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
/** What the user picked; 'system' follows the OS light/dark setting. */
export type ThemePreference = Theme | 'system';

const STORAGE_KEY = 'cot.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function systemTheme(): Theme {
  return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

// One module-level store so every component (header toggle, Settings) sees
// the same value and re-renders together.
let preference: ThemePreference = readPreference();
const listeners = new Set<() => void>();

function resolved(): Theme {
  return preference === 'system' ? systemTheme() : preference;
}

function apply(): void {
  document.documentElement.setAttribute('data-theme', resolved());
  listeners.forEach((l) => l());
}

// While following the system, repaint when the OS setting flips.
window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
  if (preference === 'system') apply();
});

function setPreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable — theme still applies for the session */
  }
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Snapshot is a string key so useSyncExternalStore can compare cheaply.
const snapshot = () => `${preference}:${resolved()}`;

export function useTheme() {
  const [pref, theme] = useSyncExternalStore(subscribe, snapshot).split(':') as [ThemePreference, Theme];

  return {
    /** The theme actually shown. */
    theme,
    /** The saved choice, including 'system'. */
    preference: pref,
    setPreference,
    /** Flip the shown theme; this pins an explicit light/dark choice. */
    toggle: () => setPreference(theme === 'light' ? 'dark' : 'light'),
  };
}
