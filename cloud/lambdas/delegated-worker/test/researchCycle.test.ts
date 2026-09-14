import type { ResearchCycleAdmission, ResearchCycleReceipt, ResearchCycleReference } from '../src/researchCycleContract';
import { researchCycleKey, researchCycleHeadKey } from '../src/researchCycle';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { createProductionHandler } from '../src/handler';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { ResearchSetupService } from '../src/researchSetup';
import { fingerprint, type DynamoCommand } from '../src/dynamoStore';
import { ownerResearchSourceSchema, ownerResearchSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import type { ResearchOnceRequest, ResearchOnceResult, ResearchOnceNextRequest } from '../src/researchOnceContract';
const env = () => ({ DELEGATED_WORKER_SCHEDULE_ARN: '', DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_RESEARCH_ONCE_ENABLED: 'true', DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_WORKER_TABLE: 'table', AWS_REGION: 'us-east-1' });
async function admitted(maxCompanies = 1, providerCost = 40) {
  const now = new Date().toISOString();
  const descriptor = { capability: { model: 'fixture', webSearch: true, searchCostMicros: providerCost, modelCostMicros: providerCost }, reviewedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), provenance: 'Fictional review only.', researchReservationMicros: 100, currency: 'USD' };
  const db = new ConditionalCommandHarness(); const commands: DynamoCommand[] = [];
  let hook: ((command: DynamoCommand) => Promise<void>) | undefined;
  const dynamo = { send: async (command: DynamoCommand) => { commands.push(command); await hook?.(command); return db.send(command); } };
  const auth = new WorkerAuth({ dynamo, workspaceId: 'ws', tableName: 'table', clock: { now: () => now } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fixture');
  const setup = new ResearchSetupService({ auth, profile: { reviewedCapability: descriptor, credentialParameterDeclared: true } });
  await setup.apply({ version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId, input: {
    expectedRevision: 0, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, permittedSources: ['https://fictional.example/'], maxCompanies, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: providerCost * 2, researchCeilingMicros: 100, disclosureAcknowledged: true,
  } }, `Bearer ${pair.credential}`);
  const source = ownerResearchSourceSchema.parse(db.inspect(ownerResearchSourceKey()));
  const request: ResearchOnceRequest = { version: 1, kind: 'research.once', workspaceId: 'ws', pairingId: pair.pairingId, expectedSourceRevision: 1, researchFingerprint: fingerprint(source.research) };
  const environment = { ...env(), DELEGATED_RESEARCH_REVIEWED_CAPABILITY: JSON.stringify(descriptor), DELEGATED_RESEARCH_CREDENTIAL_PARAMETER: '/delegated-worker/ws/research', DELEGATED_GOOGLE_CLIENT_ID: 'unused-invalid' };
  const companies = [{ name: 'Fictional PM', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'completed', model: 'fixture', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://fictional.example/' }] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies }), annotations: [{ type: 'url_citation', url: 'https://fictional.example/' }] }] },
  ] }));
  const ssm = { send: vi.fn(async () => ({ $metadata: {}, Parameter: { Type: 'SecureString' as const, Value: JSON.stringify({ apiKey: 'fictional', model: 'fixture' }) } })) };
  const pageHttp = vi.fn(async () => new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }));
  const boundaries = { dynamo, ssm, fetch, pageHttp, resolve: vi.fn(async () => ['93.184.216.34']) };
  const invoke = (value: ResearchOnceRequest = request) => createProductionHandler(environment, boundaries)(value);
  const status = (result: ResearchOnceResult) => invoke({ ...request, kind: 'research.once.status', runId: result.runId! });
  commands.length = 0;
  return { db, auth, pair, setup, source, request, environment, boundaries, commands, fetch, pageHttp, ssm, companies, invoke, status, hook: (value?: typeof hook) => { hook = value; } };
}

