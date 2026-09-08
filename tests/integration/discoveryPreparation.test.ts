import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { collectDiscoveryEvidence } from '../../src/main/domain/discovery/discoveryEvidence';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { type BeginDiscoveryRequest } from '../../src/shared/contracts/discoveryContract';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase;
beforeEach(async () => { f = await createDiscoveryDatabase(); });
afterEach(() => { vi.restoreAllMocks(); f.close(); });
const tables = ['persons', 'prospects', 'properties', 'source_events', 'person_contact_methods',
  'trigger_events', 'sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments',
  'activities', 'prospect_priority_projection', 'prioritization_evaluations',
  'discovery_assessments', 'discovery_current', 'discovery_preparations', 'sourcing_enrichment_requests'];
function snapshot() { return Object.fromEntries(tables.map(t => [t, f.database.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])); }
function request(owner: ReturnType<typeof seedDiscoveryOwner>): BeginDiscoveryRequest {
  const { assessmentId } = f.services.discovery.assess(owner.prospectId);
  return { commandId: randomUUID(), personId: owner.personId, salesCycleId: owner.salesCycleId,
    assessmentId, expectedFingerprint: f.services.discoveryRepository.getCurrent(owner.prospectId)!.fingerprint };
}

describe('atomic selected discovery preparation', () => {
  it('assesses real Unreviewed intake without readying and prepares exactly the selected owner with honest durable provenance', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'selected', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'untouched', units: 8 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(property.id);
    const before = snapshot();
    const input = request(owner);
    const assessed = snapshot();
    for (const t of ['prospects', 'sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments', 'activities']) {
      expect(assessed[t]).toEqual(before[t]);
    }
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBe(10);
    const fingerprint = f.services.unitOfWork.immediate(() => collectDiscoveryEvidence({ database: f.database,
      services: f.services, prospectId: owner.prospectId, asOf: DISCOVERY_NOW }).inputFingerprint);
    expect(input.expectedFingerprint).toBe(fingerprint);
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    expect(f.services.discovery.assess(owner.prospectId)).toEqual({ assessmentId: input.assessmentId, unchanged: true });
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    const receipt = f.services.discovery.begin(input);
    expect(receipt).toMatchObject({ personId: owner.personId, salesCycleId: owner.salesCycleId, assessmentId: input.assessmentId,
      mutation: { affectedPersonIds: [owner.personId], affectedSalesCycleIds: [owner.salesCycleId] } });
    expect(f.services.identities.getCanonicalProspect(owner.personId)).toMatchObject({ qualificationState: 'eligible' });
    const prospect = f.database.raw.prepare('SELECT qualification_reason FROM prospects WHERE id = ?').get(owner.prospectId);
    expect(prospect).toEqual({ qualification_reason: `Discovery assessment ${input.assessmentId}` });
    expect(f.database.raw.prepare('SELECT confirmation_kind FROM stage_events WHERE sales_cycle_id = ? ORDER BY transition_sequence DESC LIMIT 1')
      .get(owner.salesCycleId)).toEqual({ confirmation_kind: 'mechanical' });
    expect(f.database.raw.prepare('SELECT work_intent, status FROM next_actions WHERE id = ?').get(receipt.actionId))
      .toEqual({ work_intent: 'discretionary_prospecting', status: 'pending' });
    expect(f.services.prioritizationRepository.getProjection(owner.prospectId)).toMatchObject({
      prospectId: owner.prospectId, ruleVersionId: 'founder-priority-v1', evaluatedAt: DISCOVERY_NOW,
      fitPoints: 15, fitBand: 'medium', timingMilliPoints: 0, reachability: 'none' });
    expect(f.database.raw.prepare(`SELECT d.family FROM cadence_enrollments e
      JOIN cadence_definitions d ON d.id = e.cadence_definition_id WHERE e.sales_cycle_id = ?`)
      .all(owner.salesCycleId)).toEqual([{ family: 'cadence_b' }]);
    expect(f.services.discoveryRepository.getPreparation(input.commandId)).toEqual({ request: input, receipt });
    expect(f.services.identities.getCanonicalProspect(other.personId)?.qualificationState).toBe('unreviewed');
    expect(f.database.raw.prepare('SELECT * FROM activities').all()).toEqual(before.activities);
    expect(f.database.raw.prepare('SELECT * FROM person_contact_methods').all()).toEqual(before.person_contact_methods);
    expect(f.database.raw.prepare('SELECT * FROM sourcing_enrichment_requests').all()).toEqual([]);
    const after = snapshot();
    expect(f.services.discovery.begin(input)).toEqual(receipt);
    expect(snapshot()).toEqual(after);
    expect(auditDomainInvariants({ database: f.database, asOf: DISCOVERY_NOW })).toEqual([]);
  });

  it('replays the exact UUID result across encrypted reopen and rejects changed input or a second preparation UUID', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'reopen', units: 10 });
    const input = request(owner); const first = f.services.discovery.begin(input);
    closeDatabase(f.database);
    const database = openDatabase({ path: f.temp.path, key: f.key });
    try {
      const services = createDomainServices({ database, clock: { now: () => '2026-09-08T12:00:00.000Z' }, ids: { next: randomUUID } });
      expect(services.discovery.begin(input)).toEqual(first);
      expect(() => services.discovery.begin({ ...input, expectedFingerprint: 'f'.repeat(64) })).toThrow(/conflict/i);
      expect(() => services.discovery.begin({ ...input, commandId: randomUUID() })).toThrow();
      expect(database.raw.prepare("SELECT count(*) AS n FROM next_actions WHERE status='pending'").get()).toEqual({ n: 1 });
      expect(database.raw.prepare("SELECT count(*) AS n FROM next_actions WHERE status='completed' AND action_type='review_lead'").get()).toEqual({ n: 1 });
    } finally { closeDatabase(database); }
  });

  it.each(['qualification', 'action', 'projection', 'receipt'] as const)('rolls back EVERY write when failure follows %s', boundary => {
    const owner = seedDiscoveryOwner(f, { prefix: `rollback-${boundary}`, units: 10 });
    const input = request(owner); const before = snapshot();
    const [table, operation] = boundary === 'qualification' ? ['prospects', 'UPDATE']
      : boundary === 'action' ? ['next_actions', 'INSERT']
        : boundary === 'projection' ? ['prospect_priority_projection', 'INSERT'] : ['discovery_preparations', 'INSERT'];
    f.database.raw.exec(`CREATE TEMP TRIGGER fail_preparation AFTER ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected ${boundary} failure'); END`);
    expect(() => f.services.discovery.begin(input)).toThrow(`injected ${boundary} failure`);
    expect(snapshot()).toEqual(before);
    f.database.raw.exec('DROP TRIGGER fail_preparation');
    expect(f.services.discovery.begin(input).assessmentId).toBe(input.assessmentId);
  });

  it.each(['source', 'property', 'opt_out', 'identity', 'cycle', 'deleted', 'capacity', 'resurface'] as const)('rejects changed %s between selection and preparation without writes', mutation => {
    const owner = seedDiscoveryOwner(f, { prefix: `stale-${mutation}`, units: 10 });
    const input = request(owner);
    if (mutation === 'source') {
      const source = f.services.sourceRepository.getById(owner.sourceEventId)!;
      f.services.unitOfWork.immediate(() => f.services.sourceRepository.append({ id: randomUUID(), channel: 'parcel',
        personId: owner.personId, prospectId: owner.prospectId, salesCycleId: owner.salesCycleId,
        observedAt: source.observedAt, sourceRecord: source.sourceRecord, evidenceRef: 'fixture:new-source-observation' }));
    }
    if (mutation === 'property') f.database.raw.prepare('UPDATE properties SET door_count = 99').run();
    if (mutation === 'opt_out') f.services.optOut.apply({ personId: owner.personId, tombstoneId: randomUUID(),
      requestedAt: DISCOVERY_NOW, policyVersion: 'founder_opt_out_v1', decision: { kind: 'founder_confirmed', channel: 'manual' },
      terminalStageEventId: randomUUID(), evidence: { kind: 'append_activity', activity: { id: randomUUID(),
        personId: owner.personId, kind: 'note', direction: 'internal', channel: 'manual', occurredAt: DISCOVERY_NOW,
        observedOutcome: 'opted_out', metadata: {} } } });
    if (mutation === 'identity') f.database.raw.prepare('UPDATE persons SET display_name = ?').run('Unrelated Identity');
    if (mutation === 'cycle') f.database.raw.prepare('UPDATE sales_cycles SET version = version + 1').run();
    if (mutation === 'deleted') f.database.raw.prepare('UPDATE persons SET deleted_at = ?').run(DISCOVERY_NOW);
    if (mutation === 'capacity') f.database.raw.prepare('UPDATE workspace_settings SET daily_dial_capacity = 0').run();
    if (mutation === 'resurface') f.database.raw.prepare('UPDATE sales_cycles SET resurface_at = ?, resurface_reason = ?')
      .run('2026-09-08T12:00:00.000Z', 'snooze');
    const before = snapshot();
    expect(() => f.services.discovery.begin(input)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('respects a real founder override after selection, including after reassessment, without changing sales history', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'override', units: 10 }); const input = request(owner);
    const before = snapshot();
    const override = { commandId: randomUUID(), personId: owner.personId, assessmentId: input.assessmentId,
      expectedFingerprint: input.expectedFingerprint, decision: 'watch' as const, reason: 'Founder knows this owner is unavailable' };
    f.services.discovery.override(override);
    expect(() => f.services.discovery.begin(input)).toThrow();
    const again = request(owner);
    expect(again.assessmentId).not.toBe(input.assessmentId);
    expect(again.expectedFingerprint).toBe(input.expectedFingerprint);
    expect(() => f.services.discovery.begin(again)).toThrow();
    for (const t of ['prospects', 'sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments', 'activities']) {
      expect(snapshot()[t]).toEqual(before[t]);
    }
  });
});
