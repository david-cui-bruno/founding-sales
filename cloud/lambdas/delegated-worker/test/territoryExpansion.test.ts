import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { TerritoryPolicyRepository, territoryAddedStatesKey, territoryCountsKey, territoryEnrollmentKey } from '../src/territoryPolicyRepository';
import { WorkerCampaignRepository, campaignEnrollmentKey, territoryRetiredRouteKey, territoryRetiredRouteSchema } from '../src/workerCampaignRepository';
import { CampaignExecution } from '../src/campaignExecution';
import { ResearchSetupService, type ResearchSetupProfile } from '../src/researchSetup';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { territoryPolicyCommandSchema, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { advanceTerritorySequence, decideTerritoryReentry, DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, deriveTerritoryCampaignVersion,
  selectTerritoryReplacementRoute, territoryCallPolicyId, TERRITORY_CALL_POLICY_SUBJECT, TERRITORY_FINAL_REST_DAYS,
  TERRITORY_MAX_ENTRIES } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { planNext } from '../../../../src/main/domain/campaign/sequencePlanner';
import { researchSetupRemoteStatusSchema, territoryRemainingNewPerMorning, TERRITORY_ESTIMATE_MORNINGS,
  type ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';
import { enrollmentSchema, type CampaignCommandPayload } from '../../../../src/shared/contracts/campaignContract';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-18T12:00:00.000Z'; // Friday
const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 },
  reviewedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-19T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const,
  placesSearchCostMicros: 35000 };
const approve = { kind: 'policy.approve' as const, expectedRevision: 0, definition: DEFAULT };

