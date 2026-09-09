import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import { createIntakeBarrier, intakeRegistryKey } from '../src/intakeBarrier';
import { mailCursorKey } from '../src/threadIntakeRepository';

const now = '2026-09-09T00:04:00.000Z';
const subject = { accountId: 'acct', mailboxSubject: 'mailbox' };
async function setup() {
  const db = new ConditionalCommandHarness();
  const store = new DynamoStore({ dynamo: db, workspaceId: 'ws', tableName: 't', clock: { now: () => now } });
  await store.transact([store.put(intakeRegistryKey('acct'), { accountId: 'acct', adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'mailbox' }], manualDependencies: [] }, null)]);
  return { db, store, barrier: createIntakeBarrier(store) };
}
const scope = { version: 1 as const, accountId: 'acct', mailboxSubject: 'mailbox', revision: 1, participantAddresses: ['recipient@example.invalid'], knownThreadIds: ['thread1'], since: '2026-09-09T00:00:00.000Z', approvedAt: now };
const scopeBinding = { scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) };
const checkpoint = { ...scopeBinding, version: 1, accountId: 'acct', mailboxSubject: 'mailbox', mode: 'history', historyId: '2', pageToken: null, since: '2026-09-09T00:00:00.000Z' };
const poll = { ...scopeBinding, attemptId: 'attempt', accountId: 'acct', mailboxSubject: 'mailbox', status: 'complete', startedAt: '2026-09-09T00:03:00.000Z', completedAt: '2026-09-09T00:03:30.000Z' };
describe('persisted intake barrier', () => {
  it('requires registry and durable completed checkpoint', async () => {
    const { barrier } = await setup();
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
  it('returns revision conditions for both registry and completed poll', async () => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { scope, checkpoint, poll }, null)]);
    const result = await barrier.check(subject, new AbortController().signal);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.checks.map(item => item.ConditionCheck?.Key?.sk?.S)).toEqual([intakeRegistryKey('acct'), mailCursorKey('acct', 'mailbox')]);
    expect(result.revisions).toEqual([{ key: intakeRegistryKey('acct'), revision: 1 }, { key: mailCursorKey('acct', 'mailbox'), revision: 1 }]);
  });
  it.each(['pending', 'failed'])('never reuses a prior checkpoint after %s poll', async status => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { scope, checkpoint, poll: { ...poll, status, completedAt: status === 'pending' ? null : poll.completedAt } }, null)]);
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
  it.each(['2026-09-08T23:59:00.000Z', '2026-09-09T00:05:00.000Z'])('rejects stale or future intake %s', async completedAt => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { scope, checkpoint, poll: { ...poll, startedAt: completedAt, completedAt } }, null)]);
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
  it('holds unknown relevant adapters and unacknowledged manual dependencies', async () => {
    const { barrier, store } = await setup();
    await store.transact([store.put(intakeRegistryKey('acct'), { accountId: 'acct', adapters: [{ id: 'other', kind: 'unknown', enabled: true, relevant: true, mailboxSubject: null }], manualDependencies: [] }, 1)]);
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
});

import { createExecutionRepository } from '../src/executionRepository';
it.each(['human_reported_sent', 'unknown'])('manual dependency requires matching committed non-unknown receipt: %s', async outcome => {
  const { store, barrier } = await setup();
  const execution = createExecutionRepository(store.options);
  await execution.seedLocalAuthority('acct');
  await execution.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'explicit', approvedAt: now } });
  await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { scope, checkpoint, poll }, null),
    store.put(intakeRegistryKey('acct'), { accountId: 'acct', adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'mailbox' }], manualDependencies: [{ commandId: 'manual', actionId: 'linkedin', channel: 'linkedin', outcome }] }, 1)]);
  expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  await execution.applyCommand({ commandId: 'manual', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'manual-outcome', payload: { actionId: 'linkedin', channel: 'linkedin', outcome: outcome as 'human_reported_sent' | 'unknown', observedAt: now, evidenceRef: 'operator-observation' } });
  const result = await barrier.check(subject, new AbortController().signal);
  expect(result.status).toBe(outcome === 'unknown' ? 'blocked' : 'ready');
  if (result.status === 'ready') {
    expect(result.revisions.map(item => item.key)).toContain('COMMAND#manual');
    expect(result.revisions.map(item => item.key)).toContain('EVENT#0000000000000002');
  }
});
it('abort and missing adapter registry cannot imply inbox freshness', async () => {
  const { barrier } = await setup();
  const signal = AbortSignal.abort();
  expect((await barrier.check(subject, signal)).status).toBe('blocked');
  expect((await barrier.check({ ...subject, accountId: 'missing' }, new AbortController().signal)).status).toBe('blocked');
});

