import { randomUUID } from 'node:crypto';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { ResearchSetupService, placesResearchBudgetId, reviewedResearchProfile, type ResearchSetupProfile } from '../src/researchSetup';
import { budgetKey } from '../src/discoveryReservationStore';
import { createWorkerAccountRepository, accountRecordSchema } from '../src/workerAccountRepository';
import { runResearch } from '../src/researchCoordinator';
import { productionResearchBoundaries, researchProfile } from '../src/researchProduction';
import { fingerprint } from '../src/dynamoStore';
import { derivedCommand } from '../../../../src/main/research/companyResearchWorker';
import { researchSetupRemoteStatusSchema, type ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';
import { ConditionalCommandHarness } from './sdkHarness';

const now = '2026-09-17T12:00:00.000Z';
const cursorKey = 'DISCOVERY_CURSOR#places-territory-v1';
const placesUrl = 'https://places.googleapis.com/v1/places:searchText';
const citedDescriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const };
const descriptor = { ...citedDescriptor, placesSearchCostMicros: 35000 };
/** Three fictional firms: Alpha (http www website, listed phone), Beta (https website, listed phone), Gamma (no website). */
const firstPage = [
  { id: 'place-alpha', displayName: { text: 'Alpha Residential Management' }, formattedAddress: '1 Fictional St, Providence, RI', nationalPhoneNumber: '(401) 555-0101', websiteUri: 'http://www.alpha-pm.example/' },
  { id: 'place-beta', displayName: { text: 'Beta Property Group' }, formattedAddress: '2 Fictional Ave, Providence, RI', nationalPhoneNumber: '(617) 555-0102', websiteUri: 'https://beta-group.example/contact' },
  { id: 'place-gamma', displayName: { text: 'Gamma Rentals' }, formattedAddress: '3 Fictional Rd, Providence, RI', nationalPhoneNumber: '(617) 555-0103' },
];
const secondPage = [
  { id: 'place-delta', displayName: { text: 'Delta Homes' }, nationalPhoneNumber: '(401) 555-0104', websiteUri: 'https://delta-homes.example/' },
  { id: 'place-alpha-again', displayName: { text: 'Alpha (duplicate listing)' }, nationalPhoneNumber: '(401) 555-0199', websiteUri: 'https://alpha-pm.example/office' },
  { id: 'place-beta-phone', displayName: { text: 'Beta second brand' }, nationalPhoneNumber: '617-555-0102', websiteUri: 'https://beta-brand.example/' },
];
const bostonPage = [{ id: 'place-epsilon', displayName: { text: 'Epsilon Property Care' }, nationalPhoneNumber: '(857) 555-0105', websiteUri: 'https://epsilon-care.example/' }];
type Page = { places: Record<string, unknown>[]; nextPageToken?: string };
type Reply = Page | Error;
async function fixture(input: { descriptor?: unknown; places?: boolean; replies?: Reply[]; discoveryCeilingMicros?: number } = {}) {
  const db = new ConditionalCommandHarness(); const options = { dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(input.descriptor ?? descriptor), credentialParameterDeclared: true, placesCredentialParameterDeclared: input.places ?? true };
  const setup = new ResearchSetupService({ auth, profile });
  const request: Extract<ResearchSetupRequest, { kind: 'approve' }> = { version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId, input: {
    expectedRevision: 0, descriptorFingerprint: fingerprint(input.descriptor ?? descriptor), audience: { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] },
    permittedSources: [], maxCompanies: 20, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: input.discoveryCeilingMicros ?? 105000, researchCeilingMicros: 1000, disclosureAcknowledged: true, discoveryProvider: 'places' } };
  const replies = input.replies ?? [{ places: firstPage, nextPageToken: 'token-2' }, { places: secondPage }, { places: bostonPage }];
  const requests: { url: string; body: unknown; headers: Record<string, string> }[] = []; let pageCalls = 0; let citedCredentialCalls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const reply = replies.shift(); if (!reply) throw new Error('unconfigured fictional Places response');
    if (reply instanceof Error) throw reply;
    return Response.json(reply);
  };
  const research = { loadCredentials: async () => { citedCredentialCalls++; return { apiKey: 'fictional', model: 'fictional-reviewed-model' }; }, loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }),
    resolve: async () => ['93.184.216.34'], pageHttp: async () => { pageCalls++; return new Response('<p>We manage 120 residential units.</p>', { headers: { 'content-type': 'text/html' } }); } };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
  const bearer = `Bearer ${pair.credential}`;
  return { db, auth, store: auth.store, pair, profile, setup, request, bearer, requests, research, fetch, authorization, accounts: createWorkerAccountRepository(options),
    approve: () => setup.apply(request, bearer), status: () => setup.status({ workspaceId: 'ws', pairingId: pair.pairingId }, bearer),
    source: () => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }),
    tick: async () => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(new AbortController().signal),
    counts: () => ({ placesCalls: requests.length, pageCalls, citedCredentialCalls }) };
}
async function records(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.store.list<unknown>('ACCOUNT#')).map(row => accountRecordSchema.parse(row.stored.data)).sort((a, b) => a.account.domain!.localeCompare(b.account.domain!));
}

