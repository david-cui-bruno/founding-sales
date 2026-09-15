import { expect, it, afterEach, vi } from 'vitest';
import { createCallieApi } from '../../src/preload/createCallieApi';

it('exposes standalone ordinary saved-reply edit and explicit reconciliation', () => {
  const api = createCallieApi({ invoke: async () => { throw Error('No IPC expected for method discovery'); } });
  expect(api.delegation).toHaveProperty('editReplyDraft', expect.any(Function));
  expect(api.delegation).toHaveProperty('reconcileReplyDraft', expect.any(Function));
});

import { randomUUID } from 'node:crypto';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { SqlThreadIntakeRepository } from '../../src/main/outreach/threadIntakeRepository';
import { fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { DynamoDispatchRepository } from '../../cloud/lambdas/delegated-worker/src/dispatchRepository';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { createExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoThreadIntakeRepository } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { ownerSourceKey } from '../../src/shared/contracts/ownerCommandContract';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import type { AccountReplyDraft, EditReplyDraft, ThreadPage } from '../../src/shared/contracts/mailThreadContract';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (ipc.handlers.has(channel)) throw Error('Duplicate IPC'); ipc.handlers.set(channel, handler); },
  removeHandler: (channel: string) => ipc.handlers.delete(channel),
} }));
afterEach(() => { vi.unstubAllGlobals(); expect(ipc.handlers.size).toBe(0); });

