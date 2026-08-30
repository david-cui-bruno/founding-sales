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
    subscribeObservation: vi.fn<AppleSpikeServiceApi['subscribeObservation']>(
      () => () => undefined,
    ),
    dispose: vi.fn(),
  } as AppleSpikeServiceApi;
}

type TestWebContents = {
  emit(event: string): void;
  getURL: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setDestroyed(value: boolean): void;
  setUrl(value: string): void;
};

type TestInvokeEvent = {
  sender: TestWebContents;
  senderFrame: { url: string };
};

function fakeWebContents(initialUrl = 'callie://app/index.html'): TestWebContents {
  let currentUrl = initialUrl;
  let destroyed = false;
  const listeners = new Map<string, Set<() => void>>();
  const add = (event: string, listener: () => void) => {
    const registered = listeners.get(event) ?? new Set();
    registered.add(listener);
    listeners.set(event, registered);
  };
  return {
    getURL: vi.fn(() => currentUrl),
    isDestroyed: vi.fn(() => destroyed),
    send: vi.fn(),
    on: vi.fn(add),
    once: vi.fn(add),
    removeListener: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    setDestroyed: (value) => { destroyed = value; },
    setUrl: (value) => { currentUrl = value; },
  };
}

const eventFor = (sender: TestWebContents, frameUrl = sender.getURL()): TestInvokeEvent => ({
  sender,
  senderFrame: { url: frameUrl },
});