import { dispatchFixture } from './dispatchFixture';
import { createSendReconciler } from '../src/sendReconciler';

it.each(['dispatch', 'reconcile'] as const)('%s passes caller cancellation into actual expired C2 OAuth refresh', async operation => {
  const f = await dispatchFixture();
  if (operation === 'reconcile') { f.onSend(async () => { throw new Error('timeout'); }); await f.service().dispatch(f.intent.commandId); }
  f.advance('2026-09-09T02:00:00.000Z');
  const controller = new AbortController(); let aborted = false; let refreshes = 0;
  f.onOAuthFetch(async (url, init) => {
    expect(String(url)).toBe('https://oauth2.googleapis.com/token'); refreshes++;
    return new Promise<Response>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fictional refresh deadline')), 30);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timeout); aborted = true; reject(new Error('cancelled')); }, { once: true });
      queueMicrotask(() => controller.abort());
    });
  });
  if (operation === 'dispatch') expect((await f.service().dispatch(f.intent.commandId, controller.signal)).status).toBe('held');
  else {
    const lookup = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: async () => { throw new Error('lookup after cancellation'); } });
    expect((await lookup.reconcileSend(f.intent.commandId, controller.signal)).status).toBe('unknown');
  }
  expect(refreshes).toBe(1); expect(aborted).toBe(true);
  expect(f.sends()).toBe(operation === 'dispatch' ? 0 : 1);
  if (operation === 'dispatch') expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it('caller cancellation after credential read prevents any reservation or send', async () => {
  const f = await dispatchFixture(); const controller = new AbortController();
  const original = f.authorization.authorizedAccess.bind(f.authorization);
  vi.spyOn(f.authorization, 'authorizedAccess').mockImplementation(async (...args) => {
    const result = await original(...args); if (args[1].includes('send')) controller.abort(); return result;
  });
  expect((await f.service().dispatch(f.intent.commandId, controller.signal)).status).toBe('held');
  expect(f.sends()).toBe(0); expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it('cancellation during actual final reservation planning refuses ACTION and cap transaction', async () => {
  const f = await dispatchFixture(); const controller = new AbortController();
  const original = f.policy.reservationPlan.bind(f.policy);
  vi.spyOn(f.policy, 'reservationPlan').mockImplementation(async (...args) => {
    const plan = await original(...args); controller.abort(); return plan;
  });
  await expect(f.execution.reserveDispatch({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence, controller.signal)).rejects.toThrow();
  expect((await f.execution.readDispatch('acct', f.intent.action.actionId))?.state).toBe('prepared');
  expect(f.dynamo.inspect('DISPATCH_CAP#sender%40example.invalid#2026-09-09')).toBeUndefined();
});
it('already cancelled dispatch performs no new intake, grant, reservation or provider work', async () => {
  const f = await dispatchFixture(); const controller = new AbortController(); controller.abort();
  const transactions = f.dynamo.transactions.length;
  expect((await f.service().dispatch(f.intent.commandId, controller.signal)).status).toBe('held');
  expect(f.dynamo.transactions).toHaveLength(transactions); expect(f.sends()).toBe(0);
});
it('caller cancellation reaches cooperative Sent lookup and preserves unknown evidence without resend', async () => {
  const f = await dispatchFixture(); f.onSend(async () => { throw new Error('timeout'); }); await f.service().dispatch(f.intent.commandId);
  const original = await f.policy.sendEvidence(f.intent.commandId); const controller = new AbortController(); let aborted = false;
  const lookup = createSendReconciler({ execution: f.execution, policy: f.policy, authorization: f.authorization, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('fictional lookup deadline')), 30);
    init?.signal?.addEventListener('abort', () => { clearTimeout(deadline); aborted = true; reject(new Error('cancelled')); }, { once: true });
    queueMicrotask(() => controller.abort());
  }) });
  expect((await lookup.reconcileSend(f.intent.commandId, controller.signal)).status).toBe('unknown');
  expect(aborted).toBe(true); expect(await f.policy.sendEvidence(f.intent.commandId)).toEqual(original); expect(f.sends()).toBe(1);
});
