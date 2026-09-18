import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { ResearchSetupService, researchSelectorPauseKey, type ResearchSetupProfile } from '../src/researchSetup';
import { accountRecordSchema } from '../src/workerAccountRepository';
import { fingerprint } from '../src/dynamoStore';
import { rankAccount } from '../../../../src/shared/accounts/accountRanking';
import { researchSetupRemoteStatusSchema, type ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';
import { ConditionalCommandHarness } from './sdkHarness';

const start = '2026-09-17T12:00:00.000Z';
const placesUrl = 'https://places.googleapis.com/v1/places:searchText';
const modelUrl = 'https://api.openai.com/v1/responses';
/** USD 0.01 per firm; worst case 21024 input tokens at USD 0.40/M plus 512 output tokens at USD 1.60/M is 9230 micros, inside the reservation. */
const extraction = { version: 1 as const, model: 'fictional-reviewed-model', maxCostMicros: 10000, maxOutputTokens: 512, maxInputBytes: 20000, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 };
const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z',
  provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 10000, currency: 'USD' as const, placesSearchCostMicros: 35000, placesExtraction: extraction };
const page = [
  { id: 'place-alpha', displayName: { text: 'Alpha Residential Management' }, formattedAddress: '1 Fictional St, Providence, RI', nationalPhoneNumber: '(401) 555-0101', websiteUri: 'https://alpha-pm.example/' },
  { id: 'place-beta', displayName: { text: 'Beta Property Group' }, formattedAddress: '2 Fictional Ave, Providence, RI', nationalPhoneNumber: '(617) 555-0102', websiteUri: 'https://beta-group.example/' },
];
const html = '<p>We manage 120 residential units.</p><p>Owner and broker: Fictional Person.</p>';
type ModelReply = { facts: { key: string; ref: number }[] } | Error | 'omit-usage';
function modelEnvelope(reply: Exclude<ModelReply, Error>) {
  return { status: 'completed', model: 'fictional-reviewed-model', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
    text: JSON.stringify(reply === 'omit-usage' ? { facts: [{ key: 'target_fit', ref: 0 }] } : reply) }] }], ...(reply === 'omit-usage' ? {} : { usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 } }) };
}
async function fixture(input: { descriptor?: unknown; modelReplies?: ModelReply[]; discoveryCeilingMicros?: number } = {}) {
  let clock = start;
  const db = new ConditionalCommandHarness(); const options = { dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => clock } };
  const auth = new WorkerAuth(options);
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional');
  const reviewed = structuredClone(input.descriptor ?? descriptor);
  const profile: ResearchSetupProfile = { reviewedCapability: reviewed, credentialParameterDeclared: true, placesCredentialParameterDeclared: true };
  const setup = new ResearchSetupService({ auth, profile });
  const request: Extract<ResearchSetupRequest, { kind: 'approve' }> = { version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId, input: {
    expectedRevision: 0, descriptorFingerprint: fingerprint(reviewed), audience: { residential: true, regions: ['Providence, RI'], terms: ['property management company'] },
    permittedSources: [], maxCompanies: 20, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: input.discoveryCeilingMicros ?? 70000, researchCeilingMicros: 100000, disclosureAcknowledged: true, discoveryProvider: 'places' } };
  const modelReplies = input.modelReplies ?? [{ facts: [{ key: 'target_fit', ref: 0 }, { key: 'portfolio_description', ref: 0 }, { key: 'role', ref: 1 }] }, { facts: [{ key: 'not_target', ref: 1 }] }];
  const modelRequests: { headers: Record<string, string>; body: { model: string; input: string; text: { format: { name: string } } } }[] = [];
  let placesCalls = 0; let credentialCalls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) === placesUrl) { placesCalls++; return Response.json({ places: page }); }
    if (String(url) === modelUrl) {
      modelRequests.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      const reply = modelReplies.shift(); if (!reply) throw new Error('unconfigured fictional model reply');
      if (reply instanceof Error) throw reply;
      return Response.json(modelEnvelope(reply));
    }
    throw new Error('unexpected fictional HTTP');
  };
  const research = { loadCredentials: async () => { credentialCalls++; return { apiKey: 'fictional-model-key', model: 'fictional-reviewed-model' }; }, loadPlacesCredentials: async () => ({ apiKey: 'fictional-places-key' }),
    resolve: async () => ['93.184.216.34'], pageHttp: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
  const bearer = `Bearer ${pair.credential}`;
  return { db, store: auth.store, pair, profile, modelRequests, counts: () => ({ placesCalls, credentialCalls }), advance: (to: string) => { clock = to; },
    approve: () => setup.apply(request, bearer), status: async () => researchSetupRemoteStatusSchema.parse(await setup.status({ workspaceId: 'ws', pairingId: pair.pairingId }, bearer)),
    tick: () => createSourceCoordinator({ auth, authorization, fetch, research, researchSetupProfile: profile }).tick(new AbortController().signal),
    records: async () => (await auth.store.list<unknown>('ACCOUNT#')).map(row => accountRecordSchema.parse(row.stored.data)).sort((a, b) => a.account.domain!.localeCompare(b.account.domain!)) };
}

