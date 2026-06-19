import { useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cot.theme';

function readTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return 'light';
}

/** Apply the theme to the document immediately and persist it. */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — theme still applies for the session */
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  const setTheme = (next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  };

  const toggle = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return { theme, toggle, setTheme };
}
