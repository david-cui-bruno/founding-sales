import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

import { APPLE_SPIKE_IPC_CHANNELS } from '../../src/main/appleBridge/registerAppleSpikeIpc';
import type { CalliePreloadApi } from '../../src/shared/preload';

describe('preload Apple feasibility bridge', () => {
  beforeEach(async () => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.removeListener.mockReset();
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
        capabilities: {
          contacts: 'notDetermined',
          accessibility: 'notDetermined',
          callObservationAvailable: false,
          recordingControlAvailable: false,
        },
      };
    });
    const api = exposedApi();

    expect(Object.keys(api).sort()).toEqual([
      'appleSpike', 'daily', 'delegation', 'health', 'leadDetail', 'leads', 'linkedin', 'localWorkspace', 'outreach', 'phoneSetup', 'recovery', 'shell',
    ]);
    expect(Object.keys(api.leads)).toEqual(['list']);
    expect(Object.keys(api.leadDetail)).toEqual(['get']);
    expect(Object.keys(api.daily)).toEqual(['get']);
    expect(api.daily.get).toBeTypeOf('function');
    expect(Object.keys(api.delegation).sort()).toEqual([
      'approveRequestedFollowup', 'beginPhone', 'bootstrap', 'configure', 'configureIntake', 'configurePolicy', 'configureResearch',
      'editReplyDraft', 'editRequestedFollowup', 'getAccountPreparation', 'getPhoneHandoffState', 'getRequestedFollowup', 'getSelectedAccountFreshness', 'googleConnections', 'pair', 'policyImport', 'prepareRequestedFollowup', 'reconcileReplyDraft', 'refreshSelectedAccount', 'researchSetup', 'status', 'submit', 'sync',
    ]);
    expect(Object.keys(api.linkedin).sort()).toEqual([
      'begin', 'copy', 'get', 'open', 'prepare', 'recover', 'reportOutcome', 'save',
    ]);
    expect(Object.keys(api.delegation.policyImport).sort()).toEqual(['confirm', 'resume', 'selectAndPreview', 'status']);
    const { policyImport, googleConnections, researchSetup, ...delegationMethods } = api.delegation;
    if (!googleConnections) throw new Error('Current preload must expose Google connections');
    expect(Object.keys(googleConnections).sort()).toEqual(['begin', 'disclosure', 'revoke', 'status']);
    if (!researchSetup) throw new Error('Current preload must expose research setup');
    expect(Object.keys(researchSetup).sort()).toEqual(['approve', 'cancelPending', 'retry', 'setState', 'status']);
    for (const namespace of [delegationMethods, api.linkedin, policyImport, googleConnections, researchSetup]) {
      for (const method of Object.values(namespace)) expect(method).toBeTypeOf('function');
    }
    for (const namespace of [api.delegation, api.linkedin, policyImport, googleConnections, researchSetup]) {
      expect(namespace).not.toHaveProperty('invoke');
      expect(namespace).not.toHaveProperty('run');
      expect(namespace).not.toHaveProperty('dispatch');
    }
    expect(Object.keys(api.phoneSetup).sort()).toEqual(['clear', 'confirm', 'status']);
    for (const method of ['status', 'confirm', 'clear'] as const) expect(api.phoneSetup[method]).toBeTypeOf('function');
    expect(api.phoneSetup).not.toHaveProperty('invoke');
    expect(api.phoneSetup).not.toHaveProperty('run');
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
      'subscribeObservationEvidence',
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

  it('validates observation evidence and removes the exact wrapped listener on cleanup', async () => {
    const subscriptionAck = Promise.withResolvers<unknown>();
    electron.invoke.mockImplementation((channel: string) => {
      if (channel === APPLE_SPIKE_IPC_CHANNELS.observationSubscribe) {
        expect(electron.on).toHaveBeenCalledTimes(1);
        return subscriptionAck.promise;
      }
      return Promise.resolve(undefined);
    });
    const api = exposedApi();
    const listener = vi.fn();

    const pendingUnsubscribe = api.appleSpike.subscribeObservationEvidence(listener);
    expect(electron.on).toHaveBeenCalledTimes(1);
    const [channel, wrapped] = electron.on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    expect(channel).toBe(APPLE_SPIKE_IPC_CHANNELS.observationEvidence);
    expect(electron.invoke).toHaveBeenCalledWith(
      APPLE_SPIKE_IPC_CHANNELS.observationSubscribe,
    );

    subscriptionAck.resolve({ subscribed: true });
    const unsubscribe = await pendingUnsubscribe;

    wrapped({}, { kind: 'call_state', outgoing: true, connected: true, ended: false, onHold: false });
    wrapped({}, {
      kind: 'call_state',
      outgoing: true,
      connected: true,
      ended: false,
      onHold: false,
      handle: '+15555550100',
    });
    wrapped({}, { kind: 'identity', identity: 'resolved', callId: 'private-call-id' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: 'call_state', outgoing: true, connected: true, ended: false, onHold: false,
    });

    unsubscribe();
    unsubscribe();
    await Promise.resolve();
    expect(electron.removeListener).toHaveBeenCalledTimes(1);
    expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapped);
    expect(electron.invoke).toHaveBeenCalledWith(
      APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe,
    );
  });

  it('multiplexes renderer listeners over one main subscription until the final cleanup', async () => {
    electron.invoke.mockImplementation(async (channel: string) => (
      channel === APPLE_SPIKE_IPC_CHANNELS.observationSubscribe
        ? { subscribed: true }
        : undefined
    ));
    const api = exposedApi();
    const [firstCleanup, secondCleanup] = await Promise.all([
      api.appleSpike.subscribeObservationEvidence(vi.fn()),
      api.appleSpike.subscribeObservationEvidence(vi.fn()),
    ]);

    expect(electron.invoke.mock.calls.filter(
      ([channel]) => channel === APPLE_SPIKE_IPC_CHANNELS.observationSubscribe,
    )).toHaveLength(1);
    firstCleanup();
    await Promise.resolve();
    expect(electron.invoke.mock.calls.filter(
      ([channel]) => channel === APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe,
    )).toHaveLength(0);

    secondCleanup();
    await Promise.resolve();
    expect(electron.invoke.mock.calls.filter(
      ([channel]) => channel === APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe,
    )).toHaveLength(1);
  });

  it('rejects a malformed subscription acknowledgement and tears down main state safely', async () => {
    electron.invoke.mockImplementation(async (channel: string) => (
      channel === APPLE_SPIKE_IPC_CHANNELS.observationSubscribe
        ? { subscribed: true, rawPath: '/private/helper' }
        : undefined
    ));
    const api = exposedApi();

    await expect(
      api.appleSpike.subscribeObservationEvidence(vi.fn()),
    ).rejects.toThrow('Apple observation subscription is unavailable.');
    expect(electron.invoke.mock.calls.filter(
      ([channel]) => channel === APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe,
    )).toHaveLength(1);
  });
});