async function ordinaryFixture() {
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unexpected provider/native/model action'); });
  vi.stubGlobal('fetch', forbidden);
  const f = await createPmFixture(), clock = { now: () => PM_NOW }, workspaceId = 'ordinary-workspace';
  const account = f.repo.create({ commandId: randomUUID(), name: 'Synthetic ordinary reply account', domain: null });
  const dynamo = new ConditionalCommandHarness(), options = { dynamo, tableName: 'ordinary-fixture', workspaceId, clock };
  const auth = new WorkerAuth(options), pairing = { ...await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fixture'), endpoint: 'https://ordinary.example.test' };
  const execution = createExecutionRepository(options), threads = new DynamoThreadIntakeRepository(options);
  await execution.seedLocalAuthority(account.id);
  const delegate = { commandId: randomUUID(), workspaceId, accountId: account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate' as const, payload: { delegationId: 'explicit-fixture', approvedAt: PM_NOW } };
  const localRepository = () => new DelegationRepository({ database: f.db, workspaceId, clock });
  localRepository().initializeLocalAuthority(account.id); localRepository().queueCommand(delegate);
  await execution.applyCommand(delegate);
  await auth.store.transact([auth.store.put(ownerSourceKey(account.id), { version: 1, workspaceId, accountId: account.id, pairingId: pairing.pairingId, revision: 1, state: 'active', mailboxSubject: 'ordinary-mailbox', calendarId: null, research: null }, null)]);
  const incoming: ThreadPage = { complete: true, nextCursor: { version: 1, accountId: account.id, mailboxSubject: 'ordinary-mailbox', mode: 'history', historyId: '1', pageToken: null, since: PM_NOW }, threads: [{ accountId: account.id, mailboxSubject: 'ordinary-mailbox', provider: 'gmail', providerThreadId: 'ordinary-thread', messages: [{ id: 'incoming-1', threadId: 'ordinary-thread', rfcMessageId: '<incoming-1@example.test>', references: [], from: ['recipient@example.test'], to: ['founder@example.test'], cc: [], date: PM_NOW, subject: 'Incoming subject', bodyParts: [{ mimeType: 'text/plain', text: 'Can you explain how it works?', truncated: false }] }] }] };
  await threads.applyPage(incoming, null);
  const replay = async () => { for (const event of (await execution.eventsAfter(null)).events) localRepository().applyWorkerEvent(event); };
  await replay();
  const projection = (await threads.getThread(account.id, 'ordinary-thread'))!;
  const draft: AccountReplyDraft = { id: 'ordinary-draft', accountId: account.id, threadId: 'ordinary-thread', mailboxSubject: 'ordinary-mailbox', threadRevision: 1, contextRevision: projection.contextRevision, revision: 1, sender: 'founder@example.test', recipient: 'recipient@example.test', subject: 'Saved reply subject', body: 'Initial saved reply', evidenceIds: ['mail:incoming-1'], generation: 'model', updatedAt: PM_NOW };
  const sql = () => new SqlThreadIntakeRepository({ database: f.db, workspaceId, clock });
  // Explicit starting precondition, not a draft-generation claim.
  await threads.saveReplyDraft(draft, null); sql().saveReplyDraft(draft, null);
  const handler = createWorkerHandler({ auth, host: 'ordinary.example.test' });
  const requests: string[] = [];
  let afterResponse: ((body: unknown) => Promise<void>) | undefined, alterResponse: ((body: unknown) => unknown) | undefined, offline = false;
  const post = (body: unknown, credential = `Bearer ${pairing.credential}`, path = '/reply/draft') => handler({ version: '2.0', rawPath: path, rawQueryString: '', headers: { host: 'ordinary.example.test', 'x-forwarded-proto': 'https', authorization: credential }, body: JSON.stringify(body), requestContext: { domainName: 'ordinary.example.test', http: { method: 'POST', sourceIp: 'synthetic' } } });
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); if (url.origin !== pairing.endpoint || !['/reply/draft', '/commands'].includes(url.pathname) || init?.redirect !== 'error' || init.cache !== 'no-store') throw Error('Unexpected owner operation');
    requests.push(url.pathname); if (offline) throw Error('Synthetic offline');
    const response = await post(JSON.parse(String(init.body)), new Headers(init.headers).get('authorization') ?? '', url.pathname);
    const body = JSON.parse(response.body); await afterResponse?.(body);
    return new Response(JSON.stringify(alterResponse ? alterResponse(body) : body), { status: response.statusCode });
  };
  let runtime: ReturnType<typeof createDelegationRuntime>, api: ReturnType<typeof createCallieApi>, remove: () => void;
  const compose = () => {
    runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) }, pairing, clock, fetch: http });
    const removeOutreach = registerOutreachIpc({ provider: { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://ordinary' });
    const services = createDomainServices({ database: f.db, clock, ids: { next: () => { throw Error('Unexpected ID allocation'); } }, expectedWorkspaceId: workspaceId });
    const removeDaily = registerDailyIpc({ get: async () => services.daily.get() }, url => url === 'app://ordinary');
    remove = () => { removeDaily(); removeOutreach(); };
    api = createCallieApi({ invoke: async (channel, ...args) => { const registered = ipc.handlers.get(channel); if (!registered) throw Error('Missing IPC'); return registered({ senderFrame: { url: 'app://ordinary' } }, ...args); } });
  };
  compose();
  const edit = (body: string, expectedRevision = 1): EditReplyDraft => ({ accountId: account.id, draftId: draft.id, expectedRevision, expectedThreadRevision: 1, expectedContextRevision: draft.contextRevision, subject: 'Edited subject', body });
  return { ...f, auth, pairing, dynamo, execution, threads, draft, incoming, requests, sql, replay, post, edit, options,
    get api() { return api; }, get runtime() { return runtime; },
    setAfterResponse(fn?: typeof afterResponse) { afterResponse = fn; }, setAlterResponse(fn?: typeof alterResponse) { alterResponse = fn; }, setOffline(value: boolean) { offline = value; },
    async incomingNext() { const next = structuredClone(incoming); next.nextCursor.historyId = '2'; next.threads[0]!.messages[0]!.id = 'incoming-2'; next.threads[0]!.messages[0]!.bodyParts[0]!.text = 'One more question about the details.'; await threads.applyPage(next, incoming.nextCursor); await replay(); },
    async restart() { remove(); await runtime.dispose(); closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() }); f.db.raw = reopened.raw; f.db.kysely = reopened.kysely; compose(); },
    async finish() { remove(); await runtime.dispose(); expect(forbidden).not.toHaveBeenCalled(); f.close(); },
  };
}

