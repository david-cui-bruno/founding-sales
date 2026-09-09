import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { describe, expect, it } from 'vitest';
import { DynamoThreadIntakeRepository } from '../src/threadIntakeRepository';
import { createExecutionRepository } from '../src/executionRepository';
import { ConditionalCommandHarness, ScriptedDynamo } from './sdkHarness';
import type { ThreadPage } from '../../../../src/shared/contracts/mailThreadContract';
const now = '2026-09-08T12:00:00.000Z';
const p: ThreadPage = { complete: true, nextCursor: { version: 1, accountId: 'a1', mailboxSubject: 'sub1', mode: 'history', historyId: '11', pageToken: null, since: now }, threads: [{ accountId: 'a1', mailboxSubject: 'sub1', provider: 'gmail', providerThreadId: 't1', messages: [{ id: 'm1', threadId: 't1', rfcMessageId: '<m1@fixture.invalid>', references: [], from: ['pm@fixture.invalid'], to: ['founder@fixture.invalid'], cc: [], date: now, subject: 'reply', bodyParts: [{ mimeType: 'text/plain', text: 'Stop emailing me', truncated: false }] }] }] };
describe('real SDK Dynamo intake requests with offline conditional interpreter', () => {
  it('atomically fences authority and checkpoints with outbox, reopens and deduplicates', async () => {
    const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
    const execution = createExecutionRepository(options); await execution.seedLocalAuthority('a1');
    const repo = new DynamoThreadIntakeRepository(options);
    expect((await repo.applyPage(p, null))[0]?.revision).toBe(1);
    const restored = new DynamoThreadIntakeRepository(options);
    expect(await restored.checkpoint('a1', 'sub1')).toEqual(p.nextCursor);
    expect((await restored.applyPage(p, p.nextCursor))[0]?.changed).toBe(false);
    expect(dynamo.inspect('AUTH#a1')).toMatchObject({ version: 1, authority: { state: 'local', owner: 'local' } });
    expect((await execution.eventsAfter(null)).events[0]?.kind).toBe('thread.observed');
    expect(await restored.isSuppressed('a1')).toBe(true);
  });
  it('fails checkpoint race atomically without swallowing errors or granting authority', async () => {
    const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
    const repo = new DynamoThreadIntakeRepository(options);
    await expect(repo.applyPage(p, null)).rejects.toThrow('authority_missing');
    await createExecutionRepository(options).seedLocalAuthority('a1');
    await repo.applyPage(p, null);
    await expect(repo.applyPage(p, null)).rejects.toThrow('stale_mail_checkpoint');
    expect(dynamo.inspect('AUTH#a1')).toMatchObject({ version: 1 });
  });
});

