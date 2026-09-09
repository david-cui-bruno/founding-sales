import { describe, expect, it } from 'vitest';
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
const checkpoint = { version: 1, accountId: 'acct', mailboxSubject: 'mailbox', mode: 'history', historyId: '2', pageToken: null, since: '2026-09-09T00:00:00.000Z' };
const poll = { attemptId: 'attempt', accountId: 'acct', mailboxSubject: 'mailbox', status: 'complete', startedAt: '2026-09-09T00:03:00.000Z', completedAt: '2026-09-09T00:03:30.000Z' };
describe('persisted intake barrier', () => {
  it('requires registry and durable completed checkpoint', async () => {
    const { barrier } = await setup();
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
  it('returns revision conditions for both registry and completed poll', async () => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { checkpoint, poll }, null)]);
    const result = await barrier.check(subject, new AbortController().signal);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.checks.map(item => item.ConditionCheck?.Key?.sk?.S)).toEqual([intakeRegistryKey('acct'), mailCursorKey('acct', 'mailbox')]);
    expect(result.revisions).toEqual([{ key: intakeRegistryKey('acct'), revision: 1 }, { key: mailCursorKey('acct', 'mailbox'), revision: 1 }]);
  });
  it.each(['pending', 'failed'])('never reuses a prior checkpoint after %s poll', async status => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { checkpoint, poll: { ...poll, status, completedAt: status === 'pending' ? null : poll.completedAt } }, null)]);
    expect((await barrier.check(subject, new AbortController().signal)).status).toBe('blocked');
  });
  it.each(['2026-09-08T23:59:00.000Z', '2026-09-09T00:05:00.000Z'])('rejects stale or future intake %s', async completedAt => {
    const { barrier, store } = await setup();
    await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { checkpoint, poll: { ...poll, startedAt: completedAt, completedAt } }, null)]);
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
  await store.transact([store.put(mailCursorKey('acct', 'mailbox'), { checkpoint, poll }, null),
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
