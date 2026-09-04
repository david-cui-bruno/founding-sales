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

import { registerSourcingIpc } from '../../../src/main/sourcing/registerSourcingIpc';
import type { SourcingProvider } from '../../../src/main/sourcing/registerSourcingIpc';
import type { SourcingStatus } from '../../../src/shared/contracts/sourcingContract';
import {
  registeredIpcHandler,
  type IpcInvokeEvent,
} from '../../fixtures/registeredIpcHandler';

const trustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'callie://app/index.html' },
};
const untrustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'https://attacker.test/' },
};

const status: SourcingStatus = {
  lastPolledAt: '2026-09-01T12:00:00.000Z',
  lastKey: 'events/2026-09-01/a.ndjson',
  backlogCount: 0,
  counters: { imported: 2, replayed: 0, needsIdentity: 1, scoreUpdates: 0, quarantined: 0 },
  credentialState: 'keychain',
  hmacSaltState: 'none',
  execution: {
    state: 'idle', pollId: null, startedAt: null,
    lastCompletedAt: '2026-09-01T12:00:00.000Z', consecutiveFailures: 0,
    lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
  },
  health: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: 0,
    state: {
      state: 'idle', pollId: null, startedAt: null,
      lastCompletedAt: '2026-09-01T12:00:00.000Z', consecutiveFailures: 0,
      lastFailureAt: null, lastFailureCode: null, backlogCount: 0,
    },
  },
};

describe('registerSourcingIpc', () => {
  let provider: SourcingProvider;

  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
    provider = {
      pollNow: vi.fn(async () => status),
      status: vi.fn(async () => status),
      retry: vi.fn(async () => status),
      setHmacSalt: vi.fn(async () => ({ ...status, hmacSaltState: 'set' as const })),
    };
    registerSourcingIpc(provider);
  });

  it('registers exactly the four sourcing channels', () => {
    expect(electron.handle.mock.calls.map((call) => call[0]).sort()).toEqual([
      'sourcing:poll-now',
      'sourcing:retry',
      'sourcing:set-hmac-salt',
      'sourcing:status',
    ]);
  });

  it('serves status, pollNow, and Retry with schema-validated responses', async () => {
    const statusHandler = registeredIpcHandler(electron.handle, 'sourcing:status');
    const pollHandler = registeredIpcHandler(electron.handle, 'sourcing:poll-now');
    const retryHandler = registeredIpcHandler(electron.handle, 'sourcing:retry');

    await expect(statusHandler(trustedEvent)).resolves.toEqual(status);
    await expect(pollHandler(trustedEvent)).resolves.toEqual(status);
    await expect(retryHandler(trustedEvent)).resolves.toEqual(status);
    expect(provider.status).toHaveBeenCalledTimes(1);
    expect(provider.pollNow).toHaveBeenCalledTimes(1);
    expect(provider.retry).toHaveBeenCalledTimes(1);
  });

  it('rejects untrusted senders and unexpected arguments', async () => {
    const statusHandler = registeredIpcHandler(electron.handle, 'sourcing:status');

    await expect(statusHandler(untrustedEvent)).rejects.toThrow();
    await expect(statusHandler(trustedEvent, { extra: true })).rejects.toThrow();
  });

  it('stores the pasted HMAC salt and returns the refreshed status', async () => {
    const saltHandler = registeredIpcHandler(electron.handle, 'sourcing:set-hmac-salt');

    await expect(saltHandler(trustedEvent, { salt: 'shared-salt' })).resolves.toEqual({
      ...status,
      hmacSaltState: 'set',
    });
    expect(provider.setHmacSalt).toHaveBeenCalledWith({ salt: 'shared-salt' });
    // Blank or padded-to-blank salts never reach the provider.
    await expect(saltHandler(trustedEvent, { salt: '   ' })).rejects.toThrow();
  });

  it('rejects a malformed provider response', async () => {
    provider.status = vi.fn(async () => ({
      ...status,
      credentialState: 'plaintext',
    }) as never);
    const statusHandler = registeredIpcHandler(electron.handle, 'sourcing:status');

    await expect(statusHandler(trustedEvent)).rejects.toThrow();
  });

  it('unregisters all channels exactly once', () => {
    electron.handle.mockReset();
    const unregister = registerSourcingIpc(provider);
    unregister();
    unregister();

    expect(
      electron.removeHandler.mock.calls.map((call) => call[0]).sort(),
    ).toEqual([
      'sourcing:poll-now', 'sourcing:retry', 'sourcing:set-hmac-salt', 'sourcing:status',
    ]);
  });
});
