import { describe, expect, it } from 'vitest';
import { createWorkerAccountRepository, selectedRecordRefreshRejections, isSelectedRecordRefreshRejection } from '../src/workerAccountRepository';
import { ScriptedDynamo, row, transaction, ConditionalCommandHarness } from './sdkHarness';
import { rankAccount } from '../../../../src/shared/accounts/accountRanking';
import { projectAccountEvidence } from '../../../../src/main/domain/accounts/accountEvidence';
const clock = { now: () => '2026-09-09T00:00:00.000Z' };
const id = '00000000-0000-4000-a000-000000000001';
const account = { id: 'acct', name: 'Fictional PM', domain: 'fictional.example', version: 1 };
const state = { account, history: [{ at: clock.now(), account, claims: [], routes: [] }], sources: [], claims: [], routes: [], researchRevision: 1 };
describe('remote account research binding', () => {
  it('creates account, receipt and research event atomically without execution authority', async () => {
    const db = new ScriptedDynamo([{}, {}, transaction]);
    const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    const created = await store.create({ commandId: id, name: account.name, domain: account.domain });
    expect(created.version).toBe(1);
    const tx = JSON.stringify(db.transactions[0]);
    expect(tx).toContain('research.created');
    expect(tx).not.toContain('authority.changed');
    expect(tx).not.toContain('AUTH#');
    expect(db.transactions[0]!.TransactItems).toHaveLength(5);
  });
  it('uses shared projection and ranking unchanged', async () => {
    const db = new ScriptedDynamo([row(state)]);
    const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    const snapshot = await store.snapshot('acct', clock.now());
    const shared = projectAccountEvidence(account, [], []);
    expect(snapshot).toEqual(shared);
    expect(rankAccount(snapshot, clock.now())).toEqual(rankAccount(shared, clock.now()));
  });
  it('rejects model permitted true without trusted fetched-source receipt', async () => {
    const db = new ScriptedDynamo([{}, {}, row(state), {}]);
    const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
    await expect(store.admitEvidence({ commandId: id, accountId: 'acct', expectedVersion: 1, claims: [], routes: [],
      sources: [{ id: 'source', url: 'https://fictional.example/about', fetchedAt: clock.now(), sha256: 'a'.repeat(64), excerpt: 'Fictional', permitted: true }] })).rejects.toThrow('source_attestation_required');
    expect(db.transactions).toHaveLength(0);
  });
});

const limits = { maxCompanies: 2, maxPages: 2, maxBytes: 20000, maxCostMicros: 100 };
const job = { id, accountId: 'acct', limits, attempt: 1, claimToken: 'token', receiptCommandId: id, receiptCommitted: false, costMicros: null,
  state: 'running', reservedCost: 100, claimedAt: clock.now() };
it('fences reserved evidence admission before receipt replay or mutation', async () => {
  const db = new ScriptedDynamo([row(job)]);
  const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  await expect(store.admitEvidence({ commandId: id, accountId: 'acct', expectedVersion: 1, sources: [], claims: [], routes: [] },
    { jobId: id, claimToken: 'stale' })).rejects.toThrow('research_claim_fenced');
  expect(db.transactions).toHaveLength(0);
});
it('atomically commits account evidence and exact job-token receipt pointer', async () => {
  const db = new ScriptedDynamo([row(job), {}, row(state), {}, transaction]);
  const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  expect(await store.admitEvidence({ commandId: id, accountId: 'acct', expectedVersion: 1, sources: [], claims: [], routes: [] },
    { jobId: id, claimToken: 'token' })).toEqual({ accountId: 'acct', version: 2, duplicate: false });
  const tx = JSON.stringify(db.transactions[0]);
  expect(tx).toContain('claimToken');
  expect(tx).toContain('token');
  expect(tx).toContain('receiptCommitted');
  expect(tx).toContain('research.evidence');
  expect(db.transactions[0]!.TransactItems).toHaveLength(5);
});