describe('model extraction on the scheduled Places path', () => {
  it('calls the reviewed model once per firm with the bounded fact set, admits the quoted facts and the target_fit verdict, and settles the priced usage with the rest refunded', async () => {
    const f = await fixture(); await f.approve();
    const report = await f.tick();
    expect(f.counts()).toEqual({ placesCalls: 1, credentialCalls: 2 });
    expect(f.modelRequests).toHaveLength(2);
    for (const request of f.modelRequests) {
      expect(request.headers).toMatchObject({ Authorization: 'Bearer fictional-model-key' });
      expect(request.body.model).toBe('fictional-reviewed-model'); expect(request.body.text.format.name).toBe('company_facts');
      expect(JSON.parse(request.body.input)).toEqual({ sources: [{ sourceId: expect.any(String), blocks: [{ id: 'b1', text: 'We manage 120 residential units.', ref: 0 }, { id: 'b2', text: 'Owner and broker: Fictional Person.', ref: 1 }] }] });
    }
    // Jobs are claimed in job-id order, so which firm received which fictional reply is not fixed; each reply lands on exactly one firm.
    const records = await f.records();
    const alpha = records.find(record => record.claims.some(claim => claim.key === 'target_fit' && claim.value === 'yes'))!;
    const beta = records.find(record => record.claims.some(claim => claim.key === 'target_fit' && claim.value === 'no'))!;
    expect(alpha).toBeDefined(); expect(beta).toBeDefined(); expect(alpha.account.id).not.toBe(beta.account.id);
    const pageSource = alpha.sources.find(source => source.url.startsWith(`https://${alpha.account.domain}`))!.id;
    expect(alpha.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'portfolio', kind: 'fact' }),
      { key: 'target_fit', kind: 'fact', value: 'yes', evidenceIds: [pageSource] },
      { key: 'portfolio_description', kind: 'fact', value: 'We manage 120 residential units.', evidenceIds: [pageSource] },
      { key: 'role', kind: 'fact', value: 'Owner and broker: Fictional Person.', evidenceIds: [pageSource] }]));
    expect(beta.claims.filter(claim => claim.key === 'target_fit')).toEqual([{ key: 'target_fit', kind: 'fact', value: 'no', evidenceIds: [expect.any(String)] }]);
    // 1000 input tokens at 400000 micros/M is 400; 20 output tokens at 1600000 micros/M is 32.
    const jobs = (await f.store.list<{ state: string; costMicros: number | null; reservedCost: number }>('JOB#')).map(row => row.stored.data);
    expect(jobs.map(job => [job.state, job.costMicros, job.reservedCost])).toEqual([['completed', 432, 10000], ['completed', 432, 10000]]);
    expect(f.db.inspect('BUDGET#research')).toMatchObject({ limit: 100000, spent: 864 });
    expect(report.extraction).toEqual({ calls: 2, settledCostMicros: 864, refundedMicros: 19136 });
    expect(report.ledger).toEqual({ discoveryRemainingMicros: 35000, researchRemainingMicros: 99136 });
    expect(report).toMatchObject({ status: 'completed', researchCompleted: 2, held: 0, descriptorExpired: false, selfPaused: false });
    const asOf = '2026-09-17T12:30:00.000Z';
    expect(rankAccount({ ...alpha, portfolio: [], unknowns: [], conflicts: [], fingerprint: 'f' }, asOf).fit).not.toBe('not_target');
    // Beta's own page advertises a residential portfolio (regex fact) while the model verdict says not a target: conflicting evidence stays uncertain, never not_target.
    const beta_rank = rankAccount({ ...beta, portfolio: [], unknowns: [], conflicts: [], fingerprint: 'f' }, asOf);
    expect(beta_rank.fit).toBe('uncertain');
    expect(beta_rank.reasons.map(reason => reason.text)).toContain('Published text indicates the company is not a property manager.');
  });
  it('settles at the full reservation when the provider omits usage and when the model call fails, keeping the regex facts and routes', async () => {
    const f = await fixture({ modelReplies: ['omit-usage', new Error('fictional model outage')] }); await f.approve();
    const report = await f.tick();
    expect(f.modelRequests).toHaveLength(2);
    const jobs = (await f.store.list<{ state: string; costMicros: number | null }>('JOB#')).map(row => row.stored.data);
    expect(jobs.map(job => [job.state, job.costMicros])).toEqual([['completed', 10000], ['completed', 10000]]);
    expect(f.db.inspect('BUDGET#research')).toMatchObject({ spent: 20000 });
    expect(report.extraction).toEqual({ calls: 2, settledCostMicros: 20000, refundedMicros: 0 });
    const records = await f.records();
    expect(records.every(record => record.claims.some(claim => claim.key === 'portfolio'))).toBe(true);
    expect(records.filter(record => record.claims.some(claim => claim.key === 'target_fit'))).toHaveLength(1);
    expect(report.held).toBe(0);
  });
  it('never calls the model without a reviewed extraction in the descriptor', async () => {
    const plain = structuredClone(descriptor) as Record<string, unknown>; delete plain.placesExtraction;
    const f = await fixture({ descriptor: plain }); await f.approve();
    const report = await f.tick();
    expect(f.modelRequests).toHaveLength(0); expect(f.counts().credentialCalls).toBe(0);
    expect(report.extraction).toEqual({ calls: 0, settledCostMicros: 0, refundedMicros: 0 });
    const jobs = (await f.store.list<{ state: string; costMicros: number | null }>('JOB#')).map(row => row.stored.data);
    expect(jobs.map(job => job.costMicros)).toEqual([null, null]);
  });
});

