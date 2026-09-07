import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachTranscript } from '../../src/main/domain/conversations/conversationsDomain';
import { collectDiscoveryEvidence, type DiscoveryEvidenceServices } from '../../src/main/domain/discovery/discoveryEvidence';
import { DiscoveryFactWriter } from '../../src/main/domain/discovery/discoveryFactWriter';
import { evaluateDiscovery } from '../../src/main/domain/discovery/discoveryPolicy';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { mapCloudSourceEvent } from '../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent } from '../fixtures/cloudSourceEvents';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase;
beforeEach(async () => { f = await createDiscoveryDatabase(); });
afterEach(() => f.close());
function writer() { return new DiscoveryFactWriter({ database: f.database, unitOfWork: f.services.unitOfWork, services: f.services }); }
function collect(prospectId: string) { return collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId, asOf: DISCOVERY_NOW }); }
function evidenceServices() {
  const { identities, sourceRepository, events, outboundPermission, prioritizationRepository, prioritization, workspaceSettings } = f.services;
  return { identities, sourceRepository, events, outboundPermission, prioritizationRepository, prioritization, workspaceSettings } satisfies DiscoveryEvidenceServices;
}

function linkedParcels(sameStreet: boolean) {
  const event = validParcelEvent();
  const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('Expected intake');
  const owner = f.services.sources.createPersonProspect(mapped.command);
  const cycle = f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId,
    entrySourceEventId: owner.sourceEventId, effectiveAt: DISCOVERY_NOW });
  const second = validParcelEvent(); second.idempotency_key = 'f'.repeat(64); second.id = 'se_01JC0000000000000000000005';
  second.entity.property!.parcel_id = 'LINKED-SECOND'; second.entity.property!.situs_address.locality = 'Pawtucket';
  if (!sameStreet) second.entity.property!.situs_address.line1 = 'Second St';
  const secondMapped = mapCloudSourceEvent(second); if (secondMapped.kind !== 'intake') throw new Error('Expected intake');
  expect(f.services.sources.createPersonProspect(secondMapped.command).personId).toBe(owner.personId);
  expect(f.services.identities.listPropertiesForProspect(owner.prospectId)).toHaveLength(2);
  return { ...owner, salesCycleId: cycle.id };
}

