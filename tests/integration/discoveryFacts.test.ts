import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDiscoveryEvidence } from '../../src/main/domain/discovery/discoveryEvidence';
import { DiscoveryFactWriter } from '../../src/main/domain/discovery/discoveryFactWriter';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { mapCloudSourceEvent } from '../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent } from '../fixtures/cloudSourceEvents';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase;
beforeEach(async () => { f = await createDiscoveryDatabase(); });
afterEach(() => f.close());
function writer() { return new DiscoveryFactWriter({ database: f.database, unitOfWork: f.services.unitOfWork, services: f.services }); }
function collect(prospectId: string) { return collectDiscoveryEvidence({ database: f.database, services: f.services, prospectId, asOf: DISCOVERY_NOW }); }

describe('discovery scoped canonical materialization', () => {
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
