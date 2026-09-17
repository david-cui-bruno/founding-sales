import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { ResearchSetupService, guidedResearchBudgetId, guidedResearchMarkerKey, placesResearchBudgetId, type ResearchSetupProfile } from '../src/researchSetup';
import { budgetKey, researchAdmissionKey, type Budget } from '../src/discoveryReservationStore';
import { fingerprint } from '../src/dynamoStore';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { researchSetupRemoteStatusSchema, type ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';
import { ConditionalCommandHarness } from './sdkHarness';

const now = '2026-09-17T12:00:00.000Z';
const workspaceId = 'fss-pilot';
const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const, placesSearchCostMicros: 35000 };
const firms = [
  { id: 'place-alpha', displayName: { text: 'Alpha Residential Management' }, nationalPhoneNumber: '(401) 555-0101', websiteUri: 'https://alpha-pm.example/' },
  { id: 'place-beta', displayName: { text: 'Beta Property Group' }, nationalPhoneNumber: '(617) 555-0102', websiteUri: 'https://beta-group.example/' },
  { id: 'place-gamma', displayName: { text: 'Gamma Rentals' }, nationalPhoneNumber: '(617) 555-0103' },
];
type Approve = Extract<ResearchSetupRequest, { kind: 'approve' }>;
async function fixture() {
  const db = new ConditionalCommandHarness(); const options = { dynamo: db, tableName: 'fictional-table', workspaceId, clock: { now: () => now } };
  const auth = new WorkerAuth(options); const store = auth.store;
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(descriptor), credentialParameterDeclared: true, placesCredentialParameterDeclared: true };
  const setup = new ResearchSetupService({ auth, profile }); const bearer = `Bearer ${pair.credential}`;
  const identity = { workspaceId, pairingId: pair.pairingId };
  const base = { version: 1 as const, kind: 'approve' as const, ...identity };
  const cited = (expectedRevision: number, ceilings = { discoveryCeilingMicros: 80, researchCeilingMicros: 100 }): Approve => ({ ...base, requestId: randomUUID(), input: {
    expectedRevision, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Providence, RI'], terms: ['property management'] },
    permittedSources: ['https://fictional.example/'], maxCompanies: 1, maxPages: 1, maxBytes: 10000, ...ceilings, disclosureAcknowledged: true } });
  const places = (expectedRevision: number, ceilings = { discoveryCeilingMicros: 105000, researchCeilingMicros: 150 }): Approve => ({ ...base, requestId: randomUUID(), input: {
    expectedRevision, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] },
    permittedSources: [], maxCompanies: 20, maxPages: 1, maxBytes: 10000, ...ceilings, disclosureAcknowledged: true, discoveryProvider: 'places' } });
  /** Records reserved-or-spent balance the way the runtime does, so a replace can be checked to leave it alone. */
  const spend = async (key: string, spent: number) => { const row = (await store.get<Budget>(key))!; await store.transact([store.put(key, { ...row.data, spent }, row.rev, { limit: row.data.limit, spent })]); };
  const budget = (key: string) => db.inspect(key) as Budget | undefined;
  const source = () => ownerResearchSourceSchema.parse(db.inspect(ownerResearchSourceKey()));
  const requests: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ places: firms }); };
  const research = { loadCredentials: async () => ({ apiKey: 'fictional', model: 'fictional-reviewed-model' }), loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }),
    resolve: async () => ['93.184.216.34'], pageHttp: async () => new Response('<p>We manage 120 residential units.</p>', { headers: { 'content-type': 'text/html' } }) };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
  return { db, store, pair, setup, bearer, identity, cited, places, spend, budget, source, requests,
    apply: (request: ResearchSetupRequest) => setup.apply(request, bearer),
    status: async () => researchSetupRemoteStatusSchema.parse(await setup.status(identity, bearer)),
    tick: () => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(new AbortController().signal) };
}