async function nextFixture(providerCost = 40) {
  const f = await admitted(1, providerCost); const originalFetch = f.fetch.getMockImplementation()!;
  f.fetch.mockRejectedValue(new Error('fixture lost original response'));
  const original = await f.invoke(); expect(original.state).toBe('uncertain');
  f.fetch.mockImplementation(originalFetch); f.fetch.mockClear(); f.ssm.send.mockClear();
  await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const admission: Extract<ResearchOnceNextRequest, { kind: 'research.once.admit-next' }> = {
    version: 1, kind: 'research.once.admit-next', workspaceId: 'ws', pairingId: f.pair.pairingId,
    parentRunId: original.runId!, parentSourceRevision: 1, researchFingerprint: f.request.researchFingerprint,
    expectedSourceRevision: 2, descriptorFingerprint: fingerprint(JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY)),
    expectedDiscoveryBudget: f.db.inspect('BUDGET#discovery#guided-research-v1') as { limit: number; spent: number; approvedAt: string },
    expectedResearchBudget: f.db.inspect('BUDGET#research') as { limit: number; spent: number; approvedAt: string }, proposedDiscoveryLimitMicros: providerCost * 4,
  };
  const invokeNext = (value: ResearchOnceNextRequest = admission) => createProductionHandler(f.environment, f.boundaries)(value);
  const nextStatus = () => invokeNext({ version: 1, kind: 'research.once.admit-next.status', workspaceId: 'ws', pairingId: f.pair.pairingId,
    parentRunId: original.runId!, parentSourceRevision: 1, researchFingerprint: f.request.researchFingerprint, admissionFingerprint: fingerprint(admission) });
  const resume = () => f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: 2, state: 'active', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  f.commands.length = 0;
  return { ...f, original, admission, invokeNext, nextStatus, resume };
}
async function cycleFixture(providerCost = 40) {
  const f = await nextFixture(providerCost);
  const next = await f.invokeNext();
  const successfulFetch = f.fetch.getMockImplementation()!;
  await f.resume(); f.fetch.mockRejectedValue(new Error('fixture lost successor response'));
  const successor = await f.invoke({ ...f.request, expectedSourceRevision: 3, successor: { parentRunId: f.original.runId!, admissionFingerprint: next.receipt!.fingerprint } });
  await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: 3, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  f.fetch.mockClear(); f.pageHttp.mockClear(); f.ssm.send.mockClear(); f.commands.length = 0;
  const identity = { version: 2 as const, workspaceId: 'ws', pairingId: f.pair.pairingId };
  const native = createProductionHandler(f.environment, f.boundaries);
  const cycleStatus = () => native({ ...identity, kind: 'research.cycle.status' });
  return { ...f, successor, identity, native, cycleStatus, successfulFetch };
}
describe('bounded unsuccessful discovery cycles through native production', () => {
  it('observes actual legacy original and successor without provider effects', async () => {
    const f = await cycleFixture(); const status = await f.cycleStatus();
    expect(status).toMatchObject({ version: 2, kind: 'research.cycle.status.result', admissionState: 'not-observed',
      predecessor: { kind: 'legacy' }, source: { revision: 4, state: 'paused' }, discoveryBudget: { limit: 160, spent: 160 }, researchBudget: { limit: 100, spent: 0 } });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled();
  });
});

type Fixture = Omit<Awaited<ReturnType<typeof cycleFixture>>, 'admission'>;
async function proposal(f: Fixture): Promise<ResearchCycleAdmission> {
  const status = await f.cycleStatus();
  return { ...f.identity, kind: 'research.cycle.admit', expectedSourceRevision: status.source!.revision,
    researchFingerprint: status.source!.researchFingerprint!, descriptorFingerprint: status.descriptorFingerprint!, predecessor: status.predecessor!,
    observationFingerprint: status.observationFingerprint!, expectedDiscoveryBudget: status.discoveryBudget!, expectedResearchBudget: status.researchBudget!,
    proposedDiscoveryLimitMicros: Math.max(status.discoveryBudget!.limit, status.discoveryBudget!.spent + 80), disclosureAcknowledged: true };
}
const ref = (receipt: ResearchCycleReceipt): ResearchCycleReference => ({ ordinal: receipt.ordinal, admissionFingerprint: receipt.fingerprint });
async function transition(f: Fixture, state: 'active' | 'paused') {
  const source = ownerResearchSourceSchema.parse(f.db.inspect(ownerResearchSourceKey()));
  await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: source.revision, state, disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
}
async function ready() {
  const f = await cycleFixture(); const admission = await proposal(f); const result = await f.native(admission); expect(result.state).toBe('applied');
  const receipt = result.receipt!; await transition(f, 'active'); f.fetch.mockImplementation(f.successfulFetch);
  const execute = (context?: { getRemainingTimeInMillis(): number }) => f.native({ ...f.identity, kind: 'research.cycle.execute', reference: ref(receipt) }, context);
  return { ...f, admission, receipt, execute };
}
async function change(f: Fixture, key: string, update: (data: Record<string, unknown>) => Record<string, unknown>, scalars = {}) {
  const row = (await f.auth.store.get<Record<string, unknown>>(key))!;
  await f.auth.store.transact([f.auth.store.put(key, update(row.data), row.rev, scalars)]);
}
it.each([false, true])('keeps citation diagnostics invocation-local and uncertainty durable when console throws=%s', async throws => {
  const f = await ready();
  const keys = [`DISCOVERY#${f.original.runId}`, `DISCOVERY#${f.successor.runId}`, `RESEARCH_ONCE_NEXT#${f.original.runId}`, 'BUDGET#research'];
  const before = keys.map(key => f.db.inspect(key));
  f.fetch.mockImplementation(async () => Response.json({ status: 'completed', model: 'fixture', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://fictional.example/' }] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies: f.companies }), annotations: [] }] },
  ] }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { if (throws) throw new Error('fictional console failure'); });
  try {
    const result = await f.execute();
    expect(result.outcome).toMatchObject({ state: 'uncertain', accountId: null, jobId: null, evidenceReceiptId: null, settlementReceiptId: null, settled: false });
    expect(warn).toHaveBeenCalledWith({ event: 'research_discovery_uncertain', reason: 'citation_missing', citationSummary: {
      candidateCount: 1, annotationCount: 0, exactMatchCount: 0, serializedMatchCount: 0, consultedMatchCount: 1,
    } });
    expect(JSON.stringify(result)).not.toContain('citationSummary');
    expect(JSON.stringify(f.db.inspect(`DISCOVERY#${f.receipt.runId}`))).not.toContain('citationSummary');
    expect(result.discoveryBudget).toMatchObject({ limit: 240, spent: 240 });
    expect(keys.map(key => f.db.inspect(key))).toEqual(before);
    const status = await f.native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) });
    expect(status.outcome).toEqual(result.outcome);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