it('public registered edit changes one canonical draft, preserves received messages, and survives encrypted SQL restart', async () => {
  const f = await ordinaryFixture();
  try {
    const before = await f.api.daily.get(), answer = before.answers.find(a => a.kind === 'reply');
    expect(answer).toMatchObject({ draft: f.draft, thread: { thread: { messages: [{ subject: 'Incoming subject' }] } } });
    expect(f.requests).toEqual([]);
    const saved = await f.api.delegation.editReplyDraft(f.edit('First exact edited body'));
    expect(saved).toMatchObject({ draft: { revision: 2, body: 'First exact edited body', generation: 'edited' }, stale: false, capability: 'held' });
    expect(saved.draft).toEqual({ ...f.draft, subject: 'Edited subject', body: 'First exact edited body', revision: 2, generation: 'edited' });
    expect((await f.threads.getReplyDraft(f.draft.accountId, f.draft.id))?.draft).toEqual(saved.draft);
    const second = await f.api.delegation.editReplyDraft(f.edit('Third revision exact body', 2));
    await f.restart();
    const after = await f.api.daily.get(), restored = after.answers.find(a => a.kind === 'reply');
    expect(restored).toMatchObject({ draft: second.draft });
    expect(restored?.kind === 'reply' && restored.thread).toEqual(answer?.kind === 'reply' && answer.thread);
    for (const prefix of ['DISPATCH_PERMISSION#', 'DISPATCH_APPROVAL#', 'DISPATCH_INTENT#', 'WORK#']) expect(await f.auth.store.list(prefix)).toEqual([]);
    expect(await f.execution.readDispatch(f.draft.accountId, 'anything')).toBeNull();
  } finally { await f.finish(); }
});

