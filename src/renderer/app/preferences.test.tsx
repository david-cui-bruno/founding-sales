// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDensity } from './useDensity';
import { useTheme } from './useTheme';

type MediaListener = (event: { matches: boolean }) => void;

function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<MediaListener>();
  let matches = initialDark;

  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
  };

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQueryList),
  );

  return {
    setSystemDark(next: boolean) {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next });
      }
    },
  };
}

function ThemeProbe() {
  const theme = useTheme();

  return (
    <>
      <output data-testid="preference">{theme.preference}</output>
      <output data-testid="resolved">{theme.resolvedTheme}</output>
      <button type="button" onClick={() => theme.setPreference('dark')}>
        Use dark
      </button>
      <button type="button" onClick={() => theme.setPreference('system')}>
        Use system
      </button>
    </>
  );
}

function DensityProbe() {
  const density = useDensity();

  return (
    <>
      <output data-testid="density">{density.density}</output>
      <button type="button" onClick={() => density.setDensity('compact')}>
        Use compact
      </button>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('defaults to the system preference and resolves via matchMedia', () => {
    stubMatchMedia(true);
    render(<ThemeProbe />);

    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies and persists an explicit theme preference', () => {
    stubMatchMedia(false);
    render(<ThemeProbe />);

    fireEvent.click(screen.getByRole('button', { name: 'Use dark' }));

    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('callie.theme')).toBe('dark');
  });

  it('restores a persisted preference on mount', () => {
    stubMatchMedia(false);
    window.localStorage.setItem('callie.theme', 'dark');
    render(<ThemeProbe />);

    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores corrupted persisted values', () => {
    stubMatchMedia(false);
    window.localStorage.setItem('callie.theme', 'hotdog');
    render(<ThemeProbe />);

    expect(screen.getByTestId('preference').textContent).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows live system changes while preference is system', () => {
    const media = stubMatchMedia(false);
    render(<ThemeProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'Use system' }));

    act(() => {
      media.setSystemDark(true);
    });

    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('useDensity', () => {
  it('defaults to comfortable and marks the document', () => {
    render(<DensityProbe />);

    expect(screen.getByTestId('density').textContent).toBe('comfortable');
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });

  it('applies and persists a compact preference', () => {
    render(<DensityProbe />);

    fireEvent.click(screen.getByRole('button', { name: 'Use compact' }));

    expect(document.documentElement.dataset.density).toBe('compact');
    expect(window.localStorage.getItem('callie.density')).toBe('compact');
  });

  it('restores a persisted density and rejects corrupt values', () => {
    window.localStorage.setItem('callie.density', 'compact');
    const first = render(<DensityProbe />);
    expect(screen.getByTestId('density').textContent).toBe('compact');
    first.unmount();

    window.localStorage.setItem('callie.density', 'gigantic');
    render(<DensityProbe />);
    expect(screen.getByTestId('density').textContent).toBe('comfortable');
  });
});
