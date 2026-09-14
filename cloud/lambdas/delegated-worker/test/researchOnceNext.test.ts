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
async function admitted(maxCompanies = 1) {
  const now = new Date().toISOString();
  const descriptor = { capability: { model: 'fixture', webSearch: true, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), provenance: 'Fictional review only.', researchReservationMicros: 100, currency: 'USD' };
  const db = new ConditionalCommandHarness(); const commands: DynamoCommand[] = [];
  let hook: ((command: DynamoCommand) => Promise<void>) | undefined;
  const dynamo = { send: async (command: DynamoCommand) => { commands.push(command); await hook?.(command); return db.send(command); } };
  const auth = new WorkerAuth({ dynamo, workspaceId: 'ws', tableName: 'table', clock: { now: () => now } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fixture');
  const setup = new ResearchSetupService({ auth, profile: { reviewedCapability: descriptor, credentialParameterDeclared: true } });
  await setup.apply({ version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId, input: {
    expectedRevision: 0, descriptorFingerprint: fingerprint(descriptor), audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, permittedSources: ['https://fictional.example/'], maxCompanies, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 80, researchCeilingMicros: 100, disclosureAcknowledged: true,
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

async function nextFixture() {
  const f = await admitted(); const originalFetch = f.fetch.getMockImplementation()!;
  f.fetch.mockRejectedValue(new Error('fixture lost original response'));
  const original = await f.invoke(); expect(original.state).toBe('uncertain');
  f.fetch.mockImplementation(originalFetch); f.fetch.mockClear(); f.ssm.send.mockClear();
  await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const admission: Extract<ResearchOnceNextRequest, { kind: 'research.once.admit-next' }> = {
    version: 1, kind: 'research.once.admit-next', workspaceId: 'ws', pairingId: f.pair.pairingId,
    parentRunId: original.runId!, parentSourceRevision: 1, researchFingerprint: f.request.researchFingerprint,
    expectedSourceRevision: 2, descriptorFingerprint: fingerprint(JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY)),
    expectedDiscoveryBudget: f.db.inspect('BUDGET#discovery#guided-research-v1') as { limit: number; spent: number; approvedAt: string },
    expectedResearchBudget: f.db.inspect('BUDGET#research') as { limit: number; spent: number; approvedAt: string }, proposedDiscoveryLimitMicros: 160,
  };
  const invokeNext = (value: ResearchOnceNextRequest = admission) => createProductionHandler(f.environment, f.boundaries)(value);
  const nextStatus = () => invokeNext({ version: 1, kind: 'research.once.admit-next.status', workspaceId: 'ws', pairingId: f.pair.pairingId,
    parentRunId: original.runId!, parentSourceRevision: 1, researchFingerprint: f.request.researchFingerprint, admissionFingerprint: fingerprint(admission) });
  const resume = () => f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    input: { expectedRevision: 2, state: 'active', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  f.commands.length = 0;
  return { ...f, original, admission, invokeNext, nextStatus, resume };
}
describe('private one original successor admission', () => {
  it('increases only the cumulative discovery limit once and preserves original rows without provider IO', async () => {
    const f = await nextFixture();
    const keys = [`DISCOVERY#${f.original.runId}`, 'OWNER_RESEARCH_SOURCE', 'GUIDED_RESEARCH_SETUP', 'RESEARCH_ADMISSION_FENCE', 'BUDGET#research'];
    const before = keys.map(key => f.db.inspect(key)); const transactions = f.db.transactions.length;
    const result = await f.invokeNext();
    expect(result).toMatchObject({ kind: 'research.once.admit-next.result', state: 'applied', receipt: { expectedExecutionRevision: 3, deltaMicros: 80 } });
    expect(keys.map(key => f.db.inspect(key))).toEqual(before);
    expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toEqual({ ...f.admission.expectedDiscoveryBudget, limit: 160, spent: 80 });
    expect(f.db.transactions.length - transactions).toBe(1);
    expect(await f.invokeNext()).toEqual(result); expect(await f.nextStatus()).toEqual(result);
    expect(f.db.transactions.length - transactions).toBe(1);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled();
    expect(f.commands.some(command => command instanceof QueryCommand)).toBe(false);
  });
  it('reports a status miss as not observed without writes', async () => {
    const f = await nextFixture(); const before = f.db.transactions.length;
    expect(await f.nextStatus()).toEqual({ version: 1, kind: 'research.once.admit-next.result', state: 'not-observed', receipt: null });
    expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('concurrent identical admission converges to one immutable receipt and increment', async () => {
    const f = await nextFixture(); const results = await Promise.all([f.invokeNext(), f.invokeNext()]);
    expect(results[0]).toEqual(results[1]); expect(results[0].state).toBe('applied');
    expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 80 });
  });
});
async function executionFixture() {
  const f = await nextFixture(); const admissionResult = await f.invokeNext();
  expect(admissionResult.state).toBe('applied'); const receipt = admissionResult.receipt!;
  const execution: ResearchOnceRequest = { ...f.request, kind: 'research.once', expectedSourceRevision: 3,
    successor: { parentRunId: f.original.runId!, admissionFingerprint: receipt.fingerprint } };
  const execute = () => f.invoke(execution);
  const successorStatus = () => f.invoke({ ...f.request, kind: 'research.once.status', expectedSourceRevision: 3, runId: receipt.successorRunId });
  return { ...f, admissionResult, receipt, execution, execute, successorStatus };
}
it('requires supported Resume then completes only the derived successor with fully reserved budgets', async () => {
  const f = await executionFixture(); const originalRow = f.db.inspect(`DISCOVERY#${f.original.runId}`);
  expect(await f.execute()).toMatchObject({ state: 'held' }); expect(f.fetch).not.toHaveBeenCalled();
  await f.resume();
  const result = await f.execute();
  expect(result).toMatchObject({ state: 'completed', runId: f.receipt.successorRunId, settled: true, evidenceReceiptId: expect.any(String) });
  expect(await f.execute()).toEqual(result); expect(await f.successorStatus()).toEqual(result);
  expect(await f.status(f.original)).toEqual(f.original);
  expect(f.db.inspect(`DISCOVERY#${f.original.runId}`)).toEqual(originalRow);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 160 });
  expect(f.db.inspect('BUDGET#research')).toMatchObject({ limit: 100, spent: 100 });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
  expect(await f.invokeNext()).toEqual(f.admissionResult);
  const before = f.db.transactions.length;
  expect(await f.invoke()).toMatchObject({ state: 'held' });
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('settles a successor after evidence-before-settlement crash with exhausted budgets and no provider restart', async () => {
  const f = await executionFixture(); await f.resume(); let failed = false;
  f.hook(async command => {
    if (!(command instanceof TransactWriteItemsCommand) || failed) return;
    if (command.input.TransactItems?.some(item => { const data = JSON.parse(item.Put?.Item?.data?.S ?? '{}'); return item.Put?.Item?.sk?.S?.startsWith('JOB#') && data.state === 'completed'; })) {
      failed = true; throw new Error('fixture failure before settlement');
    }
  });
  await expect(f.execute()).rejects.toThrow('research_once_unavailable'); expect(failed).toBe(true); f.hook();
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ spent: 160 });
  expect(f.db.inspect('BUDGET#research')).toMatchObject({ spent: 100 });
  expect(await f.execute()).toMatchObject({ state: 'completed', settled: true });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
});
it('retains both uncertain reservations with no third provider attempt or successor chain', async () => {
  const f = await executionFixture(); await f.resume(); f.fetch.mockRejectedValue(new Error('fixture successor lost response'));
  const result = await f.execute(); expect(result).toMatchObject({ state: 'uncertain', runId: f.receipt.successorRunId });
  expect(await f.execute()).toEqual(result); expect(await f.successorStatus()).toEqual(result);
  expect(await f.status(f.original)).toEqual(f.original); expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 160 });
  expect(f.db.inspect('BUDGET#research')).toMatchObject({ spent: 0 });
  expect(await f.invokeNext({ ...f.admission, parentRunId: f.receipt.successorRunId })).toMatchObject({ state: 'held' });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each(['discovery', 'page', 'source', 'parent', 'marker', 'fence', 'pairing'])('atomic admission loses the actual %s CAS race without an increment', async target => {
  const f = await nextFixture(); let raced = false;
  const key = target === 'discovery' ? 'BUDGET#discovery#guided-research-v1' : target === 'page' ? 'BUDGET#research' : target === 'source' ? 'OWNER_RESEARCH_SOURCE' : target === 'parent' ? `DISCOVERY#${f.original.runId}` : target === 'marker' ? 'GUIDED_RESEARCH_SETUP' : 'RESEARCH_ADMISSION_FENCE';
  f.hook(async command => {
    if (raced || !(command instanceof TransactWriteItemsCommand) || !command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S?.startsWith('RESEARCH_ONCE_NEXT#'))) return;
    raced = true;
    if (target === 'pairing') { await f.auth.revokePairing(f.pair.pairingId); return; }
    const row = (await f.auth.store.get<Record<string, unknown>>(key))!;
    const data = target === 'source' ? { ...row.data, state: 'active', revision: 3 } : target === 'parent' ? { ...row.data, completed: true, candidates: [] } : row.data;
    const scalars: Record<string, number> = target === 'discovery' || target === 'page' ? { limit: Number(data.limit), spent: Number(data.spent) } : {};
    await f.auth.store.transact([f.auth.store.put(key, data, row.rev, scalars)]);
  });
  await expect(f.invokeNext()).rejects.toThrow('research_once_unavailable'); expect(raced).toBe(true); f.hook();
  expect((await f.nextStatus()).state).toBe('not-observed');
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 80, spent: 80 });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
});
it.each(['before', 'after'])('reconciles %s-commit admission acknowledgement loss without double increment', async phase => {
  const f = await nextFixture(); let failed = false;
  f.hook(async command => {
    if (failed || !(command instanceof TransactWriteItemsCommand) || !command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S?.startsWith('RESEARCH_ONCE_NEXT#'))) return;
    failed = true;
    if (phase === 'before') throw new Error('fixture acknowledgement lost before commit');
    f.db.afterCommit = () => { f.db.afterCommit = undefined; throw new Error('fixture acknowledgement lost after commit'); };
  });
  if (phase === 'before') await expect(f.invokeNext()).rejects.toThrow('research_once_unavailable');
  else expect((await f.invokeNext()).state).toBe('applied');
  f.hook(); expect(failed).toBe(true);
  expect((await f.nextStatus()).state).toBe(phase === 'before' ? 'not-observed' : 'applied');
  const result = await f.invokeNext(); expect(result.state).toBe('applied'); expect(await f.invokeNext()).toEqual(result);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 80 });
});
it('a missed status read cannot cancel a late remote commit racing an exact retry', async () => {
  const f = await nextFixture(); const raw = f.boundaries.dynamo.send;
  let captured!: TransactWriteItemsCommand; let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let capture = true;
  f.boundaries.dynamo.send = async command => {
    if (capture && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S?.startsWith('RESEARCH_ONCE_NEXT#'))) {
      capture = false; captured = command; entered(); return new Promise(() => {});
    }
    return raw(command);
  };
  const pending = createProductionHandler(f.environment, f.boundaries)(f.admission, { getRemainingTimeInMillis: () => 5030 }).catch(error => error);
  await waiting;
  expect((await f.nextStatus()).state).toBe('not-observed');
  expect(await pending).toMatchObject({ message: 'research_once_unavailable' });
  const replay = f.invokeNext();
  const late = f.db.send(captured).catch(() => undefined);
  await late;
  const result = await replay; expect(result.state).toBe('applied'); expect(await f.nextStatus()).toEqual(result);
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 80 });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
});
it.each(['revoke', 'expiry', 'pause'])('historical receipt/status reads survive %s while new execution does not', async defect => {
  const f = await executionFixture();
  if (defect === 'revoke') await f.auth.revokePairing(f.pair.pairingId);
  if (defect === 'expiry') { const descriptor = JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY); descriptor.expiresAt = new Date(Date.now() - 1).toISOString(); f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = JSON.stringify(descriptor); }
  const before = f.db.transactions.length;
  expect(await f.nextStatus()).toEqual(f.admissionResult); expect(await f.invokeNext()).toEqual(f.admissionResult);
  expect(await f.status(f.original)).toEqual(f.original);
  expect(await f.execute()).toMatchObject({ state: 'held' });
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['smaller', 'larger', 'spent', 'approvedAt', 'page-spent', 'parent', 'descriptor', 'pairing', 'settings'])('denies unbound %s admission without writes', async defect => {
  const f = await nextFixture(); const request = structuredClone(f.admission);
  if (defect === 'smaller') request.proposedDiscoveryLimitMicros--;
  if (defect === 'larger') request.proposedDiscoveryLimitMicros++;
  if (defect === 'spent') request.expectedDiscoveryBudget.spent--;
  if (defect === 'approvedAt') request.expectedDiscoveryBudget.approvedAt = new Date(0).toISOString();
  if (defect === 'page-spent') request.expectedResearchBudget.spent++;
  if (defect === 'parent') request.parentRunId = randomUUID();
  if (defect === 'descriptor') request.descriptorFingerprint = 'a'.repeat(64);
  if (defect === 'pairing') request.pairingId = randomUUID();
  if (defect === 'settings') request.researchFingerprint = 'a'.repeat(64);
  const before = f.db.transactions.length;
  expect(await f.invokeNext(request)).toMatchObject({ state: 'held' });
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it.each([{ successorRunId: 'bad' }, { expectedSourceRevision: 3 }, { parentSourceRevision: 3 }, { proposedDiscoveryLimitMicros: Number.MAX_SAFE_INTEGER + 1 }, { extra: 'x'.repeat(5000) }])('rejects invalid private request before IO %j', async change => {
  const f = await nextFixture(); f.commands.length = 0;
  await expect(f.invokeNext({ ...f.admission, ...change } as ResearchOnceNextRequest)).rejects.toThrow('research_once_invalid_request');
  expect(f.commands).toHaveLength(0);
});
it.each(['schedule', 'worker-disabled', 'once-disabled'])('gates %s mutation before any IO', async defect => {
  const f = await nextFixture(); f.commands.length = 0;
  if (defect === 'schedule') f.environment.DELEGATED_WORKER_SCHEDULE_ARN = 'configured';
  if (defect === 'worker-disabled') f.environment.DELEGATED_WORKER_ENABLED = '';
  if (defect === 'once-disabled') f.environment.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED = '';
  expect(await f.invokeNext()).toMatchObject({ state: 'held', receipt: null });
  expect(f.commands).toHaveLength(0);
});
it('cannot silently rebind a successor after another pause/resume cycle', async () => {
  const f = await executionFixture(); await f.resume();
  for (const [revision, state] of [[3, 'paused'], [4, 'active']] as const) await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: revision, state, disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const before = f.db.transactions.length;
  expect(await f.execute()).toMatchObject({ state: 'held' });
  expect(await f.invoke({ ...f.execution, expectedSourceRevision: 5 })).toMatchObject({ state: 'held' });
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it('conflicting payload cannot claim an existing fixed slot or change the allowance', async () => {
  const f = await nextFixture(); const result = await f.invokeNext(); const before = f.db.transactions.length;
  await expect(f.invokeNext({ ...f.admission, proposedDiscoveryLimitMicros: 161 })).rejects.toThrow('research_once_unavailable');
  expect(await f.nextStatus()).toEqual(result); expect(f.db.transactions).toHaveLength(before);
});
it('concurrent unequal submissions cannot create two allowances', async () => {
  const f = await nextFixture(); const results = await Promise.allSettled([f.invokeNext(), f.invokeNext({ ...f.admission, proposedDiscoveryLimitMicros: 161 })]);
  expect(results.filter(r => r.status === 'fulfilled' && r.value.state === 'applied')).toHaveLength(1);
  expect((await f.nextStatus()).state).toBe('applied'); expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 160, spent: 80 });
});
it.each(['discovery', 'page'])('rejects inconsistent %s top-level scalar/data ledger images atomically', async target => {
  const f = await nextFixture(); const key = target === 'discovery' ? 'BUDGET#discovery#guided-research-v1' : 'BUDGET#research';
  const row = (await f.auth.store.get<{ limit: number; spent: number; approvedAt: string }>(key))!;
  await f.auth.store.transact([f.auth.store.put(key, row.data, row.rev, { limit: row.data.limit + 1, spent: row.data.spent })]);
  await expect(f.invokeNext()).rejects.toThrow('research_once_unavailable');
  expect((await f.nextStatus()).state).toBe('not-observed'); expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ limit: 80, spent: 80 });
});
it('retains matching top-level budget scalar/data fields and exactly eight distinct admission targets', async () => {
  const f = await nextFixture(); await f.invokeNext();
  const writes = f.db.transactions.at(-1)!.TransactItems!;
  expect(writes).toHaveLength(8);
  const keys = writes.map(i => (i.Put?.Item ?? i.ConditionCheck?.Key)?.sk?.S);
  expect(new Set(keys).size).toBe(8);
  expect(keys).toEqual(expect.arrayContaining([`DISCOVERY#${f.original.runId}`, `RESEARCH_ONCE_NEXT#${f.original.runId}`, 'OWNER_RESEARCH_SOURCE', 'GUIDED_RESEARCH_SETUP', 'RESEARCH_ADMISSION_FENCE', 'BUDGET#research', 'BUDGET#discovery#guided-research-v1']));
  const ledger = writes.find(i => i.Put?.Item?.sk?.S === 'BUDGET#discovery#guided-research-v1')!.Put!.Item!;
  expect(ledger.limit).toEqual({ N: '160' }); expect(ledger.spent).toEqual({ N: '80' });
  expect(JSON.parse(ledger.data!.S!)).toEqual({ ...f.admission.expectedDiscoveryBudget, limit: 160 });
  // Negative control: the harness must reject a duplicate physical target.
  await expect(f.db.send(new TransactWriteItemsCommand({ TransactItems: [f.auth.store.check('OWNER_RESEARCH_SOURCE', 2), f.auth.store.check('OWNER_RESEARCH_SOURCE', 2)] }))).rejects.toThrow('duplicate_transaction_target');
});
it.each(['status', 'replay'])('a failed strong %s read stays unavailable and never mutates', async kind => {
  const f = await nextFixture(); if (kind === 'replay') await f.invokeNext();
  const raw = f.boundaries.dynamo.send; const before = f.db.transactions.length;
  f.boundaries.dynamo.send = async command => { if (command instanceof GetItemCommand && command.input.Key?.sk?.S?.startsWith('RESEARCH_ONCE_NEXT#')) throw new Error('HOSTILE read cause'); return raw(command); };
  await expect(kind === 'status' ? f.nextStatus() : f.invokeNext()).rejects.toThrow('research_once_unavailable');
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['fingerprint', 'run', 'parent', 'delta'])('corrupt immutable receipt %s fails closed for status and execution', async defect => {
  const f = await executionFixture(); await f.resume();
  const key = `RESEARCH_ONCE_NEXT#${f.original.runId}`; const row = (await f.auth.store.get<Record<string, unknown>>(key))!;
  const data = { ...row.data, ...(defect === 'fingerprint' ? { fingerprint: 'a'.repeat(64) } : defect === 'run' ? { successorRunId: randomUUID() } : defect === 'parent' ? { parentFingerprint: 'b'.repeat(64) } : { deltaMicros: 81 }) };
  await f.auth.store.transact([f.auth.store.put(key, data, row.rev)]); const before = f.db.transactions.length;
  await expect(f.nextStatus()).rejects.toThrow('research_once_unavailable'); await expect(f.execute()).rejects.toThrow('research_once_unavailable');
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['parent-only', 'fingerprint-only', 'extra-run'])('strict execution selector rejects %s before IO', async defect => {
  const f = await executionFixture(); f.commands.length = 0;
  const successor = defect === 'parent-only' ? { parentRunId: f.original.runId } : defect === 'fingerprint-only' ? { admissionFingerprint: f.receipt.fingerprint } : { parentRunId: f.original.runId, admissionFingerprint: f.receipt.fingerprint, runId: f.receipt.successorRunId };
  await expect(f.invoke({ ...f.execution, successor } as ResearchOnceRequest)).rejects.toThrow('research_once_invalid_request');
  expect(f.commands).toHaveLength(0);
});
it.each(['parent', 'fingerprint', 'revision', 'settings'])('forged execution %s cannot reserve or start a provider', async defect => {
  const f = await executionFixture(); await f.resume();
  const request = { ...f.execution, successor: { parentRunId: f.original.runId!, admissionFingerprint: f.receipt.fingerprint } };
  if (defect === 'parent') request.successor.parentRunId = randomUUID();
  if (defect === 'fingerprint') request.successor.admissionFingerprint = 'a'.repeat(64);
  if (defect === 'revision') request.expectedSourceRevision = 5;
  if (defect === 'settings') request.researchFingerprint = 'a'.repeat(64);
  const before = f.db.transactions.length;
  const result = await f.invoke(request).catch(() => null); expect(result?.state ?? 'held').toBe('held');
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it('revoked active pairing cannot execute but can still inspect admission and original history', async () => {
  const f = await executionFixture(); await f.resume(); await f.auth.revokePairing(f.pair.pairingId);
  const before = f.db.transactions.length;
  expect(await f.execute()).toMatchObject({ state: 'held' }); expect(await f.nextStatus()).toEqual(f.admissionResult);
  expect(await f.invokeNext()).toEqual(f.admissionResult); expect(await f.status(f.original)).toEqual(f.original);
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
});
it.each(['receipt', 'parent'])('checks immutable %s again after credentials and before provider start', async target => {
  const f = await executionFixture(); await f.resume(); const load = f.ssm.send.getMockImplementation()!;
  f.ssm.send.mockImplementation(async () => {
    const key = target === 'receipt' ? `RESEARCH_ONCE_NEXT#${f.original.runId}` : `DISCOVERY#${f.original.runId}`;
    const row = (await f.auth.store.get<unknown>(key))!; await f.auth.store.transact([f.auth.store.put(key, row.data, row.rev)]);
    return load();
  });
  await expect(f.execute()).rejects.toThrow('research_once_unavailable');
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled();
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ spent: 160 });
});
it('concurrent successor executions converge on one exact provider and page job', async () => {
  const f = await executionFixture(); await f.resume(); await Promise.allSettled([f.execute(), f.execute()]);
  expect(await f.execute()).toMatchObject({ state: 'completed', runId: f.receipt.successorRunId });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
  expect(f.commands.some(command => command instanceof QueryCommand)).toBe(false);
});
it('empty successor is terminal and never silently creates another run', async () => {
  const f = await executionFixture(); await f.resume(); f.companies.length = 0;
  const result = await f.execute(); expect(result.state).toBe('empty'); expect(await f.execute()).toEqual(result);
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled(); expect(await f.status(f.original)).toEqual(f.original);
});
it('descriptor expiry during admission reads cannot release the transaction', async () => {
  const f = await nextFixture(); const raw = f.boundaries.dynamo.send; const expires = Date.parse(JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY).expiresAt);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    f.boundaries.dynamo.send = async command => { const result = await raw(command); if (command instanceof GetItemCommand && command.input.Key?.sk?.S === 'BUDGET#research') vi.setSystemTime(expires + 1); return result; };
    const before = f.db.transactions.length; expect(await f.invokeNext()).toMatchObject({ state: 'held' });
    expect(f.db.transactions).toHaveLength(before); expect((await f.nextStatus()).state).toBe('not-observed');
  } finally { vi.useRealTimers(); }
});
it('native admission inside an HTTP body is not dispatched or granted a route', async () => {
  const f = await nextFixture(); f.commands.length = 0;
  const event = { version: '2.0', rawPath: '/research.once.admit-next', rawQueryString: '', headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https' }, body: JSON.stringify(f.admission), requestContext: { domainName: 'worker.example.test', http: { method: 'POST', sourceIp: 'fixture' } } };
  expect(await createProductionHandler({ ...f.environment, DELEGATED_WORKER_HOST: 'worker.example.test' }, f.boundaries)(event)).toMatchObject({ statusCode: 404 });
  expect(f.commands).toHaveLength(0); expect(f.fetch).not.toHaveBeenCalled();
});
it('rejects a combined cumulative allowance sum beyond safe integer range', async () => {
  const f = await nextFixture(); const row = (await f.auth.store.get<{ limit: number; spent: number; approvedAt: string }>('BUDGET#research'))!;
  const data = { ...row.data, limit: Number.MAX_SAFE_INTEGER - 80 };
  await f.auth.store.transact([f.auth.store.put('BUDGET#research', data, row.rev, { limit: data.limit, spent: 0 })]);
  const before = f.db.transactions.length;
  await expect(f.invokeNext({ ...f.admission, expectedResearchBudget: data })).rejects.toThrow('research_once_unavailable');
  expect(f.db.transactions).toHaveLength(before); expect((await f.nextStatus()).state).toBe('not-observed');
});
it('late admission initialization cannot dispatch a write after the deadline', async () => {
  const f = await nextFixture(); const raw = f.boundaries.dynamo.send;
  let finish!: () => void; let intercepted = false;
  f.boundaries.dynamo.send = async command => {
    if (!intercepted && command instanceof GetItemCommand) { intercepted = true; await new Promise<void>(resolve => { finish = resolve; }); }
    return raw(command);
  };
  const before = f.db.transactions.length;
  await expect(createProductionHandler(f.environment, f.boundaries)(f.admission, { getRemainingTimeInMillis: () => 5020 })).rejects.toThrow('research_once_unavailable');
  finish(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['completed', 'candidates', 'cost', 'binding', 'reservation'])('refuses ineligible original parent %s without amending budgets', async defect => {
  const f = await nextFixture(); const key = `DISCOVERY#${f.original.runId}`; const row = (await f.auth.store.get<Record<string, unknown>>(key))!;
  const data = { ...row.data, ...(defect === 'completed' ? { completed: true } : defect === 'candidates' ? { candidates: [] } : defect === 'cost' ? { costMicros: 0 } : defect === 'binding' ? { researchOnceBinding: { pairingId: f.pair.pairingId, researchFingerprint: f.request.researchFingerprint, sourceRevision: 3 } } : { reserved: 79 }) };
  await f.auth.store.transact([f.auth.store.put(key, data, row.rev)]); const before = f.db.transactions.length;
  expect(await f.invokeNext()).toMatchObject({ state: 'held' }); expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});