import { createCompanyResearchWorker } from '../../../../src/main/research/companyResearchWorker';
async function researchFixture() {
  const db = new ConditionalCommandHarness();
  const options = { dynamo: db, tableName: 't', workspaceId: 'ws', clock };
  const store = createWorkerAccountRepository(options);
  const account = await store.create({ commandId: id, name: 'Fictional PM', domain: 'fictional.example' });
  await store.approveResearchBudget(100);
  const commandId = '00000000-0000-4000-a000-000000000002';
  await store.enqueue({ commandId, accountId: account.id, limits });
  return { db, store, options, account, commandId };
}
it('runs B2 receipt-first restart through real SDK construction without repeated provider or budget charge', async () => {
  const f = await researchFixture(); const job = (await f.store.claimNext(clock.now()))!;
  expect(job.receiptCommitted).toBe(false);
  await f.store.admitEvidence({ commandId: job.receiptCommandId, accountId: f.account.id, expectedVersion: 1, sources: [], claims: [], routes: [] },
    { jobId: job.id, claimToken: job.claimToken });
  const restarted = createWorkerAccountRepository(f.options);
  let calls = 0;
  const worker = createCompanyResearchWorker({ store: restarted, clock, pages: { research: async () => { calls++; throw new Error('provider repeat'); } } });
  expect(await worker.runNext(new AbortController().signal)).toBe('completed');
  expect(calls).toBe(0);
  expect(f.db.inspect('BUDGET#research')).toMatchObject({ spent: 100 });
  expect((await restarted.snapshot(f.account.id, clock.now())).account.version).toBe(2);
  expect(await worker.runNext(new AbortController().signal)).toBe('idle');
  expect(f.db.inspect(`AUTH#${f.account.id}`)).toBeUndefined();
});
it('persists same-account trusted sources and retains contradictory portfolio evidence', async () => {
  const f = await researchFixture();
  const source = { id: 'fetched', url: 'https://fictional.example/', fetchedAt: clock.now(), sha256: 'a'.repeat(64), excerpt: 'We manage residential properties.', permitted: true };
  await f.store.recordFetchedSource({ accountId: f.account.id, source });
  const job = (await f.store.claimNext(clock.now()))!;
  const batch = { commandId: job.receiptCommandId, accountId: f.account.id, expectedVersion: 1, sources: [source], routes: [], claims: [
    { key: 'portfolio' as const, kind: 'fact' as const, value: { count: 240, measure: 'units' as const, scope: 'managed' as const }, evidenceIds: [source.id] },
    { key: 'portfolio' as const, kind: 'fact' as const, value: { count: 300, measure: 'units' as const, scope: 'managed' as const }, evidenceIds: [source.id] },
  ] };
  await f.store.admitEvidence(batch, { jobId: job.id, claimToken: job.claimToken });
  const snapshot = await f.store.snapshot(f.account.id, clock.now());
  expect(snapshot.portfolio).toHaveLength(2); expect(snapshot.conflicts).toEqual(['portfolio:managed:units']);
  expect(await f.store.admitEvidence(batch, { jobId: job.id, claimToken: job.claimToken })).toMatchObject({ duplicate: true, version: 2 });
});
it('reserves a job command ID against non-evidence create receipts', async () => {
  const f = await researchFixture();
  await expect(f.store.create({ commandId: f.commandId, name: 'Wrong account', domain: null })).rejects.toThrow();
});
it('retains unknown spend, caps attempts across UUIDs, and parks stale jobs without reclaiming HTTP', async () => {
  const f = await researchFixture(); const job = (await f.store.claimNext(clock.now()))!;
  await expect(f.store.settle({ jobId: job.id, claimToken: 'wrong', status: 'parked', receiptCommandId: null, costMicros: null })).rejects.toThrow('research_claim_fenced');
  expect(await f.store.claimNext('2026-09-09T00:10:00.000Z')).toBeNull();
  expect(f.db.inspect(`JOB#${job.id}`)).toMatchObject({ state: 'parked', reservedCost: 100, costMicros: null });
  for (const suffix of ['3', '4']) await f.store.enqueue({ commandId: `00000000-0000-4000-a000-00000000000${suffix}`, accountId: f.account.id, limits });
  await expect(f.store.enqueue({ commandId: '00000000-0000-4000-a000-000000000005', accountId: f.account.id, limits })).rejects.toThrow('attempt_limit');
  expect(await f.store.claimNext(clock.now())).toBeNull();
  await expect(f.store.admitEvidence({ commandId: job.id, accountId: f.account.id, expectedVersion: 1, sources: [], claims: [], routes: [] },
    { jobId: job.id, claimToken: job.claimToken })).rejects.toThrow('research_claim_fenced');
});
it('fences a concurrent unclaimed evidence admission against newly reserved job identity', async () => {
  const f = await researchFixture();
  const fresh = '00000000-0000-4000-a000-000000000009';
  // The two operations both read absence, then their transaction conditions decide.
  const results = await Promise.allSettled([
    f.store.admitEvidence({ commandId: fresh, accountId: f.account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }),
    f.store.enqueue({ commandId: fresh, accountId: f.account.id, limits }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});
it('cannot invent a research receipt when parking uncommitted work', async () => {
  const f = await researchFixture(); const job = (await f.store.claimNext(clock.now()))!;
  await expect(f.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: job.id, costMicros: null })).rejects.toThrow('research_receipt_conflict');
});
it('completed settlement replay requires the original receipt identity', async () => {
  const f = await researchFixture(); const job = (await f.store.claimNext(clock.now()))!;
  await f.store.admitEvidence({ commandId: job.id, accountId: f.account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }, { jobId: job.id, claimToken: job.claimToken });
  await f.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: job.id, costMicros: null });
  await expect(f.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: null, costMicros: null })).rejects.toThrow();
});
it('skips an unaffordable queued head without releasing reservations or starving affordable work', async () => {
  const db = new ConditionalCommandHarness();
  const store = createWorkerAccountRepository({ dynamo: db, tableName: 't', workspaceId: 'ws', clock });
  const account = await store.create({ commandId: id, name: 'Fictional PM', domain: null });
  await store.approveResearchBudget(100);
  const expensive = '00000000-0000-4000-a000-000000000002';
  const affordable = '00000000-0000-4000-a000-000000000003';
  await store.enqueue({ commandId: expensive, accountId: account.id, limits: { ...limits, maxCostMicros: 101 } });
  await store.enqueue({ commandId: affordable, accountId: account.id, limits: { ...limits, maxCostMicros: 50 } });
  const claimed = await store.claimNext(clock.now());
  expect(claimed).toMatchObject({ id: affordable, attempt: 1, receiptCommitted: false });
  expect(db.inspect(`JOB#${expensive}`)).toMatchObject({ state: 'queued', reservedCost: 0 });
  expect(db.inspect('BUDGET#research')).toMatchObject({ spent: 50 });
  expect(await store.claimNext(clock.now())).toBeNull();
});

