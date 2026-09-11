import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import { accountRecordSchema } from '../../src/shared/contracts/accountRecordContract';
import { accountRecordSchema as workerSchema } from '../../cloud/lambdas/delegated-worker/src/workerAccountRepository';
const T1 = '2026-09-08T12:01:00.000Z';
const T2 = '2026-09-08T12:02:00.000Z';
async function fixture() {
  const f = await createPmFixture(); let now = PM_NOW;
  const repo = new AccountRepository({ database: f.db, clock: { now: () => now }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const account = repo.create({ commandId: randomUUID(), name: 'Selected fictional PM', domain: null });
  const foreign = repo.create({ commandId: randomUUID(), name: 'Unselected secret', domain: null });
  now = T1;
  const source = { id: 'selected-source', url: 'https://example.invalid/team', fetchedAt: T1, sha256: 'a'.repeat(64), excerpt: 'Residential PM team', permitted: true };
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, sources: [source],
    claims: [{ key: 'residential_scope', kind: 'fact', value: 'Residential', evidenceIds: [source.id] }],
    routes: [{ id: 'real-route', accountId: account.id, personId: null, channel: 'email', value: 'team@example.invalid', purpose: 'business', verification: 'published', evidenceIds: [source.id] }] });
  now = T2;
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 2, sources: [], claims: [],
    routes: [{ id: 'real-route', accountId: account.id, personId: null, channel: 'email', value: 'new@example.invalid', purpose: 'business', verification: 'published', evidenceIds: [source.id] }] });
  return { ...f, repo, account, foreign, source };
}
describe('selected account bootstrap snapshot', () => {
  it('exports one strict canonical record with real IDs and historical route revisions, unchanged after reopen', async () => {
    const f = await fixture(); try {
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const record = exportSelectedAccountRecord({ database: f.db, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 });
      expect(workerSchema).toBe(accountRecordSchema);
      expect(workerSchema.parse(record)).toEqual(record);
      expect(record.account).toEqual({ ...f.account, version: 3 });
      expect(record.sources).toEqual([f.source]);
      expect(record.history.map(h => [h.at, h.account.version, h.routes.map(r => [r.id, r.version, r.value])])).toEqual([
        [PM_NOW, 1, []], [T1, 2, [['real-route', 1, 'team@example.invalid']]], [T2, 3, [['real-route', 2, 'new@example.invalid']]],
      ]);
      expect(JSON.stringify(record)).not.toMatch(/Unselected secret|historical-person|credentials|claim_token|authority|jobs/);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
      try { expect(exportSelectedAccountRecord({ database: reopened, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 })).toEqual(record); }
      finally { closeDatabase(reopened); }
    } finally { f.close(); }
  });
  it('rejects missing selection, historical truncation of a newer account, unknown options and resource limit overflow', async () => {
    const f = await fixture(); try {
      const input = { database: f.db, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 };
      expect(() => exportSelectedAccountRecord({ ...input, accountId: 'missing' })).toThrow();
      expect(() => exportSelectedAccountRecord({ ...input, asOf: PM_NOW })).toThrow();
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxHistory: 1 } })).toThrow(/limit/i);
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxRoutes: 1 } })).toThrow(/limit/i);
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxBytes: 10 } })).toThrow(/limit/i);
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxBytes: Number.MAX_SAFE_INTEGER } })).toThrow();
      expect(() => accountRecordSchema.parse({ ...exportSelectedAccountRecord(input), authority: true })).toThrow();
      expect(() => accountRecordSchema.parse({ ...exportSelectedAccountRecord(input), researchRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    } finally { f.close(); }
  });
  it.each(['source-key', 'claim-reference', 'route-reference', 'history-gap', 'route-gap', 'future-source'])('fails closed on %s ledger corruption without modifying it', async kind => {
    const f = await fixture(); try {
      if (kind === 'source-key' || kind === 'future-source') {
        f.db.raw.exec('DROP TRIGGER pm_account_sources_no_update');
        f.db.raw.prepare(`UPDATE pm_account_sources SET ${kind === 'source-key' ? "source_key='wrong'" : "fetched_at='2099-01-01T00:00:00.000Z'"} WHERE account_id=?`).run(f.account.id);
      }
      if (kind === 'claim-reference') {
        f.db.raw.exec('DROP TRIGGER pm_account_claims_no_update');
        f.db.raw.prepare("UPDATE pm_account_claims SET claim_json=json_set(claim_json,'$.evidenceIds[0]','foreign-source') WHERE account_id=?").run(f.account.id);
      }
      if (kind === 'route-reference') {
        f.db.raw.exec('DROP TRIGGER pm_account_route_evidence_no_delete');
        f.db.raw.prepare('DELETE FROM pm_account_route_evidence WHERE account_id=? AND route_version=1').run(f.account.id);
      }
      if (kind === 'history-gap') {
        f.db.raw.exec('DROP TRIGGER pm_account_commands_no_delete');
        f.db.raw.prepare('DELETE FROM pm_account_commands WHERE account_id=? AND account_version=2').run(f.account.id);
      }
      if (kind === 'route-gap') {
        f.db.raw.exec('DROP TRIGGER pm_account_route_evidence_no_delete; DROP TRIGGER pm_account_routes_no_delete');
        f.db.raw.prepare('DELETE FROM pm_account_route_evidence WHERE account_id=? AND route_version=1').run(f.account.id);
        f.db.raw.prepare('DELETE FROM pm_account_routes WHERE account_id=? AND version=1').run(f.account.id);
      }
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      expect(() => exportSelectedAccountRecord({ database: f.db, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 })).toThrow();
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });
  it('requires an explicit research stream base and fences existing same-stream and foreign workspace cursors', async () => {
    const f = await fixture(); try {
      const input = { database: f.db, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 };
      expect(exportSelectedAccountRecord(input).researchRevision).toBe(1);
      const withoutBase = { database: f.db, workspaceId: input.workspaceId, accountId: f.account.id, asOf: T2 };
      expect(() => Reflect.apply(exportSelectedAccountRecord, null, [withoutBase])).toThrow();
      const repo = new DelegationRepository({ database: f.db, workspaceId: input.workspaceId, clock: { now: () => T2 } });
      repo.applyWorkerEvent({ id: 'research-receipt', workspaceId: input.workspaceId, accountId: f.account.id, authorityGeneration: 0, aggregateVersion: 1,
        kind: 'research.receipt', payload: { jobId: 'actual-receipt-job', receiptCommandId: null, status: 'parked', costMicros: null, observedAt: T2 } });
      expect(exportSelectedAccountRecord(input).researchRevision).toBe(1);
      expect(() => exportSelectedAccountRecord({ ...input, researchRevision: 2 })).toThrow(/cursor/i);
      expect(() => exportSelectedAccountRecord({ ...input, workspaceId: 'foreign' })).toThrow(/workspace/i);
    } finally { f.close(); }
  });

  it('rejects equal-time route revisions rather than dropping or inventing historical identities', async () => {
    const f = await createPmFixture(); try {
      const a = f.repo.create({ commandId: randomUUID(), name: 'Same-time PM', domain: null });
      const source = { id: 'source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Team', permitted: true };
      const route = { id: 'route', accountId: a.id, personId: null as string | null, channel: 'email' as const, value: 'one@example.invalid', purpose: 'business' as const, verification: 'published' as const, evidenceIds: [source.id] };
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: a.id, expectedVersion: 1, sources: [source], claims: [], routes: [route] });
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: a.id, expectedVersion: 2, sources: [], claims: [], routes: [{ ...route, value: 'two@example.invalid' }] });
      expect(() => exportSelectedAccountRecord({ database: f.db, accountId: a.id, workspaceId: 'selected-workspace', researchRevision: 1, asOf: PM_NOW })).toThrow(/ambiguous/i);
    } finally { f.close(); }
  });

  it('enforces source/claim limits and refuses actual foreign source references even in corrupt SQL', async () => {
    const f = await fixture(); try {
      const source = { ...f.source, id: 'second-source', sha256: 'b'.repeat(64), fetchedAt: T2 };
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [source], routes: [],
        claims: [{ key: 'pain', kind: 'fact', value: 'Documented', evidenceIds: [source.id] }] });
      const input = { database: f.db, workspaceId: 'selected-workspace', researchRevision: 1, accountId: f.account.id, asOf: T2 };
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxSources: 1 } })).toThrow(/limit/i);
      expect(() => exportSelectedAccountRecord({ ...input, limits: { maxClaims: 1 } })).toThrow(/limit/i);
      expect(() => Reflect.apply(exportSelectedAccountRecord, null, [{ ...input, exportEverything: true }])).toThrow();
      const foreign = { ...source, id: 'foreign-source', sha256: 'c'.repeat(64) };
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.foreign.id, expectedVersion: 1, sources: [foreign], claims: [], routes: [] });
      expect(exportSelectedAccountRecord(input).sources.map(s => s.id)).not.toContain(foreign.id);
      f.db.raw.pragma('foreign_keys = OFF');
      f.db.raw.exec('DROP TRIGGER pm_account_claims_no_update; DROP TRIGGER pm_account_claim_evidence_no_update');
      f.db.raw.prepare("UPDATE pm_account_claims SET claim_json=json_set(claim_json,'$.evidenceIds[0]',?) WHERE account_id=? AND json_extract(claim_json,'$.key')='pain'").run(foreign.id, f.account.id);
      f.db.raw.prepare('UPDATE pm_account_claim_evidence SET source_id=? WHERE account_id=? AND source_id=?').run(foreign.id, f.account.id, source.id);
      expect(() => exportSelectedAccountRecord(input)).toThrow(/foreign evidence/i);
    } finally { f.close(); }
  });

});