/** The real coordinator, policy repository and research status over the real conditional-write harness. Nothing here dials or sends. */
async function workspace() {
  const db = new ConditionalCommandHarness();
  const options = { dynamo: db, tableName: 'fictional-territory-expansion', workspaceId: 'ws', clock: { now: () => now } };
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
  const fetch: typeof globalThis.fetch = async () => Response.json({ places: [] });
  const research = { loadCredentials: async () => ({ apiKey: 'fictional', model: 'fictional-reviewed-model' }), loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }),
    resolve: async () => ['93.184.216.34'], pageHttp: async () => new Response('<p>fictional</p>', { headers: { 'content-type': 'text/html' } }) };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
  let commands = 0;
  const command = (payload: TerritoryPolicyCommand['payload'], id = uuid(++commands)) => territoryPolicyCommandSchema.parse({ commandId: id, workspaceId: 'ws',
    accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
  /** A Places-born firm exactly as the research coordinator materialises it: create, listing attestation, listed business route. */
  const firm = async (n: number, phone: string | null) => {
    const account = await accounts.create({ commandId: uuid(100 + n), name: `Fictional PM ${n}`, domain: `fictional-${n}.example` });
    if (!phone) return { account, route: null };
    const source = { id: `place-${n}`, url: `https://places.example.invalid/${n}`, fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Business listing', permitted: true };
    const route = { id: `route-${n}`, accountId: account.id, personId: null, channel: 'phone' as const, value: phone, purpose: 'business' as const, evidenceIds: [source.id], verification: 'listed' as const };
    await accounts.recordFetchedSource({ accountId: account.id, source });
    await accounts.admitEvidence({ commandId: uuid(200 + n), accountId: account.id, expectedVersion: 1, sources: [source], claims: [], routes: [route] });
    return { account, route };
  };
  return { db, options, store, accounts, coordinator, firm, repository: new TerritoryPolicyRepository(options),
    apply: (payload: TerritoryPolicyCommand['payload'], id?: string) => coordinator.apply(command(payload, id), bearer),
    approveResearch: () => setup.apply(request, bearer),
    status: async () => researchSetupRemoteStatusSchema.parse(await setup.status({ workspaceId: 'ws', pairingId: pair.pairingId }, bearer)),
    tick: (signal = new AbortController().signal) => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(signal) };
}

describe('adding a state to the territory', () => {
  it('records Connecticut with the one zone the contract fixes for it, and reports it on the research status', async () => {
    const f = await workspace();
    await f.approveResearch();
    expect((await f.status()).territory).toEqual({ counts: null, addedRevision: 0, addedStates: [] });
    const receipt = await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'CT', rulesRevision: 2 }, uuid(20));
    expect(receipt).toMatchObject({ receipt: { status: 'applied', aggregateVersion: 1, reason: null },
      added: { revision: 1, rulesRevision: 2, states: [{ state: 'CT', timezone: 'America/New_York', addedAt: now, commandId: uuid(20) }] } });
    expect((await f.status()).territory).toMatchObject({ addedRevision: 1, addedStates: [{ state: 'CT', timezone: 'America/New_York' }] });
    // The frozen built-in map is untouched: an addition is a stored record, never a contract edit.
    expect(Object.keys((await import('../../../../src/shared/contracts/territoryClearanceContract')).TERRITORY_STATE_TIME_ZONES)).toEqual(['RI', 'MA', 'TX']);
  });

  it('refuses a state that observes two zones, with both zones named and nothing stored', async () => {
    const f = await workspace();
    const receipt = await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'FL', rulesRevision: 2 }, uuid(21));
    expect(receipt.receipt).toMatchObject({ status: 'rejected', reason: 'state_spans_two_zones' });
    expect(receipt.added ?? null).toBeNull();
    expect(await f.store.get(territoryAddedStatesKey('ws'))).toBeNull();
  });

  it('refuses a state already in the territory and a state whose zone the build does not record', async () => {
    const f = await workspace();
    expect((await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'RI', rulesRevision: 2 }, uuid(22))).receipt)
      .toMatchObject({ status: 'rejected', reason: 'already_in_territory' });
    expect((await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'CA', rulesRevision: 2 }, uuid(23))).receipt)
      .toMatchObject({ status: 'rejected', reason: 'state_zone_not_recorded' });
    expect(await f.store.get(territoryAddedStatesKey('ws'))).toBeNull();
  });

  it('is a compare-and-set on the addition record and refuses the same state twice', async () => {
    const f = await workspace();
    await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'CT', rulesRevision: 2 }, uuid(24));
    expect((await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'NH', rulesRevision: 2 }, uuid(25))).receipt)
      .toMatchObject({ status: 'rejected', reason: 'territory_added_revision_conflict' });
    expect((await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 1, state: 'CT', rulesRevision: 2 }, uuid(26))).receipt)
      .toMatchObject({ status: 'rejected', reason: 'already_in_territory' });
    const second = await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 1, state: 'NM', rulesRevision: 2 }, uuid(27));
    expect(second.added).toMatchObject({ revision: 2, states: [{ state: 'CT', timezone: 'America/New_York' }, { state: 'NM', timezone: 'America/Denver' }] });
  });

  it('answers a replayed add from the stored record instead of recording the state twice', async () => {
    const f = await workspace();
    await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'ME', rulesRevision: 2 }, uuid(28));
    const replay = await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'ME', rulesRevision: 2 }, uuid(28));
    expect(replay.receipt).toMatchObject({ status: 'applied', aggregateVersion: 1 });
    expect(replay.added?.states).toHaveLength(1);
  });

  it('reads the policy and the additions together and stores nothing on the read', async () => {
    const f = await workspace();
    await f.apply({ kind: 'policy.add-state', expectedAddedRevision: 0, state: 'VT', rulesRevision: 2 }, uuid(29));
    const read = await f.apply({ kind: 'policy.read' }, uuid(30));
    expect(read).toMatchObject({ receipt: { status: 'applied' }, policy: null, added: { revision: 1, states: [{ state: 'VT' }] } });
    expect(await f.store.get(`COMMAND#${uuid(30)}`)).toBeNull();
  });
});

