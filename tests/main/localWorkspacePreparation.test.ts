import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { LocalCompanyDraftRepository } from '../../src/main/domain/accounts/localCompanyDraftRepository';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { localAccountPreparationSchema, localWorkspaceSnapshotSchema, type LocalAccountSnapshot } from '../../src/shared/contracts/localWorkspaceContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const NOW = '2026-09-15T18:00:00.000Z';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Synthetic local companies only. Ids and names both sort in the reverse of readiness so ranking is observable. */
async function fixture() {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  try {
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const queue: string[] = [];
    const clock = { now: () => NOW }, ids = { next: () => queue.shift() ?? randomUUID() };
    const repo = new AccountRepository({ database, clock, ids, sourcePolicy: { attest: source => source.sha256 === sha(source.excerpt) } });
    const drafts = new LocalCompanyDraftRepository({ database, clock, ids });
    const create = (id: string, name: string, domain: string) => { queue.push(id); return repo.create({ commandId: randomUUID(), name, domain }); };
    const source = (accountId: string, excerpt: string) => {
      const id = randomUUID(), version = (database.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(accountId) as { version: number }).version;
      repo.admitEvidence({ commandId: randomUUID(), accountId, expectedVersion: version, claims: [], routes: [],
        sources: [{ id, url: 'https://company.example/contact', fetchedAt: NOW, excerpt, permitted: true, sha256: sha(excerpt) }] });
      return id;
    };
    const inbox = (accountId: string, email: string) => {
      const quote = `Business email: ${email}`, sourceId = source(accountId, quote);
      const version = (database.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(accountId) as { version: number }).version;
      return repo.admitReviewedBusinessEmail({ commandId: randomUUID(), accountId, expectedAccountVersion: version, email, sourceId, quote, selection: 'published_company_business_inbox' });
    };
    const alpha = create('a-alpha', 'Alpha New PM', 'alpha.example');
    // A queued attempt is not saved research. Only completed research or saved sources count.
    repo.enqueue({ commandId: randomUUID(), accountId: alpha.id, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 1000, maxCostMicros: 1000 } });
    const bravo = create('b-bravo', 'Bravo Routeless PM', 'bravo.example');
    source(bravo.id, 'Bravo manages 40 residential units. No published inbox.');
    const charlie = create('c-charlie', 'Charlie Ready PM', 'charlie.example');
    inbox(charlie.id, 'info@charlie.example');
    const delta = create('d-delta', 'Delta Draft PM', 'delta.example');
    const admitted = inbox(delta.id, 'hello@delta.example');
    const opened = drafts.open({ commandId: randomUUID(), accountId: delta.id, routeId: admitted.recipientBinding.routeId,
      expectedRouteVersion: admitted.recipientBinding.routeVersion, expectedAccountVersion: admitted.accountVersion });
    expect(opened.current.draft.status).toBe('unsent');
    const api = createLocalWorkspaceProvider({ withDatabase: async operation => operation(database), withDomain: async () => { throw new Error('Domain unavailable in this fixture'); } });
    return { database, api, repo, alpha, bravo, charlie, delta, close() { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); } };
  } catch (error) { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); throw error; }
}