import { createMailPoller, MAIL_POLL_INTERVAL_MS } from '../src/mailPoller';
it('poller uses admitted A+B scope despite caller A-only data and persists B optout before readiness', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const store = new DynamoThreadIntakeRepository(options); const order: string[] = [];
  await store.admitScope({ version: 1, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid'], knownThreadIds: ['t1'], since: now, approvedAt: now }, null);
  const { RemoteGoogleAuthorization } = await import('../src/remoteGoogleAuthorization');
  const { WorkerAuth } = await import('../src/workerAuth');
  const { googleScopes } = await import('../src/googleGrantCapabilities');
  const auth = new WorkerAuth(options);
  const bootstrap = await auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 });
  const pair = await auth.redeemPairing(bootstrap.code, 'fictional-source');
  const google = new RemoteGoogleAuthorization({ auth,
    config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional-secret', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 7) },
    fetch: async url => {
      if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional-access', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read}` });
      if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'sub1', email: 'founder@fixture.invalid', email_verified: true });
      throw new Error('unconfigured provider boundary');
    } });
  const begun = await google.beginGoogleGrant(pair.pairingId, ['relevant_read']);
  await google.completeGoogleGrant(new URL(begun.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const poller = createMailPoller({ store, authorization: { authorizedAccess: async (...args) => { order.push('authorized'); return google.authorizedAccess(...args); } },
    fetch: (async (raw: string | URL | Request) => {
      order.push('http'); const url = new URL(String(raw));
      if (url.pathname.endsWith('/profile')) return Response.json({ historyId: '11' });
      if (url.pathname.endsWith('/history')) return Response.json({ historyId: '12' });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: url.searchParams.get('q')?.includes('from:b@fixture.invalid') ? [{ id: 'b_reply' }] : [] });
      return Response.json({ id: 'b_reply', threadId: 't1', internalDate: String(Date.parse(now)), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'b@fixture.invalid' }, { name: 'To', value: 'founder@fixture.invalid' }, { name: 'Subject', value: 'reply' }, { name: 'Message-ID', value: '<b@fixture.invalid>' }], body: { data: Buffer.from('Please stop emailing me').toString('base64url') } } });
    }) as typeof globalThis.fetch });
  expect(MAIL_POLL_INTERVAL_MS).toBe(120000);
  const caller = { pairingId: pair.pairingId, accountId: 'a1', mailboxSubject: 'sub1', participantAddresses: ['a@fixture.invalid'], knownThreadIds: ['t1'], since: now };
  expect(await poller.pollOnce(caller, new AbortController().signal)).toMatchObject({ complete: false, suppressed: true });
  expect(await poller.pollOnce(caller, new AbortController().signal)).toMatchObject({ complete: true, suppressed: true });
  expect((await store.cursorState('a1', 'sub1'))?.data.poll).toMatchObject({ scopeRevision: 1, scopeFingerprint: mailScopeFingerprint((await store.scope('a1', 'sub1'))!) });
  expect(order[0]).toBe('authorized');
  expect(await store.checkpoint('a1', 'sub1')).toMatchObject({ historyId: '12' });
});
it('two concurrent pollers cannot double-advance revision and an ambiguous commit remains durable', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  const execution = createExecutionRepository(options); await execution.seedLocalAuthority('a1');
  const one = new DynamoThreadIntakeRepository(options), two = new DynamoThreadIntakeRepository(options);
  const results = await Promise.allSettled([one.applyPage(p, null), two.applyPage(p, null)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await one.getThread('a1', 't1'))?.revision).toBe(1);
  const next = structuredClone(p); next.nextCursor.historyId = '12'; next.threads[0]!.messages[0]!.id = 'm2';
  dynamo.afterCommit = () => { dynamo.afterCommit = undefined; throw new Error('ambiguous_commit'); };
  await expect(one.applyPage(next, p.nextCursor)).rejects.toThrow('ambiguous_commit');
  expect(await two.checkpoint('a1', 'sub1')).toEqual(next.nextCursor);
  expect((await two.getThread('a1', 't1'))?.revision).toBe(2);
  expect((await execution.eventsAfter(null)).events).toHaveLength(2);
});
it('multiple threads allocate one contiguous outbox head transaction and preserve paused authority', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  const execution = createExecutionRepository(options); await execution.seedLocalAuthority('a1');
  await execution.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId: 'a1', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fixture', approvedAt: now } });
  await execution.applyCommand({ commandId: 'pause', workspaceId: 'ws', accountId: 'a1', expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'pause', payload: { reason: 'paused' } });
  const next = structuredClone(p); const other = structuredClone(next.threads[0]!); other.providerThreadId = 't2'; other.messages[0]!.threadId = 't2'; other.messages[0]!.id = 'm2'; next.threads.push(other);
  await new DynamoThreadIntakeRepository(options).applyPage(next, null);
  expect(dynamo.inspect('AUTH#a1')).toMatchObject({ version: 4, authority: { state: 'paused', owner: 'worker', generation: 1 } });
  expect((await execution.eventsAfter(null)).events.map(e => e.aggregateVersion)).toEqual([1, 2, 3, 4]);
});
it('persists account draft edits with thread/AUTH/suppression CAS and derived stale state', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const repo = new DynamoThreadIntakeRepository(options); const incoming = structuredClone(p); incoming.threads[0]!.messages[0]!.bodyParts[0]!.text = 'How does this work?';
  const projection = (await repo.applyPage(incoming, null))[0]!.projection;
  const draft = { id: 'draft1', accountId: 'a1', threadId: 't1', mailboxSubject: 'sub1', threadRevision: projection.revision, contextRevision: projection.contextRevision,
    revision: 1, sender: 'founder@fixture.invalid', recipient: 'pm@fixture.invalid', subject: 'Reply', body: 'Thanks', evidenceIds: ['mail:m1'], generation: 'model' as const, updatedAt: now };
  expect(await repo.saveReplyDraft(draft, null)).toEqual(draft);
  await expect(repo.saveReplyDraft(draft, null)).rejects.toThrow('stale_draft');
  const edited = { ...draft, body: 'Edited reply', revision: 2, generation: 'edited' as const };
  await repo.saveReplyDraft(edited, 1);
  const next = structuredClone(p); next.nextCursor.historyId = '12'; next.threads[0]!.messages[0]!.id = 'm2';
  await repo.applyPage(next, incoming.nextCursor);
  expect(await new DynamoThreadIntakeRepository(options).getReplyDraft('a1', 'draft1')).toEqual({ draft: edited, stale: true });
  await expect(repo.saveReplyDraft({ ...edited, revision: 3 }, 2)).rejects.toThrow();
});
it('durable poll attempt invalidates previous success before authorization and fences stale attempts', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const store = new DynamoThreadIntakeRepository(options);
  const scope = { version: 1 as const, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['pm@fixture.invalid'], knownThreadIds: ['t1'], since: now, approvedAt: now };
  await store.admitScope(scope, null);
  await store.beginPoll('a1', 'sub1', 'attempt1');
  await store.applyPage({ ...p, nextCursor: { ...p.nextCursor, scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) }, threads: [] }, null, 'attempt1');
  expect((await store.cursorState('a1', 'sub1'))?.data.poll?.status).toBe('complete');
  const poller = createMailPoller({ store, authorization: { authorizedAccess: async () => { throw new Error('grant_revoked'); } }, fetch: (async () => { throw new Error('no network'); }) as typeof globalThis.fetch });
  await expect(poller.pollOnce({ pairingId: 'fixture', accountId: 'a1', mailboxSubject: 'sub1' }, new AbortController().signal)).rejects.toThrow('grant_revoked');
  expect((await store.cursorState('a1', 'sub1'))?.data.poll?.status).toBe('failed');
  await expect(store.applyPage({ ...p, threads: [] }, p.nextCursor, 'attempt1')).rejects.toThrow('stale_poll_attempt');
});

