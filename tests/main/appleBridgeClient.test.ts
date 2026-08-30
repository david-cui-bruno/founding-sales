import { describe, expect, it, vi } from 'vitest';

import {
  AppleBridgeClient,
} from '../../src/main/appleBridge/appleBridgeClient';
import type {
  AppleBridgeProcessEvent,
  AppleBridgeTransport,
} from '../../src/main/appleBridge/appleBridgeProcess';
import type { BridgeEvent, BridgeRequest } from '../../src/shared/appleBridgeContract';

const HELLO_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const SHUTDOWN_ID = '55555555-5555-4555-8555-555555555555';

class FakeBridgeTransport implements AppleBridgeTransport {
  readonly writes: unknown[] = [];
  readonly listeners = new Set<(event: AppleBridgeProcessEvent) => void>();
  closeInputCalls = 0;
  terminateCalls = 0;
  closeInputError: Error | undefined;

  subscribe(listener: (event: AppleBridgeProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  writeFrame(frame: unknown): void {
    this.writes.push(frame);
  }

  closeInput(): void {
    this.closeInputCalls += 1;
    if (this.closeInputError !== undefined) throw this.closeInputError;
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(event: AppleBridgeProcessEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const capabilityRequest = (id = REQUEST_ID): BridgeRequest => ({
  v: 1,
  kind: 'request',
  id,
  method: 'capabilities.probe',
  params: {},
});

const manualMessageRequest: BridgeRequest = {
  v: 1,
  kind: 'request',
  id: REQUEST_ID,
  method: 'messages.sendTest',
  params: {
    commandId: COMMAND_ID,
    recipientHandle: '+15555550100',
    body: 'consenting fixture message',
    confirmation: 'I CONSENT TO THIS TEST MESSAGE',
  },
};

const completeHandshake = (transport: FakeBridgeTransport): void => {
  expect(transport.writes[0]).toEqual({
    v: 1,
    kind: 'request',
    id: HELLO_ID,
    method: 'bridge.hello',
    params: { supportedVersions: [1] },
  });
  transport.emit({
    type: 'frame',
    frame: {
      v: 1,
      kind: 'response',
      id: HELLO_ID,
      ok: true,
      result: {
        selectedVersion: 1,
        helperVersion: '1.0.0-test',
      },
    },
  });
};

const createClient = (transport: FakeBridgeTransport): AppleBridgeClient => {
  const generatedIds = [HELLO_ID, SHUTDOWN_ID];
  return new AppleBridgeClient(transport, {
    createRequestId: () => generatedIds.shift() ?? crypto.randomUUID(),
  });
};

describe('AppleBridgeClient', () => {
  it('exposes the typed hello metadata as the only readiness gate', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);

    const readiness = client.ready();
    expect(transport.writes).toHaveLength(1);
    expect((transport.writes[0] as { method: string }).method).toBe('bridge.hello');
    completeHandshake(transport);

    await expect(readiness).resolves.toEqual({
      helperVersion: '1.0.0-test',
      protocolVersion: 1,
    });
    expect(transport.writes).toHaveLength(1);
  });

  it('rejects unsanitized or missing semantic helper versions and retains no terminal subscriber', async () => {
    for (const result of [
      { selectedVersion: 1, helperVersion: '../../private' },
      { selectedVersion: 1, helperVersion: '1.0.0-01' },
      { selectedVersion: 1 },
    ]) {
      const transport = new FakeBridgeTransport();
      const client = createClient(transport);
      const readiness = client.ready();
      transport.emit({
        type: 'frame',
        frame: { v: 1, kind: 'response', id: HELLO_ID, ok: true, result },
      });

      await expect(readiness).rejects.toThrow('hello result');
      expect(transport.terminateCalls).toBe(1);
      expect(transport.listeners.size).toBe(0);
      let calls = 0;
      const unsubscribe = client.subscribe(() => { calls += 1; });
      transport.emit({
        type: 'frame',
        frame: { v: 1, kind: 'event', seq: 1, event: 'bridge.ready', payload: {} },
      });
      unsubscribe();
      expect(calls).toBe(0);
      expect(transport.listeners.size).toBe(0);
    }
  });

  it('rejects an earlier readiness waiter when shutdown wins the handshake race', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    const readiness = client.ready();
    const readinessRejection = expect(readiness).rejects.toThrow('shut down');
    const shutdownPromise = client.shutdown();

    completeHandshake(transport);
    await readinessRejection;
    await Promise.resolve();
    const shutdown = transport.writes.find((frame) => (
      frame as { method?: string }
    ).method === 'bridge.shutdown') as { id: string };
    transport.emit({
      type: 'frame',
      frame: { v: 1, kind: 'response', id: shutdown.id, ok: true, result: {} },
    });
    await expect(shutdownPromise).resolves.toBeUndefined();
  });

  it('correlates UUIDs case-insensitively across Swift canonical encoding', async () => {
    const transport = new FakeBridgeTransport();
    const helloId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const client = new AppleBridgeClient(transport, {
      createRequestId: () => helloId,
    });
    const pending = client.request(capabilityRequest(requestId));

    transport.emit({
      type: 'frame',
      frame: {
        v: 1,
        kind: 'response',
        id: helloId.toUpperCase(),
        ok: true,
        result: { selectedVersion: 1, helperVersion: '1.0.0' },
      },
    });
    await Promise.resolve();
    transport.emit({
      type: 'frame',
      frame: {
        v: 1,
        kind: 'response',
        id: requestId.toUpperCase(),
        ok: true,
        result: {},
      },
    });

    await expect(pending).resolves.toMatchObject({ id: requestId.toUpperCase() });
  });

  it('requires a matching V1 hello before writing application requests', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    const pending = client.request(capabilityRequest());

    expect(transport.writes).toHaveLength(1);
    completeHandshake(transport);
    await Promise.resolve();
    expect(transport.writes).toHaveLength(2);
    expect(transport.writes[1]).toEqual(capabilityRequest());

    transport.emit({
      type: 'frame',
      frame: { v: 1, kind: 'response', id: REQUEST_ID, ok: true, result: { available: true } },
    });
    await expect(pending).resolves.toMatchObject({ id: REQUEST_ID, ok: true });
  });

  it('fails pending requests when the hello response selects the wrong version', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    const pending = client.request(capabilityRequest());

    transport.emit({
      type: 'frame',
      frame: {
        v: 1,
        kind: 'response',
        id: HELLO_ID,
        ok: true,
        result: { selectedVersion: 2, helperVersion: '1.0.0' },
      },
    });

    await expect(pending).rejects.toThrow('version');
    expect(transport.writes).toHaveLength(1);
  });

  it('fails the handshake after three seconds and removes its process listener', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeBridgeTransport();
      const client = createClient(transport);
      const pending = client.request(capabilityRequest());
      const rejection = expect(pending).rejects.toThrow('handshake timed out');

      await vi.advanceTimersByTimeAsync(3_000);

      await rejection;
      expect(transport.listeners.size).toBe(0);
      expect(transport.terminateCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry an ambiguous manual message send after process exit', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);
    const pending = client.request(manualMessageRequest, 50);
    await Promise.resolve();

    transport.emit({ type: 'exit', code: 1, signal: null });

    await expect(pending).rejects.toThrow('exited');
    expect(transport.writes.filter((frame) => (
      frame as { method?: string }
    ).method === 'messages.sendTest')).toHaveLength(1);
  });

  it('rejects malformed, unknown, and duplicate response IDs as terminal protocol failures', async () => {
    const cases: Array<{ name: string; frame: unknown }> = [
      {
        name: 'malformed',
        frame: { v: 1, kind: 'response', id: REQUEST_ID, ok: true, result: {}, extra: true },
      },
      {
        name: 'unknown',
        frame: { v: 1, kind: 'response', id: SECOND_REQUEST_ID, ok: true, result: {} },
      },
    ];

    for (const testCase of cases) {
      const transport = new FakeBridgeTransport();
      const client = createClient(transport);
      completeHandshake(transport);
      const pending = client.request(capabilityRequest());
      await Promise.resolve();
      transport.emit({ type: 'frame', frame: testCase.frame });
      await expect(pending, testCase.name).rejects.toThrow('protocol');
      expect(transport.listeners.size).toBe(0);
    }

    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);
    const first = client.request(capabilityRequest());
    await Promise.resolve();
    const response = { v: 1, kind: 'response', id: REQUEST_ID, ok: true, result: {} } as const;
    transport.emit({ type: 'frame', frame: response });
    await expect(first).resolves.toMatchObject({ id: REQUEST_ID });
    transport.emit({ type: 'frame', frame: response });
    await expect(client.request(capabilityRequest(SECOND_REQUEST_ID))).rejects.toThrow('duplicate');
  });

