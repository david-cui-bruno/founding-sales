import { describe, expect, it, vi } from 'vitest';
import { requestedFollowupDraftSchema, prepareRequestedFollowupSchema, type RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';
import { requestedFollowupContextRevision , createRequestedFollowupService } from '../../src/main/outreach/requestedFollowupService';
const hash = 'a'.repeat(64);
export const draft: RequestedFollowupDraft = { kind: 'requested_phone_followup' as const, id: 'draft1', accountId: 'a1', revision: 1, mailboxSubject: 'sub1', sender: 'founder@fixture.invalid', recipient: 'pm@fixture.invalid', recipientBinding: { kind: 'owner_supplied' as const, email: 'pm@fixture.invalid', originalCall: { commandId: 'command1', handoffId: 'h1', actionId: 'call1', commandFingerprint: hash, outcomeEventId: 'e1', outcomeEventHash: hash } }, accountVersion: 1, researchRevision: 1, contextRevision: hash, originalCall: { commandId: 'command1', handoffId: 'h1', actionId: 'call1', commandFingerprint: hash, outcomeEventId: 'e1', outcomeEventHash: hash }, mailContext: { scopeRevision: null, scopeFingerprint: null, inboundContextRevision: null, inboundContextFingerprint: hash }, subject: '', body: '', evidenceIds: [] as string[], generation: 'edited' as const, updatedAt: '2026-09-08T12:00:00.000Z' };
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

function replayFixture() {
  const f = requestedFollowupFixture(), event = f.event;
  if (event.kind !== 'manual.outcome') throw Error('fixture outcome');
  const request = { draftId: '66666666-6666-4666-8666-666666666666', accountId: f.draft.accountId, originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 1, mode: 'manual' as const };
  let saved: import('../../src/shared/contracts/requestedFollowupContract').SavedRequestedFollowup | null = null;
  const store = { readContext: vi.fn(async () => ({ account: f.record, originalCall: { command: f.command, event, handoff: f.handoff }, mailContext: f.draft.mailContext, mailbox: { subject: f.draft.mailboxSubject, sender: f.draft.sender } })),
    get: vi.fn(async () => saved), save: vi.fn(async (next: RequestedFollowupDraft) => { if (saved) throw Error('stale_requested_draft'); saved = { draft: next, stale: true, approval: null }; return next; }) };
  const id = vi.fn(() => 'legacy-id'); const service = createRequestedFollowupService({ store, clock: { now: () => f.draft.updatedAt }, id });
  return { f, request, store, service, id, setSaved(value: typeof saved) { saved = value; } };
}
it('same-ID replay recovers a prewrite context failure without minting replacement IDs', async () => {
  const f = replayFixture(), signal = new AbortController().signal;
  f.store.readContext.mockRejectedValueOnce(Error('missing-mailbox'));
  await expect(f.service.prepareRequestedFollowup(f.request, signal)).rejects.toThrow('missing-mailbox');
  expect(f.store.save).not.toHaveBeenCalled();
  const saved = await f.service.prepareRequestedFollowup(f.request, signal);
  expect(saved.draft.id).toBe(f.request.draftId); expect(f.id).not.toHaveBeenCalled();
  expect(await f.service.prepareRequestedFollowup(f.request, signal)).toEqual(saved); expect(f.store.save).toHaveBeenCalledTimes(1);
});
it('same-ID replay preserves exact edited text revision and stale approval without overwrite', async () => {
  const f = replayFixture(), signal = new AbortController().signal;
  const saved = { draft: { ...f.f.draft, id: f.request.draftId, revision: 4, subject: 'Exact edited subject', body: 'Exact edited body', evidenceIds: [] as string[] }, stale: true, approval: { receipt: f.f.receipt, state: 'needs_review' as const, intentCommandId: null as null, reason: 'stale' } };
  f.setSaved(saved);
  expect(await f.service.prepareRequestedFollowup(f.request, signal)).toEqual(saved);
  expect(f.store.save).not.toHaveBeenCalled(); expect(f.store.readContext).not.toHaveBeenCalled();
});
it.each(['account', 'call', 'recipient', 'version', 'model'] as const)('same-ID replay rejects mismatched %s identity without overwrite', async kind => {
  const f = replayFixture(), existing = { ...f.f.draft, id: f.request.draftId, evidenceIds: [] as string[] };
  if (kind === 'account') existing.accountId = 'other';
  if (kind === 'call') existing.originalCall = { ...existing.originalCall, outcomeEventHash: 'b'.repeat(64) };
  if (kind === 'recipient') existing.recipientBinding = { ...existing.recipientBinding, email: 'other@example.invalid' };
  if (kind === 'version') existing.accountVersion++;
  if (kind === 'model') existing.generation = 'model';
  f.setSaved({ draft: existing, stale: true, approval: null });
  await expect(f.service.prepareRequestedFollowup(f.request, new AbortController().signal)).rejects.toThrow();
  expect(f.store.save).not.toHaveBeenCalled();
});
it('same-ID contract rejects model UUID requests but preserves legacy manual and model requests', () => {
  const f = replayFixture(); expect(prepareRequestedFollowupSchema.safeParse(f.request).success).toBe(true);
  expect(prepareRequestedFollowupSchema.safeParse({ ...f.request, mode: 'model' }).success).toBe(false);
  const { draftId: _id, ...legacy } = f.request; void _id;
  for (const mode of ['manual', 'model']) expect(prepareRequestedFollowupSchema.safeParse({ ...legacy, mode }).success).toBe(true);
});

it('same-ID replay recovers a lost postwrite reply by read without a second save', async () => {
  const f = replayFixture(), signal = new AbortController().signal;
  f.store.save.mockImplementationOnce(async next => { f.setSaved({ draft: next, stale: true, approval: null }); throw Error('lost-write-reply'); });
  const recovered = await f.service.prepareRequestedFollowup(f.request, signal);
  expect(recovered.draft.id).toBe(f.request.draftId);
  expect(await f.service.prepareRequestedFollowup(f.request, signal)).toEqual(recovered);
  expect(f.store.save).toHaveBeenCalledTimes(1); expect(f.id).not.toHaveBeenCalled();
});
it.each(['absent', 'mismatch', 'read-failure'] as const)('same-ID CAS loser preserves original error on %s reread', async kind => {
  const f = replayFixture(), original = Error('original-save-error');
  f.store.save.mockImplementationOnce(async next => {
    if (kind === 'mismatch') f.setSaved({ draft: { ...next, accountVersion: 7 }, stale: true, approval: null });
    if (kind === 'read-failure') f.store.get.mockRejectedValueOnce(Error('read-error'));
    throw original;
  });
  await expect(f.service.prepareRequestedFollowup(f.request, new AbortController().signal)).rejects.toBe(original);
  expect(f.store.save).toHaveBeenCalledTimes(1); expect(f.id).not.toHaveBeenCalled();
});