describe('a worker David can see', () => {
  it('pauses the selector itself once when the review lapses, names the cause on every later tick and in status, and never calls Places meanwhile', async () => {
    const f = await fixture(); await f.approve();
    await f.tick(); expect(f.counts().placesCalls).toBe(1);
    f.advance('2026-09-18T00:00:00.000Z');
    const expired = await f.tick();
    expect(expired).toMatchObject({ status: 'completed', descriptorExpired: true, selfPaused: true, held: 0 });
    expect(f.db.inspect('OWNER_RESEARCH_SOURCE')).toMatchObject({ revision: 2, state: 'paused' });
    expect(f.db.inspect(researchSelectorPauseKey)).toEqual({ version: 1, reason: 'descriptor_expired', pausedAt: '2026-09-18T00:00:00.000Z', revision: 2 });
    const writes = f.db.transactions.length;
    const again = await f.tick();
    expect(again).toMatchObject({ descriptorExpired: true, selfPaused: false, held: 0 });
    expect(f.db.inspect('OWNER_RESEARCH_SOURCE')).toMatchObject({ revision: 2, state: 'paused' });
    // Only the phase cursor and the last-tick record were written; the selector was not touched a second time.
    expect(f.db.transactions.slice(writes).flatMap(tx => tx.TransactItems ?? []).some(item => item.Put?.Item?.sk?.S === 'OWNER_RESEARCH_SOURCE')).toBe(false);
    expect(f.counts().placesCalls).toBe(1);
    const status = await f.status();
    expect(status).toMatchObject({ pausedReason: 'descriptor_expired', lastTickAt: '2026-09-18T00:00:00.000Z', lastTick: { descriptorExpired: true, selfPaused: false } });
    expect(status.blockers).toContain('operator_descriptor_expired');
    expect(f.db.inspect('SOURCE_LAST_TICK')).toMatchObject({ event: 'SCHEDULED_RUN_COMPLETED', descriptorExpired: true });
  });
  it('reports the last tick on status and the ledger blockers: budget_exhausted when the next firm or page cannot be reserved, territory_exhausted once the sweep is done', async () => {
    const fresh = await fixture(); await fresh.approve();
    expect(await fresh.status()).toMatchObject({ lastTickAt: null, lastTick: null, pausedReason: null });
    expect((await fresh.status()).blockers).toEqual([]);
    await fresh.tick();
    const after = await fresh.status();
    expect(after.lastTickAt).toBe(start);
    expect(after.lastTick).toMatchObject({ status: 'completed', firmsCreated: 2, jobsDrained: 2, places: { outcome: 'completed' }, extraction: { calls: 2 } });
    // One query in the grid: the first page finished the territory.
    expect(after.blockers).toEqual(['territory_exhausted']);
    // Without reviewed extraction a completed job keeps its whole reservation: two firms at 60000 against a 100000 ceiling leave the second queued and no room for another.
    const plain = structuredClone(descriptor) as Record<string, unknown>; delete plain.placesExtraction; plain.researchReservationMicros = 60000;
    const retained = await fixture({ descriptor: plain }); await retained.approve();
    expect((await retained.status()).blockers).toEqual([]);
    const report = await retained.tick();
    expect(report.places).toMatchObject({ created: 2, drained: 1 });
    const status = await retained.status();
    expect(status.researchLedger).toEqual({ limitMicros: 100000, reservedOrSpentMicros: 60000, remainingMicros: 40000 });
    expect(status.blockers).toEqual(['budget_exhausted', 'territory_exhausted']);
  });
});
