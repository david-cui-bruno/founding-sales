import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import type { AccountEvidenceBatch } from '../../src/shared/contracts/accountContract';
import type { ResearchJob } from '../../src/main/research/companyResearchTypes';
import { selectedResearchSchema, accountEvidenceReceiptSchema, localCompanyResearchStatusSchema } from '../../src/shared/contracts/localWorkspaceContract';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';

const limits = { maxCompanies: 1, maxPages: 3, maxBytes: 10000, maxCostMicros: 100 };
const later = '2026-09-08T13:00:00.000Z';
type Fixture = Awaited<ReturnType<typeof createPmFixture>>;
type Selection = { commandId: string; accountId: string };
function repository(f: Fixture, budget = 1000) {
  return new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID }, research: { maxBudgetMicros: budget } });
}
function company(repo: AccountRepository, name = 'Selected') {
  return repo.create({ commandId: randomUUID(), name, domain: `${name.toLowerCase()}.invalid` });
}
function selection(accountId: string): Selection { return { commandId: randomUUID(), accountId }; }
function rows(f: Fixture) {
  return {
    jobs: f.db.raw.prepare('SELECT * FROM pm_account_research_jobs ORDER BY id').all(),
    commands: f.db.raw.prepare('SELECT * FROM pm_account_commands ORDER BY command_id').all(),
    accounts: f.db.raw.prepare('SELECT * FROM pm_accounts ORDER BY id').all(),
  };
}
function row(f: Fixture, input: Selection) {
  return f.db.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id=?').get(input.commandId);
}
function changes(f: Fixture) { return f.db.raw.prepare('SELECT total_changes() AS n').get(); }
function batch(job: ResearchJob, version = 1): AccountEvidenceBatch {
  return { commandId: job.receiptCommandId, accountId: job.accountId, expectedVersion: version, sources: [], claims: [], routes: [] };
}
function admit(repo: AccountRepository, job: ResearchJob) {
  return repo.admitEvidence(batch(job), { jobId: job.id, claimToken: job.claimToken });
}
function observe(f: Fixture, repo: AccountRepository, input: Selection, state: string, receipt: unknown = null) {
  const before = rows(f);
  const count = changes(f);
  for (let i = 0; i < 3; i++) {
    const status = repo.readSelectedResearch(input);
    expect(status).toMatchObject({ ...input, state, receipt });
    expect(Object.keys(status).sort()).toEqual(['accountId', 'commandId', 'reason', 'receipt', 'state']);
    expect(status.reason === null || typeof status.reason === 'string').toBe(true);
    expect(localCompanyResearchStatusSchema.parse(status)).toEqual(status);
  }
  expect(changes(f)).toEqual(count);
  expect(rows(f)).toEqual(before);
}

