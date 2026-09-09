import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalCompanyIntake } from '../../src/main/domain/accounts/localCompanyIntake';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
const request = (name = 'Example PM', domain: string | null = null) => ({ commandId: randomUUID(), name, domain });
function state(database: AppDatabase) {
  return database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    const { name } = row as { name: string };
    return [name, database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()];
  });
}
async function fixture() {
  const f = await createPmFixture();
  let allocated = 0;
  return { ...f, allocated: () => allocated, intake: new LocalCompanyIntake({ database: f.db, clock: { now: () => PM_NOW }, ids: { next: () => { allocated++; return randomUUID(); } } }) };
}
describe('guarded local company intake encrypted repository', () => {
  it.each([null, 'example.invalid'])('creates one ordinary exportable account with domain %s and no fabricated evidence', async domain => {
    const f = await fixture();
    try {
      const input = request(' Example PM ', domain);
      const result = f.intake.create(input);
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('Expected creation');
      expect(result).toEqual({ status: 'saved', commandId: input.commandId, replayed: false, account: { id: result.account.id, name: 'Example PM', domain, version: 1 } });
      expect(f.allocated()).toBe(1);
      expect(f.repo.create(input)).toEqual(result.account);
      expect(f.intake.create(input)).toEqual({ ...result, replayed: true });
      expect(f.intake.status(input)).toEqual({ status: 'saved', commandId: input.commandId, account: result.account });
      expect(f.repo.snapshot(result.account.id, PM_NOW)).toMatchObject({ claims: [], routes: [], portfolio: [] });
      expect(() => exportSelectedAccountRecord({ database: f.db, workspaceId: 'local-test', researchRevision: 1, accountId: result.account.id, asOf: PM_NOW })).not.toThrow();
      expect(f.db.raw.prepare('SELECT * FROM pm_account_research_jobs').all()).toEqual([]);
      expect(f.db.raw.prepare('SELECT * FROM cadence_enrollments').all()).toEqual([]);
      expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    } finally { f.close(); }
  });
  it('returns the original receipt rather than current version and distinguishes genuine conflicts without writes', async () => {
    const f = await fixture();
    try {
      const input = request(); const original = f.repo.create(input);
      const evidenceCommand = randomUUID();
      f.repo.admitEvidence({ commandId: evidenceCommand, accountId: original.id, expectedVersion: 1, sources: [], claims: [], routes: [] });
      const before = state(f.db);
      expect(f.intake.create(input)).toEqual({ status: 'saved', commandId: input.commandId, account: original, replayed: true });
      expect(f.intake.status(input)).toEqual({ status: 'saved', commandId: input.commandId, account: original });
      for (const changed of [{ ...input, name: 'Changed' }, { ...input, domain: 'other.invalid' }, { ...input, commandId: evidenceCommand }]) {
        expect(f.intake.create(changed)).toEqual({ status: 'command_conflict', commandId: changed.commandId });
        expect(f.intake.status(changed)).toEqual({ status: 'command_conflict', commandId: changed.commandId });
      }
      const absent = request('Missing');
      expect(f.intake.status(absent)).toEqual({ status: 'not_recorded', commandId: absent.commandId });
      expect(state(f.db)).toEqual(before); expect(f.allocated()).toBe(0);
      expect(() => exportSelectedAccountRecord({ database: f.db, workspaceId: 'local-test', researchRevision: 1, accountId: original.id, asOf: PM_NOW })).not.toThrow();
    } finally { f.close(); }
  });
  it('includes all preexisting duplicates by exact name OR full domain and holds without any mutation', async () => {
    const f = await fixture();
    try {
      const a = f.repo.create(request('EXAMPLE PM', null));
      const b = f.repo.create(request('Other PM', 'example.invalid'));
      const c = f.repo.create(request('Other PM', 'example.invalid'));
      const synchronized = { id: 'synchronized-existing', name: 'Synced PM', domain: 'example.invalid', version: 1 };
      f.db.raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(synchronized.id, synchronized.name, synchronized.domain, 1, PM_NOW, PM_NOW);
      f.repo.create(request('Example PM LLC', 'www.example.invalid'));
      f.db.raw.prepare('INSERT INTO pm_account_suppression_tombstones(id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), a.id, PM_NOW, 'fixture', 'manual-test', PM_NOW);
      const input = request(' example pm ', 'example.invalid'); const before = state(f.db);
      const review = f.intake.review({ name: input.name, domain: input.domain });
      expect(review).toEqual({ scope: 'local_database', input: { name: 'example pm', domain: 'example.invalid' }, complete: true, candidates: [
        { account: a, signals: ['same_name'] }, { account: b, signals: ['same_domain'] }, { account: c, signals: ['same_domain'] }, { account: synchronized, signals: ['same_domain'] },
      ].sort((x, y) => x.account.id < y.account.id ? -1 : 1) });
      expect(f.intake.create(input)).toEqual({ status: 'needs_review', commandId: input.commandId, review });
      expect(f.intake.status(input)).toEqual({ status: 'not_recorded', commandId: input.commandId });
      expect(state(f.db)).toEqual(before); expect(f.allocated()).toBe(0);
      expect(() => exportSelectedAccountRecord({ database: f.db, workspaceId: 'local-test', researchRevision: 1, accountId: a.id, asOf: PM_NOW })).not.toThrow();
    } finally { f.close(); }
  });
  it('detects a truncated candidate set at 51 and never creates anyway', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 51; i++) f.repo.create(request('Duplicate'));
      const input = request('duplicate'); const before = state(f.db);
      const review = f.intake.review({ name: input.name, domain: null });
      expect(review.complete).toBe(false); expect(review.candidates).toHaveLength(50);
      expect(f.intake.create(input)).toEqual({ status: 'needs_review', commandId: input.commandId, review });
      expect(state(f.db)).toEqual(before); expect(f.allocated()).toBe(0);
    } finally { f.close(); }
  });
  it('serializes competing commands on separate encrypted connections into one save and one review hold', async () => {
    const f = await fixture(); const key = createTestWorkspaceKey();
    const second = openDatabase({ path: f.db.path, key });
    try {
      const other = new LocalCompanyIntake({ database: second, clock: { now: () => PM_NOW }, ids: { next: randomUUID } });
      const results = await Promise.all([
        Promise.resolve().then(() => f.intake.create(request('First', 'same.invalid'))),
        Promise.resolve().then(() => other.create(request('Second', 'same.invalid'))),
      ]);
      expect(results.map(result => result.status)).toEqual(['saved', 'needs_review']);
      expect(f.db.raw.prepare('SELECT * FROM pm_accounts').all()).toHaveLength(1);
      expect(f.db.raw.prepare('SELECT * FROM pm_account_commands').all()).toHaveLength(1);
      expect(f.allocated()).toBe(1);
    } finally { closeDatabase(second); key.bytes.fill(0); f.close(); }
  });

  it('recovers the original command after reopening storage and still holds a fresh matching command', async () => {
    const f = await fixture();
    const key = createTestWorkspaceKey();
    let reopened: AppDatabase | undefined;
    try {
      const input = request('Restart Company', 'restart.invalid');
      const original = f.intake.create(input);
      expect(original.status).toBe('saved');
      if (original.status !== 'saved') throw new Error('Expected saved company');
      closeDatabase(f.db);
      reopened = openDatabase({ path: f.db.path, key });
      const intake = new LocalCompanyIntake({ database: reopened, clock: { now: () => PM_NOW }, ids: { next: () => { throw new Error('Recovery must allocate no ID'); } } });
      const before = state(reopened);
      expect(intake.status(input)).toEqual({ status: 'saved', commandId: input.commandId, account: original.account });
      expect(intake.create(input)).toEqual({ ...original, replayed: true });
      expect(intake.create({ ...input, commandId: randomUUID() }).status).toBe('needs_review');
      expect(state(reopened)).toEqual(before);
    } finally { if (reopened) closeDatabase(reopened); key.bytes.fill(0); f.close(); }
  });
  it('rejects malformed stored candidates and malformed original receipts rather than inventing outcomes', async () => {
    const f = await fixture();
    try {
      const input = request('Corrupt Company'); const original = f.repo.create(input);
      f.db.raw.prepare('UPDATE pm_accounts SET domain=? WHERE id=?').run('NOT-A-HOST', original.id);
      const before = state(f.db);
      expect(() => f.intake.review({ name: input.name, domain: null })).toThrow();
      expect(() => f.intake.create({ ...input, commandId: randomUUID() })).toThrow();
      expect(state(f.db)).toEqual(before);
      const corruptInput = { ...input, commandId: randomUUID() };
      f.db.raw.prepare('INSERT INTO pm_account_commands(command_id,account_id,fingerprint,result_json,account_version,created_at) VALUES(?,?,?,?,?,?)').run(corruptInput.commandId, original.id, accountFingerprint({ kind: 'create', ...corruptInput }), '{}', 1, PM_NOW);
      const corrupted = state(f.db);
      expect(() => f.intake.status(corruptInput)).toThrow();
      expect(() => f.intake.create(corruptInput)).toThrow();
      expect(state(f.db)).toEqual(corrupted); expect(f.allocated()).toBe(0);
    } finally { f.close(); }
  });
  it('fails closed on invalid inputs and candidate query failure with no allocations or writes', async () => {
    const f = await fixture();
    try {
      const before = state(f.db);
      expect(() => f.intake.create(request('', null))).toThrow();
      expect(() => f.intake.create(request('Name', 'HTTPS://example.invalid'))).toThrow();
      expect(state(f.db)).toEqual(before);
      f.db.raw.exec('ALTER TABLE pm_accounts RENAME TO unavailable_accounts');
      const broken = state(f.db);
      expect(() => f.intake.review({ name: 'Name', domain: null })).toThrow();
      expect(() => f.intake.create(request('Name'))).toThrow();
      expect(state(f.db)).toEqual(broken); expect(f.allocated()).toBe(0);
    } finally { f.close(); }
  });
});

