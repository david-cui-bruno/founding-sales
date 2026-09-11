import { describe, expect, it } from 'vitest';
import { outboundAuthorizationReasonCodeSchema } from '../../src/shared/contracts/commonContract';
import {
  outboundAttemptSummarySchema,
  outboundCapabilitiesSchema,
  outboundReceiptSchema,
  outboundRequestSchema,
} from '../../src/shared/contracts/outboundContract';

const request = {
  commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  channel: 'call', personId: 'p', salesCycleId: 's', contactMethodId: 'c',
  expectedContactSnapshot: 'a'.repeat(64),
};
const receipt = {
  commandId: request.commandId, channel: 'call', status: 'handoff_accepted', reasonCode: null as null,
  mutation: { revision: 1, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] },
};
const summary = {
  commandId: request.commandId, channel: 'call', contactMethodId: 'c',
  requestedAt: '2026-09-06T16:00:00.000Z', manualActivityId: null as null,
  status: 'unknown', reasonCode: 'handoff_uncertain',
};
const capabilities = {
  phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
  callObservation: { state: 'unavailable', reasonCode: 'not_integrated' },
  recording: { state: 'unavailable', reasonCode: 'not_integrated' },
  messagesSend: { state: 'unavailable', reasonCode: 'channel_unavailable' },
  gmailSend: { state: 'unavailable', reasonCode: 'channel_unavailable' },
  managedAudioImport: { state: 'unavailable', reasonCode: 'not_integrated' },
  appleTranscriptExtraction: { state: 'unavailable', reasonCode: 'not_integrated' },
  localDrafts: true,
};