describe('local preparation queue from saved evidence', () => {
  it('ranks saved companies by readiness with one local next step and reason each, without writes', async () => {
    const f = await fixture();
    try {
      f.database.raw.exec('PRAGMA query_only=ON');
      const before = f.database.raw.prepare('SELECT total_changes() AS count').get();
      const result = await f.api.get();
      expect(f.database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(localWorkspaceSnapshotSchema.parse(result)).toEqual(result);
      if (result.accounts.state !== 'available') throw new Error('Expected available local accounts');
      expect(result.accounts.snapshots.map(s => s.account.id)).toEqual([f.delta.id, f.charlie.id, f.bravo.id, f.alpha.id]);
      const byId = Object.fromEntries(result.accounts.snapshots.map(s => [s.account.id, s.preparation]));
      expect(byId[f.delta.id]).toMatchObject({ researched: true, unsentDraft: true, businessRoute: true, nextStep: 'reopen_draft' });
      expect(byId[f.charlie.id]).toMatchObject({ researched: true, unsentDraft: false, businessRoute: true, nextStep: 'draft' });
      expect(byId[f.bravo.id]).toMatchObject({ researched: true, unsentDraft: false, businessRoute: false, nextStep: 'add_route' });
      expect(byId[f.alpha.id]).toMatchObject({ researched: false, unsentDraft: false, businessRoute: false, nextStep: 'research' });
      expect(byId[f.alpha.id]?.reason).toMatch(/attempt/i);
      expect(byId[f.bravo.id]?.reason).not.toMatch(/attempt/i);
      for (const snapshot of result.accounts.snapshots) {
        expect(snapshot.preparation?.reason.trim().length).toBeGreaterThan(0);
        expect(snapshot.preparation?.reason).not.toMatch(/worker|authority|owned|automatic/i);
      }
      // Ranking is a projection of the same rows the plain read returns: identities and evidence are untouched.
      const withoutPreparation = (snapshot: LocalAccountSnapshot) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'preparation'));
      expect([...result.accounts.snapshots].sort((a, b) => a.account.id < b.account.id ? -1 : 1).map(withoutPreparation))
        .toEqual([f.alpha.id, f.bravo.id, f.charlie.id, f.delta.id].map(id => new AccountRepository({ database: f.database, clock: { now: () => result.generatedAt }, ids: { next: () => { throw new Error('No identity'); } } }).snapshot(id, result.generatedAt)));
      expect(await f.api.get()).toMatchObject({ accounts: { snapshots: result.accounts.snapshots.map(s => ({ account: { id: s.account.id }, preparation: s.preparation })) } });
    } finally { f.close(); }
  });
  it('keeps unknown honest: a failed per-account read yields unknown, never ready, and unavailable accounts carry no preparation claim', async () => {
    const f = await fixture();
    try {
      f.database.raw.exec('ALTER TABLE local_company_email_drafts RENAME TO local_company_email_drafts_missing');
      f.database.raw.exec('PRAGMA query_only=ON');
      const unknown = await f.api.get();
      if (unknown.accounts.state !== 'available') throw new Error('Expected available local accounts');
      expect(unknown.accounts.snapshots.map(s => s.account.id)).toEqual([f.alpha.id, f.bravo.id, f.charlie.id, f.delta.id]);
      for (const snapshot of unknown.accounts.snapshots) {
        expect(snapshot.preparation).toMatchObject({ researched: null, unsentDraft: null, businessRoute: null, nextStep: 'unknown' });
        expect(snapshot.preparation?.reason).toMatch(/unavailable/i);
      }
      f.database.raw.exec('PRAGMA query_only=OFF; PRAGMA ignore_check_constraints=ON');
      f.database.raw.prepare("UPDATE pm_accounts SET name='' WHERE id=?").run(f.alpha.id);
      const unavailable = await f.api.get();
      expect(unavailable.accounts).toEqual({ state: 'unavailable', snapshots: [] });
      expect(JSON.stringify(unavailable)).not.toContain('preparation');
    } finally { f.close(); }
  });
  it('gives a parked research attempt its own honest reason without changing the step or the ranking', async () => {
    const f = await fixture();
    try {
      f.repo.enqueue({ commandId: randomUUID(), accountId: f.bravo.id, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 1000, maxCostMicros: 1000 } });
      // The same row state the repository leaves behind for an expired running lease: no receipt, nothing saved.
      expect(f.database.raw.prepare("UPDATE pm_account_research_jobs SET state='parked' WHERE account_id IN (?,?) AND state='queued'").run(f.alpha.id, f.bravo.id).changes).toBe(2);
      f.database.raw.exec('PRAGMA query_only=ON');
      const result = await f.api.get();
      if (result.accounts.state !== 'available') throw new Error('Expected available local accounts');
      expect(result.accounts.snapshots.map(s => s.account.id)).toEqual([f.delta.id, f.charlie.id, f.bravo.id, f.alpha.id]);
      const byId = Object.fromEntries(result.accounts.snapshots.map(s => [s.account.id, s.preparation]));
      expect(byId[f.alpha.id]).toMatchObject({ researched: false, unsentDraft: false, businessRoute: false, nextStep: 'research' });
      expect(byId[f.alpha.id]?.reason).toMatch(/parked/i);
      expect(byId[f.alpha.id]?.reason).not.toMatch(/no research or saved sources yet|not completed/i);
      expect(byId[f.alpha.id]?.reason).not.toMatch(/worker|authority|owned|automatic/i);
      // A saved source is still research: the parked attempt neither demotes bravo nor rewrites its reason.
      expect(byId[f.bravo.id]).toMatchObject({ researched: true, unsentDraft: false, businessRoute: false, nextStep: 'add_route' });
      expect(byId[f.bravo.id]?.reason).not.toMatch(/parked|attempt/i);
    } finally { f.close(); }
  });
  it('binds the wire contract: the step follows the flags, and snapshots without preparation still parse', () => {
    const base: Record<string, unknown> = { scope: 'local_database', generatedAt: NOW, workflowMode: 'legacy', transitionReceipt: null };
    const snapshot: LocalAccountSnapshot = { account: { id: 'x', name: 'Fixture PM', domain: null, version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64) };
    expect(localWorkspaceSnapshotSchema.safeParse({ ...base, accounts: { state: 'available', snapshots: [snapshot] } }).success).toBe(true);
    const flags = { researched: true, unsentDraft: false, businessRoute: true, reason: 'Research and a published inbox are saved locally.' };
    expect(localAccountPreparationSchema.safeParse({ ...flags, nextStep: 'draft' }).success).toBe(true);
    expect(localAccountPreparationSchema.safeParse({ ...flags, nextStep: 'reopen_draft' }).success).toBe(false);
    expect(localAccountPreparationSchema.safeParse({ ...flags, researched: null, nextStep: 'draft' }).success).toBe(false);
    expect(localAccountPreparationSchema.safeParse({ ...flags, researched: null, unsentDraft: null, businessRoute: null, nextStep: 'unknown' }).success).toBe(true);
    expect(localAccountPreparationSchema.safeParse({ ...flags, nextStep: 'ready' }).success).toBe(false);
    expect(localAccountPreparationSchema.safeParse({ ...flags, nextStep: 'draft', reason: '' }).success).toBe(false);
    expect(localAccountPreparationSchema.safeParse({ ...flags, nextStep: 'draft', owner: 'worker' }).success).toBe(false);
    expect(localWorkspaceSnapshotSchema.safeParse({ ...base, accounts: { state: 'available', snapshots: [{ ...snapshot, preparation: { ...flags, nextStep: 'draft' } }] } }).success).toBe(true);
    expect(localWorkspaceSnapshotSchema.safeParse({ ...base, accounts: { state: 'unavailable', snapshots: [] } }).success).toBe(true);
  });
});
