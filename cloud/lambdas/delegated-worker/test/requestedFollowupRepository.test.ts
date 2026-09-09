import { expect, it } from 'vitest';
import { DynamoRequestedFollowupRepository, requestedFollowupDraftKey } from '../src/requestedFollowupRepository';
import { ConditionalCommandHarness } from './sdkHarness';
it('fails closed on a missing actual authority and never bootstraps one', async () => {
  const dynamo = new ConditionalCommandHarness();
  const repo = new DynamoRequestedFollowupRepository({ dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => '2026-09-08T12:00:00.000Z' } });
  await expect(repo.readContext({ accountId: 'a1', originalCall: { commandId: 'c', handoffId: 'h', actionId: 'a', commandFingerprint: 'a'.repeat(64), outcomeEventId: 'e', outcomeEventHash: 'a'.repeat(64) }, recipientBinding: { kind: 'account_route', routeId: 'r', routeVersion: 1, email: 'pm@fixture.invalid' }, expectedAccountVersion: 1, mode: 'manual' })).rejects.toThrow('authority_missing');
  expect(dynamo.inspect('AUTH#a1')).toBeUndefined();
});
import { requestedFollowupFixture, REQUESTED_NOW } from '../../../../tests/fixtures/requestedFollowup';
import { DynamoStore } from '../src/dynamoStore';
import { executionAuthorityFields } from '../src/executionRepository';
import { googleGrantSchema, googleScopes } from '../src/googleGrantCapabilities';
import { createRequestedFollowupService } from '../../../../src/main/outreach/requestedFollowupService';
async function fixture() {
  const f = requestedFollowupFixture(), dynamo = new ConditionalCommandHarness();
  const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => REQUESTED_NOW } }, store = new DynamoStore(options);
  const authority = { authority: { accountId: 'a1', owner: 'local' as const, state: 'local' as const, generation: 0 }, version: 2 };
  const grant = googleGrantSchema.parse({ provider: 'google', subject: 'sub1', email: f.draft.sender, owner: 'remote', purpose: 'permitted_correspondence', grantedScopes: [googleScopes.relevant_read], capabilities: ['relevant_read'] });
  await store.transact([store.put('AUTH#a1', authority, null, executionAuthorityFields(authority)), store.put('ACCOUNT#a1', f.record, null),
    store.put('OWNER_SOURCE#a1', f.source, null), store.put(`GOOGLE_GRANT#${f.source.pairingId}`, { grant, revoked: false, ciphertext: 'fictional-not-read' }, null),
    store.put(`COMMAND#${f.command.commandId}`, { fingerprint: f.ref.commandFingerprint, receipt: f.receipt, sequence: 2, command: f.command }, null),
    store.put(store.eventKey(2), { sequence: 2, event: f.event, published: true }, null),
    store.put('MANUAL_HANDOFF#h1', { handoff: f.handoff, accountId: 'a1', generation: 0, pairingId: f.source.pairingId, issuedAt: REQUESTED_NOW, lastOutcome: null }, null)]);
  return { ...f, options, store, dynamo, repo: new DynamoRequestedFollowupRepository(options) };
}
it('saves real SDK editable draft with exact CAS and survives adapter reconstruction', async () => {
  const f = await fixture();
  await f.repo.save(f.draft, null);
  expect(await new DynamoRequestedFollowupRepository(f.options).get('a1', f.draft.id)).toEqual({ draft: f.draft, stale: true, approval: null });
  const edited = { ...f.draft, revision: 2, body: 'Owner edited text' };
  await f.repo.save(edited, 1); await expect(f.repo.save(edited, 1)).rejects.toThrow('stale_requested_draft');
  expect(f.dynamo.inspect('AUTH#a1')).toMatchObject({ version: 2, authority: { owner: 'local', state: 'local' } });
  expect(f.dynamo.inspect(requestedFollowupDraftKey('a1', f.draft.id))).toEqual(edited);
});
it.each(['outcomeEventHash', 'commandFingerprint', 'handoffId', 'actionId'] as const)('rejects forged original call %s before persistence', async key => {
  const f = await fixture(); const originalCall = { ...f.ref, [key]: key.endsWith('Hash') || key.endsWith('Fingerprint') ? 'b'.repeat(64) : 'wrong' };
  await expect(f.repo.save({ ...f.draft, originalCall, recipientBinding: { kind: 'owner_supplied', email: f.draft.recipient, originalCall } }, null)).rejects.toThrow();
  expect(f.dynamo.inspect(requestedFollowupDraftKey('a1', f.draft.id))).toBeUndefined();
});
it('returned actual plan fails if suppression or authority changes before commit', async () => {
  const f = await fixture(); const plan = await f.repo.planCurrent(f.draft);
  await f.store.transact([f.store.put('MAIL_SUPPRESSION#a1', { accountId: 'a1', evidence: 'fixture optout' }, null)]);
  await expect(f.store.transact([...plan.checks, f.store.put(requestedFollowupDraftKey('a1', f.draft.id), f.draft, null)])).rejects.toThrow();
  expect(f.dynamo.inspect(requestedFollowupDraftKey('a1', f.draft.id))).toBeUndefined();
});
it('manual service works without a model and actual HTTP model output cannot pick routing', async () => {
  const f = await fixture(), input = { accountId: 'a1', originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 1, mode: 'manual' as const };
  const manual = createRequestedFollowupService({ store: f.repo, clock: f.options.clock, id: () => 'manual' });
  const saved = await manual.prepareRequestedFollowup(input, new AbortController().signal);
  expect(saved.draft).toMatchObject({ body: '', subject: '', generation: 'edited', recipient: f.draft.recipient });
  expect((await manual.editRequestedFollowup({ accountId: 'a1', draftId: 'manual', expectedRevision: 1, subject: 'Information', body: 'My text' })).draft.body).toBe('My text');
  const requests: string[] = [];
  const model = createRequestedFollowupService({ store: f.repo, clock: f.options.clock, id: () => 'model', model: { credentials: { apiKey: 'fictional', model: 'fictional' }, fetch: (async (_url, init) => {
    requests.push(String(init?.body)); return Response.json({ id: 'response1', status: 'completed', model: 'fictional', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ subject: 'Information', body: 'Thanks for speaking with me.', evidenceIds: ['call:outcome1'] }) }] }] });
  }) as typeof globalThis.fetch } });
  const generated = await model.prepareRequestedFollowup({ ...input, mode: 'model' }, new AbortController().signal);
  expect(generated.draft.recipient).toBe(f.draft.recipient); expect(generated.draft.evidenceIds).toEqual(['call:outcome1']);
  expect(requests[0]).toContain('call:outcome1'); expect(requests[0]).toContain('no inbound email thread');
  expect(generated.draft).not.toHaveProperty('threadId');
});
it('one-click capture adopts actual local multi-edit revisions without fake intermediate saves', async () => {
  const f = await fixture(), local = { ...f.draft, revision: 5, body: 'Reviewed local revision five' };
  const item = await f.repo.planCaptureDraft(local, null);
  expect(f.dynamo.inspect(requestedFollowupDraftKey('a1', local.id))).toBeUndefined();
  await f.store.transact([...(await f.repo.planCurrent(local)).checks, item]);
  expect((await f.repo.get('a1', local.id))?.draft).toEqual(local);
  expect((await f.repo.planCaptureDraft(local, 5)).ConditionCheck).toBeDefined();
  await expect(f.repo.planCaptureDraft({ ...local, body: 'different' }, 5)).rejects.toThrow();
  await expect(f.repo.planCaptureDraft({ ...local, revision: 4 }, 5)).rejects.toThrow();
  const later = { ...local, revision: 9, body: 'Reviewed offline revision nine' };
  await f.store.transact([await f.repo.planCaptureDraft(later, 5)]);
  await expect(f.repo.planCaptureDraft({ ...later, revision: 10 }, 5)).rejects.toThrow();
});
it('new relevant mail invalidates prior actual context without changing account version', async () => {
  const f = await fixture(); await f.repo.save(f.draft, null);
  await f.repo.intake.applyPage({ complete: true, nextCursor: { version: 1, accountId: 'a1', mailboxSubject: 'sub1', mode: 'history', historyId: '1', pageToken: null, since: REQUESTED_NOW },
    threads: [{ accountId: 'a1', mailboxSubject: 'sub1', provider: 'gmail', providerThreadId: 't1', messages: [{ id: 'm1', threadId: 't1', rfcMessageId: '<m1@fixture.invalid>', references: [], from: ['pm@fixture.invalid'], to: [f.draft.sender], cc: [], date: REQUESTED_NOW, subject: 'Question', bodyParts: [{ mimeType: 'text/plain', text: 'What does this do?', truncated: false }] }] }] }, null);
  await expect(f.repo.planCurrent(f.draft)).rejects.toThrow('requested_context_stale');
  expect((await f.repo.get('a1', f.draft.id))?.draft.body).toBe(f.draft.body);
  expect((await f.repo.get('a1', f.draft.id))?.stale).toBe(true);
});
it('unknown commit preserves the actual draft for idempotent capture recovery', async () => {
  const f = await fixture(); f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw new Error('ambiguous_commit'); };
  await expect(f.repo.save(f.draft, null)).rejects.toThrow('ambiguous_commit');
  expect((await new DynamoRequestedFollowupRepository(f.options).get('a1', f.draft.id))?.draft).toEqual(f.draft);
  expect((await f.repo.planCaptureDraft(f.draft, 1)).ConditionCheck).toBeDefined();
});
it('model cannot cite invented call evidence or save after concurrent optout', async () => {
  for (const kind of ['invented', 'optout'] as const) {
    const f = await fixture();
    const service = createRequestedFollowupService({ store: f.repo, clock: f.options.clock, id: () => kind, model: { credentials: { apiKey: 'fictional', model: 'fictional' }, fetch: (async () => {
      if (kind === 'optout') await f.store.transact([f.store.put('MAIL_SUPPRESSION#a1', { accountId: 'a1', evidence: 'optout' }, null)]);
      return Response.json({ id: 'response1', status: 'completed', model: 'fictional', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ subject: 'Information', body: 'Thanks.', evidenceIds: [kind === 'invented' ? 'mail:invented' : 'call:outcome1'] }) }] }] });
    }) as typeof globalThis.fetch } });
    await expect(service.prepareRequestedFollowup({ accountId: 'a1', originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 1, mode: 'model' }, new AbortController().signal)).rejects.toThrow();
    expect(await f.repo.get('a1', kind)).toBeNull();
  }
});
it('refuses original outcome beyond current durable authority rather than trusting a forged future receipt', async () => {
  const f = await fixture();
  const row = await f.store.get<{ authority: { accountId: string; owner: 'local'; state: 'local'; generation: number }; version: number }>('AUTH#a1');
  const prior = { ...row!.data, version: 1 };
  await f.store.transact([f.store.put('AUTH#a1', prior, row!.rev, executionAuthorityFields(prior))]);
  await expect(f.repo.planCurrent(f.draft)).rejects.toThrow('requested_call_future');
});
