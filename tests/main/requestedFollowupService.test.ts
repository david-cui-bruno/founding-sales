import { describe, expect, it, vi } from 'vitest';
import { requestedFollowupDraftSchema, prepareRequestedFollowupSchema, type RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';
import { requestedFollowupContextRevision , createRequestedFollowupService } from '../../src/main/outreach/requestedFollowupService';
const hash = 'a'.repeat(64);
export const draft: RequestedFollowupDraft = { kind: 'requested_phone_followup' as const, id: 'draft1', accountId: 'a1', revision: 1, mailboxSubject: 'sub1', sender: 'founder@fixture.invalid', recipient: 'pm@fixture.invalid', recipientBinding: { kind: 'owner_supplied' as const, email: 'pm@fixture.invalid', originalCall: { commandId: 'command1', handoffId: 'h1', actionId: 'call1', commandFingerprint: hash, outcomeEventId: 'e1', outcomeEventHash: hash } }, accountVersion: 1, researchRevision: 1, contextRevision: hash, originalCall: { commandId: 'command1', handoffId: 'h1', actionId: 'call1', commandFingerprint: hash, outcomeEventId: 'e1', outcomeEventHash: hash }, mailContext: { scopeRevision: null, scopeFingerprint: null, inboundContextRevision: null, inboundContextFingerprint: hash }, subject: '', body: '', evidenceIds: [], generation: 'edited' as const, updatedAt: '2026-09-08T12:00:00.000Z' };
describe('requested phone followup contract', () => {
  it('admits a threadless editable draft but never thread headers or invented source messages', () => {
    expect(requestedFollowupDraftSchema.parse(draft)).toEqual(draft);
    for (const key of ['threadId', 'inReplyTo', 'references', 'sourceMessageId', 'personId']) expect(requestedFollowupDraftSchema.safeParse({ ...draft, [key]: 'fake' }).success).toBe(false);
    expect(prepareRequestedFollowupSchema.safeParse({ accountId: 'a1', originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, expectedAccountVersion: 1, mode: 'manual' }).success).toBe(true);
  });
  it('hashes semantic context, not editable text or poll write revision', () => {
    expect(requestedFollowupContextRevision(draft)).toBe(requestedFollowupContextRevision({ ...draft, body: 'edited' }));
    expect(requestedFollowupContextRevision(draft)).not.toBe(requestedFollowupContextRevision({ ...draft, accountVersion: 2 }));
  });
});
it('manual mode refuses missing actual context before any model work', async () => {
  const service = createRequestedFollowupService({ store: { readContext: () => { throw new Error('requested_call_missing'); }, get: () => null, save: () => { throw new Error('unexpected save'); } }, clock: { now: () => draft.updatedAt }, id: () => 'manual1' });
  await expect(service.prepareRequestedFollowup({ accountId: 'a1', originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, expectedAccountVersion: 1, mode: 'manual' }, new AbortController().signal)).rejects.toThrow('requested_call_missing');
});
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
it.each(['requested', 'owner', 'delegation'] as const)('parses actual owner command with %s as runtime entry point', async entry => {
  vi.resetModules();
  const loaders = { requested: () => import('../../src/shared/contracts/requestedFollowupContract'), owner: () => import('../../src/shared/contracts/ownerCommandContract'), delegation: () => import('../../src/shared/contracts/delegationContract') };
  await loaders[entry]();
  const { ownerCommandSchema } = await import('../../src/shared/contracts/ownerCommandContract');
  const { delegationCommandSchema } = await import('../../src/shared/contracts/delegationContract');
  const f = requestedFollowupFixture();
  const command = { commandId: '44444444-4444-4444-8444-444444444444', workspaceId: 'ws', accountId: 'a1', expectedAuthorityGeneration: 0, expectedVersion: 2, kind: 'approve-requested-followup',
    payload: { draft: f.draft, expectedRemoteDraftRevision: null as null, approvalId: 'approval1', actionId: 'first-email1', intentCommandId: '55555555-5555-4555-8555-555555555555', request: { statement: 'recipient_requested_information_by_email', recipient: f.draft.recipient }, expiresAt: '2026-09-08T12:30:00.000Z' } };
  expect(ownerCommandSchema.parse(command)).toEqual(delegationCommandSchema.parse(command));
});
