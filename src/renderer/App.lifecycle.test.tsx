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
import type { AppleSpikePreloadApi } from '../shared/preload';
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

const disabledAppleSpike = (): AppleSpikePreloadApi => ({
  getStatus: vi.fn(async () => ({
    enabled: false,
    bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
  } as const)),
  probeCapabilities: vi.fn(),
  requestContacts: vi.fn(),
  promptAccessibility: vi.fn(),
  scanRecentNotes: vi.fn(),
  scanTestMessages: vi.fn(),
  startCallObservation: vi.fn(),
  stopCallObservation: vi.fn(),
  sendTestMessage: vi.fn(),
  onObservationEvidence: vi.fn((): (() => void) => () => undefined),
});

const renderApp = (
  getHealth: () => Promise<AppHealth>,
  appleSpike: AppleSpikePreloadApi = disabledAppleSpike(),
) => {
  window.callie = { health: { get: getHealth }, appleSpike };
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
  it('renders the CLI-enabled Apple spike alongside foundation health', async () => {
    const appleSpike = disabledAppleSpike();
    appleSpike.getStatus = vi.fn(async () => ({
      enabled: true,
      bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
    } as const));

    renderApp(vi.fn(async () => health), appleSpike);

    await screen.findByText('SQLite ready');
    expect(await screen.findByRole('region', { name: 'Apple feasibility spike' })).not.toBeNull();
  });

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
