// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StrictMode, useLayoutEffect } from 'react';

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
    liveListeners: () => listeners.size,
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
  vi.restoreAllMocks();
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

function FirstLayoutProbe({ observe }: { observe: (theme: string | undefined, density: string | undefined) => void }): null {
  useTheme();
  useDensity();
  useLayoutEffect(() => {
    observe(document.documentElement.dataset.theme, document.documentElement.dataset.density);
  }, [observe]);
  return null;
}

it('mirrors both preferences before the first layout observation', () => {
  stubMatchMedia(false);
  window.localStorage.setItem('callie.theme', 'dark');
  window.localStorage.setItem('callie.density', 'compact');
  const observe = vi.fn();
  render(<FirstLayoutProbe observe={observe} />);
  expect(observe).toHaveBeenNthCalledWith(1, 'dark', 'compact');
});
it.each(['missing', 'invalid', 'throwing'] as const)('keeps default preferences with %s storage', mode => {
  stubMatchMedia(true);
  if (mode === 'invalid') {
    window.localStorage.setItem('callie.theme', 'invalid');
    window.localStorage.setItem('callie.density', 'invalid');
  }
  if (mode === 'throwing') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const observe = vi.fn();
  render(<FirstLayoutProbe observe={observe} />);
  expect(observe).toHaveBeenNthCalledWith(1, 'dark', 'comfortable');
});
it('keeps one live system listener in StrictMode and none after unmount', () => {
  const media = stubMatchMedia(false);
  const view = render(<StrictMode><ThemeProbe /><DensityProbe /></StrictMode>);
  expect(media.liveListeners()).toBe(1);
  act(() => media.setSystemDark(true));
  expect(document.documentElement.dataset.theme).toBe('dark');
  view.unmount();
  expect(media.liveListeners()).toBe(0);
});
it('updates preferences even when persistence throws', () => {
  stubMatchMedia(false);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  render(<><ThemeProbe /><DensityProbe /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Use dark' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use compact' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.density).toBe('compact');
});
