import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { createWorkerHandler, createProductionHandler } from '../src/handler';
import { WorkerAuth, pairingKey, secretHash, type WorkerScope } from '../src/workerAuth';
import { fingerprint, type DynamoCommand } from '../src/dynamoStore';
import { ResearchSetupService, guardGuidedResearch, guidedResearchBudgetId, guidedResearchMarkerKey, type ResearchSetupProfile } from '../src/researchSetup';
import { createDiscoveryReservationStore, budgetKey, researchAdmissionKey } from '../src/discoveryReservationStore';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { researchSetupReceiptSchema, researchSetupRemoteStatusSchema, type ResearchSetupRequest } from '../../../../src/shared/contracts/researchSetupContract';
import { ConditionalCommandHarness } from './sdkHarness';

const now = '2026-09-15T12:00:00.000Z';
const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-16T00:00:00.000Z', provenance: 'Fictional operator review. Not live access or invoice proof.', researchReservationMicros: 100, currency: 'USD' as const };
function event(path: string, body: unknown, bearer: string) { return { version: '2.0', rawPath: path, rawQueryString: '', headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', authorization: bearer }, body: JSON.stringify(body), requestContext: { domainName: 'worker.example.test', http: { method: 'POST', sourceIp: 'fictional' } } }; }
async function fixture(scopes: WorkerScope[] = ['commands:write', 'events:read']) {
  const db = new ConditionalCommandHarness(); const commands: DynamoCommand[] = []; let hook: ((command: DynamoCommand) => Promise<void>) | undefined;
  const options = { dynamo: { send: async (command: DynamoCommand) => { commands.push(command); await hook?.(command); return db.send(command); } }, workspaceId: 'setup-fiction', tableName: 'setup-fiction', clock: { now: () => now } };
  const auth = new WorkerAuth(options); const store = auth.store;
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes, expiresInSeconds: 300 })).code, 'fictional');
  const profile: ResearchSetupProfile = { reviewedCapability: structuredClone(descriptor), credentialParameterDeclared: true };
  const service = new ResearchSetupService({ auth, profile });
  const handler = createWorkerHandler({ auth, host: 'worker.example.test', researchSetupProfile: profile });
  const bearer = `Bearer ${pair.credential}`;
  const request: Extract<ResearchSetupRequest, { kind: 'approve' }> = { version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: options.workspaceId, pairingId: pair.pairingId, input: { expectedRevision: 0, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, permittedSources: ['https://fictional.example/'], maxCompanies: 1, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 80, researchCeilingMicros: 100, disclosureAcknowledged: true } };
  const identity = { workspaceId: request.workspaceId, pairingId: pair.pairingId };
  return { db, commands, options, auth, store, pair, profile, service, handler, bearer, request, identity,
    hook: (value?: typeof hook) => { hook = value; },
    post: (body: unknown = request, token = bearer) => handler(event('/research/setup', body, token)),
    status: (requestId?: string) => handler(event('/research/setup/status', { ...identity, ...(requestId ? { requestId } : {}) }, bearer)),
    state: (state: 'active' | 'paused', revision: number): ResearchSetupRequest => ({ version: 1, kind: 'set-state', ...identity, requestId: randomUUID(), input: { state, expectedRevision: revision, disclosureAcknowledged: true } }),
  };
}
function payload(response: { statusCode: number; body: string }) { expect(response.statusCode, response.body).toBe(200); return JSON.parse(response.body); }
const admissionKeys = [ownerResearchSourceKey(), guidedResearchMarkerKey, 'BUDGET#research', budgetKey(guidedResearchBudgetId)];

