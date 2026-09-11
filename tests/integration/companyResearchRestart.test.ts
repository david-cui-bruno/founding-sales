import type { AccountEvidenceBatch } from '../../src/shared/contracts/accountContract';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';

const limits = { maxCompanies: 2, maxPages: 2, maxBytes: 20000, maxCostMicros: 100 };
describe('durable company research SQL', () => {
  it('reserves budget, fences settlement, and resumes a committed receipt without repeating the provider', async () => {
    const f = await createPmFixture();
    try {
      const options = { database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 100 } };
      const repo = new AccountRepository(options);
      const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'example.invalid' });
      const enqueue = { commandId: randomUUID(), accountId: account.id, limits };
      repo.enqueue(enqueue); repo.enqueue(enqueue);
      expect(() => repo.enqueue({ ...enqueue, limits: { ...limits, maxPages: 1 } })).toThrow(/conflict/i);
      const job = repo.claimNext(PM_NOW)!;
      expect(job).toMatchObject({ accountId: account.id, attempt: 1, receiptCommitted: false });
      expect(repo.claimNext(PM_NOW)).toBeNull();
      expect(() => repo.settle({ jobId: job.id, claimToken: 'stale', status: 'parked', receiptCommandId: null, costMicros: null })).toThrow(/claim/i);
      repo.admitEvidence({ commandId: job.receiptCommandId, accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }, { jobId: job.id, claimToken: job.claimToken });
      // Physically close and reopen the encrypted DB. No in-memory receipt ledger survives.
      closeDatabase(f.db);
      const key = createTestWorkspaceKey();
      const reopened = openDatabase({ path: f.db.path, key });
      key.bytes.fill(0);
      f.db.raw = reopened.raw;
      f.db.kysely = reopened.kysely;
      const restarted = new AccountRepository(options);
      const worker = createCompanyResearchWorker({ store: restarted, clock: options.clock,
        pages: { research: async () => { throw new Error('must never repeat committed provider request'); } } });
      expect(await worker.runNext(new AbortController().signal)).toBe('completed');
      expect(f.db.raw.prepare('SELECT state,cost_micros,reserved_cost_micros FROM pm_account_research_jobs').get())
        .toEqual({ state: 'completed', cost_micros: null, reserved_cost_micros: 100 });
      expect(repo.snapshot(account.id, PM_NOW).account.version).toBe(2);
      expect(await worker.runNext(new AbortController().signal)).toBe('idle');
      repo.enqueue({ ...enqueue, commandId: randomUUID() });
      expect(repo.claimNext(PM_NOW)).toBeNull(); // Unknown cost retains full reservation.
    } finally { f.close(); }
  });
  it('is inert without budget and parks ambiguous expired claims without spending again', async () => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
      f.repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
      expect(f.repo.claimNext(PM_NOW)).toBeNull();
      const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
      expect(repo.claimNext(PM_NOW)).not.toBeNull();
      expect(repo.claimNext('2026-09-08T13:00:00.000Z')).toBeNull();
      expect(f.db.raw.prepare('SELECT state,cost_micros,attempt FROM pm_account_research_jobs').get()).toEqual({ state: 'parked', cost_micros: null, attempt: 1 });
      for (let i = 0; i < 2; i++) {
        repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
        const job = repo.claimNext(PM_NOW)!;
        repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      }
      expect(() => repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits })).toThrow(/attempt/i);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  });
});

describe('research evidence receipt authenticity', () => {
  it('does not recover an unrelated command and refuses evidence from a parked attempt', async () => {
    const f = await createPmFixture();
    try {
      const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
      const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
      repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
      const job = repo.claimNext(PM_NOW)!;
      // A valid non-evidence command must not impersonate the reserved evidence receipt.
      f.db.raw.prepare('INSERT INTO pm_account_commands(command_id,account_id,fingerprint,result_json,account_version,created_at) VALUES(?,?,?,?,?,?)')
        .run(job.receiptCommandId, account.id, 'a'.repeat(64), '{}', 1, PM_NOW);
      expect(repo.claimNext(PM_NOW)).toBeNull();
      repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
      const second = repo.claimNext(PM_NOW)!;
      repo.settle({ jobId: second.id, claimToken: second.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      expect(() => repo.admitEvidence({ commandId: second.receiptCommandId, accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] })).toThrow(/research|claim/i);

    } finally { f.close(); }
  });
});

 it('fences evidence admission against a newer running claim token atomically', async () => {
   const f = await createPmFixture();
   try {
     const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
     const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
     repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
     const job = repo.claimNext(PM_NOW)!;
     const newerToken = randomUUID();
     f.db.raw.prepare('UPDATE pm_account_research_jobs SET claim_token=? WHERE id=?').run(newerToken, job.id);
     const batch: AccountEvidenceBatch = { commandId: job.receiptCommandId, accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] };
     expect(() => repo.admitEvidence(batch, { jobId: job.id, claimToken: job.claimToken })).toThrow(/claim/i);
     expect(() => repo.admitEvidence(batch)).toThrow(/claim/i);
     expect(repo.snapshot(account.id, PM_NOW).account.version).toBe(1);
     expect(repo.admitEvidence(batch, { jobId: job.id, claimToken: newerToken })).toMatchObject({ version: 2 });
     expect(f.db.raw.prepare('SELECT receipt_command_id FROM pm_account_research_jobs WHERE id=?').get(job.id)).toEqual({ receipt_command_id: job.receiptCommandId });
   } finally { f.close(); }
 });

