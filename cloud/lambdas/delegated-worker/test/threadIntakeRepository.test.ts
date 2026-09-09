import { describe, expect, it } from 'vitest';
import { DynamoThreadIntakeRepository } from '../src/threadIntakeRepository';
import { createExecutionRepository } from '../src/executionRepository';
import { ConditionalCommandHarness } from './sdkHarness';
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
it('poller authorizes before HTTP and persists intake before reporting dispatch readiness', async () => {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, tableName: 'fictional', workspaceId: 'ws', clock: { now: () => now } };
  await createExecutionRepository(options).seedLocalAuthority('a1');
  const store = new DynamoThreadIntakeRepository(options); const order: string[] = [];
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
    fetch: (async (raw: string | URL | Request) => { order.push('http'); const url = new URL(String(raw)); return new Response(JSON.stringify(url.pathname.endsWith('/profile') ? { historyId: '11' } : {})); }) as typeof globalThis.fetch });
  expect(MAIL_POLL_INTERVAL_MS).toBe(120000);
  expect(await poller.pollOnce({ pairingId: pair.pairingId, accountId: 'a1', mailboxSubject: 'sub1', knownThreadIds: [], participantAddresses: ['pm@fixture.invalid'], since: now }, new AbortController().signal)).toMatchObject({ complete: false, suppressed: false });
  expect(order[0]).toBe('authorized');
  expect(await store.checkpoint('a1', 'sub1')).toMatchObject({ historyId: '11' });
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
  await store.beginPoll('a1', 'sub1', 'attempt1');
  await store.applyPage({ ...p, threads: [] }, null, 'attempt1');
  expect((await store.cursorState('a1', 'sub1'))?.data.poll?.status).toBe('complete');
  const poller = createMailPoller({ store, authorization: { authorizedAccess: async () => { throw new Error('grant_revoked'); } }, fetch: (async () => { throw new Error('no network'); }) as typeof globalThis.fetch });
  await expect(poller.pollOnce({ pairingId: 'fixture', accountId: 'a1', mailboxSubject: 'sub1', knownThreadIds: [], participantAddresses: ['pm@fixture.invalid'], since: now }, new AbortController().signal)).rejects.toThrow('grant_revoked');
  expect((await store.cursorState('a1', 'sub1'))?.data.poll?.status).toBe('failed');
  await expect(store.applyPage({ ...p, threads: [] }, p.nextCursor, 'attempt1')).rejects.toThrow('stale_poll_attempt');
});