it('admits one immutable slot, preserves old rows/page/source and executes only after separate Resume5', async () => {
  const f = await cycleFixture(); const admission = await proposal(f);
  const keys = ['OWNER_RESEARCH_SOURCE', 'GUIDED_RESEARCH_SETUP', 'RESEARCH_ADMISSION_FENCE', 'BUDGET#research', `DISCOVERY#${f.original.runId}`, `DISCOVERY#${f.successor.runId}`, `RESEARCH_ONCE_NEXT#${f.original.runId}`];
  const before = keys.map(key => f.db.inspect(key));
  const result = await f.native(admission); expect(result).toMatchObject({ state: 'applied', receipt: { ordinal: 1, deltaMicros: 80, expectedExecutionRevision: 5 } });
  expect(keys.map(key => f.db.inspect(key))).toEqual(before);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toEqual({ ...admission.expectedDiscoveryBudget, limit: 240 });
  expect(await f.native(admission)).toEqual(result);
  const execution = { ...f.identity, kind: 'research.cycle.execute' as const, reference: ref(result.receipt!) };
  expect(await f.native(execution)).toMatchObject({ authorityState: 'paused', outcome: null });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled();
  await transition(f, 'active'); f.fetch.mockImplementation(f.successfulFetch);
  const completed = await f.native(execution); expect(completed).toMatchObject({ authorityState: 'ready', outcome: { state: 'completed', settled: true, runId: result.receipt!.runId } });
  expect(await f.native(execution)).toMatchObject({ outcome: completed.outcome });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
  expect(f.commands.some(command => command instanceof QueryCommand)).toBe(false);
});
it.each(['uncertain', 'empty', 'never-reserved'] as const)('allows later nonliteral cycle after %s, exact slot replay after head advance', async kind => {
  const f = await ready();
  if (kind === 'uncertain') { f.fetch.mockRejectedValue(new Error('lost response')); expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } }); }
  if (kind === 'empty') {
    f.fetch.mockImplementation(async () => Response.json({ status: 'completed', model: 'fixture', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"companies":[]}', annotations: [] }] }] }));
    expect(await f.execute()).toMatchObject({ outcome: { state: 'empty' } });
  }
  await transition(f, 'paused'); await transition(f, 'paused'); // supported nonliteral revision 7, not a hardcoded pause6 case
  const next = await proposal(f); const result = await f.native(next);
  expect(result).toMatchObject({ state: 'applied', receipt: { ordinal: 2, expectedExecutionRevision: 8, deltaMicros: kind === 'never-reserved' ? 0 : 80 } });
  expect(await f.native(f.admission)).toMatchObject({ state: 'applied', receipt: f.receipt });
  expect(await f.native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) })).toMatchObject({ authorityState: 'superseded', receipt: f.receipt });
  await expect(f.native({ ...f.admission, proposedDiscoveryLimitMicros: 320 })).rejects.toThrow('research_cycle_unavailable');
});
it.each(['original', 'successor', 'cycle'] as const)('blocks nonempty %s discovery even without job or account', async target => {
  const f = await ready();
  if (target === 'cycle') {
    f.hook(async command => { if (command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('ACCOUNT#'))) throw Error('stop before create'); });
    await expect(f.execute()).rejects.toThrow('research_cycle_unavailable'); f.hook(); await transition(f, 'paused');
    expect((await f.cycleStatus()).blockers).toContain('predecessor_ineligible'); expect(await f.native(await proposal(f))).toMatchObject({ state: 'held' });
  } else {
    const fresh = await cycleFixture(); const runId = target === 'original' ? fresh.original.runId! : fresh.successor.runId!;
    await change(fresh, `DISCOVERY#${runId}`, data => ({ ...data, completed: true, candidates: fresh.companies }));
    if (target === 'original') await expect(fresh.cycleStatus()).rejects.toThrow('research_cycle_unavailable');
    else { expect((await fresh.cycleStatus()).blockers).toContain('predecessor_ineligible');
      expect(await fresh.native(await proposal(fresh))).toMatchObject({ state: 'held' }); }
  }
});
it.each([{ completed: false, candidates: [] }, { completed: true, candidates: null }, { costMicros: 81 }, { reserved: 1 }, { researchOnceBinding: null }])('rejects corrupt legacy reservation state %j', async defect => {
  const f = await cycleFixture(); await change(f, `DISCOVERY#${f.original.runId}`, data => ({ ...data, ...defect }));
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable');
});
it('concurrent identical admissions converge and conflicting same-slot requests cannot mint another allowance', async () => {
  const f = await cycleFixture(); const request = await proposal(f);
  const results = await Promise.all([f.native(request), f.native(request)]); expect(results[0]).toEqual(results[1]);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 240, spent: 160 });
  await expect(f.native({ ...request, observationFingerprint: 'a'.repeat(64) })).rejects.toThrow('research_cycle_unavailable');
  expect(f.db.inspect(researchCycleKey(2))).toBeUndefined();
});
it('completed candidate replay may win the FIRST exact page claim, without another discovery', async () => {
  const f = await ready(); let failed = false;
  f.hook(async command => {
    if (!failed && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('ACCOUNT#'))) { failed = true; throw Error('stop after discovery'); }
  });
  await expect(f.execute()).rejects.toThrow('research_cycle_unavailable'); f.hook();
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
  const results = await Promise.allSettled([f.execute(), f.execute()]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(await f.execute()).toMatchObject({ outcome: { state: 'completed', settled: true } });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
});
it('fully exhausted page/discovery budgets still permit evidence-to-settlement replay', async () => {
  const f = await ready(); let failed = false;
  f.hook(async command => {
    if (!failed && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('JOB#') && JSON.parse(item.Put.Item.data!.S!).state === 'completed')) {
      failed = true; throw Error('stop before settlement');
    }
  });
  await expect(f.execute()).rejects.toThrow('research_cycle_unavailable'); f.hook();
  expect(f.db.inspect('BUDGET#research')).toMatchObject({ limit: 100, spent: 100 });
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 240, spent: 240 });
  expect(await f.execute()).toMatchObject({ outcome: { state: 'completed', settled: true } });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
});
it('lost page claim acknowledgement never restarts uncertain page HTTP', async () => {
  const f = await ready(); let lost = false;
  f.hook(async command => {
    if (!lost && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('JOB#') && JSON.parse(item.Put.Item.data!.S!).state === 'running')) {
      lost = true; await f.db.send(command); throw Error('lost claim ack');
    }
  });
  expect(await f.execute()).toMatchObject({ outcome: { state: 'in-progress' } }); f.hook();
  expect(await f.execute()).toMatchObject({ outcome: { state: 'in-progress' } });
  expect(f.pageHttp).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('incomplete discovery replay cannot load credentials or page providers', async () => {
  const f = await ready(); f.fetch.mockRejectedValue(new Error('lost discovery'));
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } });
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.ssm.send).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
});
it('historical status and exact admission replay survive revocation and descriptor expiry', async () => {
  const f = await ready(); f.fetch.mockRejectedValue(new Error('lost discovery')); await f.execute();
  await f.auth.revokePairing(f.pair.pairingId);
  const expired = { ...JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY), expiresAt: '2020-01-01T00:00:00.000Z' };
  f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = JSON.stringify(expired);
  expect(await f.native(f.admission)).toMatchObject({ state: 'applied', receipt: f.receipt });
  expect(await f.native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) })).toMatchObject({ admissionState: 'applied', authorityState: 'held', outcome: { state: 'uncertain' } });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('historical receipt stays visible but not authoritative when head is absent', async () => {
  const f = await ready();
  const dynamo = { send: (command: DynamoCommand) => command instanceof GetItemCommand && command.input.Key?.sk?.S === researchCycleHeadKey ? Promise.resolve({ $metadata: {} }) : f.boundaries.dynamo.send(command) };
  const native = createProductionHandler(f.environment, { ...f.boundaries, dynamo });
  expect(await native(f.admission)).toMatchObject({ state: 'applied', receipt: f.receipt });
  // A condition-only transaction must also see that absence, so use a read-only outage fixture below rather than f.db's real head.
  await expect(native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) })).rejects.toThrow('research_cycle_unavailable');
  expect(f.fetch).not.toHaveBeenCalled();
});
it('status reads are coherent condition-only snapshots, outages and changed absence are unavailable', async () => {
  const f = await ready(); const before = f.db.transactions.length;
  await f.cycleStatus();
  expect(f.db.transactions.slice(before).every(tx => tx.TransactItems?.every(item => item.ConditionCheck))).toBe(true);
  f.hook(async command => { if (command instanceof GetItemCommand && command.input.Key?.sk?.S === `DISCOVERY#${f.receipt.runId}`) throw Error('outage'); });
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable'); f.hook();
  let changed = false;
  f.hook(async command => {
    if (!changed && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.every(item => item.ConditionCheck)) {
      changed = true; f.hook(); await change(f, 'BUDGET#research', data => data, { limit: 100, spent: 0 });
    }
  });
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable'); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['runId', 'executeBefore', 'proposedResearchLimitMicros', 'schedule', 'model'])('rejects caller-supplied %s before effects', async field => {
  const f = await cycleFixture(); const request = await proposal(f); const before = f.commands.length;
  await expect(f.native({ ...request, [field]: 'forbidden' })).rejects.toThrow('research_cycle_invalid_request');
  expect(f.commands).toHaveLength(before);
});
it('lost admission acknowledgement returns the same receipt without another ceiling change', async () => {
  const f = await cycleFixture(); const request = await proposal(f); let lost = false;
  f.hook(async command => { if (!lost && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === researchCycleKey(1))) {
    lost = true; await f.db.send(command); throw Error('lost ack');
  } });
  const result = await f.native(request); f.hook(); expect(result.state).toBe('applied'); expect(await f.native(request)).toEqual(result);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 240, spent: 160 });
});
it('late admission commit after a status miss reconciles only its original slot', async () => {
  const f = await cycleFixture(); const request = await proposal(f); let sent: DynamoCommand | undefined; let finish!: () => void;
  f.hook(async command => { if (command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === researchCycleKey(1))) {
    sent = command; await new Promise<void>(resolve => { finish = resolve; });
  } });
  await expect(f.native(request, { getRemainingTimeInMillis: () => 5025 })).rejects.toThrow('research_cycle_unavailable'); f.hook();
  expect(await f.cycleStatus()).toMatchObject({ admissionState: 'not-observed' });
  await f.db.send(sent!); finish(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(await f.native(request)).toMatchObject({ state: 'applied', receipt: { ordinal: 1 } });
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 240, spent: 160 }); expect(f.fetch).not.toHaveBeenCalled();
});
it('late credential response after native deadline cannot start discovery', async () => {
  const f = await ready(); let finish!: (value: Awaited<ReturnType<typeof f.ssm.send>>) => void;
  f.ssm.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await expect(f.execute({ getRemainingTimeInMillis: () => 5025 })).rejects.toThrow('research_cycle_unavailable');
  const before = f.db.transactions.length; finish({ $metadata: {}, Parameter: { Type: 'SecureString', Value: '{"apiKey":"fictional","model":"fixture"}' } });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});

