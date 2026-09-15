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

// Reviewed inbox compatibility uses real repository admissions and disposable encrypted storage.
import { companyDraftAdmissionReceiptSchema, type CompanyDraftAdmissionReceipt } from '../../src/shared/contracts/localCompanyDraftContract';
const T3 = '2026-09-08T12:03:00.000Z';
async function reviewedFixture(reuse: boolean, options: { routeValue?: string; excerpt?: string; quote?: string; verification?: 'published' | 'confirmed' } = {}) {
  const f = await createPmFixture(); let now = PM_NOW;
  try {
    const repo = new AccountRepository({ database: f.db, clock: { now: () => now }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const account = repo.create({ commandId: randomUUID(), name: 'Reviewed fictional company', domain: null });
    const source = { id: 'reviewed-source', url: 'https://example.invalid/contact', fetchedAt: T1, sha256: 'd'.repeat(64), excerpt: options.excerpt ?? 'Business email: team@example.invalid', permitted: true };
    const route = { id: 'reviewed-route', accountId: account.id, personId: null as null, channel: 'email' as const, value: options.routeValue ?? 'team@example.invalid', purpose: 'business' as const, verification: options.verification ?? 'published' as const, evidenceIds: [source.id] };
    now = T1;
    repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, sources: [source], claims: [], routes: reuse ? [route] : [] });
    now = T2;
    const commandId = randomUUID();
    const receipt = repo.admitReviewedBusinessEmail({ commandId, accountId: account.id, expectedAccountVersion: 2, email: route.value, sourceId: source.id, quote: options.quote ?? source.excerpt, selection: 'published_company_business_inbox' });
    expect(companyDraftAdmissionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({ commandId, accountId: account.id, accountVersion: 3 });
    expect(repo.companyDraftEligibility(account.id, receipt.recipientBinding.routeId, T2)).toMatchObject({ email: route.value.toLowerCase(), publication: receipt.publication });
    const stored = f.db.raw.prepare('SELECT admitted_at FROM pm_account_routes WHERE id=? AND version=?').get(receipt.recipientBinding.routeId, receipt.recipientBinding.routeVersion);
    expect(stored).toEqual({ admitted_at: reuse ? T1 : T2 });
    return { ...f, repo, account, source, route, receipt, setNow: (at: string) => { now = at; }, input: { database: f.db, accountId: account.id, workspaceId: 'reviewed-workspace', researchRevision: 1, asOf: T2 } };
  } catch (error) { f.close(); throw error; }
}
describe('reviewed inbox selected export compatibility', () => {
  it.each([false, true])('exports real reviewed admission with reused route=%s after successful receipt and eligibility validation', async reuse => {
    const f = await reviewedFixture(reuse); try {
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const record = exportSelectedAccountRecord(f.input);
      expect(record.account.version).toBe(3);
      expect(record.sources).toEqual([f.source]);
      expect(record.routes).toEqual([{ ...f.route, id: f.receipt.recipientBinding.routeId, version: 1 }]);
      expect(record.history.map(h => [h.at, h.account.version, h.routes.length])).toEqual([[PM_NOW, 1, 0], [T1, 2, reuse ? 1 : 0], [T2, 3, 1]]);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      closeDatabase(f.db);
      const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
      try {
        const reopenedBefore = reopened.raw.prepare('SELECT total_changes() AS n').get();
        expect(exportSelectedAccountRecord({ ...f.input, database: reopened })).toEqual(record);
        expect(reopened.raw.prepare('SELECT total_changes() AS n').get()).toEqual(reopenedBefore);
      } finally { closeDatabase(reopened); }
    } finally { f.close(); }
  });
});

import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
type ReviewedFixture = Awaited<ReturnType<typeof reviewedFixture>>;
type CorruptibleReviewedReceipt = CompanyDraftAdmissionReceipt & Record<string, unknown>;
// Corruption helpers below operate ONLY on each test's disposable encrypted fixture.
function corruptReviewedReceipt(f: ReviewedFixture, change: (receipt: CorruptibleReviewedReceipt) => void) {
  const receipt = structuredClone(f.receipt);
  change(receipt);
  const commandFingerprint = accountFingerprint({ kind: 'company_draft_email', commandId: receipt.commandId, accountId: receipt.accountId,
    expectedAccountVersion: receipt.accountVersion - 1, email: receipt.recipientBinding.email, sourceId: receipt.publication.sourceId,
    quote: receipt.publication.quote, selection: receipt.selection });
  f.db.raw.exec('DROP TRIGGER pm_account_commands_no_update');
  f.db.raw.prepare('UPDATE pm_account_commands SET result_json=?,fingerprint=? WHERE command_id=?').run(JSON.stringify(receipt), commandFingerprint, f.receipt.commandId);
}
function rejectsWithoutWrites(f: ReviewedFixture, pattern?: RegExp) {
  const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
  if (pattern) expect(() => exportSelectedAccountRecord(f.input)).toThrow(pattern);
  else expect(() => exportSelectedAccountRecord(f.input)).toThrow();
  expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
}
function addLaterRoute(f: ReviewedFixture) {
  f.setNow(T3);
  f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [], claims: [],
    routes: [{ ...f.route, id: f.receipt.recipientBinding.routeId, value: 'later@example.invalid' }] });
  f.input.asOf = T3;
}
describe('reviewed receipt historical and corruption bindings', () => {
  it.each([false, true])('retains older reviewed route receipt when a later ordinary command updates its route, reused=%s', async reuse => {
    const f = await reviewedFixture(reuse); try {
      addLaterRoute(f);
      const commandsBefore = f.db.raw.prepare('SELECT * FROM pm_account_commands ORDER BY account_version').all();
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const record = exportSelectedAccountRecord(f.input);
      expect(record.account.version).toBe(4);
      expect(record.history.map(h => [h.at, h.account.version, h.routes.map(r => [r.id, r.version, r.value])])).toEqual([
        [PM_NOW, 1, []], [T1, 2, reuse ? [[f.receipt.recipientBinding.routeId, 1, f.route.value]] : []],
        [T2, 3, [[f.receipt.recipientBinding.routeId, 1, f.route.value]]], [T3, 4, [[f.receipt.recipientBinding.routeId, 2, 'later@example.invalid']]],
      ]);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expect(f.db.raw.prepare('SELECT * FROM pm_account_commands ORDER BY account_version').all()).toEqual(commandsBefore);
      closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
      try {
        expect(exportSelectedAccountRecord({ ...f.input, database: reopened })).toEqual(record);
        expect(reopened.raw.prepare('SELECT * FROM pm_account_commands ORDER BY account_version').all()).toEqual(commandsBefore);
      } finally { closeDatabase(reopened); }
    } finally { f.close(); }
  });
  it.each([
    ['unknown receipt key', (r: CorruptibleReviewedReceipt) => { r.extra = true; }],
    ['unknown recipient key', (r: CorruptibleReviewedReceipt) => { Reflect.set(r.recipientBinding, 'extra', true); }],
    ['unknown publication key', (r: CorruptibleReviewedReceipt) => { Reflect.set(r.publication, 'extra', true); }],
    ['malformed command', (r: CorruptibleReviewedReceipt) => { r.commandId = 'not-a-uuid'; }],
    ['different command', (r: CorruptibleReviewedReceipt) => { r.commandId = randomUUID(); }],
    ['different account', (r: CorruptibleReviewedReceipt) => { r.accountId = 'missing-account'; }],
    ['different account version', (r: CorruptibleReviewedReceipt) => { r.accountVersion = 2; }],
    ['missing route', (r: CorruptibleReviewedReceipt) => { r.recipientBinding.routeId = 'missing-route'; }],
    ['missing route version', (r: CorruptibleReviewedReceipt) => { r.recipientBinding.routeVersion = 2; }],
    ['non-null recipient person', (r: CorruptibleReviewedReceipt) => { Reflect.set(r.recipientBinding, 'personId', 'historical-person'); }],
    ['different recipient email', (r: CorruptibleReviewedReceipt) => { r.recipientBinding.email = 'other@example.invalid'; r.publication.quote = 'Business email: other@example.invalid'; }],
    ['noncanonical email case', (r: CorruptibleReviewedReceipt) => { r.recipientBinding.email = 'TEAM@example.invalid'; }],
    ['noncanonical email whitespace', (r: CorruptibleReviewedReceipt) => { r.recipientBinding.email = ' team@example.invalid '; }],
    ['missing publication source', (r: CorruptibleReviewedReceipt) => { r.publication.sourceId = 'missing-source'; }],
    ['different publication URL', (r: CorruptibleReviewedReceipt) => { r.publication.url = 'https://example.invalid/other'; }],
    ['different publication hash', (r: CorruptibleReviewedReceipt) => { r.publication.sha256 = 'e'.repeat(64); }],
    ['different publication fetched time', (r: CorruptibleReviewedReceipt) => { r.publication.fetchedAt = PM_NOW; }],
    ['future publication fetched time', (r: CorruptibleReviewedReceipt) => { r.publication.fetchedAt = T3; }],
    ['unpublished quote', (r: CorruptibleReviewedReceipt) => { r.publication.quote = 'Invented publication: team@example.invalid'; }],
    ['quote without mailbox', (r: CorruptibleReviewedReceipt) => { r.publication.quote = 'Business email'; }],
    ['different selection', (r: CorruptibleReviewedReceipt) => { Reflect.set(r, 'selection', 'other'); }],
  ] as const)('rejects %s with independently recomputed command fingerprint', async (_kind, change) => {
    const f = await reviewedFixture(true); try {
      corruptReviewedReceipt(f, change);
      rejectsWithoutWrites(f, _kind.startsWith('noncanonical') ? /noncanonical record/ : undefined);
    } finally { f.close(); }
  });
  it.each(['malformed-json', 'stored-command', 'stored-fingerprint', 'old-duplicate', 'old-unknown', 'creation-unknown', 'creation-identity'])(
    'retains strict command and original receipt checks: %s', async kind => {
      const f = await reviewedFixture(true); try {
        // Intentional SQL corruption of this disposable fixture only.
        f.db.raw.exec('DROP TRIGGER pm_account_commands_no_update');
        if (kind === 'malformed-json') {
          f.db.raw.pragma('ignore_check_constraints = ON');
          f.db.raw.prepare("UPDATE pm_account_commands SET result_json='{' WHERE command_id=?").run(f.receipt.commandId);
        }
        if (kind === 'stored-command') f.db.raw.prepare('UPDATE pm_account_commands SET command_id=? WHERE command_id=?').run(randomUUID(), f.receipt.commandId);
        if (kind === 'stored-fingerprint') f.db.raw.prepare('UPDATE pm_account_commands SET fingerprint=? WHERE command_id=?').run('0'.repeat(64), f.receipt.commandId);
        if (kind === 'old-duplicate') f.db.raw.prepare("UPDATE pm_account_commands SET result_json=json_set(result_json,'$.duplicate',json('true')) WHERE account_id=? AND account_version=2").run(f.account.id);
        if (kind === 'old-unknown' || kind === 'creation-unknown') f.db.raw.prepare("UPDATE pm_account_commands SET result_json=json_set(result_json,'$.extra',1) WHERE account_id=? AND account_version=?").run(f.account.id, kind === 'old-unknown' ? 2 : 1);
        if (kind === 'creation-identity') f.db.raw.prepare("UPDATE pm_account_commands SET result_json=json_set(result_json,'$.id','different') WHERE account_id=? AND account_version=1").run(f.account.id);
        rejectsWithoutWrites(f);
      } finally { f.close(); }
    });
  it.each(['account', 'route', 'publication'])('rejects a real foreign %s receipt binding', async kind => {
    const f = await reviewedFixture(true); try {
      const foreign = f.repo.create({ commandId: randomUUID(), name: 'Foreign fixture company', domain: null });
      const source = { ...f.source, id: 'foreign-source', sha256: 'e'.repeat(64) };
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: foreign.id, expectedVersion: 1, sources: [source], claims: [],
        routes: [{ ...f.route, id: 'foreign-route', accountId: foreign.id, evidenceIds: [source.id] }] });
      corruptReviewedReceipt(f, receipt => {
        if (kind === 'account') receipt.accountId = foreign.id;
        if (kind === 'route') receipt.recipientBinding.routeId = 'foreign-route';
        if (kind === 'publication') receipt.publication = { ...receipt.publication, sourceId: source.id, sha256: source.sha256 };
      });
      rejectsWithoutWrites(f);
    } finally { f.close(); }
  });
  it('rejects a future route version even when that version exists in the selected ledger', async () => {
    const f = await reviewedFixture(true); try {
      addLaterRoute(f);
      corruptReviewedReceipt(f, receipt => { receipt.recipientBinding.routeVersion = 2; receipt.recipientBinding.email = 'later@example.invalid'; receipt.publication.quote = 'Business email: later@example.invalid'; });
      rejectsWithoutWrites(f, /reviewed route/);
    } finally { f.close(); }
  });
  it.each(['person_id', 'channel', 'value', 'purpose', 'verification'])('rejects a ledger route whose %s no longer matches the frozen binding', async column => {
    const f = await reviewedFixture(true); try {
      const values = { person_id: 'historical-person', channel: 'phone', value: 'other@example.invalid', purpose: 'unknown', verification: 'unverified' };
      // Intentional SQL corruption of this disposable fixture only.
      f.db.raw.exec('DROP TRIGGER pm_account_routes_no_update');
      f.db.raw.prepare(`UPDATE pm_account_routes SET ${column}=? WHERE id=?`).run(values[column as keyof typeof values], f.receipt.recipientBinding.routeId);
      rejectsWithoutWrites(f, /reviewed route/);
    } finally { f.close(); }
  });
});

