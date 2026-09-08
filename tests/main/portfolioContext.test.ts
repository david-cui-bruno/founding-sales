import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase;
beforeEach(async () => { f = await createDiscoveryDatabase(); });
afterEach(() => f.close());
const detail = (personId: string) => createFounderSalesDomain({ database: f.database, services: f.services,
  clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } }).getLeadDetail({ personId });

it.each([
  ['referral', true, 'Introduced by Alex Referral'],
  ['referral', false, 'Recorded referral, referrer not recorded'],
  ['inbound_demo', false, 'Requested a demo'],
] as const)('prefers factual %s source context over a property fact (known referrer %s)', (channel, knownReferrer, reason) => {
  const owner = seedDiscoveryOwner(f, { prefix: 'Warm', units: 4 });
  const raw = f.database.raw;
  raw.prepare(`INSERT INTO persons(id,display_name,aliases_json,created_at,updated_at)
    VALUES('referrer','Alex Referral','[]',?,?)`).run(DISCOVERY_NOW, DISCOVERY_NOW);
  raw.prepare(`INSERT INTO source_events(id,person_id,prospect_id,channel,observed_at,source_record_json,referred_by_person_id,referrer_unknown_reason,created_at)
    VALUES('warm-source',?,?,?,?,'{}',?,?,?)`).run(owner.personId, owner.prospectId, channel, DISCOVERY_NOW,
    knownReferrer ? 'referrer' : null, channel === 'referral' && !knownReferrer ? 'Not supplied' : null, DISCOVERY_NOW);
  const result = detail(owner.personId);
  expect(result.contactReason).toEqual({ text: reason, evidenceIds: ['source:warm-source:reason'] });
  expect(result.portfolio?.facts).toContainEqual({ id: 'source:warm-source:reason', text: reason });
  expect(result.portfolio?.ownedCount).toBe(1);
});

it('projects sourced owner holdings with a partial scope and a cited property-specific reason', () => {
  const owner = seedDiscoveryOwner(f, { prefix: 'Known', units: 4 });
  const value = detail(owner.personId) as ReturnType<typeof detail> & { portfolio?: unknown; contactReason?: unknown };
  expect(value.portfolio).toMatchObject({ role: 'owner', ownedCount: 1, managedCount: 0, linkedCount: 0,
    knownUnits: 4, completeness: 'partial', locations: ['Providence, RI'] });
  expect(value.contactReason).toMatchObject({ text: expect.stringContaining('Known Hope St'), evidenceIds: [expect.any(String)] });
});

it('never infers a PM role or ownership from a company spelling or unexplained link', () => {
  const owner = seedDiscoveryOwner(f, { prefix: 'PM Management', units: null });
  const raw = f.database.raw;
  // Preserve the source but break its exact property match. A stored link alone is not proof.
  raw.prepare("UPDATE properties SET address_line_1 = '99 Other St' WHERE id IN (SELECT property_id FROM prospect_properties WHERE prospect_id = ?)").run(owner.prospectId);
  const value = detail(owner.personId) as ReturnType<typeof detail> & { portfolio?: unknown; contactReason?: unknown };
  expect(value.portfolio).toMatchObject({ role: 'unknown', ownedCount: 0, managedCount: 0, linkedCount: 1, knownUnits: null, completeness: 'partial' });
  expect(value.contactReason).toBeNull();
});

it('counts a duplicate civic property once and refuses inconsistent known unit totals', () => {
  const owner = seedDiscoveryOwner(f, { prefix: 'Deduplicated', units: 4 });
  const raw = f.database.raw;
  raw.prepare(`INSERT INTO properties(id,address_line_1,locality,region,country_code,door_count,created_at,updated_at)
    VALUES('duplicate','Deduplicated Hope St','Providence','RI','US',5,?,?)`).run(DISCOVERY_NOW, DISCOVERY_NOW);
  raw.prepare(`INSERT INTO prospect_properties(prospect_id,property_id,relationship,created_at) VALUES(?,'duplicate','property_owner',?)`).run(owner.prospectId, DISCOVERY_NOW);
  const value = detail(owner.personId) as ReturnType<typeof detail> & { portfolio?: unknown };
  expect(value.portfolio).toMatchObject({ ownedCount: 1, managedCount: 0, linkedCount: 0, knownUnits: null, completeness: 'partial' });
});

it('distinguishes explicit managed holdings without turning unknown counts into zero', () => {
  const owner = seedDiscoveryOwner(f, { prefix: 'Managed', units: null });
  const raw = f.database.raw;
  raw.prepare("UPDATE properties SET address_line_1 = '17 Managed St' WHERE id IN (SELECT property_id FROM prospect_properties WHERE prospect_id = ?)").run(owner.prospectId);
  raw.prepare("UPDATE prospect_properties SET relationship = 'property_manager' WHERE prospect_id = ?").run(owner.prospectId);
  const value = detail(owner.personId) as ReturnType<typeof detail> & { portfolio?: unknown };
  expect(value.portfolio).toMatchObject({ role: 'manager', ownedCount: 0, managedCount: 1, linkedCount: 0, knownUnits: null, completeness: 'partial' });
});