it('descriptor replacement cannot revive a receipt even if current marker matches that replacement', async () => {
  const f = await ready(); const descriptor = { ...JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY), provenance: 'Another reviewed descriptor' };
  f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = JSON.stringify(descriptor);
  await change(f, 'GUIDED_RESEARCH_SETUP', data => ({ ...data, descriptorFingerprint: fingerprint(descriptor) }));
  expect(await f.execute()).toMatchObject({ authorityState: 'held', outcome: null });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
});

it.each(['source', 'marker', 'fence', 'pairing', 'discovery', 'page', 'original', 'successor', 'v1receipt'])('admission CAS rejects concurrent %s change without allowance', async target => {
  const f = await cycleFixture(); const request = await proposal(f);
  const keys = { source: 'OWNER_RESEARCH_SOURCE', marker: 'GUIDED_RESEARCH_SETUP', fence: 'RESEARCH_ADMISSION_FENCE', pairing: `PAIRING#${f.pair.pairingId}`,
    discovery: 'BUDGET#discovery#guided-research-v1', page: 'BUDGET#research', original: `DISCOVERY#${f.original.runId}`, successor: `DISCOVERY#${f.successor.runId}`, v1receipt: `RESEARCH_ONCE_NEXT#${f.original.runId}` };
  let raced = false;
  f.hook(async command => { if (!raced && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === researchCycleKey(1))) {
    raced = true; f.hook(); const key = keys[target as keyof typeof keys];
    expect(command.input.TransactItems.some(item => (item.Put?.Item ?? item.ConditionCheck?.Key)?.sk?.S === key)).toBe(true);
    await change(f, key, data => data, target === 'discovery' ? { limit: 160, spent: 160 } : target === 'page' ? { limit: 100, spent: 0 } : {});
  } });
  await expect(f.native(request)).rejects.toThrow('research_cycle_unavailable'); expect(raced).toBe(true);
  expect(f.db.inspect(researchCycleKey(1))).toBeUndefined(); expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 160 });
});
it.each(['head', 'receipt', 'reservation'])('later admission CAS rejects immediate predecessor %s changes', async target => {
  const f = await ready(); f.fetch.mockRejectedValue(new Error('lost')); await f.execute(); await transition(f, 'paused');
  const request = await proposal(f); const key = target === 'head' ? researchCycleHeadKey : target === 'receipt' ? researchCycleKey(1) : `DISCOVERY#${f.receipt.runId}`;
  let raced = false;
  f.hook(async command => { if (!raced && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === researchCycleKey(2))) {
    raced = true; f.hook(); await change(f, key, data => data);
  } });
  await expect(f.native(request)).rejects.toThrow('research_cycle_unavailable'); expect(raced).toBe(true);
  expect(f.db.inspect(researchCycleKey(2))).toBeUndefined(); expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 240, spent: 240 });
});
it.each(['discovery', 'page'])('rejects %s scalar/data mismatch even with zero discovery delta', async ledger => {
  const f = await ready(); await transition(f, 'paused');
  const key = ledger === 'discovery' ? 'BUDGET#discovery#guided-research-v1' : 'BUDGET#research';
  await change(f, key, data => data, ledger === 'discovery' ? { limit: 241, spent: 160 } : { limit: 101, spent: 0 });
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable');
});
it('stale predecessor observation and page-capacity shortfall hold without budget amendments', async () => {
  const f = await cycleFixture(); const request = await proposal(f);
  await change(f, `DISCOVERY#${f.successor.runId}`, data => ({ ...data, completed: true, candidates: [] }));
  expect(await f.native(request)).toMatchObject({ state: 'held' });
  await change(f, 'BUDGET#research', data => ({ ...data, spent: 1 }), { limit: 100, spent: 1 });
  expect(await f.native(await proposal(f))).toMatchObject({ state: 'held' });
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 160 });
});
it('nonempty parked page still blocks new admission', async () => {
  const f = await ready(); f.pageHttp.mockRejectedValue(new Error('lost page'));
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain', settled: true } });
  await transition(f, 'paused'); expect((await f.cycleStatus()).blockers).toContain('predecessor_ineligible');
  expect(await f.native(await proposal(f))).toMatchObject({ state: 'held' }); expect(f.pageHttp).toHaveBeenCalledTimes(1);
});
it('legacy bootstrap supports absent fixed successor and absent successor reservation with exact fences', async () => {
  for (const includeReceipt of [false, true]) {
    const f = await nextFixture();
    if (includeReceipt) { await f.invokeNext(); await f.resume(); await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
      input: { expectedRevision: 3, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`); }
    const identity = { version: 2 as const, workspaceId: 'ws', pairingId: f.pair.pairingId }; const native = createProductionHandler(f.environment, f.boundaries);
    const status = await native({ ...identity, kind: 'research.cycle.status' });
    const result = await native({ ...identity, kind: 'research.cycle.admit', expectedSourceRevision: status.source!.revision, researchFingerprint: status.source!.researchFingerprint!,
      descriptorFingerprint: status.descriptorFingerprint!, predecessor: status.predecessor!, observationFingerprint: status.observationFingerprint!, expectedDiscoveryBudget: status.discoveryBudget!,
      expectedResearchBudget: status.researchBudget!, proposedDiscoveryLimitMicros: 160, disclosureAcknowledged: true });
    expect(result).toMatchObject({ state: 'applied', receipt: { deltaMicros: includeReceipt ? 0 : 80 } });
    expect(result.receipt!.observations.some(item => item.revision === null)).toBe(true); expect(f.fetch).not.toHaveBeenCalled();
  }
});
it('real original reservation is required for bootstrap', async () => {
  const f = await admitted(); await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const native = createProductionHandler(f.environment, f.boundaries); const identity = { version: 2 as const, workspaceId: 'ws', pairingId: f.pair.pairingId };
  const status = await native({ ...identity, kind: 'research.cycle.status' }); expect(status.blockers).toContain('predecessor_ineligible');
  expect(await native({ ...identity, kind: 'research.cycle.admit', expectedSourceRevision: 2, researchFingerprint: status.source!.researchFingerprint!, descriptorFingerprint: status.descriptorFingerprint!,
    predecessor: status.predecessor!, observationFingerprint: status.observationFingerprint!, expectedDiscoveryBudget: status.discoveryBudget!, expectedResearchBudget: status.researchBudget!,
    proposedDiscoveryLimitMicros: 80, disclosureAcknowledged: true })).toMatchObject({ state: 'held' }); expect(f.fetch).not.toHaveBeenCalled();
});
it('no new fifteen-minute expiry prevents an otherwise current admitted run', async () => {
  const f = await ready(); const now = Date.now();
  vi.useFakeTimers(); vi.setSystemTime(now + 16 * 60000);
  try { expect(await f.execute()).toMatchObject({ outcome: { state: 'completed', settled: true } }); }
  finally { vi.useRealTimers(); }
});
it.each(['head', 'receipt', 'source', 'pairing'])('current %s authority changes after reservation fence provider start', async target => {
  const f = await ready(); const load = f.ssm.send.getMockImplementation()!;
  f.ssm.send.mockImplementation(async () => {
    if (target === 'pairing') await f.auth.revokePairing(f.pair.pairingId);
    else if (target === 'source') await transition(f, 'paused');
    else await change(f, target === 'head' ? researchCycleHeadKey : researchCycleKey(1), data => data);
    return load();
  });
  await f.execute().catch(error => expect(error.message).toBe('research_cycle_unavailable'));
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled(); expect(f.ssm.send).toHaveBeenCalledTimes(1);
});
it('lost reservation acknowledgement never permits a discovery restart', async () => {
  const f = await ready(); let lost = false;
  f.hook(async command => { if (!lost && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === `DISCOVERY#${f.receipt.runId}`)) {
    lost = true; await f.db.send(command); throw Error('lost reservation ack');
  } });
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } }); f.hook();
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } }); expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
});
it('late provider response cannot complete discovery or create page work after deadline', async () => {
  const f = await ready(); let finish!: (value: Response) => void;
  f.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await expect(f.execute({ getRemainingTimeInMillis: () => 5025 })).rejects.toThrow('research_cycle_unavailable');
  const before = f.db.transactions.length; finish(await f.successfulFetch('https://fictional.invalid/')); await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.db.transactions).toHaveLength(before); expect(f.pageHttp).not.toHaveBeenCalled();
  expect(await f.execute()).toMatchObject({ outcome: { state: 'uncertain' } }); expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('exact historical status separates missing-head corruption from its immutable receipt', async () => {
  const f = await ready(); const db = new ConditionalCommandHarness();
  for (const tx of f.db.transactions) {
    const items = tx.TransactItems!.filter(item => (item.Put?.Item ?? item.ConditionCheck?.Key)?.sk?.S !== researchCycleHeadKey);
    if (items.length) await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
  }
  const native = createProductionHandler(f.environment, { ...f.boundaries, dynamo: db });
  expect(await native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) })).toMatchObject({ admissionState: 'applied', receipt: f.receipt, authorityState: 'held', blockers: ['head_corrupt'] });
  expect(await native(f.admission)).toMatchObject({ state: 'applied', receipt: f.receipt });
  await expect(native({ ...f.identity, kind: 'research.cycle.status' })).rejects.toThrow('research_cycle_unavailable');
});
it.each(['parentRevision', 'parentFingerprint'])('rejects fixed v1 receipt %s inconsistent with actual original reservation', async field => {
  const f = await cycleFixture(); const request = await proposal(f);
  const native = createProductionHandler(f.environment, { ...f.boundaries, dynamo: { send: async command => {
    const result = await f.boundaries.dynamo.send(command);
    if (command instanceof GetItemCommand && command.input.Key?.sk?.S === `RESEARCH_ONCE_NEXT#${f.original.runId}` && result.Item) {
      const data = JSON.parse(result.Item.data!.S!); data[field] = field === 'parentRevision' ? data.parentRevision + 1 : 'a'.repeat(64);
      return { ...result, Item: { ...result.Item, data: { S: JSON.stringify(data) } } };
    }
    return result;
  } } });
  await expect((async () => {
    const status = await native({ ...f.identity, kind: 'research.cycle.status' });
    return native({ ...request, observationFingerprint: status.observationFingerprint! });
  })()).rejects.toThrow('research_cycle_unavailable');
  expect(f.db.inspect(researchCycleKey(1))).toBeUndefined();
});

