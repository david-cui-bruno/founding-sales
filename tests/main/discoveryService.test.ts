import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { buildNeedsIdentityIntakeCommand, mapCloudSourceEvent } from '../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent } from '../fixtures/cloudSourceEvents';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase; let now: string;
beforeEach(async () => {
  now = DISCOVERY_NOW;
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
  const runtime = new DomainRuntime({ database, clock: { now: () => now }, ids: { next: randomUUID } });
  runtime.initialize();
  f = { database, temp, key, services: runtime.getServices(), close() {
    runtime.shutdown(); closeDatabase(database); key.bytes.fill(0); temp.cleanup();
  } };
});
afterEach(() => { vi.restoreAllMocks(); f.close(); });
function current(prospectId: string) { return f.services.discoveryRepository.getCurrent(prospectId)!; }
function select(prospectId: string) {
  f.services.discovery.assess(prospectId); const a = current(prospectId);
  return { commandId: randomUUID(), personId: a.personId, salesCycleId: a.salesCycleId,
    assessmentId: a.id, expectedFingerprint: a.fingerprint };
}
function business() {
  return ['prospects', 'sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments', 'activities', 'person_contact_methods']
    .map(t => f.database.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
}

describe('DiscoveryService assessment and freshness', () => {
  it('delegates facade reads without writes and never nests public transaction-owning services', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'facade', units: 10 });
    const domain = createFounderSalesDomain({ database: f.database, services: f.services,
      clock: { now: () => now }, ids: { next: randomUUID } });
    const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
    expect(domain.getDiscoveryBrief(owner.personId).assessment).toBeNull();
    expect(domain.getDiscovery().counts.unassessed).toBe(1);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(() => f.services.unitOfWork.immediate(() => f.services.prioritization.recalculateProspect({
      evaluationId: randomUUID(), prospectId: owner.prospectId, ruleVersionId: 'founder-priority-v1',
      evaluatedAt: now, expectedProjectionVersion: null }))).toThrow('A domain transaction is already active.');
    vi.spyOn(f.services.prioritization, 'recalculateProspect').mockImplementation(() => { throw new Error('public recalculation nested'); });
    vi.spyOn(f.services.prioritization, 'recordTriggerEvent').mockImplementation(() => { throw new Error('public trigger nested'); });
    vi.spyOn(f.services.today, 'build').mockImplementation(() => { throw new Error('public Today nested'); });
    const result = domain.assessDiscoveryProspect(owner.prospectId);
    expect(result.unchanged).toBe(false);
    const a = current(owner.prospectId);
    const receipt = domain.beginDiscovery({ commandId: randomUUID(), personId: owner.personId,
      salesCycleId: owner.salesCycleId, assessmentId: a.id, expectedFingerprint: a.fingerprint });
    expect(receipt.assessmentId).toBe(a.id);
  });

  it.each(['date', 'expiry', 'rule'] as const)('rejects stale %s at begin and reassesses instead of reusing cache', kind => {
    const owner = seedDiscoveryOwner(f, { prefix: kind, units: 10 }); const input = select(owner.prospectId);
    const a = current(owner.prospectId);
    if (kind === 'date') now = '2026-09-07T04:00:00.000Z';
    if (kind === 'expiry') now = a.expiresAt;
    if (kind === 'rule') f.database.raw.prepare('UPDATE workspace_settings SET active_prioritization_rule_version_id = NULL').run();
    const before = business();
    expect(() => f.services.discovery.begin(input)).toThrow();
    expect(business()).toEqual(before);
    if (kind !== 'rule') expect(f.services.discovery.assess(owner.prospectId).assessmentId).not.toBe(a.id);
  });

  it('reassesses at same-day trigger expiry using the current wall clock and never fabricates communications', () => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person;
    event.signal_flags.vacancy = true;
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('intake expected');
    const owner = f.services.sources.createPersonProspect(mapped.command);
    f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId,
      entrySourceEventId: owner.sourceEventId, effectiveAt: now });
    f.services.prioritization.recordTriggerEvent({ id: randomUUID(), prospectId: owner.prospectId,
      triggerType: 'live_vacancy', effectiveAt: event.observed_at, sourceExpiresAt: '2026-09-06T13:00:00.000Z',
      strengthMultiplier: 1, verificationState: 'unverified', evidence: { formatVersion: 1, triggerType: 'live_vacancy',
        authoredUnderRuleVersionId: 'founder-priority-v1', function: 'decaying', evidenceRefs: [String(event.payload.listing_url)],
        proof: { kind: 'source_event', sourceEventId: owner.sourceEventId, sourceObservedAt: event.observed_at } } });
    const before = business(); const input = select(owner.prospectId);
    expect(current(owner.prospectId).expiresAt).toBe('2026-09-06T13:00:00.000Z');
    expect(f.services.prioritizationRepository.listTriggerEvents(owner.prospectId)).toHaveLength(1);
    expect(current(owner.prospectId).axes.timing.hasSupportedTrigger).toBe(true);
    now = '2026-09-06T13:00:00.000Z';
    expect(() => f.services.discovery.begin(input)).toThrow();
    const next = f.services.discovery.assess(owner.prospectId);
    expect(next.assessmentId).not.toBe(input.assessmentId);
    expect(current(owner.prospectId).axes.timing.hasSupportedTrigger).toBe(false);
    expect(business()).toEqual(before);
  });

  it('keeps placeholder provenance after rename and refuses preparation without contact fabrication', () => {
    const event = validParcelEvent(); event.entity.person = null;
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'needs-identity') throw new Error('placeholder expected');
    const owner = f.services.sources.createPersonProspect(buildNeedsIdentityIntakeCommand(mapped)!);
    f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId,
      entrySourceEventId: owner.sourceEventId, effectiveAt: now });
    f.database.raw.prepare('UPDATE persons SET display_name = ?').run('Edited name');
    const input = select(owner.prospectId); const before = business();
    expect(current(owner.prospectId)).toMatchObject({ disposition: 'research', identitySupported: false });
    expect(() => f.services.discovery.begin(input)).toThrow();
    expect(business()).toEqual(before);
  });

  it('persists watch/exclude/reconsider without lifecycle changes and retains override provenance on revised evidence', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'decisions', units: 10 });
    const before = business();
    for (const decision of ['watch', 'exclude', 'reconsider'] as const) {
      const input = select(owner.prospectId);
      const command = { commandId: randomUUID(), personId: owner.personId, assessmentId: input.assessmentId,
        expectedFingerprint: input.expectedFingerprint, decision, reason: `Founder ${decision}` };
      f.services.discovery.override(command);
      expect(f.services.discoveryRepository.getLatestOverride(owner.prospectId)?.decision).toBe(decision);
      now = new Date(Date.parse(now) + 1000).toISOString();
    }
    expect(business()).toEqual(before);
    f.database.raw.prepare('UPDATE properties SET door_count = NULL').run();
    // Supported repair restores the same source facts but changes the canonical version.
    f.services.discovery.assess(owner.prospectId);
    expect(f.services.discovery.getBrief(owner.personId).latestOverride).toMatchObject({ decision: 'reconsider' });
  });

  it('requires a persisted current matching assessment in the scoped lifecycle writer and retains founder provenance', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'writer', units: 10 });
    const input = select(owner.prospectId); const before = business();
    expect(() => f.services.unitOfWork.immediate(() => f.services.lifecycle.scopedWriter().prepareFromAssessment({
      cycleId: owner.salesCycleId, expectedCycleVersion: 1, expectedProspectVersion: 1,
      effectiveAt: now, assessmentId: randomUUID(), fingerprint: input.expectedFingerprint }))).toThrow();
    expect(business()).toEqual(before);
    f.services.lifecycle.reviewToReady({ cycleId: owner.salesCycleId, expectedCycleVersion: 1,
      expectedProspectVersion: 1, effectiveAt: now });
    expect(f.database.raw.prepare('SELECT confirmation_kind FROM stage_events WHERE sales_cycle_id = ? AND to_stage = ?')
      .get(owner.salesCycleId, 'ready')).toEqual({ confirmation_kind: 'founder' });
  });

  it.each(['missing', 'foreign', 'fingerprint', 'expired', 'override'] as const)('scoped preparation refuses %s authority with zero writes', kind => {
    const owner = seedDiscoveryOwner(f, { prefix: `authority-${kind}`, units: 10 });
    const input = select(owner.prospectId);
    let lifecycle = f.services.lifecycle;
    let assessmentId = input.assessmentId;
    if (kind === 'missing') lifecycle = new LifecycleService({ database: f.database, unitOfWork: f.services.unitOfWork,
      identities: f.services.identities, events: f.services.events, sources: f.services.sourceRepository,
      cadences: f.services.cadences, clock: { now: () => now }, ids: { next: randomUUID },
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1 });
    if (kind === 'foreign') assessmentId = select(seedDiscoveryOwner(f, { prefix: 'foreign', units: 10 }).prospectId).assessmentId;
    if (kind === 'expired') now = current(owner.prospectId).expiresAt;
    if (kind === 'override') {
      f.services.discovery.override({ commandId: randomUUID(), personId: owner.personId, assessmentId,
        expectedFingerprint: input.expectedFingerprint, decision: 'exclude', reason: 'Founder excludes' });
      assessmentId = f.services.discovery.assess(owner.prospectId).assessmentId;
    }
    const before = business(); const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    expect(() => f.services.unitOfWork.immediate(() => lifecycle.scopedWriter().prepareFromAssessment({
      cycleId: owner.salesCycleId, expectedCycleVersion: 1, expectedProspectVersion: 1,
      effectiveAt: now, assessmentId, fingerprint: kind === 'fingerprint' ? 'f'.repeat(64) : input.expectedFingerprint }))).toThrow();
    expect(business()).toEqual(before);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('makes override replay write-free and conflicts on any changed UUID input', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'override-replay', units: 10 });
    const input = select(owner.prospectId);
    const command = { commandId: randomUUID(), personId: owner.personId, assessmentId: input.assessmentId,
      expectedFingerprint: input.expectedFingerprint, decision: 'watch' as const, reason: 'Wait for a better time' };
    const first = f.services.discovery.override(command); now = '2026-09-07T12:00:00.000Z';
    const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
    expect(f.services.discovery.override(command)).toEqual(first);
    expect(() => f.services.discovery.override({ ...command, reason: 'Changed reason' })).toThrow(/conflict/i);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});