it('retains conflicting fetched facts and parks a stale revision without admitting its source', async () => {
  const { createCompanyPageProvider } = await import('../../src/main/research/companyPageProvider');
  const { createFetchedReceiptPolicy } = await import('../../src/main/research/companySourcePolicy');
  const f = await createPmFixture();
  try {
    const receipts = createFetchedReceiptPolicy();
    const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, sourcePolicy: receipts, research: { maxBudgetMicros: 1000 } });
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'example.invalid' });
    repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
    const pages = createCompanyPageProvider({ receipts, clock: { now: () => PM_NOW }, permitted: () => true, resolve: async () => ['93.184.216.34'],
      http: async input => new Response(input.url.endsWith('/services') ? '<p>We manage 300 residential units.</p>' : '<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }) });
    expect(await createCompanyResearchWorker({ store: repo, pages, clock: { now: () => PM_NOW } }).runNext(new AbortController().signal)).toBe('completed');
    expect(repo.snapshot(account.id, PM_NOW).portfolio).toHaveLength(2);
    expect(repo.snapshot(account.id, PM_NOW).conflicts.length).toBeGreaterThan(0);
    const before = f.db.raw.prepare('SELECT * FROM pm_account_sources').all();
    repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits });
    let advanced = false;
    const stalePages = createCompanyPageProvider({ receipts, clock: { now: () => PM_NOW }, permitted: () => true, resolve: async () => ['93.184.216.34'],
      http: async () => {
        if (!advanced) { advanced = true; repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 2, sources: [], claims: [], routes: [] }); }
        return new Response('<p>We manage 999 residential units.</p>', { headers: { 'content-type': 'text/html' } });
      } });
    const issues: string[] = [];
    expect(await createCompanyResearchWorker({ store: repo, pages: stalePages, clock: { now: () => PM_NOW }, issue: code => issues.push(code) }).runNext(new AbortController().signal)).toBe('parked');
    expect(issues).toEqual(['company_research_parked']);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual(before);
    expect(repo.snapshot(account.id, PM_NOW).portfolio).toHaveLength(2);
  } finally { f.close(); }
});

it.each([0, 20])('claims affordable queued work past an expensive head while retaining unknown spend %s', async priorCost => {
  const f = await createPmFixture();
  try {
    let at = PM_NOW;
    const repo = new AccountRepository({ database: f.db, clock: { now: () => at }, ids: { next: randomUUID }, research: { maxBudgetMicros: 100 } });
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'example.invalid' });
    if (priorCost) {
      repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits: { ...limits, maxCostMicros: priorCost } });
      const initial = repo.claimNext(at)!;
      repo.settle({ jobId: initial.id, claimToken: initial.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
    }
    at = '2026-09-08T12:00:01.000Z';
    const expensiveCommand = randomUUID();
    repo.enqueue({ commandId: expensiveCommand, accountId: account.id, limits: { ...limits, maxCostMicros: 101 - priorCost } });
    at = '2026-09-08T12:00:02.000Z';
    repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits: { ...limits, maxCostMicros: 50 } });
    const affordable = repo.claimNext(at);
    expect(affordable?.limits.maxCostMicros).toBe(50);
    expect(f.db.raw.prepare('SELECT state,reserved_cost_micros FROM pm_account_research_jobs WHERE command_id=?').get(expensiveCommand))
      .toEqual({ state: 'queued', reserved_cost_micros: 0 });
    expect(f.db.raw.prepare('SELECT SUM(reserved_cost_micros) AS reserved,COUNT(cost_micros) AS known FROM pm_account_research_jobs').get())
      .toEqual({ reserved: priorCost + 50, known: 0 });
  } finally { f.close(); }
});


