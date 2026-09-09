import { describe, expect, it } from 'vitest';
import { createExecutionRepository, authorityRecordSchema, executionAuthorityKey, executionAuthorityFields } from '../src/executionRepository';
import { DynamoDispatchRepository } from '../src/dispatchRepository';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { WorkerAuth } from '../src/workerAuth';
import { fingerprint, DynamoStore } from '../src/dynamoStore';
import { createCommandService } from '../src/commandService';
import { ScriptedDynamo, row, transaction, ConditionalCommandHarness } from './sdkHarness';
const clock = { now: () => '2026-09-09T00:00:00.000Z' };
const command = { commandId: 'pause-1', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: 2,
  kind: 'pause' as const, payload: { reason: 'Operator pause' } };
const active = { authority: { accountId: 'acct', owner: 'worker', generation: 1, state: 'active' }, version: 2 };
describe('DynamoDB command repository', () => {
  it('atomically CASes authority, immutable command receipt, contiguous durable outbox', async () => {
    const db = new ScriptedDynamo([{}, row(active, 2), {}, transaction]);
    const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    const receipt = await createCommandService(repo).submit(command);
    expect(receipt).toEqual({ commandId: 'pause-1', status: 'applied', authorityGeneration: 1, aggregateVersion: 3, reason: null });
    const tx = db.transactions[0]!;
    expect(tx.TransactItems).toHaveLength(4);
    expect(JSON.stringify(tx)).toContain('attribute_not_exists');
    expect(JSON.stringify(tx)).toContain('#rev = :rev');
    expect(JSON.stringify(tx)).toContain('authority.changed');
    expect(db.reads.every(read => read.ConsistentRead === true)).toBe(true);
  });
  it('fails closed on absent authority rather than implicitly delegating research accounts', async () => {
    const db = new ScriptedDynamo([{}, {}]);
    const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    await expect(repo.applyCommand(command)).rejects.toThrow('authority_missing');
    expect(db.transactions).toHaveLength(0);
  });
  it('rejects unknown command keys before SDK calls', async () => {
    const db = new ScriptedDynamo([]);
    const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    await expect(createCommandService(repo).submit({ ...command, surprise: true })).rejects.toThrow();
    expect(db.commands).toHaveLength(0);
  });
});

it('rejects stale generation before any write', async () => {
  const db = new ScriptedDynamo([{}, row({ ...active, authority: { ...active.authority, generation: 2 } }, 2)]);
  await expect(createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).applyCommand(command)).rejects.toThrow('stale_authority');
  expect(db.transactions).toHaveLength(0);
});
it('does not advance durable cursor past a missing event', async () => {
  const db = new ScriptedDynamo([row({ sequence: 3 }), {}]);
  const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  expect(await repo.eventsAfter(null)).toEqual({ events: [], nextCursor: null, complete: false, headCursor: `${fingerprint('ws')}:3` });
});
it('does not advance durable cursor past an unpublished event', async () => {
  const db = new ScriptedDynamo([row({ sequence: 3 }), row({ published: false, sequence: 1, event: {} })]);
  const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  expect(await repo.eventsAfter(null)).toEqual({ events: [], nextCursor: null, complete: false, headCursor: `${fingerprint('ws')}:3` });
});
it('never resends an existing dispatching action even for identical input', async () => {
  const db = new ScriptedDynamo([row(active, 2), row({ state: 'dispatching' })]);
  const repo = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  await expect(repo.reserveDispatch({ actionId: 'action', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: 2,
    approvalId: 'approval', contentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64) })).rejects.toThrow('action_not_eligible');
  expect(db.transactions).toHaveLength(0);
});

const dispatch = { actionId: 'action', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: 1,
  approvalId: 'approval', contentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64) };