describe('the remaining new firms a morning', () => {
  it('counts listed firms, worker authority and firms not yet called, and paces the estimate over a business week', async () => {
    const f = await workspace();
    await f.approveResearch();
    for (let n = 1; n <= 6; n++) await f.firm(n, `+1401555020${n}`);
    await f.firm(7, null);
    // Before any policy: every listed firm is uncalled and nothing holds authority.
    expect(await f.repository.computeTerritoryCounts()).toMatchObject({ listedFirms: 6, withAuthority: 0, notYetCalled: 6,
      newFirmsPerDay: null, remainingNewPerMorningEstimate: 1 });
    await f.apply(approve, uuid(10));
    // The approval sweep enrolls the first firms; each one stands on the first step of its own derived version.
    const counts = await f.repository.computeTerritoryCounts();
    expect(counts).toMatchObject({ listedFirms: 6, withAuthority: 6, notYetCalled: 6, newFirmsPerDay: DEFAULT.caps.newFirmsPerDay });
    expect(counts.remainingNewPerMorningEstimate).toBe(Math.floor(6 / TERRITORY_ESTIMATE_MORNINGS));
  });

  it('is unknown until a tick has counted it, then stored beside the tick record', async () => {
    const f = await workspace();
    await f.approveResearch();
    await f.firm(1, '+14015550201');
    expect(await f.repository.readTerritoryCounts()).toBeNull();
    expect((await f.status()).territory?.counts).toBeNull();
    await f.tick();
    expect(await f.store.get(territoryCountsKey)).not.toBeNull();
    expect((await f.status()).territory?.counts).toMatchObject({ computedAt: now, listedFirms: 1, notYetCalled: 1 });
  });

  it('counts the territory even while the policy is paused, and the paused policy still grants nothing', async () => {
    const f = await workspace();
    await f.approveResearch();
    await f.firm(1, '+14015550201');
    await f.apply(approve, uuid(10));
    await f.apply({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' }, uuid(11));
    const before = (await f.store.list('AUTH#')).map(entry => entry.key);
    const second = await f.firm(2, '+14015550202');
    const report = await f.tick();
    expect(report.territory?.outcome).toBe('policy_paused');
    expect((await f.store.list('AUTH#')).map(entry => entry.key)).toEqual(before);
    expect(await f.store.get(territoryEnrollmentKey(second.account.id))).toBeNull();
    // The count is a read: it is there whether or not the policy grants anything.
    expect(await f.repository.readTerritoryCounts()).toMatchObject({ listedFirms: 2, notYetCalled: 2 });
  });

  it('paces the estimate below the cap and never above it', () => {
    expect(territoryRemainingNewPerMorning(61, 30)).toBe(12);
    expect(territoryRemainingNewPerMorning(1000, 30)).toBe(30);
    expect(territoryRemainingNewPerMorning(0, 30)).toBe(0);
    expect(territoryRemainingNewPerMorning(4, 30)).toBe(0);
  });
});

const WORKSPACE = uuid(1);
const ACCOUNT = uuid(4);
const FIRST = uuid(6);
const SECOND = uuid(7);

/** One enrolled territory firm on the real campaign repository, with as many published business phones as the test needs. */
async function firm(phones: { id: string; verification: 'published' | 'listed' | 'unverified'; purpose?: 'business' | 'unknown' }[]) {
  const dynamo = new ConditionalCommandHarness(); let time = now;
  const options = { dynamo, tableName: 'fictional-territory-routes', workspaceId: WORKSPACE, clock: { now: () => time } };
  const store = new DynamoStore(options); const repo = new WorkerCampaignRepository(options); let command = 300;
  const policy = { policyId: territoryCallPolicyId(WORKSPACE), revision: 1, ...DEFAULT };
  const version = deriveTerritoryCampaignVersion(policy, ACCOUNT);
  const account = { id: ACCOUNT, name: 'Fictional Territory PM', domain: 'example.invalid', version: 1 };
  const routes = phones.map((phone, index) => ({ id: phone.id, accountId: ACCOUNT, personId: null, channel: 'phone', value: `+1401555030${index}`,
    purpose: phone.purpose ?? 'business', evidenceIds: [uuid(9)], verification: phone.verification, version: 1 }));
  await store.transact([store.put(`ACCOUNT#${ACCOUNT}`, { account, routes, claims: [], sources: [], researchRevision: 1, history: [{ at: now, account, routes, claims: [] }] }, null)]);
  const apply = async (payload: CampaignCommandPayload, id = uuid(command++)) => {
    const plan = await repo.planCommand({ commandId: id, accountId: ACCOUNT, payload });
    await store.transact(plan.items); return plan.payload;
  };
  await apply({ kind: 'campaign.version', version });
  await apply({ kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await apply({ kind: 'campaign.enroll', enrollmentId: uuid(8), campaignVersionId: version.id, selectedRouteId: FIRST, executionContextId: 'call-context', contextRevision: 1 });
  let action = 400;
  /** One real reserved call action followed by one applied human outcome, exactly as a completed handoff does. */
  const report = async (outcome: string, enrollmentRevision: number, stepId: string, routeId = FIRST, observedAt = now, contextRevision = 1, observation: 'unknown' | 'no_reply' = 'unknown', id?: string) => {
    const actionId = uuid(action++);
    const binding = { workspaceId: WORKSPACE, accountId: ACCOUNT, campaignId: version.campaignId, campaignRevision: 1, enrollmentId: uuid(8),
      enrollmentRevision, stepId, actionId, channel: 'call' as const, authorityGeneration: 1, selectedRouteId: routeId,
      contextRevision: 'call-context', contentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) };
    await store.transact((await new CampaignExecution(repo).prepareManualChecks(binding)).finalize());
    return apply({ kind: 'campaign.outcome', enrollmentId: uuid(8), expectedEnrollmentVersion: enrollmentRevision,
      evidence: { enrollmentId: uuid(8), accountId: ACCOUNT, campaignVersionId: version.id, stepId, routeId, routeVersion: 1,
        executionContextId: 'call-context', contextRevision, observedAt, observation, source: 'human', actionId, channel: 'call',
        state: 'human_reported_sent', outcome } }, id);
  };
  /** The policy's own enrollment record, which is where the entry counter lives. */
  const record = async (entries?: 1 | 2) => store.transact([store.put(territoryEnrollmentKey(ACCOUNT), { policyId: policy.policyId, revision: 1,
    accountId: ACCOUNT, routeId: FIRST, commandId: uuid(250), versionId: version.id, enrollmentId: uuid(8), sequence: 1, heldSteps: [],
    grantedAt: now, ...(entries ? { entries } : {}) }, null)]);
  return { store, repo, dynamo, version, policy, apply, report, record, advance: (value: string) => { time = value; },
    enrollment: () => dynamo.inspect(campaignEnrollmentKey(uuid(8))) as Record<string, unknown> };
}

describe('a wrong number retires the route it dialed', () => {
  it('retires the dialed route and starts the sequence again on the next published number', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }, { id: SECOND, verification: 'published' }]);
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    const retirement = territoryRetiredRouteSchema.parse(f.dynamo.inspect(territoryRetiredRouteKey(ACCOUNT, FIRST)));
    expect(retirement).toEqual({ accountId: ACCOUNT, routeId: FIRST, routeVersion: 1, retiredAt: now, reason: 'wrong_number', commandId: uuid(300 + 3) });
    // The route row itself is never edited or deleted: the retirement is a record of its own.
    expect((f.dynamo.inspect(`ACCOUNT#${ACCOUNT}`) as { routes: { id: string }[] }).routes.map(route => route.id)).toEqual([FIRST, SECOND]);
    expect(f.enrollment()).toMatchObject({ state: 'active', selectedRouteId: SECOND, currentStepId: f.version.steps[0]!.id,
      startedAt: now, nextDueAt: now, restingUntil: null, contextRevision: 2 });
  });

  it('rests the firm 180 days when it publishes no other business phone, and still retires the route', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }]);
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    expect(f.dynamo.inspect(territoryRetiredRouteKey(ACCOUNT, FIRST))).toMatchObject({ reason: 'wrong_number' });
    expect(f.enrollment()).toMatchObject({ state: 'paused', selectedRouteId: FIRST, nextDueAt: null, restingUntil: '2027-03-17T12:00:00.000Z' });
  });

  it('never selects an unverified number or a number that is not for the business', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }, { id: SECOND, verification: 'unverified' }, { id: uuid(11), verification: 'published', purpose: 'unknown' }]);
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'paused', selectedRouteId: FIRST, restingUntil: '2027-03-17T12:00:00.000Z' });
  });

  it('never returns to a retired route, and prefers the firm\'s own number over its directory listing', () => {
    const route = (id: string, verification: string) => ({ id, channel: 'phone', purpose: 'business', verification, version: 1 });
    const routes = [route(FIRST, 'listed'), route(SECOND, 'published'), route(uuid(12), 'listed')];
    expect(selectTerritoryReplacementRoute({ routes, retiredRouteIds: [FIRST] })?.id).toBe(SECOND);
    expect(selectTerritoryReplacementRoute({ routes, retiredRouteIds: [FIRST, SECOND] })?.id).toBe(uuid(12));
    expect(selectTerritoryReplacementRoute({ routes, retiredRouteIds: [FIRST, SECOND, uuid(12)] })).toBeNull();
    // The highest stored version of a route id wins, so a re-admitted route is selected once, not twice.
    expect(selectTerritoryReplacementRoute({ routes: [route(SECOND, 'published'), { ...route(SECOND, 'published'), version: 3 }], retiredRouteIds: [] }))
      .toMatchObject({ id: SECOND, version: 3 });
  });

  it('plans the first step again on the replacement route: the retired route\'s outcome no longer holds it', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }, { id: SECOND, verification: 'published' }]);
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    // The replacement route and the first step are recorded, and the firm is due. The shared sequence planner
    // counts only evidence on the enrollment's selected route, so the retired route's wrong-number outcome does
    // not hold the restarted step (it still counts against the version's call cap).
    const enrollment = enrollmentSchema.parse(f.enrollment());
    const decision = planNext({ ...f.version, approvedAt: now }, enrollment, await f.repo.evidence(uuid(8)), now);
    expect(decision).toEqual({ kind: 'prepare', stepId: f.version.steps[0]!.id, reason: 'step_eligible' });
  });

  it('is idempotent by command id: the same outcome never retires twice or selects a third route', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }, { id: SECOND, verification: 'published' }]);
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    const after = f.enrollment();
    const evidence = (await f.repo.evidence(uuid(8)))[0]!;
    await expect(f.apply({ kind: 'campaign.outcome', enrollmentId: uuid(8), expectedEnrollmentVersion: 1, evidence })).rejects.toThrow(/stale_enrollment/);
    expect(f.enrollment()).toEqual(after);
  });
});

