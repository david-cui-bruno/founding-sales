import { describe, expect, it } from 'vitest';
import { createDiscoveryReservationStore } from '../src/discoveryReservationStore';
import { ScriptedDynamo, row, transaction, ConditionalCommandHarness } from './sdkHarness';
const clock = { now: () => '2026-09-09T00:00:00.000Z' };
const input = { commandId: '00000000-0000-4000-a000-000000000001', workspaceId: 'ws', budgetId: 'approved', inputFingerprint: 'a'.repeat(64), searchCostMicros: 20, modelCostMicros: 30 };
describe('pre-account discovery budget', () => {
  it('reserves cumulative cost with budget CAS and immutable receipt in one transaction', async () => {
    const db = new ScriptedDynamo([{}, row({ limit: 100, spent: 25, approvedAt: clock.now() }, 2), transaction]);
    const store = createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    expect(await store.reserveOnce(input)).toEqual({ status: 'reserved' });
    const tx = db.transactions[0]!;
    expect(tx.TransactItems).toHaveLength(2);
    expect(JSON.stringify(tx)).toContain('#rev = :rev');
    expect(JSON.stringify(tx)).toContain('75');
    expect(JSON.stringify(tx)).not.toContain('ACCOUNT#');
  });
  it('refuses another UUID when cumulative approved budget is exhausted', async () => {
    const db = new ScriptedDynamo([{}, row({ limit: 100, spent: 80, approvedAt: clock.now() })]);
    expect(await createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).reserveOnce(input)).toEqual({ status: 'denied' });
    expect(db.transactions).toHaveLength(0);
  });
  it('fails closed without approved persisted budget', async () => {
    const db = new ScriptedDynamo([{}, {}]);
    expect(await createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).reserveOnce(input)).toEqual({ status: 'denied' });
  });
});
it('uncertain prior reservation replays with null candidates and never reserves twice', async () => {
  const db = new ScriptedDynamo([row({ ...input, reserved: 50, candidates: null, costMicros: null, completed: false })]);
  expect(await createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).reserveOnce(input)).toEqual({ status: 'replay', candidates: null });
  expect(db.transactions).toHaveLength(0);
});
it('conflicts on changed fingerprint or budget under same command ID', async () => {
  const db = new ScriptedDynamo([row({ ...input, inputFingerprint: 'b'.repeat(64), reserved: 50, candidates: null, costMicros: null, completed: false })]);
  await expect(createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock }).reserveOnce(input)).rejects.toThrow('fingerprint_conflict');
});
it('persists completed candidates without refunding unknown spend', async () => {
  const db = new ScriptedDynamo([row({ ...input, reserved: 50, candidates: null, costMicros: null, completed: false }), transaction]);
  const store = createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  await store.complete({ commandId: input.commandId, workspaceId: 'ws', budgetId: 'approved', inputFingerprint: input.inputFingerprint,
    candidates: [{ name: 'Fictional PM', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }], costMicros: null });
  expect(db.transactions[0]!.TransactItems).toHaveLength(1);
  expect(JSON.stringify(db.transactions[0])).toContain('Fictional PM');
  expect(JSON.stringify(db.transactions[0])).not.toContain('BUDGET#');
});

import { createCompanyPreparation, discoveryInputFingerprint } from '../../../../src/main/research/companyResearchWorker';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
it('two UUIDs cannot concurrently overdraw one approved budget using actual CAS requests', async () => {
  const db = new ConditionalCommandHarness(); const store = createDiscoveryReservationStore({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  await store.approveBudget({ budgetId: 'approved', limitMicros: 75 });
  const results = await Promise.allSettled([store.reserveOnce(input), store.reserveOnce({ ...input, commandId: '00000000-0000-4000-a000-000000000002' })]);
  expect(results.filter(result => result.status === 'fulfilled' && result.value.status === 'reserved')).toHaveLength(1);
  expect(db.inspect('BUDGET#discovery#approved')).toMatchObject({ spent: 50 });
  expect(await store.reserveOnce({ ...input, commandId: '00000000-0000-4000-a000-000000000003' })).toEqual({ status: 'denied' });
});
it('uncertain commit never grants HTTP and completed candidates survive repository restart', async () => {
  const db = new ConditionalCommandHarness(); const options = { dynamo: db, tableName: 't', workspaceId: 'ws', clock };
  const store = createDiscoveryReservationStore(options);
  await store.approveBudget({ budgetId: 'approved', limitMicros: 100 });
  db.afterCommit = () => { throw new Error('lost-response'); };
  expect(await store.reserveOnce(input)).toEqual({ status: 'replay', candidates: null });
  db.afterCommit = undefined;
  const candidates = [{ name: 'Fictional', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }];
  await store.complete({ commandId: input.commandId, workspaceId: input.workspaceId, budgetId: input.budgetId, inputFingerprint: input.inputFingerprint, candidates, costMicros: 10 });
  const restarted = createDiscoveryReservationStore(options);
  expect(await restarted.reserveOnce(input)).toEqual({ status: 'replay', candidates });
  expect(db.inspect('BUDGET#discovery#approved')).toMatchObject({ spent: 10 });
  await restarted.complete({ commandId: input.commandId, workspaceId: input.workspaceId, budgetId: input.budgetId, inputFingerprint: input.inputFingerprint, candidates, costMicros: 10 });
  expect(db.inspect('BUDGET#discovery#approved')).toMatchObject({ spent: 10 });
});
it('B2 preparation resumes durable candidates before idempotent account creation with no provider HTTP', async () => {
  const db = new ConditionalCommandHarness(); const options = { dynamo: db, tableName: 't', workspaceId: 'ws', clock };
  const reservations = createDiscoveryReservationStore(options); const accounts = createWorkerAccountRepository(options);
  await reservations.approveBudget({ budgetId: 'approved', limitMicros: 100 });
  const limits = { maxCompanies: 2, maxPages: 1, maxBytes: 20000, maxCostMicros: 50 };
  const configuration = { workspaceId: 'ws', budgetId: 'approved', audience: { residential: true, regions: ['Fictional Region'], terms: ['residential PM'] },
    discoveryLimits: limits, researchLimits: limits, capability: { model: 'fixture', webSearch: true as const, searchCostMicros: 20, modelCostMicros: 30 } };
  const identity = { ...input, inputFingerprint: discoveryInputFingerprint(configuration) };
  expect(await reservations.reserveOnce(identity)).toEqual({ status: 'reserved' });
  let calls = 0;
  const preparation = createCompanyPreparation({ configuration, store: accounts, reservations,
    discovery: { discover: async () => { calls++; throw new Error('no repeated HTTP'); } } });
  expect(await preparation.prepare(input.commandId, new AbortController().signal)).toEqual({ status: 'blocked', accountIds: [] });
  await reservations.complete({ commandId: identity.commandId, workspaceId: 'ws', budgetId: 'approved', inputFingerprint: identity.inputFingerprint,
    candidates: [{ name: 'Fictional PM', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }], costMicros: null });
  expect(await accounts.listCandidates(clock.now())).toHaveLength(0);
  const first = await preparation.prepare(input.commandId, new AbortController().signal);
  expect(first.status).toBe('prepared'); expect(first.accountIds).toHaveLength(1);
  expect(await preparation.prepare(input.commandId, new AbortController().signal)).toEqual(first);
  expect(calls).toBe(0); expect(await accounts.listCandidates(clock.now())).toHaveLength(1);
  expect(db.inspect('BUDGET#discovery#approved')).toMatchObject({ spent: 50 });
  expect(db.inspect(`AUTH#${first.accountIds[0]}`)).toBeUndefined();
});