it('genuine completed nonempty original without successor blocks first adoption', async () => {
  const f = await admitted(); expect(await f.invoke()).toMatchObject({ state: 'completed' });
  await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const status = await createProductionHandler(f.environment, f.boundaries)({ version: 2, kind: 'research.cycle.status', workspaceId: 'ws', pairingId: f.pair.pairingId });
  expect(status.blockers).toContain('predecessor_ineligible'); expect(f.db.inspect(researchCycleHeadKey)).toBeUndefined();
});
it('native HTTP body never promotes v2 execution and disabled gates refuse before effects', async () => {
  const f = await cycleFixture(); const request = await proposal(f); const before = f.commands.length;
  expect(await f.native({ body: JSON.stringify(request) })).toMatchObject({ statusCode: 400 });
  expect(f.commands).toHaveLength(before);
  for (const key of ['DELEGATED_WORKER_ENABLED', 'DELEGATED_WORKER_RESEARCH_ONCE_ENABLED']) {
    await expect(createProductionHandler({ ...f.environment, [key]: 'false' }, f.boundaries)(request)).rejects.toThrow('research_cycle_unavailable');
  }
  expect(f.commands).toHaveLength(before);
});
it.each(['source', 'ordinal', 'combined', 'proposed'])('safe integer %s overflow cannot admit', async defect => {
  const f = await cycleFixture(); const request = await proposal(f);
  if (defect === 'source') await expect(f.native({ ...request, expectedSourceRevision: Number.MAX_SAFE_INTEGER })).rejects.toThrow('research_cycle_invalid_request');
  if (defect === 'ordinal') await expect(f.native({ ...request, predecessor: { kind: 'cycle', ordinal: Number.MAX_SAFE_INTEGER, admissionFingerprint: 'a'.repeat(64) } })).rejects.toThrow('research_cycle_unavailable');
  if (defect === 'proposed') await expect(f.native({ ...request, proposedDiscoveryLimitMicros: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow('research_cycle_invalid_request');
  if (defect === 'combined') {
    const limit = Number.MAX_SAFE_INTEGER - 100;
    await change(f, 'BUDGET#discovery#guided-research-v1', data => ({ ...data, limit, spent: limit }), { limit, spent: limit });
    const status = await f.cycleStatus();
    await expect(f.native({ ...request, expectedDiscoveryBudget: status.discoveryBudget!, proposedDiscoveryLimitMicros: limit + 80 })).rejects.toThrow('research_cycle_unavailable');
  }
  expect(f.db.inspect(researchCycleKey(1))).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
});
it('real competing v1 and v2 bootstrap admissions serialize on fixed slot/ledger observations', async () => {
  const f = await nextFixture(); const native = createProductionHandler(f.environment, f.boundaries);
  const identity = { version: 2 as const, workspaceId: 'ws', pairingId: f.pair.pairingId };
  const status = await native({ ...identity, kind: 'research.cycle.status' });
  const request: ResearchCycleAdmission = { ...identity, kind: 'research.cycle.admit', expectedSourceRevision: 2,
    researchFingerprint: status.source!.researchFingerprint!, descriptorFingerprint: status.descriptorFingerprint!, predecessor: status.predecessor!,
    observationFingerprint: status.observationFingerprint!, expectedDiscoveryBudget: status.discoveryBudget!, expectedResearchBudget: status.researchBudget!,
    proposedDiscoveryLimitMicros: 160, disclosureAcknowledged: true };
  const results = await Promise.allSettled([f.invokeNext(), native(request)]);
  expect(results.filter(result => result.status === 'fulfilled' && result.value.state === 'applied')).toHaveLength(1);
  expect([f.db.inspect(`RESEARCH_ONCE_NEXT#${f.original.runId}`), f.db.inspect(researchCycleKey(1))].filter(Boolean)).toHaveLength(1);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 80 });
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['reservation-absence', 'job-absence', 'run', 'job', 'evidence'])('coherent status fences changed %s observation', async target => {
  const f = await ready();
  if (target === 'job-absence') {
    f.hook(async command => { if (command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('ACCOUNT#'))) throw Error('stop create'); });
    await expect(f.execute()).rejects.toThrow('research_cycle_unavailable'); f.hook();
  } else if (target !== 'reservation-absence') await f.execute();
  const prior = await f.cycleStatus(); let raced = false;
  f.hook(async command => { if (!raced && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.every(item => item.ConditionCheck)) {
    raced = true; f.hook();
    if (target.endsWith('absence')) await f.execute();
    else await change(f, target === 'run' ? `DISCOVERY#${f.receipt.runId}` : target === 'job' ? `JOB#${prior.outcome!.jobId}` : `ACCOUNT_COMMAND#${prior.outcome!.evidenceReceiptId}`, data => data);
  } });
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable'); expect(raced).toBe(true);
});
it('exact later receipt proves missing head even when first slot is also missing', async () => {
  const f = await ready(); await transition(f, 'paused'); const second = (await f.native(await proposal(f))).receipt!; await transition(f, 'active');
  const db = new ConditionalCommandHarness();
  for (const tx of f.db.transactions) {
    const items = tx.TransactItems!.filter(item => ![researchCycleHeadKey, researchCycleKey(1)].includes((item.Put?.Item ?? item.ConditionCheck?.Key)?.sk?.S ?? ''));
    if (items.length) await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
  }
  const native = createProductionHandler(f.environment, { ...f.boundaries, dynamo: db });
  expect(await native({ ...f.identity, kind: 'research.cycle.status', reference: ref(second) })).toMatchObject({ admissionState: 'applied', receipt: second, authorityState: 'held', blockers: ['head_corrupt'] });
});
it('superseded historical reservation costs are validated, not reported as empty', async () => {
  const f = await ready(); f.fetch.mockRejectedValue(new Error('lost')); await f.execute(); await transition(f, 'paused'); await f.native(await proposal(f));
  await change(f, `DISCOVERY#${f.receipt.runId}`, data => ({ ...data, completed: true, candidates: [], costMicros: 81 }));
  await expect(f.native({ ...f.identity, kind: 'research.cycle.status', reference: ref(f.receipt) })).rejects.toThrow('research_cycle_unavailable');
});

it('spent plus descriptor discovery reservation overflow fails before admission', async () => {
  const f = await cycleFixture(80); const request = await proposal(f); const limit = Number.MAX_SAFE_INTEGER - 100;
  await change(f, 'BUDGET#discovery#guided-research-v1', data => ({ ...data, limit, spent: limit }), { limit, spent: limit });
  const status = await f.cycleStatus();
  await expect(f.native({ ...request, expectedDiscoveryBudget: status.discoveryBudget!, proposedDiscoveryLimitMicros: Number.MAX_SAFE_INTEGER })).rejects.toThrow('research_cycle_unavailable');
  expect(f.db.inspect(researchCycleKey(1))).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
});
it.each([{ state: 'completed', receiptCommitted: false }, { state: 'parked', receiptCommitted: true }])('rejects impossible exact page job state %j', async defect => {
  const f = await ready(); const result = await f.execute();
  await change(f, `JOB#${result.outcome!.jobId}`, data => ({ ...data, ...defect }));
  await expect(f.cycleStatus()).rejects.toThrow('research_cycle_unavailable');
});
