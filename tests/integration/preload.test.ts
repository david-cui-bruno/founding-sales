import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
}));

describe('preload health bridge', () => {
  beforeEach(async () => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    vi.resetModules();
    await import('../../src/preload');
  });

  function exposedApi(): {
    health: { get: () => Promise<unknown> };
    appleSpike: Record<string, unknown>;
  } {
    const exposure = electron.exposeInMainWorld.mock.calls[0] as
      | [string, {
        health: { get: () => Promise<unknown> };
        appleSpike: Record<string, unknown>;
      }]
      | undefined;

    if (exposure === undefined) {
      throw new Error('callie preload API was not exposed');
    }

    expect(exposure[0]).toBe('callie');
    return exposure[1];
  }

  it('keeps window.callie.health narrow and invokes only health:get without arguments', async () => {
    const health = {
      appVersion: '1.0.0',
      schemaVersion: 1,
      databasePath: '/tmp/callie.sqlite3',
      fts5Available: true,
      pendingJobs: 0,
      interruptedJobsRecovered: 0,
    };
    electron.invoke.mockResolvedValue(health);

    const api = exposedApi();

    expect(Object.keys(api)).toEqual(['health', 'appleSpike']);
    expect(Object.keys(api.health)).toEqual(['get']);
    await expect(api.health.get()).resolves.toEqual(health);
    expect(electron.invoke).toHaveBeenCalledTimes(1);
    expect(electron.invoke).toHaveBeenCalledWith('health:get');
  });

  it('rejects a malformed main-process response before exposing it to the renderer', async () => {
    electron.invoke.mockResolvedValue({
      appVersion: '1.0.0',
      schemaVersion: 1,
      databasePath: '/tmp/callie.sqlite3',
      fts5Available: true,
      pendingJobs: -1,
      interruptedJobsRecovered: 0,
    });

    await expect(exposedApi().health.get()).rejects.toThrow();
  });
});