describe('reviewed publication timing and canonical evidence', () => {
  it('accepts a real reused confirmed uppercase route without rewriting its canonical ledger value', async () => {
    const f = await reviewedFixture(true, { routeValue: 'TEAM@example.invalid', verification: 'confirmed' }); try {
      expect(f.receipt.recipientBinding.email).toBe('team@example.invalid');
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const record = exportSelectedAccountRecord(f.input);
      expect(record.routes[0]).toMatchObject({ value: 'TEAM@example.invalid', verification: 'confirmed' });
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });
  it('accepts a quote whose later source occurrence contains the full mailbox token', async () => {
    const f = await reviewedFixture(true, { excerpt: 'prefixteam@example.invalid\nBusiness email: team@example.invalid', quote: 'team@example.invalid' }); try {
      expect(exportSelectedAccountRecord(f.input).sources).toEqual([f.source]);
    } finally { f.close(); }
  });
  it('rejects a clipped quote that is only a substring of a different source mailbox', async () => {
    const f = await reviewedFixture(true, { quote: 'team@example.invalid' }); try {
      // Intentional SQL corruption of this disposable fixture only.
      f.db.raw.exec('DROP TRIGGER pm_account_sources_no_update');
      f.db.raw.prepare('UPDATE pm_account_sources SET excerpt=? WHERE id=?').run('Business email: prefixteam@example.invalid', f.source.id);
      rejectsWithoutWrites(f, /reviewed publication/);
    } finally { f.close(); }
  });
  it('rejects a selected source admitted only after the reviewed receipt, even with matching publication fields', async () => {
    const f = await reviewedFixture(true); try {
      f.setNow(T3);
      const future = { ...f.source, id: 'future-source', fetchedAt: T3, sha256: 'f'.repeat(64) };
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [future], claims: [], routes: [] });
      f.input.asOf = T3;
      expect(exportSelectedAccountRecord(f.input).sources).toEqual([f.source, future]);
      corruptReviewedReceipt(f, r => { r.publication = { sourceId: future.id, url: future.url, sha256: future.sha256, fetchedAt: future.fetchedAt, quote: future.excerpt }; });
      // Also corrupt this disposable route edge so receipt-source inclusion alone cannot reject it.
      f.db.raw.exec('DROP TRIGGER pm_account_route_evidence_no_update');
      f.db.raw.prepare('UPDATE pm_account_route_evidence SET source_id=? WHERE route_id=?').run(future.id, f.receipt.recipientBinding.routeId);
      rejectsWithoutWrites(f, /missing or foreign evidence/);
    } finally { f.close(); }
  });
  it('accepts mixed repeated reviewed admissions but rejects a receipt bound to an already superseded route', async () => {
    const f = await reviewedFixture(true); try {
      f.setNow(T3);
      f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, sources: [], claims: [], routes: [f.route] });
      const T4 = '2026-09-08T12:04:00.000Z';
      f.setNow(T4);
      const receipt = f.repo.admitReviewedBusinessEmail({ commandId: randomUUID(), accountId: f.account.id, expectedAccountVersion: 4,
        email: f.route.value, sourceId: f.source.id, quote: f.source.excerpt, selection: 'published_company_business_inbox' });
      expect(receipt.recipientBinding.routeVersion).toBe(2);
      f.input.asOf = T4;
      expect(exportSelectedAccountRecord(f.input).history.map(h => h.account.version)).toEqual([1, 2, 3, 4, 5]);
      // Intentional SQL corruption of this disposable fixture only. The command fingerprint
      // does not include the chosen route version, so this isolates the temporal route binding.
      receipt.recipientBinding.routeVersion = 1;
      f.db.raw.exec('DROP TRIGGER pm_account_commands_no_update');
      f.db.raw.prepare('UPDATE pm_account_commands SET result_json=? WHERE command_id=?').run(JSON.stringify(receipt), receipt.commandId);
      rejectsWithoutWrites(f, /reviewed route/);
    } finally { f.close(); }
  });
});