describe('exact selected company research', () => {
  it('never claims the older unrelated queued job', async () => {
    const f = await createPmFixture();
    try {
      let at = PM_NOW;
      const repo = new AccountRepository({ database: f.db, clock: { now: () => at }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
      const older = selection(company(repo, 'Older').id);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...older, limits });
      at = '2026-09-08T12:00:01.000Z';
      repo.enqueue({ ...selected, limits });
      const before = row(f, older);
      const job = repo.claimSelected(at, selected);
      expect(job?.accountId).toBe(selected.accountId);
      expect(job?.receiptCommandId).not.toBe(selected.commandId);
      expect(job?.receiptCommandId).toBe(job?.id);
      expect(row(f, older)).toEqual(before);
      observe(f, repo, older, 'queued');
      observe(f, repo, selected, 'running');
    } finally { f.close(); }
  }, 15000);

  it.each(['queued', 'expired', 'committed'] as const)('leaves same-account other-command %s interference untouched', async interference => {
    const f = await createPmFixture();
    try {
      let at = PM_NOW;
      const repo = new AccountRepository({ database: f.db, clock: { now: () => at }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
      const account = company(repo);
      const older = selection(account.id);
      const selected = selection(account.id);
      repo.enqueue({ ...older, limits });
      if (interference !== 'queued') {
        const job = repo.claimNext(PM_NOW)!;
        expect(job.accountId).toBe(account.id);
        if (interference === 'committed') admit(repo, job);
      }
      at = '2026-09-08T12:00:01.000Z';
      repo.enqueue({ ...selected, limits });
      const before = row(f, older);
      const commands = rows(f).commands;
      const selectedRow = row(f, selected) as { id: string };
      const job = repo.claimSelected(interference === 'expired' ? later : at, selected);
      expect(job?.id).toBe(selectedRow.id);
      expect(job?.receiptCommitted).toBe(false);
      expect(row(f, older)).toEqual(before);
      expect(rows(f).commands).toEqual(commands);
      observe(f, repo, selected, 'running');
    } finally { f.close(); }
  }, 15000);

  it.each(['expired', 'committed'] as const)('leaves cross-account unrelated %s running row untouched', async interference => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const older = selection(company(repo, 'Older').id);
      repo.enqueue({ ...older, limits });
      const oldJob = repo.claimNext(PM_NOW)!;
      if (interference === 'committed') admit(repo, oldJob);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      const before = row(f, older);
      const commands = rows(f).commands;
      const job = repo.claimSelected(interference === 'expired' ? later : PM_NOW, selected);
      expect(job?.accountId).toBe(selected.accountId);
      expect(job?.receiptCommitted).toBe(false);
      expect(row(f, older)).toEqual(before);
      expect(rows(f).commands).toEqual(commands);
    } finally { f.close(); }
  }, 15000);

  it('reads every repository state without writes and projects a real receipt without settlement', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      observe(f, repo, selected, 'not_recorded');
      observe(f, repository(f, 0), selected, 'not_recorded');
      repo.enqueue({ ...selected, limits });
      observe(f, repo, selected, 'queued');
      observe(f, repository(f, 0), selected, 'queued');
      const job = repo.claimSelected(PM_NOW, selected)!;
      observe(f, repo, selected, 'running');
      const before = row(f, selected);
      expect(repo.claimSelected(PM_NOW, selected)).toBeNull();
      expect(row(f, selected)).toEqual(before);
      const receipt = admit(repo, job);
      expect(accountEvidenceReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(job.receiptCommandId).toBe(job.id);
      expect(job.receiptCommandId).not.toBe(selected.commandId);
      observe(f, repo, selected, 'completed', receipt);
      observe(f, repo, selection(selected.accountId), 'not_recorded');
      expect(row(f, selected)).toMatchObject({ state: 'running', receipt_command_id: job.id });
      // The read snapshot may join a caller-owned read transaction.
      f.db.raw.transaction(() => observe(f, repo, selected, 'completed', receipt)).deferred();
      repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: job.id, costMicros: 20 });
      observe(f, repo, selected, 'completed', receipt);
      const newerReceipt = repo.admitEvidence({ ...batch(job, receipt.version), commandId: randomUUID() });
      expect(newerReceipt.version).toBe(receipt.version + 1);
      observe(f, repo, selected, 'completed', receipt);
      const parked = selection(selected.accountId);
      repo.enqueue({ ...parked, limits });
      const uncertain = repo.claimSelected(PM_NOW, parked)!;
      repo.settle({ jobId: uncertain.id, claimToken: uncertain.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      observe(f, repo, parked, 'parked');
    } finally { f.close(); }
  }, 15000);

  it('parks only selected expired uncertainty and never releases or reacquires its reservation', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      const job = repo.claimSelected(PM_NOW, selected)!;
      expect(repo.claimSelected(later, selected)).toBeNull();
      expect(row(f, selected)).toMatchObject({ state: 'parked', reserved_cost_micros: 100, cost_micros: null, attempt: 1 });
      observe(f, repo, selected, 'parked');
      const before = rows(f);
      expect(repo.claimSelected(later, selected)).toBeNull();
      expect(rows(f)).toEqual(before);
      expect(() => admit(repo, job)).toThrow(/claim|fenced/i);
    } finally { f.close(); }
  }, 15000);

  it.each([100, null])('keeps global other-account spend blocking selected work with cost %s', async costMicros => {
    const f = await createPmFixture();
    try {
      const repo = repository(f, 100);
      const older = selection(company(repo, 'Older').id);
      repo.enqueue({ ...older, limits });
      const job = repo.claimNext(PM_NOW)!;
      repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros });
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      const before = rows(f);
      expect(repo.claimSelected(later, selected)).toBeNull();
      expect(rows(f)).toEqual(before);
      observe(f, repo, selected, 'queued');
      expect(row(f, older)).toMatchObject({ reserved_cost_micros: 100, cost_micros: costMicros });
    } finally { f.close(); }
  }, 15000);

  it.each(['disabled', 'absent'] as const)('recovers selected committed evidence before %s configuration and fences the prior token', async configuration => {
    const f = await createPmFixture();
    try {
      const repo = repository(f, 100);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      const old = repo.claimSelected(PM_NOW, selected)!;
      const receipt = admit(repo, old);
      const disabled = configuration === 'disabled' ? repository(f, 0)
        : new AccountRepository({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: randomUUID } });
      observe(f, disabled, selected, 'completed', receipt);
      const recovered = disabled.claimSelected(later, selected)!;
      expect(recovered).toMatchObject({ id: old.id, accountId: selected.accountId, receiptCommandId: old.id, receiptCommitted: true, limits, attempt: 1 });
      expect(recovered.claimToken).not.toBe(old.claimToken);
      const before = rows(f);
      expect(() => admit(repo, old)).toThrow(/claim|fenced/i);
      expect(() => repo.settle({ jobId: old.id, claimToken: old.claimToken, status: 'completed', receiptCommandId: old.id, costMicros: null })).toThrow(/claim|fenced/i);
      expect(rows(f)).toEqual(before);
      disabled.settle({ jobId: recovered.id, claimToken: recovered.claimToken, status: 'completed', receiptCommandId: recovered.id, costMicros: null });
      observe(f, disabled, selected, 'completed', receipt);
    } finally { f.close(); }
  }, 15000);

  it.each(['queued', 'expired', 'committed'] as const)('rejects wrong account for an existing %s command before any mutation', async state => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      const other = company(repo, 'Other');
      repo.enqueue({ ...selected, limits });
      if (state !== 'queued') {
        const job = repo.claimNext(PM_NOW)!;
        if (state === 'committed') admit(repo, job);
      }
      const wrong = { ...selected, accountId: other.id };
      const before = rows(f);
      const count = changes(f);
      expect(() => repo.readSelectedResearch(wrong)).toThrow(/account|conflict|mismatch/i);
      expect(() => repo.claimSelected(later, wrong)).toThrow(/account|conflict|mismatch/i);
      expect(changes(f)).toEqual(count);
      expect(rows(f)).toEqual(before);
    } finally { f.close(); }
  }, 15000);

  it('validates strict selection and rejects missing accounts without creating jobs', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      expect(selectedResearchSchema.parse(selected)).toEqual(selected);
      const before = rows(f);
      const count = changes(f);
      for (const invalid of [{ ...selected, commandId: 'not-a-uuid' }, { ...selected, extra: true }, selection(randomUUID())]) {
        expect(() => repo.readSelectedResearch(invalid)).toThrow();
        expect(() => repo.claimSelected(PM_NOW, invalid)).toThrow();
      }
      expect(selectedResearchSchema.safeParse({ ...selected, extra: true }).success).toBe(false);
      expect(changes(f)).toEqual(count);
      expect(rows(f)).toEqual(before);
    } finally { f.close(); }
  }, 15000);

  it('replays saved limits unchanged and preserves the three-attempt fingerprint cap', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      const other = company(repo, 'Other');
      repo.enqueue({ ...selected, limits });
      const before = rows(f);
      const count = changes(f);
      repo.enqueue({ ...selected, limits });
      expect(() => repo.enqueue({ ...selected, limits: { ...limits, maxPages: 1 } })).toThrow(/conflict/i);
      expect(() => repo.enqueue({ ...selected, accountId: other.id, limits })).toThrow(/conflict/i);
      expect(changes(f)).toEqual(count);
      expect(rows(f)).toEqual(before);
      const changedConfiguration = repository(f, 2000);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const input = attempt === 1 ? selected : selection(selected.accountId);
        if (attempt !== 1) repo.enqueue({ ...input, limits });
        const job = changedConfiguration.claimSelected(PM_NOW, input)!;
        expect(job.limits).toEqual(limits);
        expect(job.attempt).toBe(attempt);
        changedConfiguration.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      }
      expect(() => repo.enqueue({ ...selection(selected.accountId), limits })).toThrow(/attempt/i);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  }, 15000);

  it('does not confuse a real UI-command evidence receipt with the reserved job receipt', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      const job = repo.claimSelected(PM_NOW, selected)!;
      repo.admitEvidence({ ...batch(job), commandId: selected.commandId });
      observe(f, repo, selected, 'running');
      // Disposable corruption: bind a valid but wrong evidence identity. Never positive evidence.
      f.db.raw.prepare('UPDATE pm_account_research_jobs SET receipt_command_id=? WHERE id=?').run(selected.commandId, job.id);
      const before = rows(f);
      const count = changes(f);
      expect(() => repo.readSelectedResearch(selected)).toThrow();
      expect(rows(f)).toEqual(before);
      expect(changes(f)).toEqual(count);
    } finally { f.close(); }
  }, 15000);

  it.each(['missing', 'shape', 'payload-account', 'version', 'extra'] as const)('rejects corrupt persisted receipt %s without manufacturing completed status', async corruption => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      const other = company(repo, 'Other');
      repo.enqueue({ ...selected, limits });
      const job = repo.claimSelected(PM_NOW, selected)!;
      observe(f, repo, selected, 'running');
      const independentReceipt = repo.admitEvidence({ ...batch(job), commandId: randomUUID() });
      expect(independentReceipt.version).toBe(2);
      // Negative-only disposable SQL: supported APIs cannot create these invalid persisted states.
      // No immutable trigger is disabled and no fabricated receipt is a positive fixture.
      if (corruption === 'missing') {
        f.db.raw.prepare("UPDATE pm_account_research_jobs SET state='completed' WHERE id=?").run(job.id);
      } else {
        const payload = corruption === 'shape' ? {} : {
          accountId: corruption === 'payload-account' ? other.id : selected.accountId,
          version: corruption === 'version' ? 3 : 2, duplicate: false,
          ...(corruption === 'extra' ? { injected: true } : {}),
        };
        f.db.raw.prepare('INSERT INTO pm_account_commands(command_id,account_id,fingerprint,result_json,account_version,created_at) VALUES(?,?,?,?,?,?)')
          .run(job.id, selected.accountId, 'a'.repeat(64), JSON.stringify(payload), 2, PM_NOW);
        f.db.raw.prepare('UPDATE pm_account_research_jobs SET receipt_command_id=? WHERE id=?').run(job.id, job.id);
      }
      const before = rows(f);
      const count = changes(f);
      for (let i = 0; i < 3; i++) expect(() => repo.readSelectedResearch(selected)).toThrow();
      expect(rows(f)).toEqual(before);
      expect(changes(f)).toEqual(count);
    } finally { f.close(); }
  }, 15000);

  it('rejects corrupt selected saved limits without mutating or silently repairing them', async () => {
    const f = await createPmFixture();
    try {
      const repo = repository(f);
      const selected = selection(company(repo).id);
      repo.enqueue({ ...selected, limits });
      observe(f, repo, selected, 'queued');
      // Disposable negative-only persisted corruption, never an admitted receipt.
      f.db.raw.prepare("UPDATE pm_account_research_jobs SET limits_json='{}' WHERE command_id=?").run(selected.commandId);
      const before = rows(f);
      const count = changes(f);
      expect(() => repo.readSelectedResearch(selected)).toThrow();
      expect(rows(f)).toEqual(before);
      expect(changes(f)).toEqual(count);
    } finally { f.close(); }
  }, 15000);

});