import { DynamoStore, fingerprint } from '../src/dynamoStore';
import type { AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
import type { AccountRoute } from '../../../../src/shared/contracts/accountContract';
/** The owner resubmits its saved record after a local admission. The worker plans an atomic
 * ACCOUNT# replacement for the coordinator's receipt transaction and refuses with one exact code. */
describe('owner-resubmitted saved record', () => {
  const later = '2026-09-09T00:01:00.000Z';
  const source = { id: 'source', url: 'https://fictional.example/team', fetchedAt: clock.now(), sha256: 'a'.repeat(64), excerpt: 'Fictional published phone', permitted: true };
  const seeded: AccountRoute = { id: 'route-1', accountId: 'acct', personId: null, channel: 'phone', value: '+12025550101', version: 1, purpose: 'business', verification: 'published', evidenceIds: ['source'] };
  const admitted: AccountRoute = { ...seeded, id: 'route-2', value: '+12025550102' };
  const stored: AccountRecord = { account: { ...account, version: 2 }, sources: [source], claims: [], routes: [seeded], researchRevision: 1,
    history: [{ at: clock.now(), account, claims: [], routes: [] }, { at: clock.now(), account: { ...account, version: 2 }, claims: [], routes: [seeded] }] };
  const appended: AccountRecord = { ...stored, account: { ...account, version: 3 }, routes: [seeded, admitted],
    history: [...stored.history, { at: later, account: { ...account, version: 3 }, claims: [], routes: [seeded, admitted] }] };
  async function refreshFixture(record: AccountRecord | null = stored) {
    const db = new ConditionalCommandHarness();
    const options = { dynamo: db, tableName: 't', workspaceId: 'ws', clock };
    const raw = new DynamoStore(options);
    if (record) await raw.transact([raw.put('ACCOUNT#acct', record, null, { accountId: 'acct', version: record.account.version })]);
    return { db, raw, store: createWorkerAccountRepository(options) };
  }
  it('plans one rev-checked ACCOUNT# replacement for an appended history and no write for the equal record', async () => {
    const f = await refreshFixture();
    const plan = await f.store.refreshRecord({ accountId: 'acct', record: appended, expectedResearchRevision: 1 });
    expect(plan.duplicate).toBe(false);
    expect(plan.items).toHaveLength(1);
    const put = plan.items[0]!.Put!;
    expect(put.Item!.sk).toEqual({ S: 'ACCOUNT#acct' });
    expect(JSON.parse(put.Item!.data!.S!)).toEqual(appended);
    expect(put.ConditionExpression).toContain('#rev = :rev');
    expect(put.ExpressionAttributeValues).toMatchObject({ ':rev': { N: '1' }, ':f1': { N: '2' } });
    // Planning writes nothing: the coordinator commits the plan together with its receipt.
    expect(f.db.inspect('ACCOUNT#acct')).toEqual(stored);
    expect(f.db.transactions).toHaveLength(1);
    await f.raw.transact(plan.items);
    expect(f.db.inspect('ACCOUNT#acct')).toEqual(appended);
    const duplicate = await f.store.refreshRecord({ accountId: 'acct', record: appended, expectedResearchRevision: 1 });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.items.map(item => Object.keys(item)[0])).toEqual(['ConditionCheck']);
    await f.raw.transact(duplicate.items);
    expect(f.db.inspect('ACCOUNT#acct')).toEqual(appended);
  });
  const rejections: [string, AccountRecord | null, AccountRecord, number][] = [
    ['account_missing', null, appended, 1],
    ['record_identity_mismatch', stored, { ...appended, account: { ...appended.account, name: 'Renamed PM' }, history: appended.history.map(entry => ({ ...entry, account: { ...entry.account, name: 'Renamed PM' } })) }, 1],
    ['record_research_stale', stored, appended, 2],
    ['record_history_diverged', stored, { ...appended, history: [appended.history[0]!, { ...appended.history[1]!, at: later }, appended.history[2]!] }, 1],
    ['route_evidence_missing', stored, { ...appended, routes: [seeded, { ...admitted, evidenceIds: ['unadmitted-source'] }], history: [...stored.history, { ...appended.history[2]!, routes: [seeded, { ...admitted, evidenceIds: ['unadmitted-source'] }] }] }, 1],
    ['route_evidence_missing', stored, { ...appended, sources: [{ ...source, permitted: false }] }, 1],
    ['record_not_newer', stored, { ...stored, account: { ...account, version: 1 } }, 1],
  ];
  it.each(rejections)('refuses %s with that exact code and plans nothing', async (code, seed, record, expectedResearchRevision) => {
    const f = await refreshFixture(seed);
    await expect(f.store.refreshRecord({ accountId: 'acct', record, expectedResearchRevision })).rejects.toThrow(new RegExp(`^${code}$`));
    expect(f.db.transactions).toHaveLength(seed ? 1 : 0);
    if (seed) expect(f.db.inspect('ACCOUNT#acct')).toEqual(seed);
  });
  it('checks in the stated order: a stale research revision is reported before a diverged history', async () => {
    const f = await refreshFixture();
    const diverged = { ...appended, history: [{ ...appended.history[0]!, at: later }, ...appended.history.slice(1)] };
    await expect(f.store.refreshRecord({ accountId: 'acct', record: diverged, expectedResearchRevision: 2 })).rejects.toThrow(/^record_research_stale$/);
    await expect(f.store.refreshRecord({ accountId: 'acct', record: diverged, expectedResearchRevision: 1 })).rejects.toThrow(/^record_history_diverged$/);
  });
  it('exports the exact rejection codes the coordinator may turn into a founder-readable receipt', () => {
    expect([...selectedRecordRefreshRejections]).toEqual(['account_missing', 'record_identity_mismatch', 'record_research_stale', 'record_history_diverged', 'route_evidence_missing', 'record_not_newer']);
    expect(isSelectedRecordRefreshRejection('record_not_newer')).toBe(true);
    expect(isSelectedRecordRefreshRejection('stale_authority')).toBe(false);
    expect(fingerprint(stored)).not.toBe(fingerprint(appended));
  });
});