it('reopens encrypted selected committed work through the real worker with zero pages calls and all unrelated paths untouched', async () => {
  const f = await createPmFixture();
  const abort = new AbortController();
  try {
    let at = PM_NOW;
    const options = { database: f.db, clock: { now: () => at }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } };
    const repo = new AccountRepository(options);
    const account = repo.create({ commandId: randomUUID(), name: 'Selected restart', domain: 'selected.invalid' });
    const other = repo.create({ commandId: randomUUID(), name: 'Unrelated restart', domain: 'other.invalid' });
    const queued = { commandId: randomUUID(), accountId: other.id };
    const expired = { commandId: randomUUID(), accountId: other.id };
    const committed = { commandId: randomUUID(), accountId: account.id };
    const selected = { commandId: randomUUID(), accountId: account.id };
    repo.enqueue({ ...queued, limits });
    repo.enqueue({ ...expired, limits });
    const expiredJob = repo.claimSelected(PM_NOW, expired)!;
    expect(expiredJob.accountId).toBe(other.id);
    repo.enqueue({ ...committed, limits });
    const unrelatedJob = repo.claimSelected(PM_NOW, committed)!;
    repo.admitEvidence({ commandId: unrelatedJob.receiptCommandId, accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] },
      { jobId: unrelatedJob.id, claimToken: unrelatedJob.claimToken });
    at = '2026-09-08T12:00:01.000Z';
    repo.enqueue({ ...selected, limits });
    const job = repo.claimSelected(at, selected)!;
    const evidence: AccountEvidenceBatch = { commandId: job.receiptCommandId, accountId: account.id, expectedVersion: 2, sources: [], claims: [], routes: [] };
    const receipt = repo.admitEvidence(evidence, { jobId: job.id, claimToken: job.claimToken });
    expect(receipt).toEqual({ accountId: account.id, version: 3, duplicate: false });
    expect(job.receiptCommandId).toBe(job.id);
    expect(job.receiptCommandId).not.toBe(selected.commandId);
    const unrelatedRows = () => f.db.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id<>? ORDER BY id').all(selected.commandId);
    const originalUnrelated = unrelatedRows();
    const originalCommands = f.db.raw.prepare('SELECT * FROM pm_account_commands ORDER BY command_id').all();
    const oldRaw = f.db.raw;
    const oldKysely = f.db.kysely;
    const path = f.db.path;
    // Physical encrypted close/reopen, not a recreated repository over a live handle.
    closeDatabase(f.db);
    expect(oldRaw.open).toBe(false);
    const key = createTestWorkspaceKey();
    try {
      const reopened = openDatabase({ path, key });
      f.db.raw = reopened.raw;
      f.db.kysely = reopened.kysely;
    } finally { key.bytes.fill(0); }
    expect(key.bytes.every(value => value === 0)).toBe(true);
    expect(f.db.raw).not.toBe(oldRaw);
    expect(f.db.kysely).not.toBe(oldKysely);
    expect(f.db.path).toBe(path);
    at = '2026-09-08T13:00:00.000Z';
    // Recovery must precede configuration checks, even after a real restart.
    const restarted = new AccountRepository({ ...options, research: { maxBudgetMicros: 0 } });
    const beforeRead = f.db.raw.prepare('SELECT total_changes() AS n').get();
    const selectedBeforeRead = f.db.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id=?').get(selected.commandId);
    for (let i = 0; i < 3; i++) {
      expect(restarted.readSelectedResearch(selected)).toMatchObject({ ...selected, state: 'completed', receipt });
    }
    expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(beforeRead);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id=?').get(selected.commandId)).toEqual(selectedBeforeRead);
    expect(selectedBeforeRead).toMatchObject({ state: 'running', receipt_command_id: job.id });
    let pagesCalls = 0;
    const store: Parameters<typeof createCompanyResearchWorker>[0]['store'] = {
      create: input => restarted.create(input),
      snapshot: (accountId, asOf) => restarted.snapshot(accountId, asOf),
      admitEvidence: (input, claim) => restarted.admitEvidence(input, claim),
      enqueue: input => restarted.enqueue(input),
      claimNext: asOf => restarted.claimSelected(asOf, selected),
      settle: input => restarted.settle(input),
    };
    const worker = createCompanyResearchWorker({ store, clock: options.clock,
      pages: { research: async () => { pagesCalls++; throw new Error('selected committed recovery must never call pages'); } } });
    expect(await worker.runNext(abort.signal)).toBe('completed');
    expect(pagesCalls).toBe(0);
    expect(restarted.readSelectedResearch(selected)).toMatchObject({ ...selected, state: 'completed', receipt });
    expect(f.db.raw.prepare('SELECT state,receipt_command_id,cost_micros,reserved_cost_micros,limits_json FROM pm_account_research_jobs WHERE command_id=?').get(selected.commandId))
      .toEqual({ state: 'completed', receipt_command_id: job.id, cost_micros: null, reserved_cost_micros: 100, limits_json: JSON.stringify(limits) });
    expect(unrelatedRows()).toEqual(originalUnrelated);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_commands ORDER BY command_id').all()).toEqual(originalCommands);
    expect(restarted.snapshot(account.id, at).account.version).toBe(3);
    const settledRows = f.db.raw.prepare('SELECT * FROM pm_account_research_jobs ORDER BY id').all();
    expect(() => restarted.admitEvidence(evidence, { jobId: job.id, claimToken: job.claimToken })).toThrow(/claim|fenced/i);
    expect(() => restarted.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: job.id, costMicros: null })).toThrow(/claim|fenced/i);
    expect(await worker.runNext(abort.signal)).toBe('idle');
    expect(pagesCalls).toBe(0);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_research_jobs ORDER BY id').all()).toEqual(settledRows);
    expect(unrelatedRows()).toEqual(originalUnrelated);
    expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
  } finally { abort.abort(); f.close(); }
}, 15000);