// C1 mechanics-only fixture. C4 dispatchRepository tests exercise the actual persisted
// policy, real grant proof, and produced Dynamo conditions. Never used in production.
class C1MechanicsPolicy extends DynamoDispatchRepository {
  override async reservationPlan() { return { finalize: () => [] }; }
}
async function delegated(db: ConditionalCommandHarness, publish?: (event: import('../../../../src/shared/contracts/delegationContract').WorkerEvent) => Promise<void>) {
  const options = { dynamo: db, tableName: 't', workspaceId: 'ws', clock, publish };
  const dispatchPolicy = new C1MechanicsPolicy(options, new RemoteGoogleAuthorization({ auth: new WorkerAuth(options) }));
  const repo = createExecutionRepository({ ...options, dispatchPolicy });
  await repo.seedLocalAuthority('acct');
  await repo.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0,
    kind: 'delegate', payload: { delegationId: 'approved-delegation', approvedAt: clock.now() } });
  return repo;
}
it('exact replay returns original pause receipt and changed payload conflicts', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const pause = { ...command, expectedVersion: 1 };
  const first = await repo.applyCommand(pause);
  const count = db.transactions.length;
  expect(await repo.applyCommand(pause)).toEqual(first);
  expect(db.transactions).toHaveLength(count);
  await expect(repo.applyCommand({ ...pause, payload: { reason: 'Changed' } })).rejects.toThrow('fingerprint_conflict');
});
it('publishes only committed state and retries publication without repeating mutation after crash', async () => {
  const db = new ConditionalCommandHarness(); let fail = false; const published: string[] = [];
  const repo = await delegated(db, async event => {
    expect(db.inspect('AUTH#acct')).toBeDefined();
    if (fail) throw new Error('publication_crash');
    published.push(event.id);
  });
  fail = true;
  const pause = { ...command, expectedVersion: 1 };
  await expect(repo.applyCommand(pause)).rejects.toThrow('publication_crash');
  expect((await repo.eventsAfter(null)).events).toHaveLength(1);
  const committed = db.transactions.length;
  fail = false;
  expect((await repo.applyCommand(pause)).status).toBe('applied');
  expect(db.transactions.length).toBe(committed + 1); // publication acknowledgement only
  expect((await repo.eventsAfter(null)).events).toHaveLength(2);
  expect(published).toHaveLength(2);
});
it('two contenders construct real authority/action conditions and only one offline reservation wins', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch);
  const results = await Promise.allSettled([repo.reserveDispatch(dispatch), repo.reserveDispatch(dispatch)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const checks = db.transactions.flatMap(tx => tx.TransactItems ?? []).filter(item => item.ConditionCheck);
  expect(JSON.stringify(checks)).toContain('generation');
  expect(JSON.stringify(checks)).toContain('accountId');
  expect(JSON.stringify(checks)).toContain('version');
});
it('late outcome retains reservation generation after revoke and never reactivates authority', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch); const reservation = await repo.reserveDispatch(dispatch);
  await repo.applyCommand({ ...command, kind: 'revoke', expectedVersion: 2 });
  const outcome = { reservation, state: 'provider_accepted' as const, observedAt: clock.now(), evidenceRef: 'provider-receipt' };
  await repo.appendOutcome(outcome); await repo.appendOutcome(outcome);
  const events = (await repo.eventsAfter(null)).events;
  expect(events).toHaveLength(4);
  expect(events[3]).toMatchObject({ authorityGeneration: 1, kind: 'action.outcome', payload: { state: 'provider_accepted' } });
  expect(db.inspect('AUTH#acct')).toMatchObject({ authority: { generation: 2, state: 'revoked', owner: 'worker' } });
  await expect(repo.reserveDispatch({ ...dispatch, expectedAuthorityGeneration: 2, expectedVersion: 4 })).rejects.toThrow('authority_not_active');
});
it('unknown actions cannot be dispatched again or overwritten with a different reservation identity', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch); const reservation = await repo.reserveDispatch(dispatch);
  await repo.appendOutcome({ reservation, state: 'unknown', observedAt: clock.now(), evidenceRef: 'timeout' });
  await expect(repo.reserveDispatch({ ...dispatch, expectedVersion: 3 })).rejects.toThrow('action_not_eligible');
  await expect(repo.appendOutcome({ reservation: { ...reservation, contentHash: 'c'.repeat(64) }, state: 'provider_accepted', observedAt: clock.now(), evidenceRef: 'receipt' })).rejects.toThrow('reservation_identity_conflict');
});
it('an ambiguous reservation commit does not return send eligibility on retry', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch);
  db.afterCommit = () => { throw new Error('transport_lost_after_commit'); };
  await expect(repo.reserveDispatch(dispatch)).rejects.toThrow('transport_lost_after_commit');
  db.afterCommit = undefined;
  await expect(repo.reserveDispatch({ ...dispatch, expectedVersion: 2 })).rejects.toThrow('action_not_eligible');
});
it('manual outcome retains exact channel vocabulary rather than fabricating sent', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.applyCommand({ ...command, expectedVersion: 1, kind: 'manual-outcome', payload: { actionId: 'call', channel: 'call',
    outcome: 'not_called', observedAt: clock.now(), evidenceRef: 'human-report' } });
  expect((await repo.eventsAfter(null)).events[1]).toMatchObject({ kind: 'manual.outcome', payload: { channel: 'call', outcome: 'not_called' } });
});