it('races different base-revision edits without overwriting and permits an exact acknowledged retry only', async () => {
  const f = await ordinaryFixture();
  try {
    const results = await Promise.allSettled([f.api.delegation.editReplyDraft(f.edit('Winner A')), f.api.delegation.editReplyDraft(f.edit('Winner B'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const saved = f.sql().getReplyDraft(f.draft.accountId, f.draft.id)!.draft;
    expect(saved.revision).toBe(2);
    expect((await f.threads.getReplyDraft(f.draft.accountId, f.draft.id))?.draft).toEqual(saved);
    expect((await f.api.delegation.editReplyDraft(f.edit(saved.body))).draft).toEqual(saved);
    await expect(f.api.delegation.editReplyDraft(f.edit('Different retry'))).rejects.toThrow();
  } finally { await f.finish(); }
});

it('recovers committed lost acknowledgement through exact retry after new inbound and restart without rewriting thread', async () => {
  const f = await ordinaryFixture();
  try {
    f.setAfterResponse(async () => { f.setAfterResponse(); throw Error('Synthetic lost acknowledgement'); });
    await expect(f.api.delegation.editReplyDraft(f.edit('Committed but unacknowledged'))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(f.draft);
    const canonical = (await f.threads.getReplyDraft(f.draft.accountId, f.draft.id))!.draft;
    await f.incomingNext(); await f.restart();
    await expect(f.api.delegation.editReplyDraft(f.edit('Conflicting retry'))).rejects.toThrow();
    const recovered = await f.api.delegation.editReplyDraft(f.edit(canonical.body));
    expect(recovered).toEqual({ draft: canonical, stale: true, capability: 'held' });
    const answer = (await f.api.daily.get()).answers.find(a => a.kind === 'reply');
    expect(answer).toMatchObject({ draft: canonical, stale: true });
    expect(answer?.kind === 'reply' && answer.thread.thread.messages.map(m => m.id)).toEqual(['incoming-1', 'incoming-2']);
    await expect(f.api.delegation.editReplyDraft(f.edit('Cannot rebase', 2))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(canonical);
  } finally { await f.finish(); }
});

it('imports an owner commit when inbound advances between save and SQL acknowledgement', async () => {
  const f = await ordinaryFixture();
  try {
    f.setAfterResponse(async () => { f.setAfterResponse(); await f.incomingNext(); });
    const saved = await f.api.delegation.editReplyDraft(f.edit('Committed before new inbound'));
    expect(saved.stale).toBe(true);
    expect(f.sql().getThread(f.draft.accountId, f.draft.threadId)?.revision).toBe(2);
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(saved.draft);
  } finally { await f.finish(); }
});

it('explicit reconcile recovers a local mirror failure after restart and local Refresh stays offline', async () => {
  const f = await ordinaryFixture();
  try {
    f.db.raw.exec("CREATE TRIGGER ordinary_ack_failure BEFORE UPDATE ON delegated_reply_drafts BEGIN SELECT RAISE(ABORT,'synthetic local write failure'); END");
    await expect(f.api.delegation.editReplyDraft(f.edit('Owner saved while SQL failed'))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft.revision).toBe(1);
    f.db.raw.exec('DROP TRIGGER ordinary_ack_failure'); await f.restart();
    const saved = await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id });
    expect(saved.draft.revision).toBe(2);
    f.setOffline(true); const requests = f.requests.length;
    expect((await f.api.daily.get()).answers).toContainEqual(expect.objectContaining({ draft: saved.draft }));
    expect(f.requests).toHaveLength(requests);
    await expect(f.api.delegation.editReplyDraft(f.edit('Offline update', 2))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(saved.draft);
  } finally { await f.finish(); }
});

it('rejects injected identities, untrusted IPC, stale context, missing drafts and malformed owner acknowledgements', async () => {
  const f = await ordinaryFixture();
  try {
    for (const extra of [{ recipient: 'intruder@example.test' }, { workspaceId: 'other' }, { threadId: 'other' }, { mailboxSubject: 'other' }]) {
      await expect(f.api.delegation.editReplyDraft({ ...f.edit('bad'), ...extra })).rejects.toThrow();
      await expect(ipc.handlers.get('outreach:reply-edit')!({ senderFrame: { url: 'app://ordinary' } }, { ...f.edit('bad'), ...extra })).rejects.toThrow();
    }
    await expect(ipc.handlers.get('outreach:reply-edit')!({ senderFrame: { url: 'https://untrusted.example.test' } }, f.edit('bad'))).rejects.toThrow();
    for (const patch of [{ accountId: 'missing' }, { draftId: 'missing' }, { expectedThreadRevision: 2 }, { expectedContextRevision: 'other' }]) await expect(f.api.delegation.editReplyDraft({ ...f.edit('bad'), ...patch })).rejects.toThrow();
    expect(f.requests).toEqual([]);
    f.setAlterResponse(body => { const result = body as { draft: AccountReplyDraft }; return { ...result, draft: { ...result.draft, recipient: 'wrong@example.test' } }; });
    await expect(f.api.delegation.editReplyDraft(f.edit('Remote commit, malformed response'))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(f.draft);
    f.setAlterResponse();
    expect((await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id })).draft.revision).toBe(2);
    const ownerRequest = { workspaceId: 'foreign', expectedAuthorityGeneration: 1, previousDraft: f.draft, edit: { subject: 'bad', body: 'bad' } };
    expect((await f.post(ownerRequest)).statusCode).not.toBe(200);
    await f.auth.revokePairing(f.pairing.pairingId);
    await expect(f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id })).rejects.toThrow();
  } finally { await f.finish(); }
});

it('an ordinary edit invalidates an old public approval at real unreserved dispatch reservation without sending', async () => {
  const f = await ordinaryFixture();
  try {
    const intentCommandId = randomUUID(), source = f.incoming.threads[0]!.messages[0]!;
    await f.api.delegation.submit({ commandId: randomUUID(), workspaceId: f.options.workspaceId, accountId: f.draft.accountId, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'approve-reply', payload: {
      draft: f.draft, expectedRemoteDraftRevision: 1, approvalId: 'old-approval', actionId: 'old-action', intentCommandId,
      permission: { id: 'explicit-test-permission', sourceMessageId: source.id, sourceMessageHash: fingerprint(source), basis: 'ongoing_correspondence', expiresAt: '2026-09-09T12:00:00.000Z' },
      binding: { kind: 'thread_participant', threadId: f.draft.threadId, sourceMessageId: source.id, sourceMessageHash: fingerprint(source) }, expiresAt: '2026-09-09T12:00:00.000Z',
    } });
    await f.replay();
    const policy = new DynamoDispatchRepository(f.options, new RemoteGoogleAuthorization({ auth: f.auth }));
    const intent = await policy.loadIntent(intentCommandId); expect(intent).not.toBeNull();
    expect(await f.execution.readDispatch(f.draft.accountId, 'old-action')).toMatchObject({ state: 'prepared', reservation: null });
    const permissions = await f.auth.store.list('DISPATCH_PERMISSION#'), approvals = await f.auth.store.list('DISPATCH_APPROVAL#'), intents = await f.auth.store.list('DISPATCH_INTENT#');
    await f.api.delegation.editReplyDraft(f.edit('Text after the separately approved old revision'));
    const reservationOwner = createExecutionRepository({ ...f.options, dispatchPolicy: policy });
    await expect(reservationOwner.reserveDispatch({ ...intent!.action, expectedVersion: await f.execution.currentVersion(f.draft.accountId) })).rejects.toThrow('approval_not_current');
    expect(await f.execution.readDispatch(f.draft.accountId, 'old-action')).toMatchObject({ state: 'prepared', reservation: null });
    expect(await f.auth.store.list('DISPATCH_PERMISSION#')).toEqual(permissions);
    expect(await f.auth.store.list('DISPATCH_APPROVAL#')).toEqual(approvals);
    expect(await f.auth.store.list('DISPATCH_INTENT#')).toEqual(intents);
    expect(f.requests).toEqual(['/commands', '/reply/draft']);
  } finally { await f.finish(); }
});

it('local lifecycle invalidation after owner commit refuses Saved and explicit reconciliation recovers later', async () => {
  const f = await ordinaryFixture();
  try {
    f.runtime.invalidate(true);
    await expect(f.api.delegation.editReplyDraft(f.edit('Locked attempt'))).rejects.toThrow();
    expect(f.requests).toEqual([]);
    f.runtime.invalidate(false);
    f.setAfterResponse(async () => { f.setAfterResponse(); f.runtime.invalidate(true); });
    await expect(f.api.delegation.editReplyDraft(f.edit('Committed before local lock'))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(f.draft);
    f.runtime.invalidate(false);
    const recovered = await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id });
    expect(recovered.draft).toMatchObject({ body: 'Committed before local lock', revision: 2 });
  } finally { await f.finish(); }
});

it('an acknowledged retry refuses a newer different canonical revision before changing the local mirror', async () => {
  const f = await ordinaryFixture();
  try {
    const saved = await f.api.delegation.editReplyDraft(f.edit('Acknowledged revision two'));
    const other = await f.post({ workspaceId: f.options.workspaceId, expectedAuthorityGeneration: 1, previousDraft: saved.draft, edit: { subject: 'Other client subject', body: 'Other client revision three' } });
    expect(other.statusCode).toBe(200);
    await expect(f.api.delegation.editReplyDraft(f.edit(saved.draft.body))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(saved.draft);
    const recovered = await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id });
    expect(recovered.draft).toMatchObject({ revision: 3, body: 'Other client revision three' });
  } finally { await f.finish(); }
});

