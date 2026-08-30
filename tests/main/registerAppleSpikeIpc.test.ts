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

import type { AppleSpikeServiceApi } from '../../src/main/appleBridge/appleSpikeService';
import {
  APPLE_SPIKE_IPC_CHANNELS,
  registerAppleSpikeIpc,
} from '../../src/main/appleBridge/registerAppleSpikeIpc';

const completed = {
  action: 'scan_recent_notes',
  outcome: 'completed',
  artifactCount: 0,
  truncated: false,
} as const;

function fakeService(): AppleSpikeServiceApi {
  return {
    getStatus: vi.fn(() => ({
      enabled: true,
      bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
    })),
    runReadOnlyCheck: vi.fn(async (action) => {
      if (action.action === 'probe_capabilities') {
        return {
          action: action.action,
          outcome: 'completed',
          capabilities: {
            contacts: 'notDetermined',
            accessibility: 'notDetermined',
            callObservationAvailable: false,
            recordingControlAvailable: false,
          },
        };
      }
      if (action.action === 'scan_test_messages') {
        return {
          action: action.action,
          outcome: 'completed',
          sentCount: 0,
          receivedCount: 0,
          latestAt: null,
        };
      }
      return completed;
    }),
    requestPermission: vi.fn(async (action) => action.action === 'request_contacts'
      ? { action: action.action, outcome: 'completed', contactAccess: 'full' }
      : { action: action.action, outcome: 'completed', accessibilityTrusted: true }),
    authorizeManualAction: vi.fn(async (action) => {
      if (action.action === 'start_call_observation') {
        return { action: action.action, outcome: 'completed', observation: 'started' };
      }
      if (action.action === 'send_test_message') {
        return { action: action.action, outcome: 'completed', delivery: 'sent' };
      }
      return { action: action.action, outcome: 'completed', observation: 'stopped' };
    }),
  } as AppleSpikeServiceApi;
}

describe('registerAppleSpikeIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  function handlers() {
    return new Map<string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown>(
      electron.handle.mock.calls as [string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown][],
    );
  }

  it('registers only the fixed spike channels, including typed status when disabled', async () => {
    const service = fakeService();
    service.getStatus = vi.fn(() => ({
      enabled: false,
      bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
    } as const));

    registerAppleSpikeIpc(service);

    expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual(
      Object.values(APPLE_SPIKE_IPC_CHANNELS),
    );
    await expect(
      handlers().get(APPLE_SPIKE_IPC_CHANNELS.status)?.({
        senderFrame: { url: 'callie://app/index.html' },
      }),
    ).resolves.toEqual({
      enabled: false,
      bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
    });
  });

  it('rejects an untrusted sender and extra arguments before the service', async () => {
    const service = fakeService();
    registerAppleSpikeIpc(service);
    const status = handlers().get(APPLE_SPIKE_IPC_CHANNELS.status);

    await expect(status?.({ senderFrame: { url: 'https://attacker.invalid/' } })).rejects.toThrow('trusted');
    await expect(status?.(
      { senderFrame: { url: 'callie://app/index.html' } },
      { path: '/private/escape' },
    )).rejects.toThrow('arguments');
    expect(service.getStatus).not.toHaveBeenCalled();
  });

  it('rejects malformed and wrongly confirmed inputs before the service', async () => {
    const service = fakeService();
    registerAppleSpikeIpc(service);
    const registered = handlers();
    const event = { senderFrame: { url: 'callie://app/index.html' } };

    await expect(registered.get(APPLE_SPIKE_IPC_CHANNELS.scanTestMessages)?.(
      event,
      { normalizedHandle: '555-0100', sql: 'select *' },
    )).rejects.toThrow();
    await expect(registered.get(APPLE_SPIKE_IPC_CHANNELS.startCallObservation)?.(
      event,
      { confirmation: 'yes' },
    )).rejects.toThrow();
    await expect(registered.get(APPLE_SPIKE_IPC_CHANNELS.sendTestMessage)?.(
      event,
      {
        normalizedHandle: '+15555550100',
        body: 'Synthetic test',
        confirmation: 'yes',
      },
    )).rejects.toThrow();
    expect(service.runReadOnlyCheck).not.toHaveBeenCalled();
    expect(service.authorizeManualAction).not.toHaveBeenCalled();
  });

  it('maps each fixed channel to an exact service action', async () => {
    const service = fakeService();
    registerAppleSpikeIpc(service);
    const registered = handlers();
    const event = { senderFrame: { url: 'callie://app/index.html' } };

    await registered.get(APPLE_SPIKE_IPC_CHANNELS.probeCapabilities)?.(event);
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.requestContacts)?.(event);
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.promptAccessibility)?.(event);
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.scanRecentNotes)?.(event);
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.scanTestMessages)?.(
      event,
      { normalizedHandle: '+15555550100' },
    );
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.startCallObservation)?.(
      event,
      { confirmation: 'I CONSENT TO THIS TEST CALL' },
    );
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.stopCallObservation)?.(event);
    await registered.get(APPLE_SPIKE_IPC_CHANNELS.sendTestMessage)?.(
      event,
      {
        normalizedHandle: '+15555550100',
        body: 'Synthetic test',
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      },
    );

    expect(service.runReadOnlyCheck).toHaveBeenNthCalledWith(1, { action: 'probe_capabilities' });
    expect(service.runReadOnlyCheck).toHaveBeenNthCalledWith(2, { action: 'scan_recent_notes' });
    expect(service.runReadOnlyCheck).toHaveBeenNthCalledWith(3, {
      action: 'scan_test_messages',
      normalizedHandle: '+15555550100',
    });
    expect(service.requestPermission).toHaveBeenNthCalledWith(1, { action: 'request_contacts' });
    expect(service.requestPermission).toHaveBeenNthCalledWith(2, { action: 'prompt_accessibility' });
    expect(service.authorizeManualAction).toHaveBeenNthCalledWith(1, {
      action: 'start_call_observation',
      confirmation: 'I CONSENT TO THIS TEST CALL',
    });
    expect(service.authorizeManualAction).toHaveBeenNthCalledWith(2, { action: 'stop_call_observation' });
    expect(service.authorizeManualAction).toHaveBeenNthCalledWith(3, {
      action: 'send_test_message',
      normalizedHandle: '+15555550100',
      body: 'Synthetic test',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    });
  });

  it('rejects a malformed service result at the main-process boundary', async () => {
    const service = fakeService();
    service.runReadOnlyCheck = vi.fn(async () => ({
      action: 'scan_recent_notes',
      outcome: 'completed',
      artifactPath: '/private/raw',
    })) as unknown as AppleSpikeServiceApi['runReadOnlyCheck'];
    registerAppleSpikeIpc(service);

    await expect(
      handlers().get(APPLE_SPIKE_IPC_CHANNELS.scanRecentNotes)?.({
        senderFrame: { url: 'callie://app/index.html' },
      }),
    ).rejects.toThrow();
  });

  it('unregisters every fixed handler once', () => {
    const unregister = registerAppleSpikeIpc(fakeService());

    unregister();
    unregister();

    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      Object.values(APPLE_SPIKE_IPC_CHANNELS),
    );
  });
});
