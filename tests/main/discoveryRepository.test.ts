import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DiscoveryRepository } from '../../src/main/domain/discovery/discoveryRepository';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DomainRepositoryDatabaseMismatchError, DomainTransactionRequiredError } from '../../src/main/domain/support/domainErrors';
import { beginDiscoveryRequestSchema, beginDiscoveryReceiptSchema, type OverrideDiscoveryRequest } from '../../src/shared/contracts/discoveryContract';
import { createDiscoveryDatabase, discoveryAssessment, DISCOVERY_NOW, seedDiscoveryOwner, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

const CORRUPT = /^Discovery storage is corrupt\.$/;
const CONFLICT = /^Discovery command conflicts with immutable history\.$/;

describe('DiscoveryRepository', () => {
  let f: DiscoveryDatabase;
  let repository: DiscoveryRepository;
  let owner: ReturnType<typeof seedDiscoveryOwner>;
  let other: ReturnType<typeof seedDiscoveryOwner>;
  beforeEach(async () => {
    f = await createDiscoveryDatabase();
    repository = f.services.discoveryRepository;
    owner = seedDiscoveryOwner(f, { prefix: 'first', units: 10 });
    other = seedDiscoveryOwner(f, { prefix: 'other', units: null });
  });
  afterEach(() => { vi.restoreAllMocks(); f?.close(); });
  const write = (fn: () => void) => f.services.unitOfWork.immediate(fn);
  const current = () => {
    const assessment = discoveryAssessment(owner);
    write(() => { repository.appendAssessment(assessment); repository.setCurrent(owner.prospectId, assessment.id); });
    return assessment;
  };
  const override = (assessment = current()): OverrideDiscoveryRequest & { createdAt: string } => ({
    commandId: randomUUID(), personId: owner.personId, assessmentId: assessment.id,
    expectedFingerprint: assessment.fingerprint, decision: 'watch', reason: 'Follow up after review', createdAt: DISCOVERY_NOW,
  });
  function preparation(assessment = current()) {
    const ready = f.services.lifecycle.reviewToReady({ cycleId: owner.salesCycleId,
      expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
    const request = beginDiscoveryRequestSchema.parse({ commandId: randomUUID(), personId: owner.personId,
      salesCycleId: owner.salesCycleId, assessmentId: assessment.id, expectedFingerprint: assessment.fingerprint });
    const receipt = beginDiscoveryReceiptSchema.parse({ personId: owner.personId, salesCycleId: owner.salesCycleId,
      assessmentId: assessment.id, actionId: ready.currentNextActionId,
      mutation: { revision: 1, affectedPersonIds: [owner.personId], affectedSalesCycleIds: [owner.salesCycleId] } });
    return { request, receipt };
  }
  function corrupt(table: string, column: string, value: unknown, whereId?: string) {
    // Deliberately bypass only this disposable fixture's guards to exercise readers.
    const triggers = f.database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table) as { name: string }[];
    for (const { name } of triggers) f.database.raw.exec(`DROP TRIGGER "${name}"`);
    f.database.raw.pragma('ignore_check_constraints = ON');
    f.database.raw.pragma('foreign_keys = OFF');
    f.database.raw.prepare(`UPDATE ${table} SET ${column} = ?${whereId === undefined ? '' : ' WHERE id = ?'}`)
      .run(...(whereId === undefined ? [value] : [value, whereId]));
  }

  it('seeds actual production-shaped parcel envelopes and linked property evidence through intake', () => {
    const source = f.database.raw.prepare('SELECT source_record_json FROM source_events WHERE id = ?')
      .get(owner.sourceEventId) as { source_record_json: string };
    const envelope = JSON.parse(source.source_record_json);
    expect(envelope.sourceRecord.cloudSourceEvent).toMatchObject({ channel: 'parcel',
      entity: { person: { full_name: 'first Property Owner' }, property: { unit_count: 10 } } });
    expect(owner.sourceEventId).toBe(`cloud:${envelope.sourceRecord.cloudSourceEvent.idempotency_key}`);
    expect(f.database.raw.prepare(`SELECT p.door_count FROM properties p JOIN prospect_properties pp
      ON pp.property_id = p.id WHERE pp.prospect_id = ?`).get(owner.prospectId)).toEqual({ door_count: 10 });
  });

  it('composes exactly one repository without SQL, clock, or ID work and binds the exact database/UOW', () => {
    const query = vi.spyOn(f.database.raw, 'prepare').mockImplementation(() => { throw new Error('Unexpected SQL'); });
    const now = vi.fn(() => { throw new Error('Unexpected clock'); });
    const next = vi.fn(() => { throw new Error('Unexpected ID'); });
    const services = createDomainServices({ database: f.database, clock: { now }, ids: { next } });
    expect(services.discoveryRepository).toBeInstanceOf(DiscoveryRepository);
    services.discoveryRepository.assertBoundTo(f.database, services.unitOfWork);
    expect(query).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    expect(() => services.discoveryRepository.assertBoundTo(f.database, f.services.unitOfWork)).toThrow(DomainRepositoryDatabaseMismatchError);
    const alias = { ...f.database };
    expect(() => new DiscoveryRepository({ database: alias, unitOfWork: f.services.unitOfWork })).toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => repository.assertBoundTo(alias, f.services.unitOfWork)).toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('requires the bound UOW for every mutation, rejecting no scope, raw scope, and another UOW on the same database', () => {
    const assessment = current(); const input = override(assessment); const prepared = preparation(assessment);
    const mutations = [() => repository.appendAssessment(discoveryAssessment(owner)),
      () => repository.setCurrent(owner.prospectId, assessment.id), () => repository.appendOverride(input),
      () => repository.appendPreparation(prepared.request, prepared.receipt), () => repository.writeScanCursor(null)];
    for (const mutation of mutations) {
      expect(mutation).toThrow(DomainTransactionRequiredError);
      f.database.raw.exec('BEGIN');
      try { expect(mutation).toThrow(DomainTransactionRequiredError); } finally { f.database.raw.exec('ROLLBACK'); }
      expect(() => new DomainUnitOfWork(f.database).immediate(mutation)).toThrow(DomainTransactionRequiredError);
    }
  });

  it('keeps immutable history while versioning the current pointer and rolls all new writes back together', () => {
    const first = current(); const second = discoveryAssessment(owner, { fingerprint: 'b'.repeat(64) });
    write(() => { repository.appendAssessment(second); repository.setCurrent(owner.prospectId, second.id); });
    expect(repository.getCurrent(owner.prospectId)).toEqual(second);
    expect(f.database.raw.prepare('SELECT version FROM discovery_current WHERE prospect_id = ?').get(owner.prospectId)).toEqual({ version: 2 });
    write(() => repository.setCurrent(owner.prospectId, second.id));
    expect(f.database.raw.prepare('SELECT version FROM discovery_current').get()).toEqual({ version: 2 });
    expect(JSON.parse((f.database.raw.prepare('SELECT assessment_json FROM discovery_assessments WHERE id = ?').get(first.id) as { assessment_json: string }).assessment_json)).toEqual(first);
    const third = discoveryAssessment(owner); const input = override(second);
    expect(() => write(() => { repository.appendAssessment(third); repository.setCurrent(owner.prospectId, third.id);
      repository.appendOverride(input); repository.writeScanCursor('rolled-back'); throw new Error('rollback'); })).toThrow('rollback');
    expect(repository.getCurrent(owner.prospectId)).toEqual(second);
    expect(repository.getLatestOverride(owner.prospectId)).toBeNull(); expect(repository.readScanCursor()).toBeNull();
    expect(f.database.raw.prepare('SELECT id FROM discovery_assessments WHERE id = ?').get(third.id)).toBeUndefined();
    for (const sql of ['UPDATE discovery_assessments SET fingerprint = fingerprint', 'DELETE FROM discovery_assessments']) {
      expect(() => f.database.raw.exec(sql)).toThrow();
    }
  });

  it('replays exact assessments and rejects changed content under the same immutable id', () => {
    const assessment = current();
    write(() => repository.appendAssessment({ ...assessment }));
    expect(() => write(() => repository.appendAssessment({ ...assessment, fingerprint: 'b'.repeat(64) }))).toThrow(CONFLICT);
    expect(f.database.raw.prepare('SELECT count(*) AS n FROM discovery_assessments').get()).toEqual({ n: 1 });
  });

  it('rejects FK-valid foreign owners and raw whitespace aliases without normalizing ownership', () => {
    const assessment = current(); const alien = discoveryAssessment(other);
    write(() => repository.appendAssessment(alien));
    for (const patch of [{ personId: other.personId }, { prospectId: other.prospectId }, { salesCycleId: other.salesCycleId },
      { personId: ` ${owner.personId}` }, { prospectId: `${owner.prospectId} ` }, { salesCycleId: `${owner.salesCycleId}\t` }]) {
      expect(() => write(() => repository.appendAssessment({ ...assessment, id: randomUUID(), ...patch }))).toThrow();
    }
    expect(() => write(() => repository.setCurrent(owner.prospectId, alien.id))).toThrow();
    expect(() => write(() => repository.setCurrent(` ${owner.prospectId}`, assessment.id))).toThrow();
    expect(() => write(() => repository.setCurrent(owner.prospectId, randomUUID()))).toThrow();
    expect(repository.getCurrent(owner.prospectId)).toEqual(assessment);
  });

  it('persists overrides with exact replay, immutable time/reason, deterministic latest and changed-evidence comparison', () => {
    const assessment = current(); const input = override(assessment);
    write(() => { repository.appendOverride(input); repository.appendOverride({ ...input }); });
    expect(repository.getLatestOverride(owner.prospectId)).toEqual({ id: input.commandId, assessmentId: assessment.id,
      decision: input.decision, reason: input.reason, createdAt: input.createdAt, evidenceChanged: false });
    for (const patch of [{ reason: 'Changed' }, { decision: 'exclude' as const }, { createdAt: '2026-09-06T13:00:00.000Z' },
      { personId: other.personId }, { expectedFingerprint: 'b'.repeat(64) }]) {
      expect(() => write(() => repository.appendOverride({ ...input, ...patch }))).toThrow();
    }
    expect(() => write(() => repository.appendOverride({ ...input, commandId: randomUUID(), personId: other.personId }))).toThrow();
    const revised = discoveryAssessment(owner, { fingerprint: 'b'.repeat(64), overrideId: input.commandId });
    write(() => { repository.appendAssessment(revised); repository.setCurrent(owner.prospectId, revised.id); });
    expect(repository.getLatestOverride(owner.prospectId)?.evidenceChanged).toBe(true);
    expect(() => f.database.raw.exec('UPDATE discovery_overrides SET reason = reason')).toThrow();
    expect(() => f.database.raw.exec('DELETE FROM discovery_overrides')).toThrow();
  });

  it('stores exact preparation command/receipt, rejects cross-owner/cycle/action/fingerprint and conflicts', () => {
    const prepared = preparation();
    const otherReady = f.services.lifecycle.reviewToReady({ cycleId: other.salesCycleId, expectedCycleVersion: 1,
      expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
    write(() => { repository.appendPreparation(prepared.request, prepared.receipt); repository.appendPreparation(prepared.request, prepared.receipt); });
    expect(repository.getPreparation(prepared.request.commandId)).toEqual(prepared);
    for (const patch of [{ personId: other.personId }, { salesCycleId: other.salesCycleId }, { expectedFingerprint: 'b'.repeat(64) }]) {
      expect(() => write(() => repository.appendPreparation({ ...prepared.request, commandId: randomUUID(), ...patch }, prepared.receipt))).toThrow();
    }
    for (const patch of [{ personId: other.personId }, { salesCycleId: other.salesCycleId }, { assessmentId: randomUUID() },
      { actionId: otherReady.currentNextActionId! }, { actionId: 'missing-action' }]) {
      expect(() => write(() => repository.appendPreparation({ ...prepared.request, commandId: randomUUID() }, { ...prepared.receipt, ...patch }))).toThrow();
    }
    expect(() => write(() => repository.appendPreparation(prepared.request,
      { ...prepared.receipt, mutation: { ...prepared.receipt.mutation, revision: 2 } }))).toThrow(CONFLICT);
    expect(() => f.database.raw.exec('UPDATE discovery_preparations SET action_id = action_id')).toThrow();
    expect(() => f.database.raw.exec('DELETE FROM discovery_preparations')).toThrow();
  });

  it('rolls canonical preparation and receipt back in the same UOW and preserves committed replay across encrypted reopen', () => {
    const assessment = current(); const input = override(assessment);
    const request = beginDiscoveryRequestSchema.parse({ commandId: randomUUID(), personId: owner.personId,
      salesCycleId: owner.salesCycleId, assessmentId: assessment.id, expectedFingerprint: assessment.fingerprint });
    const prepare = () => {
      const ready = f.services.lifecycle.scopedWriter().reviewToReady({ cycleId: owner.salesCycleId,
        expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: DISCOVERY_NOW });
      const receipt = beginDiscoveryReceiptSchema.parse({ personId: owner.personId, salesCycleId: owner.salesCycleId,
        assessmentId: assessment.id, actionId: ready.currentNextActionId,
        mutation: { revision: 1, affectedPersonIds: [owner.personId], affectedSalesCycleIds: [owner.salesCycleId] } });
      repository.appendPreparation(request, receipt); return receipt;
    };
    expect(() => write(() => { prepare(); throw new Error('abort preparation'); })).toThrow('abort preparation');
    expect(repository.getPreparation(request.commandId)).toBeNull();
    expect(f.database.raw.prepare('SELECT stage FROM sales_cycles WHERE id = ?').get(owner.salesCycleId)).toEqual({ stage: 'unreviewed' });
    const receipt = f.services.unitOfWork.immediate(prepare);
    write(() => { repository.appendOverride(input); repository.writeScanCursor(owner.prospectId); });
    closeDatabase(f.database);
    const reopened = openDatabase({ path: f.temp.path, key: f.key });
    try {
      const runtime = new DomainRuntime({ database: reopened, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
      expect(runtime.initialize().status).toBe('ready');
      const services = runtime.getServices(); const repo = services.discoveryRepository;
      expect(repo.getCurrent(owner.prospectId)).toEqual(assessment);
      expect(repo.getPreparation(request.commandId)).toEqual({ request, receipt });
      expect(repo.readScanCursor()).toBe(owner.prospectId);
      services.unitOfWork.immediate(() => { repo.appendAssessment(assessment); repo.appendOverride(input); repo.appendPreparation(request, receipt); });
      expect(() => services.unitOfWork.immediate(() => repo.appendOverride({ ...input, reason: 'conflicting reopen' }))).toThrow(CONFLICT);
      expect(() => services.unitOfWork.immediate(() => repo.appendPreparation({ ...request, expectedFingerprint: 'b'.repeat(64) }, receipt))).toThrow();
      runtime.shutdown();
    } finally { closeDatabase(reopened); }
  });

  it('does not initialize scan state at construction, explicitly persists/reset cursors and validates bounds', () => {
    expect(repository.getCurrent('missing')).toBeNull(); expect(repository.getLatestOverride('missing')).toBeNull();
    expect(repository.getPreparation(randomUUID())).toBeNull(); expect(repository.readScanCursor()).toBeNull();
    expect(f.database.raw.prepare('SELECT * FROM discovery_scan_state').all()).toEqual([]);
    write(() => repository.writeScanCursor(owner.prospectId)); expect(repository.readScanCursor()).toBe(owner.prospectId);
    write(() => repository.writeScanCursor(null)); expect(repository.readScanCursor()).toBeNull();
    for (const invalid of ['', ' space ', 'a'.repeat(257), 'bad\u0000cursor']) {
      expect(() => write(() => repository.writeScanCursor(invalid))).toThrow();
    }
  });

  it.each(['unknown-key', 'bad-axis', 'malformed-json', 'noncanonical-json', 'raw-owner-alias', 'column-mismatch', 'missing-assessment', 'bad-pointer-version'])('fails closed on stored assessment/current %s', kind => {
    const assessment = current();
    if (kind === 'unknown-key') corrupt('discovery_assessments', 'assessment_json', JSON.stringify({ ...assessment, private: 'PRIVATE' }));
    if (kind === 'bad-axis') corrupt('discovery_assessments', 'assessment_json', JSON.stringify({ ...assessment, axes: { ...assessment.axes, timing: { milliPoints: 41_000, band: 'hot', hasSupportedTrigger: true } } }));
    if (kind === 'malformed-json') corrupt('discovery_assessments', 'assessment_json', '{PRIVATE');
    if (kind === 'noncanonical-json') corrupt('discovery_assessments', 'assessment_json', ` ${JSON.stringify(assessment)}`);
    if (kind === 'raw-owner-alias') corrupt('discovery_assessments', 'person_id', ` ${owner.personId}`);
    if (kind === 'column-mismatch') corrupt('discovery_assessments', 'fingerprint', 'b'.repeat(64));
    if (kind === 'missing-assessment') corrupt('discovery_current', 'assessment_id', randomUUID());
    if (kind === 'bad-pointer-version') corrupt('discovery_current', 'version', 0);
    expect(() => repository.getCurrent(owner.prospectId)).toThrow(CORRUPT);
  });

  it.each(['override-owner', 'override-decision', 'override-time', 'request-json', 'receipt-json', 'receipt-owner', 'cursor', 'scan-date', 'scan-time'])('returns fixed errors for corrupt %s, never empty success', kind => {
    const assessment = current(); const input = override(assessment); const prepared = preparation(assessment);
    write(() => { repository.appendOverride(input); repository.appendPreparation(prepared.request, prepared.receipt); repository.writeScanCursor(null); });
    if (kind === 'override-owner') corrupt('discovery_overrides', 'person_id', other.personId);
    if (kind === 'override-decision') corrupt('discovery_overrides', 'decision', 'PRIVATE');
    if (kind === 'override-time') corrupt('discovery_overrides', 'created_at', 'PRIVATE');
    if (kind === 'request-json') corrupt('discovery_preparations', 'request_json', '{PRIVATE');
    if (kind === 'receipt-json') corrupt('discovery_preparations', 'receipt_json', JSON.stringify({ ...prepared.receipt, private: 'PRIVATE' }));
    if (kind === 'receipt-owner') corrupt('discovery_preparations', 'person_id', other.personId);
    if (kind === 'cursor') corrupt('discovery_scan_state', 'cursor', ' bad ');
    if (kind === 'scan-date') corrupt('discovery_scan_state', 'last_complete_local_date', '2026-02-30');
    if (kind === 'scan-time') corrupt('discovery_scan_state', 'last_complete_scan_at', 'PRIVATE');
    const read = kind.startsWith('override') ? () => repository.getLatestOverride(owner.prospectId)
      : kind.startsWith('request') || kind.startsWith('receipt') ? () => repository.getPreparation(prepared.request.commandId)
        : () => repository.readScanCursor();
    expect(read).toThrow(CORRUPT);
  });

  it.each(['fingerprint', 'assessment_id'])('rejects a corrupt effective override %s when reading its current assessment', column => {
    const first = current(); const input = override(first);
    const alien = discoveryAssessment(other);
    const revised = discoveryAssessment(owner, { overrideId: input.commandId });
    write(() => { repository.appendAssessment(alien); repository.appendOverride(input);
      repository.appendAssessment(revised); repository.setCurrent(owner.prospectId, revised.id); });
    corrupt('discovery_overrides', column, column === 'fingerprint' ? 'b'.repeat(64) : alien.id);
    expect(() => repository.getCurrent(owner.prospectId)).toThrow(CORRUPT);
  });

  it('rejects raw canonical parent owner aliases rather than normalizing them into the assessed owner', () => {
    current();
    corrupt('prospects', 'person_id', ` ${owner.personId}`, owner.prospectId);
    expect(() => repository.getCurrent(owner.prospectId)).toThrow(CORRUPT);
  });

  it('selects the latest override deterministically and preserves same-evidence founder decisions', () => {
    const assessment = current(); const input = override(assessment);
    const earlier = { ...input, commandId: '11111111-1111-4111-8111-111111111111' };
    const later = { ...input, commandId: '22222222-2222-4222-8222-222222222222', decision: 'exclude' as const };
    write(() => { repository.appendOverride(later); repository.appendOverride(earlier); });
    const revised = discoveryAssessment(owner, { overrideId: later.commandId });
    write(() => { repository.appendAssessment(revised); repository.setCurrent(owner.prospectId, revised.id); });
    expect(repository.getLatestOverride(owner.prospectId)).toMatchObject({ id: later.commandId, decision: 'exclude', evidenceChanged: false });
  });

  it('strictly parses every input before persistence including excess keys and invalid time', () => {
    const assessment = current(); const input = override(assessment); const prepared = preparation(assessment);
    expect(() => write(() => repository.appendAssessment({ ...assessment, id: randomUUID(), private: true } as never))).toThrow();
    expect(() => write(() => repository.appendOverride({ ...input, private: true } as never))).toThrow();
    expect(() => write(() => repository.appendOverride({ ...input, createdAt: '2026-02-30T12:00:00.000Z' }))).toThrow();
    expect(() => write(() => repository.appendPreparation({ ...prepared.request, private: true } as never, prepared.receipt))).toThrow();
    expect(() => write(() => repository.appendPreparation(prepared.request, { ...prepared.receipt, private: true } as never))).toThrow();
  });
});