it('reviews actual encrypted Unicode IDs in SQL BINARY order and holds without mutation', async () => {
  const f = await fixture();
  try {
    for (const id of ['a-\u{10000}', 'a-\uE000']) {
      f.db.raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, 'Unicode PM', 'unicode.invalid', 1, PM_NOW, PM_NOW);
    }
    const input = request('Unicode PM', 'unicode.invalid');
    const before = state(f.db);
    const review = f.intake.review({ name: input.name, domain: input.domain });
    expect(review.candidates.map(candidate => candidate.account.id)).toEqual(['a-\uE000', 'a-\u{10000}']);
    expect(f.intake.create(input)).toEqual({ status: 'needs_review', commandId: input.commandId, review });
    expect(state(f.db)).toEqual(before); expect(f.allocated()).toBe(0);
    for (let index = 0; index < 49; index++) {
      f.db.raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`a-${String(index).padStart(3, '0')}`, 'Unicode PM', 'unicode.invalid', 1, PM_NOW, PM_NOW);
    }
    const truncated = f.intake.review({ name: input.name, domain: input.domain });
    expect(truncated.complete).toBe(false);
    expect(truncated.candidates).toHaveLength(50);
    expect(truncated.candidates.at(-1)!.account.id).toBe('a-\uE000');
    expect(truncated.candidates.some(candidate => candidate.account.id === 'a-\u{10000}')).toBe(false);
    expect(f.intake.create(input)).toEqual({ status: 'needs_review', commandId: input.commandId, review: truncated });
  } finally { f.close(); }
});
it.each(['guarded', 'ordinary'] as const)('rolls back %s account insertion when receipt insertion fails', async mode => {
  const f = await fixture();
  try {
    // The trigger fires only if the account INSERT already happened. It fails at
    // the next write, before the normal receipt is inserted, with triggers intact.
    f.db.raw.exec(`CREATE TEMP TRIGGER fail_company_receipt BEFORE INSERT ON pm_account_commands
      WHEN EXISTS (SELECT 1 FROM pm_accounts WHERE id=NEW.account_id)
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure after account insert'); END`);
    const input = request('Rollback Company'); const before = state(f.db);
    const create = () => mode === 'guarded' ? f.intake.create(input) : f.repo.create(input);
    expect(create).toThrow('injected receipt failure after account insert');
    expect(state(f.db)).toEqual(before);
    expect(f.intake.status(input)).toEqual({ status: 'not_recorded', commandId: input.commandId });
    f.db.raw.exec('DROP TRIGGER fail_company_receipt');
    expect(create).not.toThrow();
    expect(f.db.raw.prepare('SELECT * FROM pm_accounts').all()).toHaveLength(1);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_commands').all()).toHaveLength(1);
  } finally { f.close(); }
});
