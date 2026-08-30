import { describe, expect, it, vi } from 'vitest';

import type { AppleBridgeService } from '../../src/main/appleBridge/appleBridgeService';
import { AppleSpikeService } from '../../src/main/appleBridge/appleSpikeService';
import type { BridgeRequest } from '../../src/shared/appleBridgeContract';

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
): AppleBridgeService & { request: ReturnType<typeof vi.fn> } {
  return {
    getStatus: () => status,
    request: vi.fn(async (request: BridgeRequest) => responseFor(request)),
    subscribe: () => () => undefined,
  } as AppleBridgeService & { request: ReturnType<typeof vi.fn> };
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
});