it('reservation publishes durable dispatching provenance before returning', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch); await repo.reserveDispatch(dispatch);
  expect((await repo.eventsAfter(null)).events[1]).toMatchObject({ kind: 'action.outcome', authorityGeneration: 1, aggregateVersion: 2, payload: { actionId: 'action', state: 'dispatching', evidenceRef: 'approval' } });
});
it('recovers an exact committed command receipt after transaction response loss', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  db.afterCommit = () => { throw new Error('response_lost'); };
  const receipt = await repo.applyCommand({ ...command, expectedVersion: 1 });
  expect(receipt).toMatchObject({ status: 'applied', aggregateVersion: 2 });
  db.afterCommit = undefined;
  expect(await repo.applyCommand({ ...command, expectedVersion: 1 })).toEqual(receipt);
});
it('two same-command contenders replay the same receipt and altered payload loses', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const pause = { ...command, expectedVersion: 1 };
  const receipts = await Promise.all([repo.applyCommand(pause), repo.applyCommand(pause)]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect((await repo.eventsAfter(null)).events).toHaveLength(2);
  await expect(repo.applyCommand({ ...pause, payload: { reason: 'different' } })).rejects.toThrow('fingerprint_conflict');
});
it('refuses a corrupt persisted event head rather than resetting missing sequence to zero', async () => {
  const db = new ScriptedDynamo([row({})]);
  await expect(createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).eventsAfter(null)).rejects.toThrow();
});
it('rejects cross-workspace commands before accessing DynamoDB', async () => {
  const db = new ScriptedDynamo([]);
  await expect(createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).applyCommand({ ...command, workspaceId: 'other' })).rejects.toThrow('workspace_mismatch');
  expect(db.commands).toHaveLength(0);
});
it('drains pending publication in durable sequence without applying commands again', async () => {
  const db = new ConditionalCommandHarness(); let fail = false;
  const repo = await delegated(db, async () => { if (fail) throw new Error('publication_down'); });
  fail = true;
  await expect(repo.applyCommand({ ...command, expectedVersion: 1 })).rejects.toThrow('publication_down');
  fail = false;
  await repo.retryPublications();
  expect((await repo.eventsAfter(null)).events).toHaveLength(2);
  expect(db.inspect('AUTH#acct')).toMatchObject({ version: 2, authority: { state: 'paused' } });
});
it('manual outcome carries command-correlated applied receipt with unchanged payload across replay and restart', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const manual = { ...command, expectedVersion: 1, kind: 'manual-outcome' as const, payload: { actionId: 'linkedin-action', channel: 'linkedin' as const,
    outcome: 'not_sent' as const, observedAt: clock.now(), evidenceRef: 'human-observation' } };
  const receipt = await repo.applyCommand(manual);
  const restarted = createExecutionRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  expect(await restarted.applyCommand(manual)).toEqual(receipt);
  const events = (await restarted.eventsAfter(null)).events;
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ kind: 'manual.outcome', receipt, payload: manual.payload });
  expect(receipt).toMatchObject({ commandId: manual.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2 });
});
it('keeps two prepared identities dispatchable across current version advances', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch);
  const second = { ...dispatch, actionId: 'second' }; await repo.prepareAction(second);
  await repo.reserveDispatch(dispatch);
  await expect(repo.reserveDispatch({ ...second, expectedVersion: 2 })).resolves.toMatchObject({ actionId: 'second', authorityGeneration: 1 });
});
it('preserves prepared approval identity across intervening manual command but rejects changed approval', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db); await repo.prepareAction(dispatch);
  await repo.applyCommand({ ...command, expectedVersion: 1, kind: 'manual-outcome', payload: { actionId: 'call', channel: 'call', outcome: 'not_called', observedAt: clock.now(), evidenceRef: 'human' } });
  await expect(repo.reserveDispatch({ ...dispatch, expectedVersion: 2, approvalId: 'changed' })).rejects.toThrow('action_fingerprint_conflict');
  await expect(repo.reserveDispatch({ ...dispatch, expectedVersion: 2 })).resolves.toMatchObject({ actionId: dispatch.actionId });
});
it('queues atomically and replays only publication after crash without resurrecting or duplicating action', async () => {
  const db = new ConditionalCommandHarness(); let down = false;
  const repo = await delegated(db, async () => { if (down) throw new Error('publisher_down'); });
  await repo.prepareAction(dispatch); down = true;
  await expect(repo.queueAction(dispatch)).rejects.toThrow('publisher_down');
  expect(db.inspect('ACTION#acct#action')).toMatchObject({ state: 'queued' });
  expect(db.inspect('AUTH#acct')).toMatchObject({ version: 2 });
  expect((await repo.eventsAfter(null)).events).toHaveLength(1);
  down = false; await repo.queueAction(dispatch);
  expect((await repo.eventsAfter(null)).events[1]).toMatchObject({ kind: 'action.outcome', aggregateVersion: 2, payload: { state: 'queued', actionId: 'action' } });
  await repo.reserveDispatch({ ...dispatch, expectedVersion: 2 });
  await repo.queueAction(dispatch);
  expect(db.inspect('ACTION#acct#action')).toMatchObject({ state: 'dispatching' });
  expect(db.inspect('AUTH#acct')).toMatchObject({ version: 3 });
});
it('does not put external publication between committed reservation and the sender continuation', async () => {
  const db = new ConditionalCommandHarness(); let down = false; let publicationCalls = 0;
  const repo = await delegated(db, async () => { publicationCalls++; if (down) throw new Error('publisher_down'); });
  await repo.prepareAction(dispatch); down = true;
  const before = publicationCalls; let fictionalSenderCalls = 0;
  const reservation = await repo.reserveDispatch(dispatch);
  fictionalSenderCalls++;
  expect(reservation.state).toBe('dispatching'); expect(fictionalSenderCalls).toBe(1);
  expect(publicationCalls).toBe(before);
  expect(db.inspect('ACTION#acct#action')).toMatchObject({ state: 'dispatching' });
  expect((await repo.eventsAfter(null)).events).toHaveLength(1);
  down = false; await repo.retryPublications();
  expect((await repo.eventsAfter(null)).events[1]).toMatchObject({ payload: { state: 'dispatching' } });
});
it('queue transaction fences authority and prepared state and exact concurrent replay has one event', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db); await repo.prepareAction(dispatch);
  await Promise.all([repo.queueAction(dispatch), repo.queueAction(dispatch)]);
  const events = (await repo.eventsAfter(null)).events;
  expect(events.filter(event => event.kind === 'action.outcome' && event.payload.state === 'queued')).toHaveLength(1);
  const tx = db.transactions.find(transaction => transaction.TransactItems?.some(item => item.Put?.Item?.state?.S === 'queued'))!;
  expect(tx.TransactItems).toHaveLength(4);
  expect(JSON.stringify(tx)).toContain('generation'); expect(JSON.stringify(tx)).toContain('prepared');
  await expect(repo.queueAction({ ...dispatch, targetHash: 'd'.repeat(64) })).rejects.toThrow('action_fingerprint_conflict');
  await expect(repo.queueAction({ ...dispatch, expectedAuthorityGeneration: 2 })).rejects.toThrow('action_fingerprint_conflict');
});
it('pause blocks a fresh queue and dispatch without rewriting the stable prepared identity', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db); await repo.prepareAction(dispatch);
  await repo.applyCommand({ ...command, expectedVersion: 1 });
  await expect(repo.queueAction({ ...dispatch, expectedVersion: 2 })).rejects.toThrow('authority_not_active');
  await expect(repo.reserveDispatch({ ...dispatch, expectedVersion: 2 })).rejects.toThrow('authority_not_active');
  expect(db.inspect('ACTION#acct#action')).toMatchObject({ state: 'prepared', input: { approvalId: dispatch.approvalId, expectedAuthorityGeneration: 1 } });
  expect(db.inspect('ACTION#acct#action')).not.toHaveProperty('input.expectedVersion');
});
it('owner-only command cannot receive fabricated authority receipt from generic C1 applyCommand', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await expect(repo.applyCommand({ commandId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: 1,
    kind: 'submit-approved-reply', payload: { intentCommandId: '22222222-2222-4222-8222-222222222222' } })).rejects.toThrow('owner_command_requires_coordinator');
  expect(db.inspect('AUTH#acct')).toMatchObject({ version: 1 });
  expect((await repo.eventsAfter(null)).events).toHaveLength(1);
});