describe('scheduled Places territory batches', () => {
  it('reserves the reviewed cost before the call, creates one account per listed firm with a listed phone route and per-account sources, then drains research', async () => {
    const f = await fixture(); await f.approve();
    const report = await f.tick();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.url).toBe(placesUrl);
    expect(f.requests[0]!.body).toEqual({ textQuery: 'property management company in Providence, RI', pageSize: 20 });
    expect(f.requests[0]!.headers).toMatchObject({ 'X-Goog-Api-Key': 'fictional-places-key' });
    expect(f.counts().citedCredentialCalls).toBe(0);
    const stored = await records(f);
    expect(stored.map(record => record.account.domain)).toEqual(['alpha-pm.example', 'beta-group.example']);
    const cursor = f.db.inspect(cursorKey) as { runId: string };
    expect(cursor).toMatchObject({ version: 1, queryIndex: 0, page: 1, nextPageToken: 'token-2', exhausted: false, ordinal: 1 });
    for (const [record, phone] of [[stored[0]!, '+14015550101'], [stored[1]!, '+16175550102']] as const) {
      expect(record.account.id).toBe(`account-${fingerprint(['ws', derivedCommand(cursor.runId, record.account.domain!, 'create')])}`);
      const listed = record.routes.filter(route => route.verification === 'listed');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ channel: 'phone', purpose: 'business', personId: null, value: phone, accountId: record.account.id });
      const source = record.sources.find(item => listed[0]!.evidenceIds.includes(item.id))!;
      expect(source).toMatchObject({ url: placesUrl, permitted: true, fetchedAt: now });
      expect(source.excerpt).toContain(phone.replace('+1', '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'));
      expect(f.db.inspect(`FETCHED#${source.id}`)).toMatchObject({ accountId: record.account.id });
    }
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 35000 });
    const jobs = (await f.store.list<{ accountId: string; state: string; permittedSources?: string[] }>('JOB#')).map(row => row.stored.data).sort((a, b) => a.accountId.localeCompare(b.accountId));
    expect(jobs).toHaveLength(2);
    expect(jobs.map(job => job.state)).toEqual(['completed', 'completed']);
    const alpha = jobs.find(job => job.accountId === stored[0]!.account.id)!;
    expect(alpha.permittedSources).toEqual(['https://alpha-pm.example/', 'https://www.alpha-pm.example/']);
    expect(f.counts().pageCalls).toBe(2);
    expect(stored.every(record => record.claims.some(claim => claim.key === 'portfolio'))).toBe(true);
    expect(report).toMatchObject({ status: 'completed', researchPrepared: 2, researchCompleted: 2, places: { outcome: 'completed', created: 2, routes: 2, enqueued: 2, drained: 2, skipped: { no_website: 1 } } });
    expect(await f.store.list('AUTH#')).toEqual([]);
    const reservation = f.db.inspect(`DISCOVERY#${cursor.runId}`);
    expect(reservation).toMatchObject({ completed: true, searchCostMicros: 35000, modelCostMicros: 0, reserved: 35000, costMicros: null });
  });
  it('never replays a page: later ticks use the next page token, then the next query, skip known firms and stop reserving once the grid is exhausted', async () => {
    const f = await fixture(); await f.approve();
    await f.tick();
    const second = await f.tick();
    expect(f.requests[1]!.body).toEqual({ textQuery: 'property management company in Providence, RI', pageSize: 20, pageToken: 'token-2' });
    expect((await records(f)).map(record => record.account.domain)).toEqual(['alpha-pm.example', 'beta-group.example', 'delta-homes.example']);
    expect(second.places).toMatchObject({ outcome: 'completed', created: 1, skipped: { existing_domain: 1, existing_phone: 1 } });
    expect(f.db.inspect(cursorKey)).toMatchObject({ queryIndex: 1, page: 0, nextPageToken: null, exhausted: false, ordinal: 2 });
    const third = await f.tick();
    expect(f.requests[2]!.body).toEqual({ textQuery: 'property management company in Boston, MA', pageSize: 20 });
    expect(third.places).toMatchObject({ outcome: 'completed', created: 1 });
    expect(f.db.inspect(cursorKey)).toMatchObject({ queryIndex: 2, page: 0, nextPageToken: null, exhausted: true, ordinal: 3 });
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 105000 });
    const runIds = new Set((await f.store.list('DISCOVERY#')).map(row => row.key));
    expect(runIds.size).toBe(3);
    const exhausted = await f.tick();
    expect(f.requests).toHaveLength(3);
    expect(exhausted.places).toMatchObject({ outcome: 'exhausted' });
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 105000 });
    expect(await f.store.list('DISCOVERY#')).toHaveLength(3);
    expect((await records(f)).map(record => record.account.domain)).toEqual(['alpha-pm.example', 'beta-group.example', 'delta-homes.example', 'epsilon-care.example']);
  });
  it('retains an uncertain page as reserved spend, never re-issues it, and continues with the next query on the following tick', async () => {
    const f = await fixture({ replies: [new Error('fictional lost response'), { places: bostonPage }] }); await f.approve();
    const first = await f.tick();
    expect(first.places).toMatchObject({ outcome: 'uncertain', runId: expect.any(String), created: 0 }); expect(first.held).toBeGreaterThan(0);
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 35000 });
    expect(await f.store.list('ACCOUNT#')).toEqual([]);
    const settled = await f.tick();
    expect(f.requests).toHaveLength(1);
    expect(settled.places).toMatchObject({ outcome: 'uncertain', created: 0 });
    expect(f.db.inspect(cursorKey)).toMatchObject({ queryIndex: 1, page: 0, nextPageToken: null, exhausted: false, ordinal: 1 });
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 35000 });
    const third = await f.tick();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.body).toEqual({ textQuery: 'property management company in Boston, MA', pageSize: 20 });
    expect(third.places).toMatchObject({ outcome: 'completed', created: 1 });
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 70000 });
  });
  it('holds a Places configuration when the discovery ceiling cannot cover one more call and when invoked as research.once', async () => {
    const f = await fixture({ discoveryCeilingMicros: 35000 }); await f.approve();
    await f.tick(); expect(f.requests).toHaveLength(1);
    const denied = await f.tick();
    expect(f.requests).toHaveLength(1); expect(denied.places).toMatchObject({ outcome: 'denied' });
    expect(f.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ spent: 35000 });
    const g = await fixture(); await g.approve();
    const config = (await g.store.get<{ revision: number; research: unknown }>('OWNER_RESEARCH_SOURCE'))!.data;
    const report = { status: 'inactive' as const, researchPrepared: 0, researchCompleted: 0, held: 0, mailPolls: 0, dispatches: 0, sendReconciliations: 0, meetings: 0 };
    await runResearch({ auth: g.auth, fetch: g.fetch, research: g.research, researchSetupProfile: g.profile }, new AbortController().signal, report,
      { version: 1, kind: 'research.once', workspaceId: 'ws', pairingId: g.pair.pairingId, expectedSourceRevision: config.revision, researchFingerprint: fingerprint(config.research) });
    expect(g.requests).toHaveLength(0); expect(await g.store.list('DISCOVERY#')).toEqual([]); expect(report.status).toBe('inactive');
  });
});

