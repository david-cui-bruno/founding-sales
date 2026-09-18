import { expect, it } from 'vitest';
import { delegatedPhoneHandoffRequestSchema } from '../../src/shared/contracts/ownerCommandContract';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';

/**
 * The optional manual-dial flag lane 32 carries on the phone router. It is a routing flag, never a
 * permission: absent or present, the handoff, the evidence and the approvals are identical, and only
 * the literal `true` is accepted so `false` can never be read as "the worker may dial".
 */
const base = () => {
  const f = requestedFollowupFixture();
  const command = { commandId: '55555555-5555-4555-8555-555555555555', workspaceId: 'ws', accountId: 'a1',
    expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'prepare-manual' as const,
    payload: { actionId: f.handoff.actionId, channel: 'call' as const, routeId: f.handoff.routeId, routeVersion: 1,
      targetHash: f.handoff.targetHash, contentHash: f.handoff.contentHash, contextRevision: f.handoff.contextRevision,
      campaign: f.handoff.campaign } };
  return { command, expectedEvidenceFingerprint: f.ref.commandFingerprint };
};

it('accepts a phone handoff request with manual true, and one with no manual flag at all', () => {
  const request = base();
  expect(delegatedPhoneHandoffRequestSchema.parse({ ...request, manual: true }).manual).toBe(true);
  expect(delegatedPhoneHandoffRequestSchema.parse(request).manual).toBeUndefined();
  // The flag changes nothing else: the command and the evidence binding are byte-identical either way.
  const { manual: _manual, ...withoutFlag } = delegatedPhoneHandoffRequestSchema.parse({ ...request, manual: true });
  void _manual;
  expect(withoutFlag).toEqual(delegatedPhoneHandoffRequestSchema.parse(request));
});

it('refuses manual false, and every other value than the literal true', () => {
  const request = base();
  for (const manual of [false, 'true', 1, null]) {
    expect(delegatedPhoneHandoffRequestSchema.safeParse({ ...request, manual }).success).toBe(false);
  }
});