it('plans one conditional ACTION write without mutating AUTH, outbox or storage', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const current = authorityRecordSchema.parse(db.inspect('AUTH#acct')); const before = db.transactions.length;
  const plan = await repo.planPrepareAction(dispatch, current);
  expect(db.transactions).toHaveLength(before); expect(db.inspect('ACTION#acct#action')).toBeUndefined();
  expect(plan.items).toHaveLength(1); expect(plan.items[0]!.Put?.Item?.sk?.S).toBe('ACTION#acct#action');
  expect(plan.items[0]!.Put?.ConditionExpression).toBe('attribute_not_exists(#pk)');
  expect(plan.preparedAction).toMatchObject({ state: 'prepared', input: { actionId: 'action', expectedAuthorityGeneration: 1 } });
  expect(plan.preparedAction.input).not.toHaveProperty('expectedVersion');
});
it('composes planner action with a single current authority mutation and never duplicates a target', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const store = new DynamoStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  const row = (await store.get(executionAuthorityKey('acct')))!; const current = authorityRecordSchema.parse(row.data);
  const plan = await repo.planPrepareAction(dispatch, current); const next = { ...current, version: current.version + 1 };
  await store.transact([...plan.items, store.put(executionAuthorityKey('acct'), next, row.rev, executionAuthorityFields(next), executionAuthorityFields(current))]);
  expect(await repo.currentVersion('acct')).toBe(2); expect(await repo.readDispatch('acct','action')).toEqual({ state: 'prepared', reservation: null });
  const replay = await repo.planPrepareAction({ ...dispatch, expectedVersion: 2 }, next);
  expect(replay.items).toHaveLength(1); expect(replay.items[0]!.ConditionCheck?.Key?.sk?.S).toBe('ACTION#acct#action');
  expect(replay.items[0]!.Put).toBeUndefined();
  await store.transact(replay.items); expect(await repo.currentVersion('acct')).toBe(2);
});
it('two absent action planners cannot both create an action and stale generation never rebases', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db); const current = authorityRecordSchema.parse(db.inspect('AUTH#acct'));
  const store = new DynamoStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  const [a,b] = await Promise.all([repo.planPrepareAction(dispatch,current),repo.planPrepareAction(dispatch,current)]);
  await store.transact(a.items); await expect(store.transact(b.items)).rejects.toThrow('TransactionCanceledException');
  await expect(repo.planPrepareAction({ ...dispatch, expectedAuthorityGeneration: 0 }, current)).rejects.toThrow('stale_authority');
  await expect(repo.planPrepareAction({ ...dispatch, contentHash: 'c'.repeat(64) }, current)).rejects.toThrow('action_fingerprint_conflict');
  await expect(repo.planPrepareAction(dispatch, { ...current, authority: { ...current.authority, accountId: 'other' } })).rejects.toThrow('authority_identity_conflict');
});
it('planner cannot turn a reserved or unknown identical action back into prepared work', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db); await repo.prepareAction(dispatch);
  const reservation = await repo.reserveDispatch(dispatch);
  await expect(repo.planPrepareAction({ ...dispatch, expectedVersion: 2 }, authorityRecordSchema.parse(db.inspect('AUTH#acct')))).rejects.toThrow('action_not_eligible');
  await repo.appendOutcome({ reservation, state: 'unknown', observedAt: clock.now(), evidenceRef: 'uncertain' });
  await expect(repo.planPrepareAction({ ...dispatch, expectedVersion: 3 }, authorityRecordSchema.parse(db.inspect('AUTH#acct')))).rejects.toThrow('action_not_eligible');
});
it('existing prepareAction uses the same plan and preserves an identical queued record', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  await repo.prepareAction(dispatch); await repo.prepareAction(dispatch);
  expect(db.transactions.at(-1)?.TransactItems).toHaveLength(2);
  expect(db.transactions.at(-1)?.TransactItems?.every(item => item.ConditionCheck)).toBe(true);
  await repo.queueAction(dispatch);
  const before = db.inspect('ACTION#acct#action');
  await repo.prepareAction({ ...dispatch, expectedVersion: 2 });
  expect(db.inspect('ACTION#acct#action')).toEqual(before); expect(await repo.currentVersion('acct')).toBe(2);
  await expect(repo.planPrepareAction(dispatch, authorityRecordSchema.parse(db.inspect('AUTH#acct')))).rejects.toThrow('stale_authority');
});
it('planner denies missing/inactive ownership and caller AUTH CAS blocks a concurrent pause', async () => {
  const db = new ConditionalCommandHarness(); const repo = await delegated(db);
  const store = new DynamoStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  const row = (await store.get('AUTH#acct'))!; const current = authorityRecordSchema.parse(row.data);
  await expect(repo.planPrepareAction(dispatch, { ...current, authority: { ...current.authority, state: 'paused' } })).rejects.toThrow('authority_not_active');
  const plan = await repo.planPrepareAction(dispatch,current);
  await repo.applyCommand({ ...command, expectedVersion: 1 });
  await expect(store.transact([store.check('AUTH#acct',row.rev,executionAuthorityFields(current)), ...plan.items])).rejects.toThrow('TransactionCanceledException');
  expect(await repo.readDispatch('acct','action')).toBeNull();
});
