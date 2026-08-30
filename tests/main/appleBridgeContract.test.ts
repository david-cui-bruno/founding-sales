import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_BRIDGE_PROTOCOL_VERSION,
  bridgeEventSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
} from '../../src/shared/appleBridgeContract';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      resolve('contracts/apple-bridge/v1/fixtures', name),
      'utf8',
    ),
  );

describe('Apple bridge protocol V1', () => {
  it('accepts only the committed request, response, and event fixtures', () => {
    expect(APPLE_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(bridgeRequestSchema.parse(fixture('hello.request.json')).method).toBe(
      'bridge.hello',
    );
    expect(bridgeRequestSchema.parse(fixture('messages-send.request.json')).method).toBe(
      'messages.sendTest',
    );
    expect(bridgeResponseSchema.parse(fixture('hello.response.json')).ok).toBe(true);
    expect(bridgeEventSchema.parse(fixture('call-connected.event.json')).event).toBe(
      'call.stateChanged',
    );
    expect(bridgeEventSchema.parse(fixture('recording-failed.event.json')).event).toBe(
      'recording.failed',
    );
    expect(bridgeResponseSchema.parse(fixture('error.response.json')).ok).toBe(false);
  });

  it('accepts every fixed V1 command with its typed parameters', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const commands = [
      ['bridge.hello', { supportedVersions: [1] }],
      ['capabilities.probe', {}],
      ['permissions.requestContacts', {}],
      ['permissions.promptAccessibility', {}],
      ['call.observe.start', {}],
      ['call.observe.stop', {}],
      ['recording.armOutgoing', { callId: id }],
      ['recording.disarm', { callId: id }],
      ['notes.scanCallRecordings', {}],
      ['notes.exportCallRecording', { artifactId: id }],
      ['messages.sendTest', {
        commandId: '22222222-2222-4222-8222-222222222222',
        recipientHandle: '+15555550100',
        body: 'Test message',
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      }],
      ['messages.scanTestActivity', { recipientHandle: '+15555550100' }],
      ['bridge.shutdown', {}],
    ] as const;

    for (const [method, params] of commands) {
      expect(
        bridgeRequestSchema.parse({ v: 1, kind: 'request', id, method, params }),
      ).toMatchObject({ method, params });
    }
  });

  it('requires a distinct command id and the exact test-message consent phrase', () => {
    const base = {
      v: 1,
      kind: 'request',
      id: '11111111-1111-4111-8111-111111111111',
      method: 'messages.sendTest',
      params: {
        commandId: '22222222-2222-4222-8222-222222222222',
        recipientHandle: '+15555550100',
        body: 'Test message',
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      },
    };

    expect(bridgeRequestSchema.safeParse(base).success).toBe(true);
    expect(bridgeRequestSchema.safeParse({
      ...base,
      params: { ...base.params, commandId: base.id },
    }).success).toBe(false);
    expect(bridgeRequestSchema.safeParse({
      ...base,
      id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      params: { ...base.params, commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    }).success).toBe(false);
    const { commandId: _omittedCommandId, ...withoutCommandId } = base.params;
    expect(bridgeRequestSchema.safeParse({ ...base, params: withoutCommandId }).success).toBe(false);
    expect(bridgeRequestSchema.safeParse({
      ...base,
      params: { ...base.params, confirmation: 'yes' },
    }).success).toBe(false);
    expect(bridgeRequestSchema.safeParse({
      ...base,
      params: { ...base.params, script: 'arbitrary source' },
    }).success).toBe(false);
  });

  it('applies recipient and body limits in UTF-8 bytes', () => {
    const frame = (recipientHandle: string, body: string) => ({
      v: 1,
      kind: 'request',
      id: '11111111-1111-4111-8111-111111111111',
      method: 'messages.sendTest',
      params: {
        commandId: '22222222-2222-4222-8222-222222222222',
        recipientHandle,
        body,
        confirmation: 'I CONSENT TO THIS TEST MESSAGE',
      },
    });

    expect(bridgeRequestSchema.safeParse(frame('é'.repeat(128), '😀'.repeat(1000))).success).toBe(true);
    expect(bridgeRequestSchema.safeParse(frame('é'.repeat(129), 'ok')).success).toBe(false);
    expect(bridgeRequestSchema.safeParse(frame('ok', '😀'.repeat(1001))).success).toBe(false);
  });

  it('rejects arbitrary native commands and caller-provided paths', () => {
    expect(() =>
      bridgeRequestSchema.parse({
        v: 1,
        kind: 'request',
        id: crypto.randomUUID(),
        method: 'shell.execute',
        params: { path: '/tmp/output' },
      }),
    ).toThrow();

    expect(() =>
      bridgeRequestSchema.parse({
        v: 1,
        kind: 'request',
        id: crypto.randomUUID(),
        method: 'notes.exportCallRecording',
        params: { artifactId: crypto.randomUUID(), destinationPath: '/tmp/output' },
      }),
    ).toThrow();
  });
});
