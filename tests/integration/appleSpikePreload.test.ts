import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
}));

import { APPLE_SPIKE_IPC_CHANNELS } from '../../src/main/appleBridge/registerAppleSpikeIpc';
import type { CalliePreloadApi } from '../../src/shared/preload';

describe('preload Apple feasibility bridge', () => {
  beforeEach(async () => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    vi.resetModules();
    await import('../../src/preload');
  });

  function exposedApi(): CalliePreloadApi {
    const exposure = electron.exposeInMainWorld.mock.calls[0] as
      | [string, CalliePreloadApi]
      | undefined;
    if (exposure === undefined) throw new Error('callie preload API was not exposed');
    expect(exposure[0]).toBe('callie');
    return exposure[1];
  }

  it('exposes only narrow enumerated spike methods with no raw dispatcher', async () => {
    electron.invoke.mockImplementation(async (channel: string) => {
      if (channel === APPLE_SPIKE_IPC_CHANNELS.status) {
        return {
          enabled: true,
          bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
        };
      }
      return {
        action: 'probe_capabilities',
        outcome: 'completed',
        capabilities: {},
      };
    });
    const api = exposedApi();

    expect(Object.keys(api).sort()).toEqual(['appleSpike', 'health']);
    expect(Object.keys(api.appleSpike)).toEqual([
      'getStatus',
      'probeCapabilities',
      'requestContacts',
      'promptAccessibility',
      'scanRecentNotes',
      'scanTestMessages',
      'startCallObservation',
      'stopCallObservation',
      'sendTestMessage',
    ]);
    expect(api.appleSpike).not.toHaveProperty('invoke');
    expect(api.appleSpike).not.toHaveProperty('run');
    await api.appleSpike.getStatus();
    await api.appleSpike.probeCapabilities();
    expect(electron.invoke).toHaveBeenNthCalledWith(1, APPLE_SPIKE_IPC_CHANNELS.status);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, APPLE_SPIKE_IPC_CHANNELS.probeCapabilities);
  });

  it('passes only typed data fields to argument-bearing channels', async () => {
    electron.invoke.mockImplementation(async (channel: string) => {
      const results: Record<string, unknown> = {
        [APPLE_SPIKE_IPC_CHANNELS.scanTestMessages]: {
          action: 'scan_test_messages', outcome: 'completed', sentCount: 0, receivedCount: 0, latestAt: null,
        },
        [APPLE_SPIKE_IPC_CHANNELS.startCallObservation]: {
          action: 'start_call_observation', outcome: 'completed', observation: 'started',
        },
        [APPLE_SPIKE_IPC_CHANNELS.sendTestMessage]: {
          action: 'send_test_message', outcome: 'completed', delivery: 'sent',
        },
      };
      return results[channel];
    });
    const api = exposedApi();

    await api.appleSpike.scanTestMessages({ normalizedHandle: '+15555550100' });
    await api.appleSpike.startCallObservation({ confirmation: 'I CONSENT TO THIS TEST CALL' });
    await api.appleSpike.sendTestMessage({
      normalizedHandle: '+15555550100',
      body: 'Synthetic test',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    });

    expect(electron.invoke.mock.calls).toEqual([
      [APPLE_SPIKE_IPC_CHANNELS.scanTestMessages, { normalizedHandle: '+15555550100' }],
      [APPLE_SPIKE_IPC_CHANNELS.startCallObservation, { confirmation: 'I CONSENT TO THIS TEST CALL' }],
      [APPLE_SPIKE_IPC_CHANNELS.sendTestMessage, {
        normalizedHandle: '+15555550100',
        body: 'Synthetic test',
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      }],
    ]);
  });

  it('rejects malformed or action-mismatched main-process results', async () => {
    const api = exposedApi();
    electron.invoke.mockResolvedValue({
      action: 'stop_call_observation',
      outcome: 'completed',
      observation: 'stopped',
    });

    await expect(api.appleSpike.probeCapabilities()).rejects.toThrow();
  });
});
