import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { createSqlAccountRoutePolicy } from '../../src/main/domain/accounts/accountOutreach';
import { evaluateFederalEvidence } from '../../src/main/domain/compliance/contactCompliance';
import { AccountRoutePolicyStore } from '../../src/main/delegation/accountRoutePolicyStore';
import { createAccountRoutePolicyImport } from '../../src/main/delegation/accountRoutePolicyImport';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { AccountRoutePolicyImportArtifact, PolicyImportPreview } from '../../src/shared/contracts/accountRoutePolicyImportContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const NOW = '2026-09-08T14:00:00.000Z';
const EXPIRES = '2026-09-09T14:00:00.000Z';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(count = 1) {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  let db = openDatabase({ path: temp.path, key });
  cleanups.push(() => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  let now = NOW; const clock = { now: () => now };
  const repository = () => new AccountRepository({ database: db, clock, ids: { next: randomUUID }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
  const content = 'Fictional document for owner review: phone evidence, jurisdiction, validation and clearance assertions. Not native government verification.';
  const artifact: AccountRoutePolicyImportArtifact = { format: 'fss-account-route-policy-review', version: 1, workspaceId: WORKSPACE,
    documents: [{ id: 'doc', mediaType: 'text/plain', content, sha256: hash(content) }], rows: [] };
  for (let index = 0; index < count; index++) {
    const repo = repository(); const account = repo.create({ commandId: randomUUID(), name: `Fictional PM ${index}`, domain: null });
    const routeId = randomUUID(); const sourceId = randomUUID();
    repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, claims: [],
      sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: NOW, sha256: hash('fictional route'), excerpt: 'Published phone only, not compliance permission', permitted: true }],
      routes: [{ id: routeId, accountId: account.id, personId: null, channel: 'phone', value: `+1401555010${index}`, purpose: 'business', evidenceIds: [sourceId], verification: 'published' }] });
    artifact.rows.push({ rowId: `row-${index}`, accountId: account.id, routeId, expectedRouteVersion: 1, expectedEvidenceFingerprint: repo.snapshot(account.id, NOW).fingerprint,
      targetSourceIds: [sourceId], documentIds: ['doc'], citations: [{ documentId: 'doc', field: 'contact.evidence', excerpt: content }],
      observedAt: NOW, effectiveAt: NOW, expiresAt: EXPIRES, operation: 'observe', reason: 'Review actual supplied documentary statements',
      policy: { contact: { kind: 'phone', normalizedValue: `+1401555010${index}`, validationState: 'unverified', evidence: { source: 'manual_import', federalStatus: 'unknown', tcpaFlag: null, coveredAreaCode: null, scrubbedAt: null, expiresAt: null } }, jurisdiction: null, clearance: null } });
  }
  let bytes: Uint8Array | null = Buffer.from(JSON.stringify(artifact)); let confirmed = true; let confirmations = 0;
  let onConfirm: (preview: PolicyImportPreview) => void = () => {};
  const controller = new AbortController();
  const service = () => createAccountRoutePolicyImport({ workspaceId: WORKSPACE, clock,
    databaseGate: { withDatabase: async run => run(db, controller.signal) },
    native: { selectArtifact: async () => bytes, confirmReview: async ({ preview }) => { confirmations++; onConfirm(preview); return confirmed; } } });
  let importer = service();
  const select = async () => { bytes = Buffer.from(JSON.stringify(artifact)); return (await importer.selectAndPreview())!; };
  const confirm = (preview: PolicyImportPreview) => importer.confirm({ previewId: preview.previewId, expectedArtifactHash: preview.artifactHash, reviewReason: 'Owner reviewed the exact fictional document batch' });
  return { get db() { return db; }, artifact, repository, clock, select, confirm, get importer() { return importer; }, get confirmations() { return confirmations; },
    setConfirmed(value: boolean) { confirmed = value; }, setBytes(value: Uint8Array | null) { bytes = value; }, setNow(value: string) { now = value; },
    onConfirm(fn: typeof onConfirm) { onConfirm = fn; }, controller,
    reopen() { closeDatabase(db); db = openDatabase({ path: temp.path, key }); importer = service(); },
    seedPolicy(index: number, policy = artifact.rows[index].policy) { const row = artifact.rows[index]; const receipt = { id: randomUUID(), accountId: row.accountId, routeId: row.routeId, routeVersion: row.expectedRouteVersion,
      canonicalTarget: row.policy.contact.normalizedValue, evidenceFingerprint: row.expectedEvidenceFingerprint, revision: 1, evidenceRef: row.targetSourceIds[0], evidenceIds: row.targetSourceIds,
      provenance: 'fictional-trusted-attestation', observedAt: NOW, effectiveAt: NOW, expiresAt: EXPIRES, policy };
      new AccountRoutePolicyStore({ database: db, clock, admission: { attest: value => accountFingerprint(value) === accountFingerprint(receipt) } }).admit(receipt); return receipt; },
  };
}

