import { describe, expect, it, vi } from 'vitest';

import type { AppleBridgeService } from '../../src/main/appleBridge/appleBridgeService';
import { AppleSpikeService } from '../../src/main/appleBridge/appleSpikeService';
import type { BridgeEvent, BridgeRequest } from '../../src/shared/appleBridgeContract';
import {
  appleSpikeObservationEvidenceSchema,
  type AppleSpikeObservationEvidence,
} from '../../src/shared/appleSpikeContract';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';

function fakeBridge(
  responseFor: (request: BridgeRequest) => unknown = (request) => ({
    v: 1,
    kind: 'response',
    id: request.id,
    ok: true,
    result: {},
  }),
  status: ReturnType<AppleBridgeService['getStatus']> = {
    state: 'ready',
    helperVersion: '1.0.0',
    protocolVersion: 1,
  },
): AppleBridgeService & {
  emit(event: BridgeEvent): void;
  listenerCount(): number;
  request: ReturnType<typeof vi.fn>;
  setStatus(next: ReturnType<AppleBridgeService['getStatus']>): void;
  subscribe: ReturnType<typeof vi.fn>;
} {
  let currentStatus = status;
  const listeners = new Set<(event: BridgeEvent) => void>();
  const subscribe = vi.fn((listener: (event: BridgeEvent) => void) => {
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  });
  return {
    getStatus: () => currentStatus,
    request: vi.fn(async (request: BridgeRequest) => responseFor(request)),
    subscribe,
    emit: (event: BridgeEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
    setStatus: (next: ReturnType<AppleBridgeService['getStatus']>) => {
      currentStatus = next;
    },
  } as unknown as AppleBridgeService & {
    emit(event: BridgeEvent): void;
    listenerCount(): number;
    request: ReturnType<typeof vi.fn>;
    setStatus(next: ReturnType<AppleBridgeService['getStatus']>): void;
    subscribe: ReturnType<typeof vi.fn>;
  };
}

const fixedIds = (...ids: string[]) => {
  let index = 0;
  return () => ids[index++] ?? '33333333-3333-4333-8333-333333333333';
};

describe('AppleSpikeService', () => {
  it('returns a sanitized disabled status without contacting the helper', () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: false, bridge });

    expect(service.getStatus()).toEqual({
      enabled: false,
      bridge: {
        state: 'ready',
        helperVersion: '1.0.0',
        protocolVersion: 1,
      },
    });
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it('hard-fails every operation before a bridge request when disabled', async () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: false, bridge });

    await expect(
      service.authorizeManualAction({
        action: 'send_test_message',
        normalizedHandle: '+15555550100',
        body: 'Synthetic test',
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      }),
    ).rejects.toThrow('disabled');
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it('requires exact call consent before starting observation', async () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: true, bridge });

    await expect(
      service.authorizeManualAction({
        action: 'start_call_observation',
        confirmation: 'yes',
      } as never),
    ).rejects.toThrow();
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it('enforces the test-message body limit in UTF-8 bytes', async () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: true, bridge });

    await expect(
      service.authorizeManualAction({
        action: 'send_test_message',
        normalizedHandle: '+15555550100',
        body: '😀'.repeat(126),
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      }),
    ).rejects.toThrow();
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it('maps every fixed action to exactly one literal bridge request', async () => {
    const bridge = fakeBridge((request) => {
      const resultByMethod: Record<BridgeRequest['method'], Record<string, unknown>> = {
        'bridge.hello': {},
        'bridge.shutdown': {},
        'capabilities.probe': {
          capabilities: {
            contacts: 'notDetermined',
            accessibility: 'notDetermined',
            callObservationAvailable: false,
            recordingControlAvailable: false,
          },
        },
        'permissions.requestContacts': { access: 'restricted' },
        'permissions.promptAccessibility': { trusted: true },
        'call.observe.start': { observing: true },
        'call.observe.stop': { observing: false },
        'recording.armOutgoing': {},
        'recording.disarm': {},
        'notes.scanCallRecordings': { artifacts: [], truncated: false },
        'notes.exportCallRecording': {},
        'messages.sendTest': { commandId: COMMAND_ID },
        'messages.scanTestActivity': {
          sentCount: 1,
          receivedCount: 2,
          latestAt: '2026-08-30T14:00:00.000Z',
        },
      };
      return {
        v: 1,
        kind: 'response',
        id: request.id,
        ok: true,
        result: resultByMethod[request.method],
      };
    });
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        REQUEST_ID,
        COMMAND_ID,
      ),
    });

    await expect(service.runReadOnlyCheck({ action: 'probe_capabilities' })).resolves.toEqual({
      action: 'probe_capabilities',
      outcome: 'completed',
      capabilities: {
        contacts: 'notDetermined',
        accessibility: 'notDetermined',
        callObservationAvailable: false,
        recordingControlAvailable: false,
      },
    });
    await expect(service.requestPermission({ action: 'request_contacts' })).resolves.toEqual({
      action: 'request_contacts',
      outcome: 'completed',
      contactAccess: 'restricted',
    });
    await expect(service.requestPermission({ action: 'prompt_accessibility' })).resolves.toEqual({
      action: 'prompt_accessibility',
      outcome: 'completed',
      accessibilityTrusted: true,
    });
    await expect(service.runReadOnlyCheck({ action: 'scan_recent_notes' })).resolves.toEqual({
      action: 'scan_recent_notes',
      outcome: 'completed',
      artifactCount: 0,
      truncated: false,
    });
    await expect(service.runReadOnlyCheck({
      action: 'scan_test_messages',
      normalizedHandle: '+15555550100',
    })).resolves.toEqual({
      action: 'scan_test_messages',
      outcome: 'completed',
      sentCount: 1,
      receivedCount: 2,
      latestAt: '2026-08-30T14:00:00.000Z',
    });
    await expect(service.authorizeManualAction({
      action: 'start_call_observation',
      confirmation: 'I CONSENT TO THIS TEST CALL',
    })).resolves.toEqual({
      action: 'start_call_observation',
      outcome: 'completed',
      observation: 'started',
    });
    await expect(service.authorizeManualAction({
      action: 'stop_call_observation',
    })).resolves.toEqual({
      action: 'stop_call_observation',
      outcome: 'completed',
      observation: 'stopped',
    });
    await expect(service.authorizeManualAction({
      action: 'send_test_message',
      normalizedHandle: '+15555550100',
      body: '😀'.repeat(125),
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    })).resolves.toEqual({
      action: 'send_test_message',
      outcome: 'completed',
      delivery: 'sent',
    });

    expect(bridge.request).toHaveBeenCalledTimes(8);
    expect(bridge.request.mock.calls.map(([request]) => request)).toEqual([
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'capabilities.probe', params: {} },
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'permissions.requestContacts', params: {} },
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'permissions.promptAccessibility', params: {} },
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'notes.scanCallRecordings', params: {} },
      {
        v: 1,
        kind: 'request',
        id: REQUEST_ID,
        method: 'messages.scanTestActivity',
        params: { recipientHandle: '+15555550100' },
      },
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'call.observe.start', params: {} },
      { v: 1, kind: 'request', id: REQUEST_ID, method: 'call.observe.stop', params: {} },
      {
        v: 1,
        kind: 'request',
        id: REQUEST_ID,
        method: 'messages.sendTest',
        params: {
          commandId: COMMAND_ID,
          recipientHandle: '+15555550100',
          body: '😀'.repeat(125),
          confirmation: 'I CONSENT TO THIS TEST MESSAGE',
        },
      },
    ]);
  });

  it('surfaces capability_unavailable as a typed sanitized outcome', async () => {
    const bridge = fakeBridge((request) => ({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: false,
      error: {
        code: 'capability_unavailable',
        message: '/Users/founder +15555550100 raw native detail',
        retryable: false,
      },
    }));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID),
    });

    await expect(service.requestPermission({ action: 'request_contacts' })).resolves.toEqual({
      action: 'request_contacts',
      outcome: 'capability_unavailable',
      message: 'This Apple feasibility operation is unavailable on this Mac.',
    });
    expect(JSON.stringify(await service.requestPermission({ action: 'request_contacts' })))
      .not.toContain('/Users/founder');
  });

  it('rejects a response whose envelope id does not match the request', async () => {
    const bridge = fakeBridge(() => ({
      v: 1,
      kind: 'response',
      id: COMMAND_ID,
      ok: true,
      result: {
        capabilities: {
          contacts: 'full',
          accessibility: 'granted',
          callObservationAvailable: true,
          recordingControlAvailable: false,
        },
      },
    }));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID),
    });

    await expect(
      service.runReadOnlyCheck({ action: 'probe_capabilities' }),
    ).rejects.toThrow('response was invalid');
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a message receipt carrying a different command id', async () => {
    const bridge = fakeBridge((request) => ({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: true,
      result: { commandId: '33333333-3333-4333-8333-333333333333' },
    }));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID, COMMAND_ID),
    });

    await expect(service.authorizeManualAction({
      action: 'send_test_message',
      normalizedHandle: '+15555550100',
      body: 'Synthetic test',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    })).rejects.toThrow('response was invalid');
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'legacy capability record',
      { capabilities: { contacts: true } },
      (service: AppleSpikeService) => service.runReadOnlyCheck({ action: 'probe_capabilities' }),
    ],
    [
      'unknown contacts result',
      { access: 'not_determined' },
      (service: AppleSpikeService) => service.requestPermission({ action: 'request_contacts' }),
    ],
    [
      'call observation false-success shape',
      { observing: false },
      (service: AppleSpikeService) => service.authorizeManualAction({
        action: 'start_call_observation',
        confirmation: 'I CONSENT TO THIS TEST CALL',
      }),
    ],
  ])('rejects malformed action-specific ok payload: %s', async (_name, result, invoke) => {
    const bridge = fakeBridge((request) => ({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: true,
      result,
    }));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID, COMMAND_ID),
    });

    await expect(invoke(service)).rejects.toThrow('response was invalid');
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('maps a non-capability native failure to only a fixed sanitized error', async () => {
    const rawDetail = '/Users/founder/private +15555550100 raw native rejection';
    const bridge = fakeBridge((request) => ({
      v: 1,
      kind: 'response',
      id: request.id,
      ok: false,
      error: {
        code: 'invalid_request',
        message: rawDetail,
        retryable: false,
      },
    }));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID),
    });

    const error = await service.requestPermission({ action: 'request_contacts' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Apple feasibility request was rejected.');
    expect((error as Error).message).not.toContain(rawDetail);
  });

  it('does not retry a bridge request whose outcome is ambiguous', async () => {
    const bridge = fakeBridge();
    bridge.request.mockRejectedValue(new Error('/private/raw transport failure'));
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID, COMMAND_ID),
    });

    await expect(service.authorizeManualAction({
      action: 'send_test_message',
      normalizedHandle: '+15555550100',
      body: 'Synthetic test',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    })).rejects.toThrow('unavailable');
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('maps only exact Task 4 bridge events to bounded observation evidence', () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: true, bridge });
    const evidence: AppleSpikeObservationEvidence[] = [];
    const unsubscribe = service.subscribeObservation((next) => evidence.push(next));

    bridge.emit({
      v: 1,
      kind: 'event',
      seq: 41,
      event: 'capability.changed',
      payload: { source: 'phone_observation', available: true },
    });
    bridge.emit({
      v: 1,
      kind: 'event',
      seq: 42,
      event: 'capability.changed',
      payload: {
        source: 'phone_observation',
        available: false,
        reason: 'traversalDeadlineExceeded',
      },
    });
    bridge.emit({
      v: 1,
      kind: 'event',
      seq: 43,
      event: 'call.stateChanged',
      payload: { outgoing: true, connected: false, ended: false, onHold: true },
    });
    bridge.emit({
      v: 1,
      kind: 'event',
      seq: 44,
      event: 'call.identityResolved',
      payload: { identity: 'resolved' },
    });
    bridge.emit({
      v: 1,
      kind: 'event',
      seq: 45,
      event: 'call.identityUnresolved',
      payload: { identity: 'ambiguous' },
    });

    expect(evidence).toEqual([
      { kind: 'capability', available: true },
      { kind: 'capability', available: false, reason: 'traversalDeadlineExceeded' },
      { kind: 'call_state', outgoing: true, connected: false, ended: false, onHold: true },
      { kind: 'identity', identity: 'resolved' },
      { kind: 'identity', identity: 'ambiguous' },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('seq');
    unsubscribe();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('accepts exactly the ten native observation degradation reasons', () => {
    const reasons = [
      'accessibilityDenied',
      'phoneUIUnavailable',
      'unsupportedPhoneUIVersion',
      'ambiguousPhoneState',
      'noMacVisibleCall',
      'snapshotFailed',
      'traversalDepthExceeded',
      'traversalNodeLimitExceeded',
      'traversalCycleDetected',
      'traversalDeadlineExceeded',
    ] as const;

    for (const reason of reasons) {
      expect(appleSpikeObservationEvidenceSchema.safeParse({
        kind: 'capability',
        available: false,
        reason,
      }).success).toBe(true);
    }
    expect(appleSpikeObservationEvidenceSchema.safeParse({
      kind: 'capability',
      available: false,
      reason: 'privateNativeReason',
    }).success).toBe(false);
    expect(appleSpikeObservationEvidenceSchema.safeParse({
      kind: 'capability',
      available: true,
      reason: 'snapshotFailed',
    }).success).toBe(false);
  });

  it('ignores unsupported, mismatched, and extra-field event payloads instead of stripping PII', () => {
    const bridge = fakeBridge();
    const service = new AppleSpikeService({ enabled: true, bridge });
    const evidence: AppleSpikeObservationEvidence[] = [];
    service.subscribeObservation((next) => evidence.push(next));

    const invalidEvents = [
      {
        v: 1, kind: 'event', seq: 1, event: 'call.stateChanged',
        payload: {
          outgoing: true,
          connected: true,
          ended: false,
          onHold: false,
          handle: '+15555550100',
        },
      },
      {
        v: 1, kind: 'event', seq: 2, event: 'call.identityResolved',
        payload: { identity: 'resolved', callId: 'private-call-id' },
      },
      {
        v: 1, kind: 'event', seq: 3, event: 'call.identityResolved',
        payload: { identity: 'unresolved' },
      },
      {
        v: 1, kind: 'event', seq: 4, event: 'capability.changed',
        payload: {
          source: 'phone_observation',
          available: false,
          reason: 'snapshotFailed',
          path: '/Users/founder/private',
        },
      },
      {
        v: 1, kind: 'event', seq: 5, event: 'recording.verified',
        payload: { recordingId: 'private-recording-id' },
      },
    ] as BridgeEvent[];
    for (const event of invalidEvents) bridge.emit(event);

    expect(evidence).toEqual([]);
  });

  it('binds only while enabled, ready, and observed; then unbinds, rebinds, and disposes idempotently', () => {
    const bridge = fakeBridge(undefined, { state: 'starting' });
    const service = new AppleSpikeService({ enabled: true, bridge });
    const unsubscribe = service.subscribeObservation(() => undefined);
    expect(bridge.subscribe).not.toHaveBeenCalled();

    bridge.setStatus({ state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 });
    service.getStatus();
    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount()).toBe(1);

    bridge.setStatus({
      state: 'degraded',
      code: 'helper_exited',
      message: 'Apple integration helper stopped unexpectedly.',
    });
    service.getStatus();
    expect(bridge.listenerCount()).toBe(0);

    bridge.setStatus({ state: 'ready', helperVersion: '1.0.1', protocolVersion: 1 });
    service.getStatus();
    expect(bridge.subscribe).toHaveBeenCalledTimes(2);
    expect(bridge.listenerCount()).toBe(1);

    unsubscribe();
    expect(bridge.listenerCount()).toBe(0);
    service.dispose();
    service.dispose();
    service.subscribeObservation(() => undefined);
    expect(bridge.subscribe).toHaveBeenCalledTimes(2);

    const disabledBridge = fakeBridge();
    const disabled = new AppleSpikeService({ enabled: false, bridge: disabledBridge });
    disabled.subscribeObservation(() => undefined);
    disabled.getStatus();
    expect(disabledBridge.subscribe).not.toHaveBeenCalled();
  });

  it('reconciles the current ready bridge before starting observation', async () => {
    const order: string[] = [];
    const bridge = fakeBridge((request) => {
      order.push('request');
      return {
        v: 1,
        kind: 'response',
        id: request.id,
        ok: true,
        result: { observing: true },
      };
    }, { state: 'starting' });
    bridge.subscribe.mockImplementation(() => {
      order.push('subscribe');
      return (): void => undefined;
    });
    const service = new AppleSpikeService({
      enabled: true,
      bridge,
      createUuid: fixedIds(REQUEST_ID),
    });
    service.subscribeObservation(() => undefined);
    bridge.setStatus({ state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 });

    await service.authorizeManualAction({
      action: 'start_call_observation',
      confirmation: 'I CONSENT TO THIS TEST CALL',
    });

    expect(order).toEqual(['subscribe', 'request']);
  });
});
