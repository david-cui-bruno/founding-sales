import { useCallback, useLayoutEffect, useState } from 'react';

export type DensityPreference = 'compact' | 'comfortable';

const STORAGE_KEY = 'callie.density';

const isDensityPreference = (value: unknown): value is DensityPreference =>
  value === 'compact' || value === 'comfortable';

const readStoredDensity = (): DensityPreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDensityPreference(stored) ? stored : 'comfortable';
  } catch {
    return 'comfortable';
  }
};

export type DensityState = {
  density: DensityPreference;
  setDensity(density: DensityPreference): void;
};

/**
 * Persists only the non-sensitive density preference and mirrors it onto
 * `<html data-density>` so tokens can switch row heights.
 */
export function useDensity(): DensityState {
  const [density, setDensityState] = useState<DensityPreference>(readStoredDensity);

  useLayoutEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((next: DensityPreference) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference persistence is best-effort only.
    }
  }, []);

  return { density, setDensity };
}