describe('normal owner-reviewed policy import through actual encrypted SQL', () => {
  it('persists exact immutable bytes/review and actual receipt without inventing clearance or sources', async () => {
    const f = await fixture(); const before = f.repository().snapshot(f.artifact.rows[0].accountId, NOW);
    const preview = await f.select(); expect(Object.isFrozen(preview)).toBe(true);
    const result = await f.confirm(preview); expect(result.rows[0].status).toBe('admitted'); expect(f.confirmations).toBe(1);
    const review = f.db.raw.prepare('SELECT * FROM account_route_policy_import_reviews').get() as { artifact_bytes: Buffer; artifact_sha256: string; review_reason: string };
    expect(hash(review.artifact_bytes)).toBe(review.artifact_sha256); expect(review.artifact_sha256).toBe(preview.artifactHash);
    const receipt = f.db.raw.prepare('SELECT policy_json,provenance,receipt_fingerprint FROM pm_account_route_policy_receipts').get() as { policy_json: string; provenance: string; receipt_fingerprint: string };
    expect(JSON.parse(receipt.policy_json).contact.evidence.federalStatus).toBe('unknown'); expect(receipt.provenance).toBe(result.reviewId);
    expect(result.rows[0].receiptFingerprint).toBe(receipt.receipt_fingerprint);
    expect(f.repository().snapshot(f.artifact.rows[0].accountId, NOW)).toEqual(before);
    expect(f.db.raw.prepare('SELECT * FROM persons').all()).toEqual([]); expect(f.db.raw.prepare('SELECT * FROM pm_account_sources').all()).toHaveLength(1);
    expect(() => f.db.raw.prepare('UPDATE account_route_policy_import_reviews SET review_reason=?').run('changed')).toThrow();
    expect(() => f.db.raw.prepare('DELETE FROM account_route_policy_import_reviews').run()).toThrow();
  });
  it('requires private native confirmation, not renderer approval', async () => {
    const f = await fixture(); const preview = await f.select(); f.setConfirmed(false);
    await expect(f.confirm(preview)).rejects.toThrow('review_cancelled');
    expect(f.db.raw.prepare('SELECT * FROM account_route_policy_import_reviews').all()).toEqual([]);
    await expect(f.importer.confirm({ previewId: preview.previewId, expectedArtifactHash: preview.artifactHash, reviewReason: 'reason', approved: true } as never)).rejects.toThrow();
  });
  it.each(['document_hash', 'oversized', 'wrong_workspace', 'non_utf8'] as const)('rejects actual %s artifact boundary', async mode => {
    const f = await fixture();
    if (mode === 'document_hash') f.artifact.documents[0].sha256 = '0'.repeat(64);
    if (mode === 'wrong_workspace') f.artifact.workspaceId = randomUUID();
    f.setBytes(mode === 'oversized' ? Buffer.alloc(1048577) : mode === 'non_utf8' ? Uint8Array.from([0xff]) : Buffer.from(JSON.stringify(f.artifact)));
    await expect(f.importer.selectAndPreview()).rejects.toThrow(); expect(f.confirmations).toBe(0);
  });
  it('close/reopen resumes a partial real transaction failure without claiming unsaved rows or recomputing plans', async () => {
    const f = await fixture(2); const row = f.artifact.rows[1];
    f.db.raw.exec(`CREATE TRIGGER fictional_receipt_failure BEFORE INSERT ON pm_account_route_policy_receipts WHEN NEW.account_id='${row.accountId}' BEGIN SELECT RAISE(ABORT,'fictional row failure'); END;`);
    const preview = await f.select(); const partial = await f.confirm(preview);
    expect(partial.rows.map(row => row.status)).toEqual(['admitted', 'pending']); expect(partial.rows[1].receiptFingerprint).toBeNull();
    f.reopen(); expect(await f.importer.status({ reviewId: partial.reviewId })).toMatchObject({ rows: [{ status: 'admitted' }, { status: 'pending' }] });
    f.db.raw.exec('DROP TRIGGER fictional_receipt_failure');
    const result = await f.importer.resume({ reviewId: partial.reviewId, expectedArtifactHash: partial.artifactHash });
    expect(result.rows.map(row => row.status)).toEqual(['admitted', 'admitted']); expect(f.confirmations).toBe(1);
    f.reopen(); expect(await f.importer.resume({ reviewId: result.reviewId, expectedArtifactHash: result.artifactHash })).toEqual(result);
    const replay = await f.confirm(await f.select()); expect(replay.reviewId).toBe(result.reviewId);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_route_policy_receipts').all()).toHaveLength(2);
  });
  it('close/reopen holds the original stale predecessor instead of generating a new revision', async () => {
    const f = await fixture(2); const preview = await f.select(); f.onConfirm(() => { f.seedPolicy(1); });
    const partial = await f.confirm(preview); expect(partial.rows.map(row => row.status)).toEqual(['admitted', 'held']);
    expect(partial.rows[1].reason).toBe('stale_policy_predecessor');
    f.reopen(); expect(await f.importer.resume({ reviewId: partial.reviewId, expectedArtifactHash: partial.artifactHash })).toEqual(partial);
  });
  it('retains listed/TCPA restrictions under ordinary import using canonical merge', async () => {
    const f = await fixture(); const prior = structuredClone(f.artifact.rows[0].policy); prior.contact.evidence.federalStatus = 'listed'; prior.contact.evidence.tcpaFlag = true; f.seedPolicy(0, prior);
    Object.assign(f.artifact.rows[0].policy.contact.evidence, { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', scrubbedAt: NOW, expiresAt: EXPIRES });
    const preview = await f.select(); expect(preview.rows[0].policy?.contact.evidence).toMatchObject({ federalStatus: 'listed', tcpaFlag: true });
    expect((await f.confirm(preview)).rows[0].status).toBe('admitted');
  });
  it('allows only explicit documented canonical usable-clear authoritative correction', async () => {
    const f = await fixture(); const prior = structuredClone(f.artifact.rows[0].policy); prior.contact.evidence.federalStatus = 'listed'; f.seedPolicy(0, prior);
    f.artifact.rows[0].operation = 'authoritative_correction';
    await expect(f.select()).rejects.toThrow('correction_requires_usable_clear');
    Object.assign(f.artifact.rows[0].policy.contact.evidence, { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', scrubbedAt: NOW, expiresAt: EXPIRES });
    const preview = await f.select(); expect(preview.rows[0].policy?.contact.evidence.federalStatus).toBe('verified_clear'); expect((await f.confirm(preview)).rows[0].status).toBe('admitted');
  });
  it('maps uncited positive claims to unknown without publication-derived permission', async () => {
    const f = await fixture(); f.artifact.rows[0].citations = [{ documentId: 'doc', field: 'contact.validationState', excerpt: f.artifact.documents[0].content }];
    Object.assign(f.artifact.rows[0].policy.contact.evidence, { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', scrubbedAt: NOW, expiresAt: EXPIRES });
    f.artifact.rows[0].policy.clearance = { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: NOW, expiresAt: EXPIRES };
    const preview = await f.select(); expect(preview.rows[0].policy?.contact.evidence.federalStatus).toBe('unknown'); expect(preview.rows[0].policy?.clearance).toBeNull();
  });
  it.each(['route', 'evidence', 'expiry', 'foreign_workspace', 'abort'] as const)('rechecks actual %s after native review and never admits stale plans', async mode => {
    const f = await fixture(); const preview = await f.select(); const row = f.artifact.rows[0];
    f.onConfirm(() => {
      if (mode === 'expiry') f.setNow(EXPIRES);
      if (mode === 'abort') f.controller.abort();
      if (mode === 'foreign_workspace') f.db.raw.prepare("INSERT INTO delegated_authorities VALUES(?,?,'local',0,'local',0,?)").run(row.accountId, randomUUID(), NOW);
      if (mode === 'route' || mode === 'evidence') {
        const repo = f.repository(); const snapshot = repo.snapshot(row.accountId, NOW);
        repo.admitEvidence({ commandId: randomUUID(), accountId: row.accountId, expectedVersion: snapshot.account.version, sources: [],
          claims: mode === 'evidence' ? [{ key: 'pain', kind: 'hypothesis', value: 'New fictional hypothesis', evidenceIds: [] }] : [],
          routes: mode === 'route' ? [{ id: row.routeId, accountId: row.accountId, personId: null, channel: 'phone', value: '+14015550199', purpose: 'business', evidenceIds: row.targetSourceIds, verification: 'published' }] : [] });
      }
    });
    if (mode === 'abort') await expect(f.confirm(preview)).rejects.toThrow();
    else expect((await f.confirm(preview)).rows[0].status).toBe('held');
    expect(f.db.raw.prepare('SELECT * FROM pm_account_route_policy_receipts').all()).toEqual([]);
  });
  it('freezes nested native preview and retains originally selected bytes after adapter buffer changes', async () => {
    const f = await fixture(); const bytes = Buffer.from(JSON.stringify(f.artifact)); f.setBytes(bytes);
    const preview = (await f.importer.selectAndPreview())!; bytes.fill(0);
    f.onConfirm(native => {
      expect(Object.isFrozen(native.artifact.rows[0].policy.contact.evidence)).toBe(true);
      expect(() => { native.artifact.rows[0].policy.contact.evidence.federalStatus = 'verified_clear'; }).toThrow();
    });
    const result = await f.confirm(preview); expect(result.rows[0].status).toBe('admitted');
    expect(result.artifactHash).toBe(hash(JSON.stringify(f.artifact)));
    await expect(f.importer.resume({ reviewId: result.reviewId, expectedArtifactHash: '0'.repeat(64) })).rejects.toThrow('artifact_hash_mismatch');
  });
  it('retains nonfederal restrictions and jurisdiction on ordinary observe rather than relaxing them', async () => {
    const f = await fixture(); const prior = structuredClone(f.artifact.rows[0].policy);
    prior.contact.validationState = 'invalid'; prior.jurisdiction = { regionCode: 'RI', timezone: 'America/New_York', reviewAt: EXPIRES };
    prior.clearance = { decision: 'blocked', registrationConfirmed: false, stateDncSubscriptionConfirmed: false, consentRuleConfirmed: false, effectiveAt: NOW, expiresAt: EXPIRES };
    f.seedPolicy(0, prior);
    const preview = await f.select(); expect(preview.rows[0].policy).toEqual(prior); expect((await f.confirm(preview)).rows[0].status).toBe('admitted');
  });

  it('projects reviewed manual evidence through real B4 SQL policy without granting execution or clearing suppression', async () => {
    const f = await fixture(); const row = f.artifact.rows[0];
    new DelegationRepository({ database: f.db, workspaceId: WORKSPACE, clock: f.clock }).initializeLocalAuthority(row.accountId);
    Object.assign(row.policy.contact.evidence, { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', scrubbedAt: NOW, expiresAt: EXPIRES });
    f.db.raw.prepare('INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run(randomUUID(), row.accountId, NOW, 'fictional-optout', row.targetSourceIds[0], NOW);
    f.db.raw.prepare('INSERT INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'phone', row.policy.contact.normalizedValue, NOW, 'fictional-optout', row.targetSourceIds[0], NOW);
    const result = await f.confirm(await f.select()); expect(result.rows[0].status).toBe('admitted');
    const snapshot = f.repository().snapshot(row.accountId, NOW);
    const actual = f.db.raw.transaction(() => createSqlAccountRoutePolicy({ database: f.db, clock: f.clock, expectedWorkspaceId: WORKSPACE }).read(snapshot, snapshot.routes[0])).immediate()!;
    if ('held' in actual) throw new Error('A hand-cited receipt must win over the territory clearance');
    expect(actual.suppression).toMatchObject({ account: true, handle: true }); expect(actual.evidenceRef).toBe(result.rows[0].receiptId);
    expect(evaluateFederalEvidence({ normalizedPhone: row.policy.contact.normalizedValue, evidence: actual.contact.evidence, now: NOW })).toEqual({ kind: 'usable_clear' });
    expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM persons').all()).toEqual([]);
  });

  it('reports the real committed receipt when the operation is aborted between row transactions', async () => {
    const f = await fixture(2);
    f.db.raw.function('fictional_abort_after_receipt', () => { f.controller.abort(); return 1; });
    f.db.raw.exec('CREATE TRIGGER fictional_abort AFTER INSERT ON pm_account_route_policy_receipts BEGIN SELECT fictional_abort_after_receipt(); END;');
    const result = await f.confirm(await f.select());
    expect(result.rows.map(row => row.status)).toEqual(['admitted', 'held']);
    const actual = f.db.raw.prepare('SELECT receipt_fingerprint FROM pm_account_route_policy_receipts').get() as { receipt_fingerprint: string };
    expect(result.rows[0].receiptFingerprint).toBe(actual.receipt_fingerprint); expect(result.rows[1].receiptFingerprint).toBeNull();
  });

});
