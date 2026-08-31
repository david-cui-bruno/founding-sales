import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'callie.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

const readStoredPreference = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
};

const systemPrefersDark = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;

const resolveTheme = (
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

export type ThemeState = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
};

/**
 * Persists only the non-sensitive theme preference, resolves `system` through
 * matchMedia, and mirrors the resolved theme onto `<html data-theme>`.
 */
export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readStoredPreference,
  );
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: { matches: boolean }) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference persistence is best-effort only.
    }
  }, []);

  return { preference, resolvedTheme, setPreference };
}