it('does not create durable Dynamo suppression from quoted intent while retaining evidence', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const repo = new DynamoThreadIntakeRepository(options); const incoming = structuredClone(p);
  incoming.threads[0]!.messages[0]!.bodyParts[0]!.text = 'Tuesday works.\n> Please stop emailing me';
  expect((await repo.applyPage(incoming, null))[0]?.signals[0]?.kind).toBe('scheduling');
  const restored = new DynamoThreadIntakeRepository(options);
  expect(await restored.isSuppressed('a1')).toBe(false);
  expect((await restored.getThread('a1', 't1'))?.thread.messages[0]?.bodyParts[0]?.text).toContain('> Please stop');
  expect(await restored.checkpoint('a1', 'sub1')).toEqual(incoming.nextCursor);
});

it('requires admitted complete account scope and resets evidence on scope CAS changes', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1'); const repo = new DynamoThreadIntakeRepository(options);
  await expect(repo.beginPoll('a1', 'sub1', 'missing')).rejects.toThrow('mail_scope_required');
  const scope = { version: 1 as const, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid'], knownThreadIds: ['t1'], since: now, approvedAt: now };
  await repo.admitScope(scope, null);
  await repo.beginPoll('a1', 'sub1', 'old');
  const before = await repo.cursorState('a1', 'sub1');
  await repo.admitScope({ ...scope, revision: 2, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid', 'c@fixture.invalid'] }, before!.rev);
  expect(await new DynamoThreadIntakeRepository(options).scope('a1', 'sub1')).toMatchObject({ revision: 2 });
  expect((await repo.cursorState('a1', 'sub1'))?.data).toMatchObject({ checkpoint: null, poll: null });
  await expect(repo.applyPage(p, null, 'old')).rejects.toThrow();
  await expect(repo.admitScope({ ...scope, revision: 3 }, before!.rev)).rejects.toThrow('stale_mail_scope');
});

it('scope CAS has one winner and an ambiguous admission commit remains durably reset', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1'); const repo = new DynamoThreadIntakeRepository(options);
  const scope = { version: 1 as const, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['a@fixture.invalid'], knownThreadIds: ['t1'], since: now, approvedAt: now };
  const results = await Promise.allSettled([repo.admitScope(scope, null), new DynamoThreadIntakeRepository(options).admitScope(scope, null)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await repo.beginPoll('a1', 'sub1', 'crashed'); const before = await repo.cursorState('a1', 'sub1');
  dynamo.afterCommit = () => { dynamo.afterCommit = undefined; throw new Error('ambiguous_commit'); };
  await expect(repo.admitScope({ ...scope, revision: 2, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid'] }, before!.rev)).rejects.toThrow('ambiguous_commit');
  expect((await new DynamoThreadIntakeRepository(options).cursorState('a1', 'sub1'))?.data).toMatchObject({ scope: { revision: 2 }, checkpoint: null, poll: null });
});
it('semantic context preserves unchanged polls and changes only with retained evidence or scope', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const repo = new DynamoThreadIntakeRepository(options);
  const empty = await repo.inboundContext('a1', 'sub1');
  const scope = { version: 1 as const, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['pm@fixture.invalid'], knownThreadIds: [] as string[], since: now, approvedAt: now };
  await repo.admitScope(scope, null);
  expect((await repo.cursorState('a1', 'sub1'))?.data).toMatchObject({ inboundContextRevision: 1, inboundContextFingerprint: empty });
  await repo.beginPoll('a1', 'sub1', 'semantic1');
  const next = structuredClone(p); next.nextCursor.scopeRevision = 1; next.nextCursor.scopeFingerprint = mailScopeFingerprint(scope);
  await repo.applyPage(next, null, 'semantic1');
  const changed = (await repo.cursorState('a1', 'sub1'))!.data;
  expect(changed.inboundContextRevision).toBe(2); expect(changed.inboundContextFingerprint).not.toBe(empty);
  expect(changed.inboundContextFingerprint).toBe(await repo.inboundContext('a1', 'sub1'));
  await repo.beginPoll('a1', 'sub1', 'semantic2'); await repo.applyPage({ ...next, threads: [] }, await repo.checkpoint('a1', 'sub1'), 'semantic2');
  await repo.beginPoll('a1', 'sub1', 'semantic3'); await repo.failPoll('a1', 'sub1', 'semantic3');
  expect((await new DynamoThreadIntakeRepository(options).cursorState('a1', 'sub1'))!.data.inboundContextRevision).toBe(2);
});
it('scope mutation preserves actual digest, increments semantic revision and clears completeness', async () => {
  const dynamo = new ConditionalCommandHarness(), options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1'); const repo = new DynamoThreadIntakeRepository(options);
  await repo.applyPage(p, null);
  const actual = await repo.inboundContext('a1', 'sub1');
  const legacy = await repo.cursorState('a1', 'sub1'); expect(legacy?.data.inboundContextRevision).toBeNull();
  const scope = { version: 1 as const, accountId: 'a1', mailboxSubject: 'sub1', revision: 1, participantAddresses: ['pm@fixture.invalid'], knownThreadIds: ['t1'], since: now, approvedAt: now };
  await repo.admitScope(scope, legacy!.rev);
  const first = (await repo.cursorState('a1', 'sub1'))!;
  await repo.admitScope({ ...scope, revision: 2, participantAddresses: ['other@fixture.invalid', 'pm@fixture.invalid'] }, first.rev);
  expect((await repo.cursorState('a1', 'sub1'))?.data).toMatchObject({ inboundContextRevision: 2, inboundContextFingerprint: actual, checkpoint: null, poll: null });
});
import { QueryCommand } from '@aws-sdk/client-dynamodb';
it('actual semantic digest query is account bounded and imposes a retained-row request limit', async () => {
  const dynamo = new ScriptedDynamo([{ Items: [] }]);
  const repo = new DynamoThreadIntakeRepository({ dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } });
  await repo.inboundContext('a1', 'sub1');
  const command = dynamo.commands[0]; expect(command).toBeInstanceOf(QueryCommand);
  expect((command as QueryCommand).input.Limit).toBe(1001);
});
