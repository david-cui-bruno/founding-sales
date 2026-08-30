// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppHealth } from '../shared/healthContract';
import { App } from './App';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 1,
  databasePath: '/tmp/callie.sqlite3',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 0,
};

type Deferred<T> = {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

const renderApp = (getHealth: () => Promise<AppHealth>) => {
  window.callie = { health: { get: getHealth } };
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App async lifecycle', () => {
  it('ignores a stale failed request after the latest request is ready', async () => {
    const first = deferred<AppHealth>();
    const second = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderApp(getHealth);
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(health));
    await screen.findByText('SQLite ready');
    await act(async () => first.reject(new Error('stale failure')));

    expect(screen.getByText('SQLite ready')).not.toBeNull();
    expect(screen.queryByText('The local database could not be opened')).toBeNull();
  });

  it('ignores a stale successful request after the latest request fails', async () => {
    const first = deferred<AppHealth>();
    const second = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderApp(getHealth);
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));

    await act(async () => second.reject(new Error('latest failure')));
    await screen.findByRole('alert');
    await act(async () => first.resolve(health));

    expect(screen.getByRole('alert').textContent).toContain(
      'The local database could not be opened',
    );
    expect(screen.queryByText('SQLite ready')).toBeNull();
  });

  it('announces failure and ignores a retry that resolves after unmount', async () => {
    const stale = deferred<AppHealth>();
    const initial = deferred<AppHealth>();
    const retry = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(retry.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderApp(getHealth);

    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
    await act(async () => initial.reject(new Error('initial failure')));
    const alert = await screen.findByRole('alert');

    expect(alert.getAttribute('aria-live')).toBe('assertive');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(async () => retry.resolve(health));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