  it('delivers only strict, monotonically sequenced V1 events to active subscribers', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);
    const received: BridgeEvent[] = [];
    const unsubscribe = client.subscribe((event) => received.push(event));
    const valid = {
      v: 1,
      kind: 'event',
      seq: 7,
      event: 'bridge.ready',
      payload: {},
    } as const;
    transport.emit({ type: 'frame', frame: valid });
    unsubscribe();
    transport.emit({ type: 'frame', frame: { ...valid, seq: 8 } });
    expect(received).toEqual([valid]);

    const pending = client.request(capabilityRequest());
    await Promise.resolve();
    transport.emit({ type: 'frame', frame: valid });
    await expect(pending).rejects.toThrow('event sequence');
  });

  it('rejects an unknown event name as a terminal protocol failure', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);
    const pending = client.request(capabilityRequest());
    await Promise.resolve();

    transport.emit({
      type: 'frame',
      frame: {
        v: 1,
        kind: 'event',
        seq: 1,
        event: 'apple.arbitraryAction',
        payload: {},
      },
    });

    await expect(pending).rejects.toThrow('event failed strict validation');
    expect(transport.listeners.size).toBe(0);
  });

  it('clears a request timer after response and never retries a timed-out request', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeBridgeTransport();
      const client = createClient(transport);
      completeHandshake(transport);
      const pending = client.request(capabilityRequest(), 25);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      const rejection = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(transport.writes.filter((frame) => (
        frame as { method?: string }
      ).method === 'capabilities.probe')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs one graceful, idempotent shutdown and detaches after its response', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);

    const first = client.shutdown();
    const second = client.shutdown();
    const postShutdownReadiness = expect(client.ready()).rejects.toThrow('shut down');
    let terminalSubscriberCalls = 0;
    const unsubscribeTerminal = client.subscribe(() => { terminalSubscriberCalls += 1; });
    transport.emit({
      type: 'frame',
      frame: { v: 1, kind: 'event', seq: 1, event: 'bridge.ready', payload: {} },
    });
    unsubscribeTerminal();
    expect(terminalSubscriberCalls).toBe(0);
    await Promise.resolve();
    expect(second).toBe(first);
    await postShutdownReadiness;
    const shutdown = transport.writes.find((frame) => (
      frame as { method?: string }
    ).method === 'bridge.shutdown') as { id: string };
    expect(shutdown).toBeDefined();

    transport.emit({
      type: 'frame',
      frame: { v: 1, kind: 'response', id: shutdown.id, ok: true, result: { shuttingDown: true } },
    });
    await expect(first).resolves.toBeUndefined();
    expect(transport.closeInputCalls).toBe(1);
    expect(transport.listeners.size).toBe(0);
    await expect(client.request(capabilityRequest(SECOND_REQUEST_ID))).rejects.toThrow('shut down');
    await expect(client.ready()).rejects.toThrow('shut down');
  });

  it('detaches process listeners even when closing stdin fails during shutdown', async () => {
    const transport = new FakeBridgeTransport();
    const client = createClient(transport);
    completeHandshake(transport);
    transport.closeInputError = new Error('stdin close failed');

    const shutdownPromise = client.shutdown();
    await Promise.resolve();
    const shutdown = transport.writes.find((frame) => (
      frame as { method?: string }
    ).method === 'bridge.shutdown') as { id: string };
    transport.emit({
      type: 'frame',
      frame: { v: 1, kind: 'response', id: shutdown.id, ok: true, result: {} },
    });

    await expect(shutdownPromise).rejects.toThrow('stdin close failed');
    expect(transport.listeners.size).toBe(0);
  });
});