describe('Places readiness in the reviewed profile and setup handler', () => {
  it('reports places_credential_parameter_missing and places_cost_missing only for the Places provider', () => {
    const cited = reviewedResearchProfile({ reviewedCapability: citedDescriptor, credentialParameterDeclared: true }, now);
    expect(cited.blockers).toEqual([]);
    const places = reviewedResearchProfile({ reviewedCapability: citedDescriptor, credentialParameterDeclared: true }, now, 'places');
    expect(places.blockers).toEqual(['places_cost_missing', 'places_credential_parameter_missing']);
    expect(reviewedResearchProfile({ reviewedCapability: descriptor, credentialParameterDeclared: false, placesCredentialParameterDeclared: true }, now, 'places').blockers).toEqual([]);
    expect(reviewedResearchProfile({ reviewedCapability: descriptor, credentialParameterDeclared: true, placesCredentialParameterDeclared: true }, now).blockers).toEqual([]);
  });
  it('exposes Places readiness in status and refuses a Places approval while it is blocked, without touching cited approvals', async () => {
    const blocked = await fixture({ descriptor: citedDescriptor, places: false });
    const status = researchSetupRemoteStatusSchema.parse(await blocked.status());
    expect(status.blockers).toEqual([]); expect(status.placesCredentialParameterDeclared).toBe(false);
    expect(status.placesBlockers).toEqual(['places_cost_missing', 'places_credential_parameter_missing']);
    await expect(blocked.approve()).rejects.toThrow('research_setup_descriptor_unavailable');
    expect(blocked.db.inspect('OWNER_RESEARCH_SOURCE')).toBeUndefined();
    const cited = { ...blocked.request, requestId: randomUUID(), input: { ...blocked.request.input, permittedSources: ['https://fictional.example/'], maxCompanies: 1, discoveryCeilingMicros: 80 } };
    delete (cited.input as { discoveryProvider?: string }).discoveryProvider;
    expect(await blocked.setup.apply(cited, blocked.bearer)).toMatchObject({ status: 'applied', revision: 1, state: 'active' });
    expect(blocked.db.inspect('OWNER_RESEARCH_SOURCE')).not.toHaveProperty(['research', 'discoveryProvider']);
    const ready = await fixture();
    const readyStatus = researchSetupRemoteStatusSchema.parse(await ready.status());
    expect(readyStatus.placesBlockers).toEqual([]); expect(readyStatus.placesCredentialParameterDeclared).toBe(true);
    expect(await ready.approve()).toMatchObject({ status: 'applied', revision: 1, state: 'active' });
    expect(ready.db.inspect('OWNER_RESEARCH_SOURCE')).toMatchObject({ research: { discoveryProvider: 'places', budgetId: placesResearchBudgetId, permittedSources: [], discoveryLimits: { maxCompanies: 20, maxCostMicros: 35000 } } });
    expect(ready.db.inspect(budgetKey(placesResearchBudgetId))).toMatchObject({ limit: 105000, spent: 0 });
  });
  it('declares the Places credential parameter only under the workspace prefix and reads it as a SecureString JSON key', async () => {
    const env = { DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_RESEARCH_CREDENTIAL_PARAMETER: '/delegated-worker/ws/research-model-credentials', DELEGATED_PLACES_CREDENTIAL_PARAMETER: '/delegated-worker/ws/places-api-credentials', AWS_REGION: 'us-east-1' };
    expect(researchProfile(env)).toMatchObject({ credentialParameterDeclared: true, placesCredentialParameterDeclared: true });
    expect(researchProfile({ ...env, DELEGATED_PLACES_CREDENTIAL_PARAMETER: '' }).placesCredentialParameterDeclared).toBe(false);
    expect(researchProfile({ ...env, DELEGATED_PLACES_CREDENTIAL_PARAMETER: '/delegated-worker/other/places-api-credentials' }).placesCredentialParameterDeclared).toBe(false);
    const names: string[] = [];
    const ssm = { send: async (command: GetParameterCommand) => { names.push(command.input.Name!); expect(command.input.WithDecryption).toBe(true); return { $metadata: {}, Parameter: { Type: 'SecureString' as const, Value: JSON.stringify({ apiKey: 'fictional-places-key' }) } }; } };
    const boundaries = productionResearchBoundaries(env, { ssm });
    expect(await boundaries.loadPlacesCredentials!('ws', new AbortController().signal)).toEqual({ apiKey: 'fictional-places-key' });
    expect(names).toEqual(['/delegated-worker/ws/places-api-credentials']);
    await expect(boundaries.loadPlacesCredentials!('other', new AbortController().signal)).rejects.toThrow('research_workspace_mismatch');
    const plain = productionResearchBoundaries(env, { ssm: { send: async () => ({ $metadata: {}, Parameter: { Type: 'String' as const, Value: '{"apiKey":"x"}' } }) } });
    await expect(plain.loadPlacesCredentials!('ws', new AbortController().signal)).rejects.toThrow('research_unconfigured');
    expect(productionResearchBoundaries({ ...env, DELEGATED_PLACES_CREDENTIAL_PARAMETER: '' }, { ssm }).loadPlacesCredentials).toBeUndefined();
  });
});
