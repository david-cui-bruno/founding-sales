import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';
import { CompanyFactExtractionError } from '../../src/main/research/companyFactExtraction';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';

it.each(['snapshot', 'admission'] as const)('reports the %s boundary without serializing an arbitrary exception', async stage => {
  const f = await createPmFixture();
  const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
  try {
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'fictional.example' });
    repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 } });
    const failure = (): never => { throw new Error('private model response or database context'); };
    if (stage === 'snapshot') vi.spyOn(repo, 'snapshot').mockImplementation(failure);
    else vi.spyOn(repo, 'admitEvidence').mockImplementation(failure);
    const issue = vi.fn();
    const research = vi.fn(async () => ({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }));
    const worker = createCompanyResearchWorker({ store: repo, pages: { research }, clock: { now: () => PM_NOW }, issue });
    expect(await worker.runNext(new AbortController().signal)).toBe('parked');
    expect(issue).toHaveBeenCalledWith('company_research_parked', account.id, { stage, reason: 'unknown', jobId: expect.any(String) });
    expect(JSON.stringify(issue.mock.calls)).not.toContain('private');
    expect(research).toHaveBeenCalledTimes(stage === 'snapshot' ? 0 : 1);
  } finally { f.close(); }
});

it('retains a safe model diagnostic after parking without changing the reservation or retrying', async () => {
  const f = await createPmFixture();
  const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
  try {
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'fictional.example' });
    const commandId = randomUUID();
    repo.enqueue({ commandId, accountId: account.id, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 } });
    const issue = vi.fn();
    const research = vi.fn(async (): Promise<never> => { throw new CompanyFactExtractionError('quote'); });
    const worker = createCompanyResearchWorker({ store: repo, pages: { research }, clock: { now: () => PM_NOW }, issue });
    expect(await worker.runNext(new AbortController().signal)).toBe('parked');
    const row = f.db.raw.prepare('SELECT id,state,reserved_cost_micros,cost_micros,attempt FROM pm_account_research_jobs WHERE command_id=?').get(commandId);
    expect(row).toMatchObject({ state: 'parked', reserved_cost_micros: 100, cost_micros: null, attempt: 1 });
    expect(issue).toHaveBeenCalledWith('company_research_parked', account.id, expect.objectContaining({ stage: 'page', reason: 'quote', jobId: expect.any(String) }));
    expect(await worker.runNext(new AbortController().signal)).toBe('idle');
    expect(research).toHaveBeenCalledTimes(1);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
  } finally { f.close(); }
});

it('a diagnostic callback cannot turn a durably parked result into a thrown failure', async () => {
  const f = await createPmFixture();
  const repo = new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
  try {
    const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'fictional.example' });
    repo.enqueue({ commandId: randomUUID(), accountId: account.id, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 } });
    const worker = createCompanyResearchWorker({ store: repo, pages: { research: async (): Promise<never> => { throw new Error('private page content'); } },
      clock: { now: () => PM_NOW }, issue: () => { throw new Error('sink unavailable'); } });
    await expect(worker.runNext(new AbortController().signal)).resolves.toBe('parked');
  } finally { f.close(); }
});
