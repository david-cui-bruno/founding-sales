import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import { registerHealthIpc } from '../../src/main/health/registerHealthIpc';

const validHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 0,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
};

describe('registerHealthIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  function registeredHandler() {
    const registration = electron.handle.mock.calls[0] as
      | [string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown]
      | undefined;

    if (registration === undefined) {
      throw new Error('health:get was not registered');
    }

    return registration[1];
  }

  it('registers only health:get and returns a validated response to a trusted sender', async () => {
    const service = { getHealth: vi.fn(async () => validHealth) };

    registerHealthIpc(service);

    expect(electron.handle).toHaveBeenCalledTimes(1);
    expect(electron.handle.mock.calls[0]?.[0]).toBe('health:get');
    await expect(
      registeredHandler()({ senderFrame: { url: 'callie://app/index.html' } }),
    ).resolves.toEqual(validHealth);
    expect(service.getHealth).toHaveBeenCalledTimes(1);
  });

  it('rejects an untrusted sender before invoking the health service', async () => {
    const service = { getHealth: vi.fn(() => validHealth) };
    registerHealthIpc(service);

    await expect(
      registeredHandler()({ senderFrame: { url: 'https://attacker.example/' } }),
    ).rejects.toThrow('trusted');
    expect(service.getHealth).not.toHaveBeenCalled();
  });

  it('accepts only the explicitly composed development sender validator', async () => {
    const service = { getHealth: vi.fn(() => validHealth) };
    registerHealthIpc(
      service,
      (url) => url === 'http://localhost:5173/',
    );

    await expect(
      registeredHandler()({ senderFrame: { url: 'http://localhost:5173/' } }),
    ).resolves.toEqual(validHealth);
    await expect(
      registeredHandler()({ senderFrame: { url: 'http://localhost:5173/other' } }),
    ).rejects.toThrow('trusted');
  });

  it('rejects every request argument before invoking the health service', async () => {
    const service = { getHealth: vi.fn(() => validHealth) };
    registerHealthIpc(service);

    await expect(
      registeredHandler()(
        { senderFrame: { url: 'callie://app/index.html' } },
        '/tmp/other.sqlite3',
      ),
    ).rejects.toThrow('arguments');
    expect(service.getHealth).not.toHaveBeenCalled();
  });

  it('rejects a malformed service response in the main process', async () => {
    const service = {
      getHealth: vi.fn(() => ({ ...validHealth, pendingJobs: -1 })),
    };
    registerHealthIpc(service);

    await expect(
      registeredHandler()({ senderFrame: { url: 'callie://app/index.html' } }),
    ).rejects.toThrow();
  });

  it('removes only the registered health handler and does so once', () => {
    const unregister = registerHealthIpc({ getHealth: () => validHealth });

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(1);
    expect(electron.removeHandler).toHaveBeenCalledWith('health:get');
  });
});