describe('the single re-entry after the ninety day rest', () => {
  const version = deriveTerritoryCampaignVersion({ policyId: territoryCallPolicyId(WORKSPACE), revision: 1, ...DEFAULT }, ACCOUNT);
  const day = (from: string, days: number) => new Date(Date.parse(from) + days * 86400000).toISOString();

  it('rests 90 days on the first completed run and 180 with no further re-entry on the second', () => {
    const enrollment = { currentStepId: version.steps[3]!.id, startedAt: now };
    const observedAt = '2026-09-30T12:00:00.000Z';
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'no_answer', observedAt, entries: 1 }))
      .toMatchObject({ state: 'paused', currentStepId: null, nextDueAt: null, restingUntil: day(observedAt, 90), reason: 'rest_sequence_complete' });
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'no_answer', observedAt, entries: 2 }))
      .toMatchObject({ state: 'paused', currentStepId: null, nextDueAt: null, restingUntil: day(observedAt, TERRITORY_FINAL_REST_DAYS), reason: 'rest_final' });
    // A record written before the counter existed is the first run, never the last.
    expect(advanceTerritorySequence({ version, enrollment, outcome: 'no_answer', observedAt }).reason).toBe('rest_sequence_complete');
    expect(TERRITORY_FINAL_REST_DAYS).toBe(180);
    expect(TERRITORY_MAX_ENTRIES).toBe(2);
  });

  it('reads the firm\'s entry counter from the policy\'s own enrollment record on an applied outcome', async () => {
    const f = await firm([{ id: FIRST, verification: 'listed' }]);
    await f.record(2);
    // A wrong number with no replacement rests the firm; the counter is read on the same applied outcome.
    await f.report('wrong_number', 1, f.version.steps[0]!.id);
    expect(f.enrollment()).toMatchObject({ state: 'paused', restingUntil: day(now, 180) });
  });

  it('decides the re-entry from the counter alone and never re-enters a second time', () => {
    const firstStepId = version.steps[0]!.id;
    const resting = { state: 'paused', restingUntil: '2026-09-17T12:00:00.000Z' };
    expect(decideTerritoryReentry({ firstStepId, enrollment: resting, entries: 1, now })).toEqual({ kind: 'reenter', entries: 2, currentStepId: firstStepId, startedAt: now });
    expect(decideTerritoryReentry({ firstStepId, enrollment: resting, entries: 2, now })).toEqual({ kind: 'final_rest', until: resting.restingUntil });
    expect(decideTerritoryReentry({ firstStepId, enrollment: { state: 'paused', restingUntil: '2026-12-01T12:00:00.000Z' }, entries: 1, now }))
      .toEqual({ kind: 'resting', until: '2026-12-01T12:00:00.000Z' });
    expect(decideTerritoryReentry({ firstStepId, enrollment: { state: 'active', restingUntil: null }, entries: 1, now })).toEqual({ kind: 'not_resting' });
  });

  it('restarts a rested firm once on the next sweep and leaves a firm on its second run resting', async () => {
    const f = await workspace();
    await f.approveResearch();
    const one = await f.firm(1, '+14015550201');
    await f.apply(approve, uuid(10));
    const enrollmentRow = await f.store.get<{ enrollmentId: string; versionId: string }>(territoryEnrollmentKey(one.account.id));
    const enrollmentKey = campaignEnrollmentKey(enrollmentRow!.data.enrollmentId);
    const live = await f.store.get<Record<string, unknown>>(enrollmentKey);
    // Put the firm exactly where a completed first run leaves it: paused, resting, and the rest already over.
    await f.store.transact([f.store.put(enrollmentKey, { ...live!.data, state: 'paused', currentStepId: null, nextDueAt: null,
      restingUntil: '2026-09-17T12:00:00.000Z', version: 2 }, live!.rev)]);
    const report = await f.repository.sweepTerritoryBackfill({ limit: 50, count: false });
    expect(report.reentered).toBe(1);
    const restarted = await f.store.get<Record<string, unknown>>(enrollmentKey);
    expect(restarted!.data).toMatchObject({ state: 'active', startedAt: now, nextDueAt: now, restingUntil: null });
    expect(await f.store.get<{ entries: number }>(territoryEnrollmentKey(one.account.id))).toMatchObject({ data: { entries: 2, reenteredAt: now } });
    // A second sweep finds the firm on run two and leaves it alone.
    const again = await f.repository.sweepTerritoryBackfill({ limit: 50, count: false });
    expect(again.reentered).toBeUndefined();
  });
});
