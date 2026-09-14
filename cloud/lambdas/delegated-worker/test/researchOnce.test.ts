import { describe, expect, it, vi } from 'vitest';
import { createProductionHandler } from '../src/handler';
import { ConditionalCommandHarness } from './sdkHarness';
const request = () => ({ version: 1, kind: 'research.once' as const, workspaceId: 'ws', pairingId: '00000000-0000-4000-a000-000000000001', expectedSourceRevision: 1, researchFingerprint: 'a'.repeat(64) });
const env = () => ({ DELEGATED_WORKER_SCHEDULE_ARN: '', DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_RESEARCH_ONCE_ENABLED: 'true', DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_WORKER_TABLE: 'table', AWS_REGION: 'us-east-1' });
describe('native research once boundary', () => {
  it('returns a native held result for missing durable admission, with no Google initialization', async () => {
    const db = new ConditionalCommandHarness(); const ssm = { send: vi.fn() };
    const result = await createProductionHandler({ ...env(), DELEGATED_GOOGLE_CLIENT_ID: 'malformed-unused' }, { dynamo: db, ssm })(request());
    expect(result).toMatchObject({ version: 1, kind: 'research.once.result', state: 'held' });
    expect(db.transactions).toHaveLength(0); expect(ssm.send).not.toHaveBeenCalled();
  });
  it.each([{ version: 2 }, { extra: true }, { researchFingerprint: 'bad' }, { pairingId: 'not-a-uuid' }])('rejects malformed native contract before IO: %j', async change => {
    const db = new ConditionalCommandHarness(); const send = vi.spyOn(db, 'send');
    await expect(createProductionHandler(env(), { dynamo: db })({ ...request(), ...change })).rejects.toThrow('research_once_invalid_request');
    expect(send).not.toHaveBeenCalled();
  });
  it.each([{ DELEGATED_WORKER_RESEARCH_ONCE_ENABLED: '' }, { DELEGATED_WORKER_SCHEDULE_ARN: 'configured' }, { DELEGATED_WORKSPACE_ID: 'other' }])('denies execution before IO: %j', async change => {
    const db = new ConditionalCommandHarness(); const send = vi.spyOn(db, 'send');
    expect(await createProductionHandler({ ...env(), ...change }, { dynamo: db })(request())).toMatchObject({ state: 'held' });
    expect(send).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { WorkerAuth } from '../src/workerAuth';
import { ResearchSetupService } from '../src/researchSetup';
import { fingerprint, type DynamoCommand } from '../src/dynamoStore';
import { ownerResearchSourceSchema, ownerResearchSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import type { ResearchOnceRequest, ResearchOnceResult } from '../src/researchOnceContract';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
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
describe('durable guided one-shot execution', () => {
  it('completes one exact job, ignores unrelated queued jobs, and replays without providers or scans', async () => {
    const f = await admitted();
    const accounts = createWorkerAccountRepository(f.auth.options);
    const other = await accounts.create({ commandId: randomUUID(), name: 'Other', domain: 'other.example' });
    const otherId = randomUUID(); await accounts.enqueue({ commandId: otherId, accountId: other.id, limits: f.source.research!.researchLimits });
    const before = f.db.inspect(`JOB#${otherId}`); f.commands.length = 0;
    const result = await f.invoke();
    expect(result).toMatchObject({ state: 'completed', settled: true, evidenceReceiptId: expect.any(String) });
    expect(await f.invoke()).toEqual(result); expect(await f.status(result)).toEqual(result);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
    expect(f.commands.some(c => c instanceof QueryCommand)).toBe(false);
    expect(f.db.inspect(`JOB#${otherId}`)).toEqual(before);
    expect(f.db.inspect('SOURCE_PHASE_CURSOR')).toBeUndefined();
    expect(f.commands.filter(c => c instanceof GetItemCommand).some(c => c.input.Key?.sk?.S === `JOB#${otherId}`)).toBe(false);
  });
  it('status remains read-only after pause/review expiry and rejects forged historical binding', async () => {
    const f = await admitted(); const result = await f.invoke();
    await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
    f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = '{}';
    const before = f.db.transactions.length;
    expect(await f.status(result)).toEqual(result);
    expect(await f.invoke({ ...f.request, kind: 'research.once.status', runId: result.runId!, pairingId: randomUUID() })).toMatchObject({ state: 'held', runId: null });
    expect(f.db.transactions).toHaveLength(before); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses broader approved configuration without a reservation or provider', async () => {
    const f = await admitted(2); expect(await f.invoke()).toMatchObject({ state: 'held' });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
  });
  it('returns durable uncertainty after lost model response and never starts it again', async () => {
    const f = await admitted(); f.fetch.mockRejectedValue(new Error('fictional lost response'));
    const result = await f.invoke(); expect(result).toMatchObject({ state: 'uncertain' });
    expect(await f.invoke()).toEqual(result); expect(await f.status(result)).toEqual(result);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
    expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ spent: 80 });
  });
  it('empty discovery is terminal and never re-queries', async () => {
    const f = await admitted(); f.companies.length = 0;
    const result = await f.invoke(); expect(result.state).toBe('empty'); expect(await f.invoke()).toEqual(result);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
  });
  it('bounds non-cooperative initialization and carries SDK abort without late writes', async () => {
    const db = { send: vi.fn(async () => new Promise<never>(() => {})) };
    await expect(createProductionHandler(env(), { dynamo: db })(request(), { getRemainingTimeInMillis: () => 5005 })).rejects.toThrow('research_once_unavailable');
    expect(db.send).toHaveBeenCalledTimes(1);
    const args = db.send.mock.calls[0] as unknown as [unknown, { abortSignal: AbortSignal }];
    expect(args[1].abortSignal.aborted).toBe(true);
  });
});

it.each(['paused', 'revoked', 'expired', 'descriptor', 'revision', 'fingerprint', 'pairing', 'exhausted'])('holds %s execution with no new provider start', async defect => {
  const f = await admitted();
  if (defect === 'paused') await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: 1, state: 'paused', disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  if (defect === 'revoked') await f.auth.revokePairing(f.pair.pairingId);
  if (defect === 'expired') { const d = JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY); d.expiresAt = new Date(Date.now() - 1).toISOString(); f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = JSON.stringify(d); }
  if (defect === 'descriptor') f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = '{}';
  if (defect === 'revision') f.request.expectedSourceRevision++;
  if (defect === 'fingerprint') f.request.researchFingerprint = 'f'.repeat(64);
  if (defect === 'pairing') f.request.pairingId = randomUUID();
  if (defect === 'exhausted') { const row = (await f.auth.store.get<{ limit: number; spent: number }>('BUDGET#research'))!; await f.auth.store.transact([f.auth.store.put('BUDGET#research', { ...row.data, spent: row.data.limit }, row.rev)]); }
  const before = f.db.transactions.length;
  expect(await f.invoke()).toMatchObject({ state: 'held' });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled();
  expect(f.db.transactions).toHaveLength(before);
});
it('overlapping invocations converge without an extra model or page start', async () => {
  const f = await admitted(); await Promise.allSettled([f.invoke(), f.invoke()]);
  expect((await f.invoke()).state).toBe('completed');
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).toHaveBeenCalledTimes(1);
});
it.each(['reservation', 'candidates', 'enqueue', 'claim', 'evidence', 'settlement'])('retains truthful status after ambiguous %s acknowledgement', async phase => {
  const f = await admitted(); let triggered = false;
  f.hook(async command => {
    if (!(command instanceof TransactWriteItemsCommand) || triggered) return;
    const writes = command.input.TransactItems ?? [];
    const row = writes.map(w => w.Put?.Item).find(item => {
      const key = item?.sk?.S ?? ''; const data = JSON.parse(item?.data?.S ?? '{}');
      if (phase === 'reservation') return key.startsWith('DISCOVERY#') && !data.completed;
      if (phase === 'candidates') return key.startsWith('DISCOVERY#') && data.completed;
      if (phase === 'enqueue') return key.startsWith('JOB#') && data.state === 'queued';
      if (phase === 'claim') return key.startsWith('JOB#') && data.state === 'running' && !data.receiptCommitted;
      if (phase === 'evidence') return key.startsWith('JOB#') && data.receiptCommitted;
      return key.startsWith('JOB#') && data.state === 'completed';
    });
    if (row) { triggered = true; f.db.afterCommit = () => { f.db.afterCommit = undefined; throw new Error('fictional lost acknowledgement'); }; }
  });
  await f.invoke().catch(() => undefined); expect(triggered).toBe(true); f.hook();
  const after = await f.invoke();
  expect(f.fetch.mock.calls.length).toBeLessThanOrEqual(1); expect(f.pageHttp.mock.calls.length).toBeLessThanOrEqual(1);
  if (phase === 'reservation') expect(after.state).toBe('uncertain');
  else if (phase === 'claim') expect(after.state).toBe('in-progress');
  else expect(after.state).toBe('completed');
  const before = f.db.transactions.length; expect(await f.status(after)).toEqual(after); expect(f.db.transactions).toHaveLength(before);
});
it('rejects HTTP body smuggling and malformed operation/oversized native input before storage', async () => {
  const f = await admitted(); f.commands.length = 0;
  const raw = { version: '2.0', rawPath: '/research.once', rawQueryString: '', headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https' }, body: JSON.stringify(f.request), requestContext: { domainName: 'worker.example.test', http: { method: 'POST', sourceIp: 'fixture' } } };
  const result = await createProductionHandler({ ...f.environment, DELEGATED_WORKER_HOST: 'worker.example.test' }, f.boundaries)(raw);
  expect(result.statusCode).toBe(404); expect(f.fetch).not.toHaveBeenCalled();
  await expect(f.invoke({ ...f.request, kind: 'research.once.bad' } as unknown as ResearchOnceRequest)).rejects.toThrow('research_once_invalid_request');
  await expect(f.invoke({ ...f.request, extra: 'x'.repeat(5000) } as ResearchOnceRequest)).rejects.toThrow('research_once_invalid_request');
  expect(f.commands).toHaveLength(0);
});
it('late non-cooperative SSM response cannot start a model or write after deadline', async () => {
  const f = await admitted(); let finish!: (value: Awaited<ReturnType<typeof f.ssm.send>>) => void;
  f.ssm.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await expect(createProductionHandler(f.environment, f.boundaries)(f.request, { getRemainingTimeInMillis: () => 5020 })).rejects.toThrow('research_once_unavailable');
  const before = f.db.transactions.length;
  finish({ $metadata: {}, Parameter: { Type: 'SecureString', Value: JSON.stringify({ apiKey: 'fictional', model: 'fixture' }) } });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['revoked', 'expired'])('rechecks %s during credentials before model HTTP', async defect => {
  const f = await admitted();
  const load = f.ssm.send.getMockImplementation()!;
  if (defect === 'expired') { const descriptor = JSON.parse(f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY); descriptor.expiresAt = new Date(Date.now() + 100).toISOString(); f.environment.DELEGATED_RESEARCH_REVIEWED_CAPABILITY = JSON.stringify(descriptor);
    const row = (await f.auth.store.get<Record<string, unknown>>('GUIDED_RESEARCH_SETUP'))!; await f.auth.store.transact([f.auth.store.put('GUIDED_RESEARCH_SETUP', { ...row.data, descriptorFingerprint: fingerprint(descriptor) }, row.rev)]);
  }
  f.ssm.send.mockImplementation(async () => {
    if (defect === 'revoked') await f.auth.revokePairing(f.pair.pairingId);
    else await new Promise(resolve => setTimeout(resolve, 110));
    return load();
  });
  const result = await f.invoke(); expect(result.state).toBe('uncertain');
  expect(f.ssm.send).toHaveBeenCalledTimes(1); expect(f.fetch).not.toHaveBeenCalled(); expect(f.pageHttp).not.toHaveBeenCalled();
  expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ spent: 80 });
});
it('late non-cooperative provider response cannot write after deadline', async () => {
  const f = await admitted(); const original = f.fetch.getMockImplementation()!; let finish!: (value: Response) => void;
  f.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await expect(createProductionHandler(f.environment, f.boundaries)(f.request, { getRemainingTimeInMillis: () => 5020 })).rejects.toThrow('research_once_unavailable');
  expect(f.fetch).toHaveBeenCalledTimes(1); const before = f.db.transactions.length;
  finish(await original('https://fictional.invalid/')); await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.db.transactions).toHaveLength(before); expect(f.pageHttp).not.toHaveBeenCalled();
  const result = await f.invoke(); expect(result.state).toBe('uncertain'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('missing persisted research budget denies discovery before provider I/O', async () => {
  const f = await admitted(); const original = f.boundaries.dynamo.send;
  f.boundaries.dynamo.send = async command => command instanceof GetItemCommand && command.input.Key?.sk?.S === 'BUDGET#research' ? { $metadata: {} } : original(command);
  const before = f.db.transactions.length;
  expect((await f.invoke()).state).toBe('held'); expect(f.fetch).not.toHaveBeenCalled(); expect(f.ssm.send).not.toHaveBeenCalled(); expect(f.db.transactions).toHaveLength(before);
});
it.each(['fingerprint', 'revision', 'run'])('status refuses forged %s historical identity without writes', async defect => {
  const f = await admitted(); const result = await f.invoke(); const request = { ...f.request, kind: 'research.once.status' as const, runId: result.runId! };
  if (defect === 'fingerprint') request.researchFingerprint = 'b'.repeat(64);
  if (defect === 'revision') request.expectedSourceRevision++;
  if (defect === 'run') request.runId = randomUUID();
  const before = f.db.transactions.length;
  expect(await f.invoke(request)).toMatchObject({ state: 'held', runId: null }); expect(f.db.transactions).toHaveLength(before);
});
it('leaves unrelated stale and receipted jobs untouched, but parks only the selected stale unreceipted job', async () => {
  const f = await admitted(); let interrupted = false;
  f.hook(async command => {
    if (!(command instanceof TransactWriteItemsCommand) || interrupted) return;
    if (command.input.TransactItems?.some(i => { const data = JSON.parse(i.Put?.Item?.data?.S ?? '{}'); return i.Put?.Item?.sk?.S?.startsWith('JOB#') && data.state === 'running'; })) {
      interrupted = true; f.db.afterCommit = () => { f.db.afterCommit = undefined; throw new Error('lost claim acknowledgement'); };
    }
  });
  const result = await f.invoke(); f.hook(); expect(result.state).toBe('in-progress');
  const jobKey = `JOB#${result.jobId}`; const job = (await f.auth.store.get<Record<string, unknown>>(jobKey))!;
  const stale: Record<string, unknown> = { ...job.data, claimedAt: new Date(Date.now() - 360000).toISOString() };
  const unrelated = [randomUUID(), randomUUID()];
  await f.auth.store.transact([f.auth.store.put(jobKey, stale, job.rev, { accountId: String(stale.accountId), state: String(stale.state), claimToken: String(stale.claimToken), receiptCommitted: Boolean(stale.receiptCommitted) }), ...unrelated.map((id, index) => f.auth.store.put(`JOB#${id}`, { ...stale, id, receiptCommandId: id, receiptCommitted: index === 1 }, null))]);
  f.commands.length = 0; const before = f.db.transactions.length;
  expect(await f.status(result)).toMatchObject({ state: 'uncertain', settled: false }); expect(f.db.transactions).toHaveLength(before);
  expect(await f.invoke()).toMatchObject({ state: 'uncertain', settled: true }); expect(f.pageHttp).not.toHaveBeenCalled();
  expect(f.commands.some(c => c instanceof QueryCommand || c instanceof GetItemCommand && unrelated.some(id => c.input.Key?.sk?.S === `JOB#${id}`))).toBe(false);
  for (const id of unrelated) expect(f.db.inspect(`JOB#${id}`)).toMatchObject({ state: 'running' });
});
it('refuses changed revision continuation before writes while retaining original historical status', async () => {
  const f = await admitted(); let interrupted = false;
  f.hook(async command => {
    if (!(command instanceof TransactWriteItemsCommand) || interrupted) return;
    if (command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S?.startsWith('DISCOVERY#') && JSON.parse(i.Put.Item.data!.S!).completed)) {
      interrupted = true; f.db.afterCommit = () => { f.db.afterCommit = undefined; throw new Error('lost candidates ack'); };
    }
  });
  await expect(f.invoke()).rejects.toThrow('research_once_unavailable'); f.hook();
  for (const [revision, state] of [[1, 'paused'], [2, 'active']] as const) await f.setup.apply({ version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId, input: { expectedRevision: revision, state, disclosureAcknowledged: true } }, `Bearer ${f.pair.credential}`);
  const before = f.db.transactions.length;
  expect(await f.invoke({ ...f.request, expectedSourceRevision: 3 })).toMatchObject({ state: 'held', runId: null });
  expect(f.db.transactions).toHaveLength(before); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.pageHttp).not.toHaveBeenCalled();
});

it('logs one safe invocation-local discovery diagnostic through the production handler, never on replay/status', async () => {
  const f = await admitted(); const secret = 'HOSTILE-api-key-prompt-https://private.invalid/';
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    f.fetch.mockRejectedValue(new Error(secret));
    const result = await f.invoke();
    expect(result.state).toBe('uncertain');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: 'research_discovery_uncertain', reason: 'transport_uncertain' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(await f.invoke()).toEqual(result);
    const writes = f.db.transactions.length;
    expect(await f.status(result)).toEqual(result);
    expect(f.db.transactions).toHaveLength(writes);
    expect(log).toHaveBeenCalledTimes(1); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.pageHttp).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

import * as discoveryProvider from '../../../../src/main/research/companyDiscoveryProvider';
import { ResearchDiscoveryError } from '../../../../src/main/research/researchDiscoveryError';
it.each(['valid status', 'hostile fields', 'invalid status'])('sanitizes %s at the actual production emission boundary', async variant => {
  const f = await admitted(); const secret = 'HOSTILE-key-prompt-https://private.invalid/';
  const error = new ResearchDiscoveryError('http_rejected', 429);
  Object.assign(error, { message: secret, stack: secret, cause: secret, body: secret, apiKey: secret });
  if (variant === 'hostile fields') Object.assign(error, { reason: secret, httpStatus: secret });
  if (variant === 'invalid status') Object.assign(error, { httpStatus: 999 });
  const provider = vi.spyOn(discoveryProvider, 'requestCompanyDiscovery').mockRejectedValue(error);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await f.invoke()).toMatchObject({ state: 'uncertain' });
    expect(log.mock.calls).toEqual([[{ event: 'research_discovery_uncertain', reason: variant === 'hostile fields' ? 'transport_uncertain' : 'http_rejected', ...(variant === 'valid status' ? { httpStatus: 429 } : {}) }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { provider.mockRestore(); log.mockRestore(); }
});
it.each(['invalid body', 'http rejection'])('logs %s from the real provider through production without retry', async variant => {
  const f = await admitted(); const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.fetch.mockImplementation(async () => new Response('HOSTILE-key-prompt', { status: variant === 'invalid body' ? 200 : 503 }));
  try {
    const result = await f.invoke(); expect(result.state).toBe('uncertain');
    expect(log.mock.calls).toEqual([[{ event: 'research_discovery_uncertain', reason: variant === 'invalid body' ? 'response_body_invalid' : 'http_rejected', ...(variant === 'http rejection' ? { httpStatus: 503 } : {}) }]]);
    expect(await f.invoke()).toEqual(result); expect(await f.status(result)).toEqual(result);
    expect(log).toHaveBeenCalledTimes(1); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.pageHttp).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
it('does not emit discovery diagnostics for success, empty output, admission refusal or their status reads', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const state of ['completed', 'empty', 'held']) {
      const f = await admitted(state === 'held' ? 2 : 1);
      if (state === 'empty') f.companies.length = 0;
      const result = await f.invoke(); expect(result.state).toBe(state);
      expect(await f.invoke()).toEqual(result);
      if (result.runId && state !== 'held') expect(await f.status(result)).toEqual(result);
      else if (result.runId) expect(await f.status(result)).toMatchObject({ state: 'held', runId: null });
      expect(result).not.toHaveProperty('diagnostic');
    }
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
it('a failing console observer cannot replace uncertainty or cause another request', async () => {
  const f = await admitted(); f.fetch.mockRejectedValue(new Error('fixture transport loss'));
  const log = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('HOSTILE-observer-secret'); });
  try {
    const result = await f.invoke(); expect(result.state).toBe('uncertain');
    expect(await f.invoke()).toEqual(result); expect(await f.status(result)).toEqual(result);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
    expect(f.db.inspect('BUDGET#discovery#guided-research-v1')).toMatchObject({ spent: 80 });
  } finally { log.mockRestore(); }
});