describe('registerAppleSpikeIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  function handlers() {
    return new Map<string, (event: TestInvokeEvent, ...args: unknown[]) => unknown>(
      electron.handle.mock.calls as [string, (event: TestInvokeEvent, ...args: unknown[]) => unknown][],
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
      Object.values(APPLE_SPIKE_IPC_CHANNELS).filter(
        (channel) => channel !== APPLE_SPIKE_IPC_CHANNELS.observationEvidence,
      ),
    );
    await expect(
      handlers().get(APPLE_SPIKE_IPC_CHANNELS.status)?.({
        sender: fakeWebContents(),
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

    await expect(status?.(
      eventFor(fakeWebContents('https://attacker.invalid/')),
    )).rejects.toThrow('trusted');
    await expect(status?.(
      eventFor(fakeWebContents()),
      { path: '/private/escape' },
    )).rejects.toThrow('arguments');
    expect(service.getStatus).not.toHaveBeenCalled();
  });

  it('rejects malformed and wrongly confirmed inputs before the service', async () => {
    const service = fakeService();
    registerAppleSpikeIpc(service);
    const registered = handlers();
    const event = eventFor(fakeWebContents());

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
    const event = eventFor(fakeWebContents());

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
        sender: fakeWebContents(),
        senderFrame: { url: 'callie://app/index.html' },
      }),
    ).rejects.toThrow();
  });

  it('unregisters every fixed handler once', () => {
    const service = fakeService();
    const unregister = registerAppleSpikeIpc(service);

    unregister();
    unregister();

    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      Object.values(APPLE_SPIKE_IPC_CHANNELS).filter(
        (channel) => channel !== APPLE_SPIKE_IPC_CHANNELS.observationEvidence,
      ),
    );
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });

  it('registers one trusted renderer subscription and delivers only strict evidence once', async () => {
    const service = fakeService();
    const unsubscribeObservation = vi.fn();
    service.subscribeObservation = vi.fn(() => unsubscribeObservation);
    registerAppleSpikeIpc(service);
    const registered = handlers();
    const sender = fakeWebContents();
    const event = eventFor(sender);
    const subscribe = registered.get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe);

    await expect(subscribe?.(event)).resolves.toEqual({ subscribed: true });
    await expect(subscribe?.(event)).resolves.toEqual({ subscribed: true });
    expect(service.subscribeObservation).toHaveBeenCalledTimes(1);
    const listener = vi.mocked(service.subscribeObservation).mock.calls[0]?.[0];
    listener?.({ kind: 'identity', identity: 'ambiguous' });

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(
      APPLE_SPIKE_IPC_CHANNELS.observationEvidence,
      { kind: 'identity', identity: 'ambiguous' },
    );

    listener?.({
      kind: 'call_state',
      outgoing: true,
      connected: true,
      ended: false,
      onHold: false,
      handle: '+15555550100',
    } as never);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(unsubscribeObservation).not.toHaveBeenCalled();
  });

  it('acknowledges only after the ready service has installed its bridge listener', async () => {
    const service = fakeService();
    const order: string[] = [];
    service.getStatus = vi.fn(() => ({
      enabled: true,
      bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
    } as const));
    service.subscribeObservation = vi.fn<AppleSpikeServiceApi['subscribeObservation']>(() => {
      order.push('service-bound');
      return (): void => undefined;
    });
    registerAppleSpikeIpc(service);
    const subscribe = handlers().get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe);

    const result = await subscribe?.(eventFor(fakeWebContents()));
    order.push('ack-resolved');

    expect(result).toEqual({ subscribed: true });
    expect(order).toEqual(['service-bound', 'ack-resolved']);
  });

  it('rejects subscription without an acknowledgement when helper binding is unavailable', async () => {
    const service = fakeService();
    service.subscribeObservation = vi.fn(() => {
      throw new Error('/private/raw bridge binding failure');
    });
    registerAppleSpikeIpc(service);

    await expect(
      handlers().get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe)?.(
        eventFor(fakeWebContents()),
      ),
    ).rejects.toThrow('Apple observation subscription is unavailable.');
  });

  it('rejects subscription before service binding when the CLI gate or helper is unavailable', async () => {
    const service = fakeService();
    service.getStatus = vi.fn(() => ({
      enabled: false,
      bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
    } as const));
    registerAppleSpikeIpc(service);

    await expect(
      handlers().get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe)?.(
        eventFor(fakeWebContents()),
      ),
    ).rejects.toThrow('Apple observation subscription is unavailable.');
    expect(service.subscribeObservation).not.toHaveBeenCalled();
  });

  it('rejects untrusted or argument-bearing subscriptions before the service', async () => {
    const service = fakeService();
    registerAppleSpikeIpc(service);
    const subscribe = handlers().get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe);

    await expect(subscribe?.(
      eventFor(fakeWebContents('https://attacker.invalid/')),
    )).rejects.toThrow('trusted');
    await expect(subscribe?.(
      eventFor(fakeWebContents()),
      { event: 'call.stateChanged' },
    )).rejects.toThrow('arguments');
    expect(service.subscribeObservation).not.toHaveBeenCalled();
  });

  it('removes subscriptions on explicit unsubscribe, navigation, and destruction', async () => {
    const service = fakeService();
    const unsubscribeCallbacks = [vi.fn(), vi.fn(), vi.fn()];
    service.subscribeObservation = vi.fn(() => (
      unsubscribeCallbacks.shift() ?? vi.fn()
    ));
    registerAppleSpikeIpc(service);
    const registered = handlers();
    const subscribe = registered.get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe);
    const unsubscribe = registered.get(APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe);
    const explicitSender = fakeWebContents();
    const navigationSender = fakeWebContents();
    const destroyedSender = fakeWebContents();

    await subscribe?.(eventFor(explicitSender));
    await subscribe?.(eventFor(navigationSender));
    await subscribe?.(eventFor(destroyedSender));
    expect(service.subscribeObservation).toHaveBeenCalledTimes(3);
    const activeUnsubscribes = vi.mocked(service.subscribeObservation).mock.results.map(
      (result) => result.value,
    );

    await unsubscribe?.(eventFor(explicitSender));
    await unsubscribe?.(eventFor(explicitSender));
    navigationSender.emit('did-start-navigation');
    destroyedSender.setDestroyed(true);
    destroyedSender.emit('destroyed');

    for (const cleanup of activeUnsubscribes) expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('revalidates the renderer URL at delivery and tears down an invalid destination', async () => {
    const service = fakeService();
    const unsubscribeObservation = vi.fn();
    service.subscribeObservation = vi.fn(() => unsubscribeObservation);
    registerAppleSpikeIpc(service);
    const sender = fakeWebContents();
    await handlers().get(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe)?.(eventFor(sender));
    const listener = vi.mocked(service.subscribeObservation).mock.calls[0]?.[0];
    sender.setUrl('https://attacker.invalid/');

    listener?.({ kind: 'capability', available: true });

    expect(sender.send).not.toHaveBeenCalled();
    expect(unsubscribeObservation).toHaveBeenCalledTimes(1);
  });
});