describe('discovery scoped canonical materialization', () => {
  it('makes no canonical mutation from ambiguous street-only management support', () => {
    const owner = linkedParcels(true);
    const properties = f.services.identities.listPropertiesForProspect(owner.prospectId);
    const quote = `I self-manage ${properties[0]!.addressLine1}.`;
    f.services.unitOfWork.immediate(() => f.services.events.appendActivity({ id: 'ambiguous-call', personId: owner.personId,
      prospectId: owner.prospectId, salesCycleId: owner.salesCycleId, kind: 'call', direction: 'inbound', channel: 'call', occurredAt: DISCOVERY_NOW }));
    const ids = ['ambiguous-consent', 'ambiguous-transcript', 'ambiguous-utterance'];
    attachTranscript({ database: f.database, clock: { now: () => DISCOVERY_NOW }, ids: { next: () => ids.shift()! } },
      { activityId: 'ambiguous-call', personId: owner.personId, rawText: `Lead: ${quote}` });
    for (const p of properties) f.database.raw.prepare('UPDATE properties SET maintenance_profile_json = ? WHERE id = ?').run(
      JSON.stringify({ formatVersion: 1, management: 'self_managed', relevantProfile: 'unknown', evidenceRefs: ['ambiguous-utterance'] }), p.id);
    const before = f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all();
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    f.services.unitOfWork.immediate(() => {
      const snapshot = collect(owner.prospectId);
      writer().apply(snapshot);
      expect(snapshot.properties).toHaveLength(2);
      expect(snapshot.properties.every(p => p.maintenanceProfile === null)).toBe(true);
      expect(snapshot.validatedClaims.some(c => c.value === 'self_managed')).toBe(false);
      expect(snapshot.validatedClaims.some(c => c.value === quote)).toBe(true);
    });
    expect(f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all()).toEqual(before);
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('makes no materializer writes when a known-parcel address conflict coexists with an independently fillable property', () => {
    const owner = linkedParcels(false);
    const properties = f.services.identities.listPropertiesForProspect(owner.prospectId);
    const first = properties.find(p => p.addressLine1 !== 'second st')!;
    const second = properties.find(p => p.id !== first.id)!;
    f.database.raw.prepare('UPDATE properties SET address_line_1 = ? WHERE id = ?').run('Founder Disagrees St', first.id);
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(second.id);
    const rows = f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all();
    const sources = f.database.raw.prepare('SELECT * FROM source_events ORDER BY id').all();
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    const snapshot = f.services.unitOfWork.immediate(() => {
      const evidence = collect(owner.prospectId); writer().apply(evidence); return evidence;
    });
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(f.database.raw.prepare('SELECT * FROM properties ORDER BY id').all()).toEqual(rows);
    expect(f.database.raw.prepare('SELECT * FROM source_events ORDER BY id').all()).toEqual(sources);
    expect(snapshot.properties.find(p => p.id === second.id)?.doorCount).toBe(3);
    expect(evaluateDiscovery({ snapshot, rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: DISCOVERY_NOW }).disposition).toBe('judgment');
    expect(f.services.prioritizationRepository.listTriggerEvents(owner.prospectId)).toEqual([]);
  });

  it('accepts distinct Pick wrappers with exact dependency instances while preserving stale, forged and database identity guards', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'composition', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(property.id);
    const collectorServices = evidenceServices(); const writerServices = evidenceServices();
    expect(collectorServices).not.toBe(writerServices);
    const materializer = new DiscoveryFactWriter({ database: f.database, unitOfWork: f.services.unitOfWork, services: writerServices });
    f.services.unitOfWork.immediate(() => {
      const snapshot = collectDiscoveryEvidence({ database: f.database, services: collectorServices, prospectId: owner.prospectId, asOf: DISCOVERY_NOW });
      materializer.apply(snapshot);
      expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBe(10);
      const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
      expect(() => materializer.apply(snapshot)).toThrow('stale_evidence');
      const fresh = collectDiscoveryEvidence({ database: f.database, services: evidenceServices(), prospectId: owner.prospectId, asOf: DISCOVERY_NOW });
      materializer.apply(fresh);
      expect(() => materializer.apply({ ...fresh })).toThrow('stale_evidence');
      const differentDatabaseWrapper = new DiscoveryFactWriter({ database: { ...f.database }, unitOfWork: f.services.unitOfWork, services: writerServices });
      expect(() => differentDatabaseWrapper.apply(fresh)).toThrow('stale_evidence');
      expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    });
  });

  it.each([false, true])('rejects a substituted actual repository instance even if the admitted Pick wrapper was mutated: %s', mutateWrapper => {
    const owner = seedDiscoveryOwner(f, { prefix: 'binding', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(property.id);
    const collectorServices = evidenceServices();
    const replacement = new SourceRepository({ database: f.database, unitOfWork: f.services.unitOfWork, clock: { now: () => DISCOVERY_NOW } });
    expect(replacement).not.toBe(collectorServices.sourceRepository);
    f.services.unitOfWork.immediate(() => {
      const snapshot = collectDiscoveryEvidence({ database: f.database, services: collectorServices, prospectId: owner.prospectId, asOf: DISCOVERY_NOW });
      const writerServices = mutateWrapper ? collectorServices : evidenceServices();
      writerServices.sourceRepository = replacement;
      const materializer = new DiscoveryFactWriter({ database: f.database, unitOfWork: f.services.unitOfWork, services: writerServices });
      const before = f.database.raw.prepare('SELECT total_changes() AS n').get();
      expect(() => materializer.apply(snapshot)).toThrow('stale_evidence');
      expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBeNull();
      expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    });
  });

  it('fills only a missing supported door count and preserves profile, verification and lifecycle with no-op replay', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'fill', units: 10 });
    const property = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(property.id);
    const before = f.database.raw.prepare('SELECT * FROM sales_cycles').all();
    f.services.unitOfWork.immediate(() => writer().apply(collect(owner.prospectId)));
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]).toMatchObject({ doorCount: 10, verifiedAt: null, maintenanceProfile: null });
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    f.services.unitOfWork.immediate(() => writer().apply(collect(owner.prospectId)));
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(f.database.raw.prepare('SELECT * FROM sales_cycles').all()).toEqual(before);
  });

  it('asserts exact UOW and rolls back all supported writes with the caller', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'rollback', units: 10 });
    const p = f.services.identities.listPropertiesForProspect(owner.prospectId)[0]!;
    f.database.raw.prepare('UPDATE properties SET door_count = NULL WHERE id = ?').run(p.id);
    const snapshot = f.services.unitOfWork.immediate(() => collect(owner.prospectId));
    expect(() => writer().apply(snapshot)).toThrow();
    expect(() => new DiscoveryFactWriter({ database: f.database, unitOfWork: new DomainUnitOfWork(f.database), services: f.services })).toThrow();
    expect(() => f.services.unitOfWork.immediate(() => { writer().apply(collect(owner.prospectId)); throw new Error('abort'); })).toThrow('abort');
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBeNull();
  });

  it('never overwrites a conflicting founder value or trusts a stale/forged snapshot', () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'founder', units: 10 });
    f.services.unitOfWork.immediate(() => {
      const snapshot = collect(owner.prospectId);
      f.database.raw.prepare('UPDATE properties SET door_count = 99 WHERE id = ?').run(snapshot.properties[0]!.id);
      expect(() => writer().apply(snapshot)).toThrow();
      expect(() => writer().apply({ ...snapshot, properties: [{ ...snapshot.properties[0]!, doorCount: 2 }] })).toThrow();
      writer().apply(collect(owner.prospectId));
    });
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)[0]?.doorCount).toBe(99);
  });

  it.each([true, false, null])('maps only fully validated explicit FRBO vacancy (%s), never self-management, with one trigger per source', vacancy => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person; event.signal_flags.vacancy = vacancy;
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('Expected intake');
    const owner = f.services.sources.createPersonProspect(mapped.command);
    f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId, entrySourceEventId: owner.sourceEventId, effectiveAt: DISCOVERY_NOW });
    const initial = f.services.identities.listPropertiesForProspect(owner.prospectId);
    f.services.unitOfWork.immediate(() => writer().apply(collect(owner.prospectId)));
    const events = f.services.prioritizationRepository.listTriggerEvents(owner.prospectId);
    expect(events).toHaveLength(vacancy === true ? 1 : 0);
    if (vacancy === true) expect(events[0]).toMatchObject({ triggerType: 'live_vacancy', sourceEventId: owner.sourceEventId, effectiveAt: event.observed_at, verificationState: 'unverified' });
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    f.services.unitOfWork.immediate(() => writer().apply(collect(owner.prospectId)));
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(f.services.identities.listPropertiesForProspect(owner.prospectId)).toEqual(initial);
  });
});