describe('replacing an existing guided research configuration', () => {
  it('replaces the cited setup with Places in place: revision advances, the Places ledger is created, the research ceiling widens, spent and the fence are kept', async () => {
    const f = await fixture();
    expect(await f.apply(f.cited(0))).toMatchObject({ status: 'applied', revision: 1, state: 'active' });
    await f.spend(budgetKey(guidedResearchBudgetId), 80); await f.spend('BUDGET#research', 30);
    const fenceBefore = (await f.store.get(researchAdmissionKey))!; const before = f.db.transactions.length;
    const replace = f.places(1);
    expect(await f.apply(replace)).toEqual({ ...f.identity, requestId: replace.requestId, kind: 'approve', fingerprint: fingerprint(replace), status: 'applied', revision: 2, state: 'active' });
    expect(f.db.transactions.length - before).toBe(1);
    const config = f.source();
    expect(config).toMatchObject({ revision: 2, state: 'active', research: { budgetId: placesResearchBudgetId, discoveryProvider: 'places', preparationCommandId: replace.requestId, permittedSources: [],
      discoveryLimits: { maxCompanies: 20, maxCostMicros: 35000 }, researchLimits: { maxCostMicros: 100 }, audienceRevision: 2, sourceRevision: 2, budgetRevision: 2 } });
    expect(f.budget(budgetKey(placesResearchBudgetId))).toEqual({ limit: 105000, spent: 0, approvedAt: now });
    expect(f.budget(budgetKey(guidedResearchBudgetId))).toMatchObject({ limit: 80, spent: 80 });
    expect(f.budget('BUDGET#research')).toMatchObject({ limit: 150, spent: 30 });
    const fenceAfter = (await f.store.get(researchAdmissionKey))!;
    expect(fenceAfter).toEqual(fenceBefore); expect(fenceAfter.data).toEqual({ version: 1, kind: 'guided' });
    expect(f.db.inspect(guidedResearchMarkerKey)).toEqual({ version: 1, workspaceId, pairingId: f.pair.pairingId, budgetId: placesResearchBudgetId, descriptorFingerprint: fingerprint(descriptor), settingsFingerprint: fingerprint(config.research) });
    const status = await f.status();
    expect(status.blockers).toEqual([]); expect(status.selector?.revision).toBe(2);
    expect(status.discoveryLedger).toEqual({ limitMicros: 105000, reservedOrSpentMicros: 0, remainingMicros: 105000 });
    expect(status.researchLedger).toEqual({ limitMicros: 150, reservedOrSpentMicros: 30, remainingMicros: 120 });
    // The replaced configuration runs on its own ledger and a fresh cursor; the exhausted guided ledger is not consulted.
    const report = await f.tick();
    expect(f.requests).toEqual([{ textQuery: 'property management company in Providence, RI', pageSize: 20 }]);
    expect(report.places).toMatchObject({ outcome: 'completed', created: 2, routes: 2 });
    expect(f.db.inspect(`DISCOVERY_CURSOR#${placesResearchBudgetId}`)).toMatchObject({ queryIndex: 1, ordinal: 1 });
    expect(f.budget(budgetKey(placesResearchBudgetId))).toMatchObject({ limit: 105000, spent: 35000 });
    expect(f.budget(budgetKey(guidedResearchBudgetId))).toMatchObject({ limit: 80, spent: 80 });
    expect(await f.store.list('ACCOUNT#')).toHaveLength(2);
  });
  it('never lowers a ceiling or touches spent, and a second replace with the same provider reuses its ledger', async () => {
    const f = await fixture();
    await f.apply(f.cited(0)); await f.apply(f.places(1)); await f.spend(budgetKey(placesResearchBudgetId), 70000); await f.spend('BUDGET#research', 30);
    expect(await f.apply(f.places(2, { discoveryCeilingMicros: 50000, researchCeilingMicros: 100 }))).toMatchObject({ status: 'applied', revision: 3, state: 'active' });
    expect(f.budget(budgetKey(placesResearchBudgetId))).toMatchObject({ limit: 105000, spent: 70000 });
    expect(f.budget('BUDGET#research')).toMatchObject({ limit: 150, spent: 30 });
    expect(f.source()).toMatchObject({ revision: 3, research: { budgetId: placesResearchBudgetId } });
    expect(await f.apply(f.places(3, { discoveryCeilingMicros: 210000, researchCeilingMicros: 400 }))).toMatchObject({ status: 'applied', revision: 4 });
    expect(f.budget(budgetKey(placesResearchBudgetId))).toMatchObject({ limit: 210000, spent: 70000 });
    expect(f.budget('BUDGET#research')).toMatchObject({ limit: 400, spent: 30 });
    expect(await f.store.list('BUDGET#discovery#')).toHaveLength(2);
    // Back to the cited provider: its original ledger, spent balance included, is reused and only widened.
    await f.spend(budgetKey(guidedResearchBudgetId), 80);
    expect(await f.apply(f.cited(4, { discoveryCeilingMicros: 90, researchCeilingMicros: 100 }))).toMatchObject({ status: 'applied', revision: 5 });
    expect(f.budget(budgetKey(guidedResearchBudgetId))).toMatchObject({ limit: 90, spent: 80 });
    expect(f.source()).toMatchObject({ revision: 5, research: { budgetId: guidedResearchBudgetId, permittedSources: ['https://fictional.example/'] } });
    expect(f.source().research).not.toHaveProperty('discoveryProvider');
    expect(f.db.inspect(guidedResearchMarkerKey)).toMatchObject({ budgetId: guidedResearchBudgetId, settingsFingerprint: fingerprint(f.source().research) });
    expect(f.db.inspect(researchAdmissionKey)).toEqual({ version: 1, kind: 'guided' });
  });
  it('refuses a stale, future or foreign revision and an empty workspace with no writes, and still requires the first-use revision to be exactly 0', async () => {
    const f = await fixture();
    await f.apply(f.cited(0)); await f.apply(f.places(1));
    const before = f.db.transactions.length; const config = f.source();
    for (const revision of [1, 3, 8]) await expect(f.apply(f.places(revision))).rejects.toThrow('research_setup_revision_conflict');
    await expect(f.apply({ ...f.places(2), pairingId: randomUUID() })).rejects.toThrow(/research_setup/);
    expect(f.db.transactions.length).toBe(before); expect(f.source()).toEqual(config);
    const empty = await fixture(); const emptyBefore = empty.db.transactions.length;
    await expect(empty.apply(empty.places(1))).rejects.toThrow('research_setup_legacy_or_orphan_state');
    expect(empty.db.transactions.length).toBe(emptyBefore); expect(empty.db.inspect(ownerResearchSourceKey())).toBeUndefined();
    await expect(f.apply(f.cited(0))).rejects.toThrow('research_setup_legacy_or_orphan_state');
  });
  it('a first-use Places approval draws on the Places ledger from the start', async () => {
    const f = await fixture();
    expect(await f.apply(f.places(0))).toMatchObject({ status: 'applied', revision: 1, state: 'active' });
    expect(f.source()).toMatchObject({ revision: 1, research: { budgetId: placesResearchBudgetId, discoveryProvider: 'places' } });
    expect(f.budget(budgetKey(placesResearchBudgetId))).toEqual({ limit: 105000, spent: 0, approvedAt: now });
    expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toBeUndefined();
    const status = await f.status();
    expect(status.blockers).toEqual([]); expect(status.discoveryLedger).toEqual({ limitMicros: 105000, reservedOrSpentMicros: 0, remainingMicros: 105000 });
  });
});
