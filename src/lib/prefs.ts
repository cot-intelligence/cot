import { useSyncExternalStore } from 'react';

/** Display preferences for this browser (ported from the demo's prefs). Theme lives in lib/theme and the
 *  sidebar state in the collector settings; these are the rest. Nothing secret is ever stored here. */
export interface Prefs {
  density: 'comfortable' | 'compact';
  motion: 'system' | 'reduced';
  start: 'overview' | 'sessions' | 'findings';
  range: 7 | 30 | 90;
}

const DEFAULTS: Prefs = { density: 'comfortable', motion: 'system', start: 'overview', range: 30 };
const KEY = 'cot.prefs';

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const subs = new Set<() => void>();
const sub = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs = { ...prefs, [k]: v };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked: keep it for this visit */
  }
  subs.forEach((f) => f());
}

export const getPrefs = () => prefs;
export const usePrefs = () => useSyncExternalStore(sub, () => prefs);