describe('real authenticated guided research handler', () => {
  it('evaluates descriptor expiry at the same post-fence time as checkedAt', async () => {
    const f = await fixture(); let clock = now;
    f.options.clock.now = () => clock;
    f.hook(async command => {
      if (command instanceof TransactWriteItemsCommand) clock = descriptor.expiresAt;
    });
    const status = payload(await f.status());
    expect(status.checkedAt).toBe(descriptor.expiresAt);
    expect(status.blockers).toContain('operator_descriptor_expired');
  });
  it('returns read-only coherent empty status and admits all first-use state in one fenced transaction', async () => {
    const f = await fixture(); const before = f.db.transactions.length;
    const status = researchSetupRemoteStatusSchema.parse(payload(await f.status()));
    expect(status).toMatchObject({ selector: null, discoveryLedger: null, researchLedger: null, blockers: [], descriptorFingerprint: fingerprint(descriptor), credentialParameterDeclared: true });
    expect(f.db.transactions.slice(before).flatMap(tx => tx.TransactItems ?? []).every(item => !!item.ConditionCheck)).toBe(true);
    const query = f.commands.find(command => command instanceof QueryCommand) as QueryCommand;
    expect(query.input.Limit).toBe(1); expect(query.input.ConsistentRead).toBe(true);
    const txBefore = f.db.transactions.length;
    const receipt = researchSetupReceiptSchema.parse(payload(await f.post()));
    expect(receipt).toMatchObject({ status: 'applied', revision: 1, state: 'active', fingerprint: fingerprint(f.request) });
    expect(f.db.transactions.length - txBefore).toBe(1);
    const tx = f.db.transactions.at(-1)!;
    expect(tx.TransactItems?.filter(i => i.Put)).toHaveLength(6);
    for (const key of admissionKeys) expect(f.db.inspect(key)).toBeDefined();
    expect(tx.TransactItems?.some(i => i.ConditionCheck?.Key?.sk?.S === pairingKey(f.pair.pairingId))).toBe(true);
    expect(tx.TransactItems?.some(i => i.ConditionCheck?.Key?.sk?.S === `TOKEN#${secretHash(f.pair.credential)}`)).toBe(true);
    expect(await f.store.list('ACCOUNT#')).toEqual([]); expect(await f.store.list('AUTH#')).toEqual([]); expect(await f.store.list('JOB#')).toEqual([]);
    const configured = researchSetupRemoteStatusSchema.parse(payload(await f.status(f.request.requestId)));
    expect(configured.receipt).toEqual(receipt); expect(configured.discoveryLedger).toEqual({ limitMicros: 80, reservedOrSpentMicros: 0, remainingMicros: 80 });
    expect(configured.selector?.research).toMatchObject({ preparationCommandId: f.request.requestId, budgetId: guidedResearchBudgetId, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1 });
  });
  it.each(['unauthenticated','scope','emergency','workspace','pairing','revoked'])('rejects %s before mutation', async defect => {
    const f = await fixture(defect === 'scope' ? ['events:read'] : undefined); const request = structuredClone(f.request);
    if (defect === 'workspace') request.workspaceId = 'different';
    if (defect === 'pairing') request.pairingId = randomUUID();
    if (defect === 'revoked') await f.auth.revokePairing(f.pair.pairingId);
    const before = f.db.transactions.length;
    expect((await f.post(request, defect === 'unauthenticated' ? '' : defect === 'emergency' ? `Bearer ${f.pair.emergencyCredential}` : f.bearer)).statusCode).not.toBe(200);
    expect(f.db.transactions.length).toBe(before); for (const key of admissionKeys) expect(f.db.inspect(key)).toBeUndefined();
  });
  it('requires read scope and device identity for status', async () => {
    const f = await fixture(['commands:write']); expect((await f.status()).statusCode).toBe(403);
    expect((await f.handler(event('/research/setup/status', f.identity, `Bearer ${f.pair.emergencyCredential}`))).statusCode).toBe(403);
  });
  it.each(['proto','host','domain','query','oversize'])('enforces existing HTTP %s restrictions', async defect => {
    const f = await fixture(); const raw = event('/research/setup', f.request, f.bearer);
    if (defect === 'proto') raw.headers['x-forwarded-proto'] = 'http';
    if (defect === 'host') raw.headers.host = 'foreign.test';
    if (defect === 'domain') raw.requestContext.domainName = 'foreign.test';
    if (defect === 'query') raw.rawQueryString = 'requestId=forbidden';
    if (defect === 'oversize') raw.body = ' '.repeat(65537);
    expect((await f.handler(raw)).statusCode).toBe(400); expect(f.db.inspect(ownerResearchSourceKey())).toBeUndefined();
  });
  it.each(['missing','invalid','expired','future','credential','binding'])('holds %s reviewed descriptor without provider setup', async defect => {
    const f = await fixture();
    if (defect === 'missing') delete f.profile.reviewedCapability;
    if (defect === 'invalid') f.profile.reviewedCapability = '{invalid JSON';
    if (defect === 'expired') f.profile.reviewedCapability = { ...descriptor, expiresAt: now };
    if (defect === 'future') f.profile.reviewedCapability = { ...descriptor, reviewedAt: '2026-09-15T13:00:00.000Z' };
    if (defect === 'credential') f.profile.credentialParameterDeclared = false;
    if (defect === 'binding') f.request.input.descriptorFingerprint = 'a'.repeat(64);
    if (defect !== 'binding') expect(payload(await f.status()).blockers.length).toBeGreaterThan(0);
    expect((await f.post()).statusCode).toBe(400); for (const key of admissionKeys) expect(f.db.inspect(key)).toBeUndefined();
  });
  it.each(['empty-sources','zero','sum-overflow','discovery-insufficient','research-insufficient','revision','extra-budget-id','unacknowledged'])('rejects %s proposal', async defect => {
    const f = await fixture(); const input: Record<string, unknown> = { ...f.request.input };
    if (defect === 'empty-sources') input.permittedSources = [];
    if (defect === 'zero') input.discoveryCeilingMicros = 0;
    if (defect === 'sum-overflow') input.discoveryCeilingMicros = Number.MAX_SAFE_INTEGER;
    if (defect === 'discovery-insufficient') input.discoveryCeilingMicros = 79;
    if (defect === 'research-insufficient') input.researchCeilingMicros = 99;
    if (defect === 'revision') input.expectedRevision = 1;
    if (defect === 'extra-budget-id') input.budgetId = 'alternate';
    if (defect === 'unacknowledged') input.disclosureAcknowledged = false;
    expect((await f.post({ ...f.request, input })).statusCode).toBe(400); expect(f.db.inspect(ownerResearchSourceKey())).toBeUndefined();
  });
  it.each(['discovery','research','source','marker'])('holds legacy/orphan %s instead of adopting or resetting', async target => {
    const f = await fixture(); const key = target === 'discovery' ? 'BUDGET#discovery#other-budget' : target === 'research' ? 'BUDGET#research' : target === 'source' ? ownerResearchSourceKey() : guidedResearchMarkerKey;
    await f.store.transact([f.store.put(key, { legacy: true }, null)]);
    const before = f.db.transactions.length;
    expect((await f.post()).statusCode).toBe(400); expect(f.db.transactions.length).toBe(before);
    expect(payload(await f.status()).blockers).toContain('legacy_or_orphan_state'); expect(f.db.inspect(key)).toEqual({ legacy: true });
  });
  it('distinguishes read outage and corruption from missing or zero state', async () => {
    const f = await fixture(); f.hook(async command => { if (command instanceof GetItemCommand && command.input.Key?.sk?.S === 'BUDGET#research') throw Error('private SDK failure'); });
    expect(await f.status()).toMatchObject({ statusCode: 503, body: '{"error":"worker_unavailable"}' });
    f.hook(); await f.post(); const row = await f.store.get('BUDGET#research');
    await f.store.transact([f.store.put('BUDGET#research', { limit: 100, spent: 101, approvedAt: now }, row!.rev)]);
    const status = payload(await f.status()); expect(status.researchLedger).toBeNull(); expect(status.blockers).toContain('budget_corrupt');
  });
  it('fences concurrent status changes instead of returning an incoherent snapshot', async () => {
    const f = await fixture(); await f.post(); let changed = false;
    f.hook(async command => { if (!changed && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.every(i => !!i.ConditionCheck)) { changed = true; await f.service.apply(f.state('paused', 1), f.bearer); } });
    expect((await f.status()).statusCode).toBe(400);
  });
  it.each(['pairing','token'])('fences final %s revocation atomically with no partial admission', async target => {
    const f = await fixture(); const key = target === 'pairing' ? pairingKey(f.pair.pairingId) : `TOKEN#${secretHash(f.pair.credential)}`;
    const row = await f.store.get<object>(key);
    f.hook(async command => { if (command instanceof TransactWriteItemsCommand) { f.hook(); await f.store.transact([f.store.put(key, { ...row!.data, ...(target === 'pairing' ? { revoked: true } : { generation: 99 }) }, row!.rev)]); } });
    expect((await f.post()).statusCode).not.toBe(200); for (const key of admissionKeys) expect(f.db.inspect(key)).toBeUndefined();
  });
  it('allows exactly one concurrent first-use proposal and never an alternate-ID reset', async () => {
    const f = await fixture(); const second = { ...f.request, requestId: randomUUID() };
    const responses = await Promise.all([f.post(), f.post(second)]); expect(responses.filter(r => r.statusCode === 200)).toHaveLength(1);
    const before = admissionKeys.map(k => f.db.inspect(k)); expect((await f.post({ ...second, requestId: randomUUID() })).statusCode).toBe(400);
    expect(admissionKeys.map(k => f.db.inspect(k))).toEqual(before); expect(await f.store.list('BUDGET#discovery#')).toHaveLength(1);
  });
  it.each(['legacy-first', 'guided-first'] as const)('serializes concurrent legacy setter and guided admission: %s', async order => {
    const f = await fixture(); const reservations = createDiscoveryReservationStore(f.auth.options);
    const legacy = () => reservations.approveBudget({ budgetId: 'legacy-other', limitMicros: 123 });
    let entered = false;
    f.hook(async command => {
      if (entered || !(command instanceof TransactWriteItemsCommand)) return;
      const keys = command.input.TransactItems?.map(i => i.Put?.Item?.sk?.S) ?? [];
      if (order === 'legacy-first' && keys.includes(ownerResearchSourceKey())) { entered = true; await legacy(); }
      if (order === 'guided-first' && keys.includes('BUDGET#discovery#legacy-other')) { entered = true; payload(await f.post()); }
    });
    if (order === 'legacy-first') {
      expect((await f.post()).statusCode).toBe(400);
      expect(f.db.inspect('BUDGET#discovery#legacy-other')).toMatchObject({ limit: 123, spent: 0 });
      expect(f.db.inspect(ownerResearchSourceKey())).toBeUndefined();
      expect(payload(await f.status()).blockers).toContain('legacy_or_orphan_state');
    } else {
      await expect(legacy()).rejects.toThrow();
      expect(f.db.inspect('BUDGET#discovery#legacy-other')).toBeUndefined();
      expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toMatchObject({ limit: 80, spent: 0 });
    }
    expect(f.db.inspect(researchAdmissionKey)).toEqual({ version: 1, kind: order === 'legacy-first' ? 'legacy' : 'guided' });
  });
  it('recovers ambiguous committed approval, replays exact immutable receipt and authenticates revoked replay', async () => {
    const f = await fixture(); f.db.afterCommit = () => { f.db.afterCommit = undefined; throw Error('lost response'); };
    const result = payload(await f.post()); const before = f.db.transactions.length;
    expect(payload(await f.post())).toEqual(result); expect(f.db.transactions.length).toBe(before);
    expect((await f.post({ ...f.request, input: { ...f.request.input, maxBytes: 9999 } })).statusCode).toBe(400);
    await f.auth.revokePairing(f.pair.pairingId); expect((await f.post()).statusCode).toBe(401); expect((await f.status(f.request.requestId)).statusCode).toBe(401);
  });
  it('preserves every setting, marker and ledger byte across pause/resume and refuses old configureResearch bypass', async () => {
    const f = await fixture(); await f.post();
    const reservations = createDiscoveryReservationStore(f.auth.options);
    await reservations.reserveOnce({ workspaceId: f.request.workspaceId, budgetId: guidedResearchBudgetId, commandId: randomUUID(), inputFingerprint: 'a'.repeat(64), searchCostMicros: 40, modelCostMicros: 40 });
    const source = ownerResearchSourceSchema.parse(f.db.inspect(ownerResearchSourceKey()));
    const keys = [guidedResearchMarkerKey, 'BUDGET#research', budgetKey(guidedResearchBudgetId)]; const before = await Promise.all(keys.map(k => f.store.get(k)));
    f.profile.reviewedCapability = undefined;
    expect(payload(await f.post(f.state('paused', 1)))).toMatchObject({ state: 'paused', revision: 2 });
    expect((await f.post(f.state('active', 2))).statusCode).toBe(400);
    f.profile.reviewedCapability = descriptor; expect(payload(await f.post(f.state('active', 2)))).toMatchObject({ state: 'active', revision: 3 });
    expect(await Promise.all(keys.map(k => f.store.get(k)))).toEqual(before);
    expect(f.db.inspect(ownerResearchSourceKey())).toEqual({ ...source, revision: 3 });
    expect((await f.handler(event('/research/configure', { commandId: randomUUID(), ...f.identity, expectedRevision: 3, configuration: { ...source, revision: 4, research: { ...source.research!, budgetId: 'alternate' } } }, f.bearer))).statusCode).toBe(400);
    await expect(reservations.approveBudget({ budgetId: 'alternate', limitMicros: 999 })).rejects.toThrow();
    await expect(createWorkerAccountRepository(f.auth.options).approveResearchBudget(999)).rejects.toThrow();
    expect(f.db.inspect(ownerResearchSourceKey())).toEqual({ ...source, revision: 3 });
  });
  it.each(['cancel-first','approve-first','simultaneous','lost-cancel-ack'])('cancellation returns exact winning receipt: %s', async mode => {
    const f = await fixture(); const cancel = { version: 1, kind: 'cancel', originalRequest: f.request };
    let winner;
    if (mode === 'approve-first') { winner = payload(await f.post()); expect(payload(await f.post(cancel))).toEqual(winner); }
    else if (mode === 'simultaneous') { const results = await Promise.all([f.post(), f.post(cancel)]); expect(results[0]!.statusCode).toBe(200); expect(results[1]!.statusCode).toBe(200); winner = payload(results[0]!); expect(payload(results[1]!)).toEqual(winner); }
    else { if (mode === 'lost-cancel-ack') f.db.afterCommit = () => { f.db.afterCommit = undefined; throw Error('lost cancellation ack'); }; winner = payload(await f.post(cancel)); expect(winner.status).toBe('cancelled'); }
    expect(payload(await f.post())).toEqual(winner); expect(payload(await f.post(cancel))).toEqual(winner);
    expect(payload(await f.status(f.request.requestId)).receipt).toEqual(winner);
    if (winner.status === 'cancelled') for (const key of admissionKeys) expect(f.db.inspect(key)).toBeUndefined();
    else for (const key of admissionKeys) expect(f.db.inspect(key)).toBeDefined();
  });
  it.each(['cancel-wins','approve-wins'] as const)('fences delayed in-flight transaction with exact winner: %s', async order => {
    const f = await fixture(); const cancel = { version: 1, kind: 'cancel', originalRequest: f.request };
    let entered = false; let other: unknown;
    f.hook(async command => {
      if (entered || !(command instanceof TransactWriteItemsCommand)) return;
      const puts = command.input.TransactItems?.filter(i => i.Put) ?? [];
      if (order === 'cancel-wins' && puts.length === 6) { entered = true; other = payload(await f.post(cancel)); }
      if (order === 'approve-wins' && puts.length === 1) { entered = true; other = payload(await f.post()); }
    });
    const winner = payload(await f.post(order === 'cancel-wins' ? f.request : cancel));
    expect(winner).toEqual(other); expect(winner.status).toBe(order === 'cancel-wins' ? 'cancelled' : 'applied');
    expect(f.db.inspect(ownerResearchSourceKey()) !== undefined).toBe(order === 'approve-wins');
    expect(payload(await f.post(cancel))).toEqual(winner);
  });
  it('still permits pause with corrupt budget but refuses resume without altering ledger', async () => {
    const f = await fixture(); payload(await f.post()); const row = await f.store.get('BUDGET#research');
    await f.store.transact([f.store.put('BUDGET#research', { limit: 100, spent: 101, approvedAt: now }, row!.rev)]);
    const before = await f.store.get('BUDGET#research');
    expect(payload(await f.post(f.state('paused', 1)))).toMatchObject({ state: 'paused' });
    expect((await f.post(f.state('active', 2))).statusCode).toBe(400);
    expect(await f.store.get('BUDGET#research')).toEqual(before);
  });
  it('cancels expired uncommitted requests but never accepts changed same-ID cancellation', async () => {
    const f = await fixture(); f.profile.reviewedCapability = undefined;
    expect((await f.post()).statusCode).toBe(400);
    const cancel = { version: 1, kind: 'cancel', originalRequest: f.request };
    expect(payload(await f.post(cancel))).toMatchObject({ status: 'cancelled', revision: null, state: null, fingerprint: fingerprint(f.request) });
    expect((await f.post({ ...cancel, originalRequest: { ...f.request, input: { ...f.request.input, maxBytes: 10 } } })).statusCode).toBe(400);
    await f.auth.revokePairing(f.pair.pairingId); expect((await f.post(cancel)).statusCode).toBe(401);
  });
  it('production setup profile is optional raw JSON and status/approval perform no SSM or provider IO', async () => {
    const f = await fixture(); const ssm = { send: vi.fn(async () => { throw Error('no credential IO'); }) }; const fetch = vi.fn(async () => { throw Error('no provider IO'); });
    const env = { DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: f.options.tableName, DELEGATED_WORKSPACE_ID: f.options.workspaceId, DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'fictional-region', DELEGATED_GOOGLE_CLIENT_ID: 'present-but-not-read', DELEGATED_GOOGLE_SECRET_PARAMETER: '/not-read', DELEGATED_GOOGLE_KEY_PARAMETER: '/not-read' };
    const missing = createProductionHandler(env, { dynamo: f.options.dynamo, ssm, fetch });
    const status = payload(await missing(event('/research/setup/status', f.identity, f.bearer))); expect(status.blockers).toContain('operator_descriptor_missing'); expect(status.blockers).toContain('credential_parameter_missing');
    const productionDescriptor = { ...descriptor, reviewedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    f.request.input.descriptorFingerprint = fingerprint(productionDescriptor);
    const configured = createProductionHandler({ ...env, DELEGATED_RESEARCH_REVIEWED_CAPABILITY: JSON.stringify(productionDescriptor), DELEGATED_RESEARCH_CREDENTIAL_PARAMETER: `/delegated-worker/${f.options.workspaceId}/research` }, { dynamo: f.options.dynamo, ssm, fetch });
    expect(payload(await configured(event('/research/setup', f.request, f.bearer))).status).toBe('applied'); expect(ssm.send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

async function sourceFixture() {
  const f = await fixture(); let modelCalls = 0; let pageCalls = 0; let credentialCalls = 0; let credentialsHook: (() => void) | undefined;
  const fetch: typeof globalThis.fetch = async () => { modelCalls++; return Response.json({ status: 'completed', model: descriptor.capability.model, output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://fictional.example/' }] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies: [{ name: 'Fictional PM', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }] }), annotations: [{ type: 'url_citation', url: 'https://fictional.example/' }] }] },
  ] }); };
  const research = { loadCredentials: async () => { credentialCalls++; credentialsHook?.(); return { apiKey: 'fictional', model: descriptor.capability.model }; }, resolve: async () => ['93.184.216.34'], pageHttp: async () => { pageCalls++; return new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }); } };
  const source = () => createSourceCoordinator({ auth: f.auth, authorization: new RemoteGoogleAuthorization({ auth: f.auth, fetch }), fetch, research, researchSetupProfile: f.profile });
  return { ...f, source, counts: () => ({ modelCalls, pageCalls, credentialCalls }), onCredentials: (hook: () => void) => { credentialsHook = hook; } };
}
describe('guided admission into actual source coordinator with fictional provider only', () => {
  it('has no hidden budget seeding and produces one research result without duplicate second tick', async () => {
    const f = await sourceFixture(); expect(await f.store.list('BUDGET#')).toEqual([]);
    payload(await f.post());
    expect(await f.source().tick(new AbortController().signal)).toMatchObject({ researchPrepared: 1, researchCompleted: 1 });
    expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 1, credentialCalls: 1 });
    const candidates = await createWorkerAccountRepository(f.auth.options).listCandidates(now);
    expect(candidates).toHaveLength(1); expect(candidates[0]!.snapshot.portfolio).toMatchObject([{ count: 240, scope: 'managed', measure: 'units' }]);
    expect(await f.store.list('AUTH#')).toEqual([]);
    expect(payload(await f.status()).discoveryLedger).toEqual({ limitMicros: 80, reservedOrSpentMicros: 80, remainingMicros: 0 });
    await f.source().tick(new AbortController().signal); expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 1, credentialCalls: 1 });
  });
  it.each(['missing','expired','changed','paused'])('holds %s descriptor/state before reserves or credentials', async defect => {
    const f = await sourceFixture(); payload(await f.post());
    if (defect === 'missing') f.profile.reviewedCapability = undefined;
    if (defect === 'expired') f.profile.reviewedCapability = { ...descriptor, expiresAt: now };
    if (defect === 'changed') f.profile.reviewedCapability = { ...descriptor, provenance: 'different review' };
    if (defect === 'paused') payload(await f.post(f.state('paused', 1)));
    await f.source().tick(new AbortController().signal);
    expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 0 }); expect(await f.store.list('DISCOVERY#')).toEqual([]);
    expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toMatchObject({ spent: 0 });
  });
  it('fences a concurrent authenticated pause at the actual discovery reservation transaction', async () => {
    const f = await sourceFixture(); payload(await f.post()); let entered = false;
    f.hook(async command => {
      if (!entered && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S?.startsWith('DISCOVERY#'))) {
        entered = true; payload(await f.post(f.state('paused', 1)));
      }
    });
    await f.source().tick(new AbortController().signal);
    expect(entered).toBe(true); expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 0 });
    expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toMatchObject({ spent: 0 }); expect(await f.store.list('DISCOVERY#')).toEqual([]);
  });
  it.each(['source', 'pairing'])('holds expiry during final %s read after credentials before model HTTP', async boundary => {
    const f = await sourceFixture(); payload(await f.post()); let clock = now; let crossed = false;
    f.options.clock.now = () => clock;
    f.onCredentials(() => {
      f.hook(async command => {
        const key = boundary === 'source' ? ownerResearchSourceKey() : pairingKey(f.pair.pairingId);
        if (!crossed && command instanceof GetItemCommand && command.input.Key?.sk?.S === key) {
          crossed = true; clock = descriptor.expiresAt;
        }
      });
    });
    await f.source().tick(new AbortController().signal);
    expect(crossed).toBe(true);
    expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 1 });
    expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toMatchObject({ spent: 80 });
  });
  it.each([guidedResearchBudgetId, 'another-legal-id'])('holds genuinely guided admission with a missing marker for budget %s', async budgetId => {
    const f = await sourceFixture(); payload(await f.post());
    const row = await f.store.get<unknown>(ownerResearchSourceKey());
    const config = ownerResearchSourceSchema.parse(row!.data);
    config.research!.budgetId = budgetId;
    await f.store.transact([f.store.put(ownerResearchSourceKey(), config, row!.rev)]);
    const send = f.options.dynamo.send;
    f.options.dynamo.send = async command => command instanceof GetItemCommand && command.input.Key?.sk?.S === guidedResearchMarkerKey ? { $metadata: {} } : send(command);
    await expect(guardGuidedResearch(f.store, config, f.profile)).rejects.toThrow('research_setup_marker_missing');
    await f.source().tick(new AbortController().signal);
    expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 0 });
  });
  it('rechecks descriptor after credential load before model HTTP while retaining conservative reservation', async () => {
    const f = await sourceFixture(); payload(await f.post()); f.onCredentials(() => { f.profile.reviewedCapability = undefined; });
    await f.source().tick(new AbortController().signal);
    expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 1 }); expect(await f.store.list('ACCOUNT#')).toEqual([]);
    expect(f.db.inspect(budgetKey(guidedResearchBudgetId))).toMatchObject({ spent: 80 });
  });
});
