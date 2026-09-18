import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { TerritoryPolicyRepository, territoryBackfillCursorKey, territoryEnrollmentKey } from '../src/territoryPolicyRepository';
import { executionAuthorityKey } from '../src/executionRepository';
import { ResearchSetupService, placesResearchBudgetId, type ResearchSetupProfile } from '../src/researchSetup';
import { budgetKey } from '../src/discoveryReservationStore';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { territoryPolicyCommandSchema, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, TERRITORY_CALL_POLICY_SUBJECT } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import type { ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-18T12:00:00.000Z';
const citedDescriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-17T00:00:00.000Z',
  expiresAt: '2026-09-19T00:00:00.000Z', provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const };
const descriptor = { ...citedDescriptor, placesSearchCostMicros: 35000 };

async function fixture() {
  const db = new ConditionalCommandHarness();
  const options = { dynamo: db, tableName: 'fictional-territory', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const bearer = `Bearer ${pair.credential}`;
  const store = new DynamoStore(options);
  const accounts = createWorkerAccountRepository(options);
  const coordinator = new OwnerCommandCoordinator({ auth, authorization: new RemoteGoogleAuthorization({ auth }) });
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(descriptor), credentialParameterDeclared: true, placesCredentialParameterDeclared: true };
  const setup = new ResearchSetupService({ auth, profile });
  const request: Extract<ResearchSetupRequest, { kind: 'approve' }> = { version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId, input: {
    expectedRevision: 0, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Providence, RI'], terms: ['property management company'] },
    permittedSources: [], maxCompanies: 20, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 105000, researchCeilingMicros: 1000, disclosureAcknowledged: true, discoveryProvider: 'places' } };
  let placesCalls = 0;
  const fetch: typeof globalThis.fetch = async () => { placesCalls++; return Response.json({ places: [] }); };
  const research = { loadCredentials: async () => ({ apiKey: 'fictional', model: 'fictional-reviewed-model' }), loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }),
    resolve: async () => ['93.184.216.34'], pageHttp: async () => new Response('<p>fictional</p>', { headers: { 'content-type': 'text/html' } }) };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
  let commands = 0;
  const command = (payload: TerritoryPolicyCommand['payload'], id = uuid(++commands)) => territoryPolicyCommandSchema.parse({ commandId: id, workspaceId: 'ws',
    accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
  /** A Places-born firm exactly as the research coordinator materialises it: create, listed-phone source attestation, listed business route. */
  const firm = async (n: number, phone: string | null) => {
    const account = await accounts.create({ commandId: uuid(100 + n), name: `Fictional PM ${n}`, domain: `fictional-${n}.example` });
    if (!phone) return { account, route: null };
    const source = { id: `place-${n}`, url: `https://places.example.invalid/${n}`, fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Business listing', permitted: true };
    const route = { id: `route-${n}`, accountId: account.id, personId: null, channel: 'phone' as const, value: phone, purpose: 'business' as const, evidenceIds: [source.id], verification: 'listed' as const };
    await accounts.recordFetchedSource({ accountId: account.id, source });
    await accounts.admitEvidence({ commandId: uuid(200 + n), accountId: account.id, expectedVersion: 1, sources: [source], claims: [], routes: [route] });
    return { account, route };
  };
  return { db, options, auth, pair, bearer, store, accounts, coordinator, profile, setup, request, firm, command,
    apply: (payload: TerritoryPolicyCommand['payload'], id?: string) => coordinator.apply(command(payload, id), bearer),
    tick: (signal = new AbortController().signal) => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(signal),
    placesCalls: () => placesCalls };
}
const approve = { kind: 'policy.approve' as const, expectedRevision: 0, definition: DEFAULT };

describe('territory backfill for firms that already exist', () => {
  it('gives every pre-existing listed firm the same authority a newly admitted firm gets, names each hold and creates nothing on a second sweep', async () => {
    const f = await fixture();
    const firms = [await f.firm(1, '+14015550201'), await f.firm(2, '+14015550202'), await f.firm(3, '+14015550203')];
    const unlisted = await f.firm(4, null);
    const owned = await f.firm(5, '+14015550205');
    await f.store.transact([f.store.put(executionAuthorityKey(owned.account.id), { authority: { accountId: owned.account.id, owner: 'local', generation: 0, state: 'local' }, version: 0 }, null)]);
    // Before the policy: the sweep finds no policy and touches nothing.
    const quiet = await f.tick();
    expect(quiet.territory).toEqual({ outcome: 'no_policy', scanned: 0, enrolled: 0, replayed: 0, skipped: { policy_paused: 0, authority_exists: 0, route_unavailable: 0, enrollment_failed: 0 } });
    // Only the authority the fixture seeded for the owned firm exists: no policy, no grant.
    expect((await f.store.list('AUTH#')).map(entry => entry.key)).toEqual([executionAuthorityKey(owned.account.id)]);
    await f.apply(approve, uuid(10));
    const report = await f.tick();
    expect(report.phases.territoryBackfill).toBe('completed');
    // Every firm scanned exactly once; the three listed ones are already enrolled (the approval receipt swept them), the other two name their hold.
    expect(report.territory).toEqual({ outcome: 'exhausted', scanned: 5, enrolled: 0, replayed: 3, skipped: { policy_paused: 0, authority_exists: 1, route_unavailable: 1, enrollment_failed: 0 } });
    expect(report.heldByReason.territory_backfill_held).toBeUndefined();
    for (const entry of firms) {
      expect(f.db.inspect(territoryEnrollmentKey(entry.account.id))).toMatchObject({ accountId: entry.account.id, routeId: entry.route!.id, revision: 1 });
      expect(f.db.inspect(executionAuthorityKey(entry.account.id))).toMatchObject({ authority: { owner: 'worker', state: 'active', generation: 1 } });
    }
    expect(f.db.inspect(territoryEnrollmentKey(unlisted.account.id))).toBeUndefined();
    expect(f.db.inspect(territoryEnrollmentKey(owned.account.id))).toBeUndefined();
    const events = (await f.store.eventsAfter(null)).events;
    const granted = events.filter(event => event.kind === 'authority.granted');
    expect(granted.map(event => event.accountId).sort()).toEqual(firms.map(entry => entry.account.id).sort());
    // The wrapped cursor sweeps again next tick and creates nothing: no new enrollment, no new authority, no new event.
    const enrollments = firms.map(entry => f.db.inspect(territoryEnrollmentKey(entry.account.id)));
    const again = await f.tick();
    expect(again.territory).toMatchObject({ outcome: 'exhausted', scanned: 5, enrolled: 0, replayed: 3 });
    expect((await f.store.eventsAfter(null)).events).toEqual(events);
    expect(firms.map(entry => f.db.inspect(territoryEnrollmentKey(entry.account.id)))).toEqual(enrollments);
  });
  it('enrolls in the scheduled tick the firms the bounded approval sweep could not reach', async () => {
    const f = await fixture();
    const firms: Awaited<ReturnType<typeof f.firm>>[] = [];
    for (let index = 0; index < 12; index++) firms.push(await f.firm(index + 1, `+1401555${String(2000 + index).padStart(4, '0')}`));
    await f.apply(approve, uuid(10));
    // The approval receipt path is deliberately bounded: it enrolls its cap and leaves the rest to the sweep's own cursor.
    const enrolledAtApproval = firms.filter(entry => f.db.inspect(territoryEnrollmentKey(entry.account.id)) !== undefined);
    expect(enrolledAtApproval).toHaveLength(10);
    const report = await f.tick();
    // The tick resumes at the cursor the approval sweep left, so it scans the two remaining firms and no others before wrapping.
    expect(report.territory).toMatchObject({ outcome: 'exhausted', scanned: 2, enrolled: 2, replayed: 0, skipped: { route_unavailable: 0, authority_exists: 0 } });
    for (const entry of firms) expect(f.db.inspect(executionAuthorityKey(entry.account.id))).toMatchObject({ authority: { owner: 'worker', state: 'active', generation: 1 } });
    expect((await f.store.eventsAfter(null)).events.filter(event => event.kind === 'authority.granted')).toHaveLength(12);
  });
  it('resumes from its persisted cursor after an abort instead of starting the table again', async () => {
    const f = await fixture();
    const firms = [await f.firm(1, '+14015550201'), await f.firm(2, '+14015550202'), await f.firm(3, '+14015550203')];
    const standing = await f.apply(approve, uuid(10));
    expect(standing.policy).toMatchObject({ revision: 1, state: 'active' });
    const controller = new AbortController();
    let seen = 0;
    const repository = new TerritoryPolicyRepository(f.options);
    const first = await repository.sweepTerritoryBackfill({ limit: 50, signal: controller.signal, onFirm: () => { if (++seen === 1) controller.abort(); } });
    expect(first).toMatchObject({ outcome: 'held', scanned: 1 });
    const cursor = f.db.inspect(territoryBackfillCursorKey) as { version: number; after: string | null };
    expect(cursor.version).toBe(1);
    expect(cursor.after).toMatch(/^ACCOUNT#/);
    const resumed = await new TerritoryPolicyRepository(f.options).sweepTerritoryBackfill({ limit: 50 });
    // Two firms remain after the cursor, not all three: the abort did not cost the sweep its position.
    expect(resumed).toMatchObject({ outcome: 'exhausted', scanned: 2 });
    for (const entry of firms) expect(f.db.inspect(territoryEnrollmentKey(entry.account.id))).toMatchObject({ accountId: entry.account.id });
    expect(f.db.inspect(territoryBackfillCursorKey)).toEqual({ version: 1, after: null });
  });
  it('sweeps a bounded first batch straight from the approval receipt path, before any scheduled tick, and leaves a paused policy alone', async () => {
    const f = await fixture();
    const firm = await f.firm(1, '+14015550201');
    const receipt = await f.apply(approve, uuid(10));
    expect(receipt).toMatchObject({ receipt: { status: 'applied' }, policy: { revision: 1, state: 'active' } });
    expect(f.db.inspect(territoryEnrollmentKey(firm.account.id))).toMatchObject({ accountId: firm.account.id, revision: 1 });
    expect(f.db.inspect(executionAuthorityKey(firm.account.id))).toMatchObject({ authority: { owner: 'worker', state: 'active' } });
    await f.apply({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' });
    const later = await f.firm(2, '+14015550202');
    const report = await f.tick();
    expect(report.territory).toMatchObject({ outcome: 'policy_paused', scanned: 0, enrolled: 0 });
    expect(f.db.inspect(territoryEnrollmentKey(later.account.id))).toBeUndefined();
  });
  it('names an unexpected sweep failure by its constructor class alone, carrying no message into the tick record', async () => {
    const f = await fixture();
    await f.firm(1, '+14015550201');
    await f.apply(approve, uuid(10));
    // A stored account record whose data names another firm is the one condition the sweep refuses rather than counts.
    const key = `ACCOUNT#${encodeURIComponent('account-impostor')}`;
    const record = f.db.inspect(`ACCOUNT#${encodeURIComponent((await f.store.list<{ account: { id: string } }>('ACCOUNT#'))[0]!.stored.data.account.id)}`);
    await f.store.transact([f.store.put(key, record, null)]);
    const report = await f.tick();
    expect(report.phases.territoryBackfill).toBe('held');
    expect(report.phaseHolds.territoryBackfill).toEqual({ reason: 'phase_error', errorClass: 'Error' });
    expect(report.heldByReason.territory_phase_failed).toBe(1);
    expect(report.territory).toBeUndefined();
    const line = JSON.stringify(f.db.inspect('SOURCE_LAST_TICK'));
    expect(line).toContain('"territoryBackfill":{"reason":"phase_error","errorClass":"Error"}');
    expect(line).not.toContain('identity_conflict');
    expect(line).not.toContain('impostor');
  });
});

describe('the research phase names the condition it hit', () => {
  it('reports descriptor_changed with no throw and no spend when the marker no longer matches the deployed descriptor', async () => {
    const f = await fixture();
    await f.setup.apply(f.request, f.bearer);
    f.profile.reviewedCapability = { ...descriptor, provenance: 'A different operator review' };
    const report = await f.tick();
    expect(report.phases.research).toBe('held');
    expect(report.phaseHolds).toEqual({ research: { reason: 'descriptor_changed', errorClass: null } });
    expect(f.placesCalls()).toBe(0);
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 0 });
    expect(f.db.inspect('SOURCE_LAST_TICK')).toMatchObject({ phaseHolds: { research: { reason: 'descriptor_changed', errorClass: null } } });
  });
  it('reports descriptor_expired when the operator review has lapsed', async () => {
    const f = await fixture();
    await f.setup.apply(f.request, f.bearer);
    f.profile.reviewedCapability = { ...descriptor, expiresAt: now };
    const expired = await f.tick();
    expect(expired.phaseHolds.research).toEqual({ reason: 'descriptor_expired', errorClass: null });
    expect(f.placesCalls()).toBe(0);
  });
});
