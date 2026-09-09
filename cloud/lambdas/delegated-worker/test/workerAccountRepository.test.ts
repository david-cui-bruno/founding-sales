import { describe, expect, it } from 'vitest';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
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
