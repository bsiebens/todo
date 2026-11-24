import { useCallback, useSyncExternalStore } from 'react';

/** The user's choice. "system" follows the OS light/dark setting. */
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'todo.theme';
export const THEME_PREFS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
/** Browser chrome colour (status bar on iOS, title bar on desktop) for each theme. Keep in sync with --surface in styles.css. */
export const THEME_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#15181e' };

export function parseThemePref(v: unknown): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

/** Next choice when cycling with a single button: System, Light, Dark, back to System. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system';
}

// ---------- Browser side ----------
// The preference is per device (a phone can be dark while the office PC is light), so it lives in
// localStorage, not in the synced settings table.

const listeners = new Set<() => void>();
const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Sets data-theme on <html> and the theme-color meta tag. Also run (inlined) from index.html before first paint. */
export function applyTheme(pref: ThemePref = readPref()): Theme {
  const theme = resolveTheme(pref, !!darkQuery()?.matches);
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  root.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', THEME_COLOR[theme]));
  return theme;
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode: still apply for this session */
  }
  current = pref;
  applyTheme(pref);
  listeners.forEach((l) => l());
}

let current: ThemePref = typeof window === 'undefined' ? 'system' : readPref();

/** Keeps <html> in sync with the OS setting and with other tabs. Call once at startup. */
export function initTheme(): void {
  applyTheme(current);
  darkQuery()?.addEventListener('change', () => {
    applyTheme(current);
    listeners.forEach((l) => l());
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    current = readPref();
    applyTheme(current);
    listeners.forEach((l) => l());
  });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, () => current);
  const systemDark = useSyncExternalStore(subscribe, () => !!darkQuery()?.matches);
  const setPref = useCallback((p: ThemePref) => setThemePref(p), []);
  return { pref, theme: resolveTheme(pref, systemDark), setPref };
}