describe('outbound contracts are strict execution-only DTOs', () => {
  it.each(['call', 'text', 'email'])('accepts %s with existing non-UUID domain IDs', (channel) => {
    expect(outboundRequestSchema.parse({ ...request, channel })).toEqual({ ...request, channel });
  });

  it.each([
    ['commandId', 'bad'], ['commandId', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    ['personId', ''], ['salesCycleId', ''], ['contactMethodId', ''],
    ['channel', 'sms'], ['expectedContactSnapshot', 'A'.repeat(64)],
    ['expectedContactSnapshot', 'a'.repeat(63)], ['expectedContactSnapshot', 'g'.repeat(64)],
    ['expectedContactSnapshot', `${'a'.repeat(64)}\n`],
  ])('rejects invalid %s (%s)', (key, value) => {
    expect(outboundRequestSchema.safeParse({ ...request, [key]: value }).success).toBe(false);
  });

  it.each([
    ['url', 'tel:+12025550123'], ['uri', 'file:///fixture'], ['target', '+12025550123'],
    ['body', 'synthetic'], ['subject', 'synthetic'], ['executable', 'open'],
    ['providerMethod', 'send'], ['observedOutcome', 'answered'], ['status', 'delivered'],
    ['ready', true], ['phoneContinuityVerified', true],
  ])('rejects renderer-supplied %s instead of stripping it', (key, value) => {
    expect(outboundRequestSchema.safeParse({ ...request, [key]: value }).success).toBe(false);
  });

  it('requires all request fields', () => {
    for (const key of Object.keys(request)) {
      const partial = { ...request } as Record<string, unknown>;
      delete partial[key];
      expect(outboundRequestSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('accepts a handoff receipt without claiming a communication outcome', () => {
    expect(outboundReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(outboundAttemptSummarySchema.parse(summary)).toEqual(summary);
  });

  it.each(['refused', 'unavailable', 'unknown'])('requires a fixed reason for %s', (status) => {
    for (const reasonCode of [null, undefined, 'provider said something', { error: 'fixture' }]) {
      expect(outboundReceiptSchema.safeParse({ ...receipt, status, reasonCode }).success).toBe(false);
      expect(outboundAttemptSummarySchema.safeParse({ ...summary, status, reasonCode }).success).toBe(false);
    }
  });

  it('requires a null reason only for handoff acceptance', () => {
    for (const reasonCode of ['handoff_uncertain', undefined]) {
      expect(outboundReceiptSchema.safeParse({ ...receipt, reasonCode }).success).toBe(false);
      expect(outboundAttemptSummarySchema.safeParse({ ...summary, status: 'handoff_accepted', reasonCode }).success).toBe(false);
    }
  });

  it.each([
    'stale_contact', 'invalid_target', 'cycle_not_executable', 'command_conflict',
    'command_evidence_invalid', 'outbound_busy', 'channel_unavailable', 'phone_route_unverified',
    'inbound_safety_unwired', 'workspace_inactive', 'operation_interrupted', 'handoff_uncertain',
    'result_not_persisted', ...outboundAuthorizationReasonCodeSchema.options,
  ])('allows fixed refusal reason %s', (reasonCode) => {
    expect(outboundReceiptSchema.safeParse({ ...receipt, status: 'refused', reasonCode }).success).toBe(true);
    expect(outboundAttemptSummarySchema.safeParse({ ...summary, status: 'refused', reasonCode }).success).toBe(true);
  });

  it.each(['sent', 'delivered', 'connected', 'recorded', 'completed'])('rejects delivery state %s', (status) => {
    expect(outboundReceiptSchema.safeParse({ ...receipt, status }).success).toBe(false);
    expect(outboundAttemptSummarySchema.safeParse({ ...summary, status }).success).toBe(false);
  });

  it.each(['url', 'target', 'body', 'error', 'providerFrame', 'observedOutcome'])('rejects %s in response DTOs', (key) => {
    expect(outboundReceiptSchema.safeParse({ ...receipt, [key]: 'fixture' }).success).toBe(false);
    expect(outboundAttemptSummarySchema.safeParse({ ...summary, [key]: 'fixture' }).success).toBe(false);
    expect(outboundCapabilitiesSchema.safeParse({ ...capabilities, [key]: 'fixture' }).success).toBe(false);
  });

  it('validates nested mutation receipts and attempt identity/timestamps', () => {
    for (const mutation of [
      { ...receipt.mutation, revision: -1 }, { ...receipt.mutation, revision: 0.5 },
      { ...receipt.mutation, affectedPersonIds: [''] }, { ...receipt.mutation, target: 'fixture' },
    ]) expect(outboundReceiptSchema.safeParse({ ...receipt, mutation }).success).toBe(false);
    for (const patch of [
      { commandId: 'bad' }, { contactMethodId: '' }, { requestedAt: 'yesterday' },
      { manualActivityId: '' }, { manualActivityId: undefined },
    ]) expect(outboundAttemptSummarySchema.safeParse({ ...summary, ...patch }).success).toBe(false);
  });

  it('keeps local drafts separate from all unavailable capabilities', () => {
    expect(outboundCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(outboundCapabilitiesSchema.safeParse({ ...capabilities, localDrafts: false }).success).toBe(false);
  });

  it.each([
    'phone_route_unverified', 'inbound_safety_unwired', 'workspace_inactive', 'not_integrated', 'channel_unavailable',
  ])('permits only the fixed capability reason %s', (reasonCode) => {
    expect(outboundCapabilitiesSchema.safeParse({ ...capabilities, phoneHandoff: { state: 'unavailable', reasonCode } }).success).toBe(true);
  });

  it.each([
    { state: 'available', reasonCode: 'phone_route_unverified' },
    { state: 'unavailable', reasonCode: null }, { state: 'unavailable', reasonCode: 'handoff_uncertain' },
    { state: 'ready', reasonCode: null }, { state: 'available' },
    { state: 'available', reasonCode: null, handler: 'fixture' },
  ])('rejects inconsistent or extended capability %j', (phoneHandoff) => {
    expect(outboundCapabilitiesSchema.safeParse({ ...capabilities, phoneHandoff }).success).toBe(false);
  });

  it('accepts available only with explicit null reason', () => {
    expect(outboundCapabilitiesSchema.safeParse({ ...capabilities, phoneHandoff: { state: 'available', reasonCode: null } }).success).toBe(true);
  });
});
