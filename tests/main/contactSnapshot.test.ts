import { describe, expect, it } from 'vitest';
import { contactSnapshot, outboundIntentFingerprint } from '../../src/main/communications/contactSnapshot';
import type { OutboundRequest } from '../../src/shared/contracts/outboundContract';

const contact = {
  id: 'c', personId: 'p', kind: 'phone' as const, normalizedValue: '+12025550123',
  validationState: 'valid' as const, updatedAt: '2026-09-06T16:00:00.000Z',
};
const request: OutboundRequest = {
  commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call',
  personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64),
};

describe('contact display consistency, not authorization', () => {
  it('hashes the versioned fixed tuple with a stable SHA-256 golden value', () => {
    expect(contactSnapshot(contact)).toBe('cfc34d2d98e52c442925530fbc1be9831c22698f3fa77c486f004792d0c9232f');
    expect(contactSnapshot(contact)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { id: 'other' }, { personId: 'other' }, { kind: 'email' as const },
    { normalizedValue: '+12025550124' }, { validationState: 'invalid' as const },
    { validationState: 'unverified' as const }, { updatedAt: '2026-09-06T16:00:01.000Z' },
  ])('changes when any displayed-contact authority changes: %j', (patch) => {
    expect(contactSnapshot({ ...contact, ...patch })).not.toBe(contactSnapshot(contact));
  });

  it('ignores key order and unrelated lead revisions', () => {
    const reordered = {
      updatedAt: contact.updatedAt, validationState: contact.validationState,
      normalizedValue: contact.normalizedValue, kind: contact.kind, personId: contact.personId, id: contact.id,
      leadRevision: 999,
    };
    expect(contactSnapshot(reordered)).toBe(contactSnapshot(contact));
  });

  it('uses tuple boundaries rather than ambiguous concatenation', () => {
    expect(contactSnapshot({ ...contact, id: 'ab', personId: 'c' }))
      .not.toBe(contactSnapshot({ ...contact, id: 'a', personId: 'bc' }));
  });
});

describe('outbound intent identity', () => {
  it('hashes every intent field in the locked versioned tuple order', () => {
    expect(outboundIntentFingerprint(request)).toBe('55c638c505ed8759da2524302c335d8410bb9ac03c713adf9258da797375f14d');
  });

  it.each([
    { commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { channel: 'text' as const },
    { personId: 'p2' }, { salesCycleId: 's2' }, { contactMethodId: 'c2' },
    { expectedContactSnapshot: 'b'.repeat(64) },
  ])('does not conflate changed intent %j', (patch) => {
    expect(outboundIntentFingerprint({ ...request, ...patch })).not.toBe(outboundIntentFingerprint(request));
  });

  it('is independent of request object insertion order', () => {
    expect(outboundIntentFingerprint({
      expectedContactSnapshot: request.expectedContactSnapshot, contactMethodId: request.contactMethodId,
      salesCycleId: request.salesCycleId, personId: request.personId, channel: request.channel, commandId: request.commandId,
    })).toBe(outboundIntentFingerprint(request));
  });
});