it('historical canonical recovery after opt-out keeps the draft held and does not permit another edit', async () => {
  const f = await ordinaryFixture();
  try {
    f.setAfterResponse(async () => { f.setAfterResponse(); throw Error('Lost acknowledgement before opt-out'); });
    await expect(f.api.delegation.editReplyDraft(f.edit('Owner commit before opt-out'))).rejects.toThrow();
    const next = structuredClone(f.incoming); next.nextCursor.historyId = '2'; next.threads[0]!.messages[0]!.id = 'optout'; next.threads[0]!.messages[0]!.bodyParts[0]!.text = 'Stop emailing me';
    await f.threads.applyPage(next, f.incoming.nextCursor); await f.replay();
    const recovered = await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id });
    expect(recovered).toMatchObject({ draft: { revision: 2, body: 'Owner commit before opt-out' }, stale: true, capability: 'held' });
    await expect(f.api.delegation.editReplyDraft(f.edit('Must not save on opted-out thread', 2))).rejects.toThrow();
    expect(f.sql().getReplyDraft(f.draft.accountId, f.draft.id)?.draft).toEqual(recovered.draft);
  } finally { await f.finish(); }
});

it('saves maximum-length Unicode draft text twice through the real worker envelope and reconciles without truncation', async () => {
  const f = await ordinaryFixture();
  try {
    const firstBody = '界'.repeat(20000), secondBody = '語'.repeat(20000);
    const first = await f.api.delegation.editReplyDraft(f.edit(firstBody));
    expect(first.draft.body).toBe(firstBody);
    const second = await f.api.delegation.editReplyDraft(f.edit(secondBody, 2));
    expect(second.draft).toMatchObject({ revision: 3, body: secondBody });
    const reconciled = await f.api.delegation.reconcileReplyDraft({ accountId: f.draft.accountId, draftId: f.draft.id });
    expect(reconciled.draft).toEqual(second.draft);
    await f.restart();
    expect((await f.api.daily.get()).answers).toContainEqual(expect.objectContaining({ draft: second.draft }));
    expect((await f.post({ oversized: 'x'.repeat(1024 * 1024) })).statusCode).not.toBe(200);
  } finally { await f.finish(); }
});
