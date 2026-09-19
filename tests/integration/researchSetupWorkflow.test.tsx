// @vitest-environment jsdom
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// Real worker round-trips through encrypted SQLite and the synthetic Dynamo harness run slower under the full parallel suite;
// the 1 s query default and the 5 s test default both flaked there while every case passes alone in about two seconds.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20000 });
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { ResearchSetupRequestStore } from '../../src/main/delegation/researchSetupRequestStore';
import { SettingsScreen } from '../../src/renderer/foundation/SettingsScreen';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createProductionHandler, createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { guidedResearchBudgetId } from '../../cloud/lambdas/delegated-worker/src/researchSetup';
import { budgetKey, budgetSchema } from '../../cloud/lambdas/delegated-worker/src/discoveryReservationStore';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../src/shared/contracts/ownerCommandContract';
import { fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import type { ResearchOnceRequest, ResearchOnceNextRequest } from '../../cloud/lambdas/delegated-worker/src/researchOnceContract';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (ipc.handlers.has(channel)) throw Error('Duplicate handler'); ipc.handlers.set(channel, handler); },
  removeHandler: (channel: string) => ipc.handlers.delete(channel),
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(ipc.handlers.size).toBe(0); });

async function fixture(options: { now?: string; discoveryCostMicros?: number; researchReservationMicros?: number } = {}) {
  const now = options.now ?? PM_NOW;
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unexpected external action'); });
  vi.stubGlobal('fetch', forbidden);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
  const scratch = process.env.JCODE_SCRATCH_DIR ?? tmpdir();
  const directory = await mkdtemp(join(scratch, 'research-workflow-'));
  const f = await createPmFixture();
  const key = randomBytes(32);
  // Real authenticated encryption behind a fictional OS SafeStorage boundary.
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (text: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString: (bytes: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); },
  };
  let unregister = (): void => undefined;
  let runtime: ReturnType<typeof createDelegationRuntime> | undefined;
  try {
    const db = new ConditionalCommandHarness();
    const auth = new WorkerAuth({ dynamo: db, tableName: 'research-workflow', workspaceId: 'research-workflow', clock: { now: () => now } });
    const pairing = { ...await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional'), endpoint: 'https://research.example.test' };
    const descriptor = { capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 40, modelCostMicros: (options.discoveryCostMicros ?? 80) - 40 }, reviewedAt: new Date(Date.parse(now) - 3600000).toISOString(), expiresAt: new Date(Date.parse(now) + 86400000).toISOString(), provenance: 'Fictional review, not verified provider access or invoice cost.', researchReservationMicros: options.researchReservationMicros ?? 100, currency: 'USD' as const };
    const handler = createWorkerHandler({ auth, host: 'research.example.test', researchSetupProfile: { reviewedCapability: descriptor, credentialParameterDeclared: true } });
    const requests: { path: string; body: unknown }[] = [];
    let loseNextWrite = false;
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== pairing.endpoint || init?.redirect !== 'error' || init.cache !== 'no-store') throw Error('Unexpected worker transport');
      const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      const reply = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init.headers).get('authorization') ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { domainName: url.host, http: { method: init.method ?? 'GET', sourceIp: 'fictional' } } });
      if (url.pathname === '/research/setup' && loseNextWrite) { loseNextWrite = false; throw Error('Fictional response lost after worker commit'); }
      return new Response(reply.body, { status: reply.statusCode });
    };
    const mount = () => {
      runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) }, pairing, clock: { now: () => now }, fetch: http, researchSetupStore: new ResearchSetupRequestStore({ directory: join(directory, 'journal'), safeStorage }) });
      unregister = registerOutreachIpc({ provider: { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://research' });
      const api = createCallieApi({ invoke: async (channel, ...args) => { const registered = ipc.handlers.get(channel); if (!registered) throw Error('Unregistered IPC'); return registered({ senderFrame: { url: 'app://research' } }, ...args); } });
      render(<SettingsScreen state={{ status: 'loading' }} onRetry={() => undefined} theme={{ preference: 'light', resolvedTheme: 'light', setPreference: () => undefined }} density={{ density: 'comfortable', setDensity: () => undefined }} delegationApi={api.delegation} />);
      fireEvent.click(screen.getByRole('button', { name: 'Worker connection' }));
      return api;
    };
    const unmount = async () => { cleanup(); unregister(); unregister = () => undefined; await runtime?.dispose(); runtime = undefined; };
    return { ...f, dynamo: db, auth, pairing, descriptor, requests, mount, unmount, loseNextWrite: () => { loseNextWrite = true; },
      async assertEncrypted() { for (const name of await readdir(join(directory, 'journal'))) { const bytes = await readFile(join(directory, 'journal', name)); expect(bytes.toString('utf8')).not.toMatch(/fictional-reviewed-model|research-workflow|fictional-pm\.example/); } },
      async finish() { try { await unmount(); expect(forbidden).not.toHaveBeenCalled(); } finally { key.fill(0); f.close(); await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) { unregister(); await runtime?.dispose(); key.fill(0); f.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

function fillPolicy(region: ReturnType<typeof within>) {
  const fields = [
    ['Residential regions, one per line', 'Fictional region'], ['Targeting terms, one per line', 'property management'],
    ['Official website URLs, one per line', 'https://fictional-pm.example/'], ['Maximum companies (1–50)', '1'],
    ['Maximum pages (1–10)', '1'], ['Maximum bytes (1–1,000,000)', '10000'],
    ['Discovery cumulative ceiling (USD)', '0.01'], ['Research cumulative ceiling (USD)', '0.02'],
  ];
  for (const [label, value] of fields) fireEvent.change(region.getByLabelText(label), { target: { value } });
  fireEvent.click(region.getByLabelText('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above'));
}

// Real renderer/preload/IPC/runtime/filesystem/worker auth and transactions.
// Dynamo, OS encryption service and provider configuration are controlled boundaries.
// This does not assert live AWS, actual model connectivity or closed-Mac acceptance.
it('admits a policy and both cumulative budgets only through explicit Settings approval, then pauses without resetting them', async () => {
  const f = await fixture();
  try {
    f.mount(); const region = within(await screen.findByRole('region', { name: 'Cloud research' }));
    await region.findByText('fictional-reviewed-model');
    expect(f.requests.every(request => request.path.endsWith('/status') || request.path === '/google/disclosure')).toBe(true);
    expect(f.dynamo.inspect(ownerResearchSourceKey())).toBeUndefined();
    expect(f.dynamo.inspect('BUDGET#research')).toBeUndefined();
    expect(f.dynamo.inspect(budgetKey(guidedResearchBudgetId))).toBeUndefined();
    fillPolicy(region); fireEvent.click(region.getByRole('button', { name: 'Approve research' }));
    await region.findByText(/Research policy request applied/);
    const budgets = [f.dynamo.inspect('BUDGET#research'), f.dynamo.inspect(budgetKey(guidedResearchBudgetId))];
    expect(budgets.every(Boolean)).toBe(true);
    expect(await f.auth.store.list('ACCOUNT#')).toEqual([]); expect(await f.auth.store.list('JOB#')).toEqual([]);
    fireEvent.click(region.getByRole('button', { name: 'Refresh' })); await region.findByText('Existing policy (read-only): active');
    fireEvent.click(region.getByLabelText('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above'));
    fireEvent.click(region.getByRole('button', { name: 'Pause research' })); await region.findByText(/Research policy request applied/);
    expect([f.dynamo.inspect('BUDGET#research'), f.dynamo.inspect(budgetKey(guidedResearchBudgetId))]).toEqual(budgets);
    fireEvent.click(region.getByRole('button', { name: 'Refresh' })); await region.findByText('Existing policy (read-only): paused');
    expect(f.requests.filter(request => request.path === '/research/setup')).toHaveLength(2);
    expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM delegated_local_configuration').all()).toEqual([]);
    await f.assertEncrypted();
  } finally { await f.finish(); }
}, 15000);

it('reopens an encrypted uncertain request without replay and reconciles its exact receipt without a second budget admission', async () => {
  const f = await fixture();
  try {
    f.mount(); const region = within(await screen.findByRole('region', { name: 'Cloud research' })); await region.findByText('fictional-reviewed-model');
    fillPolicy(region); f.loseNextWrite(); fireEvent.click(region.getByRole('button', { name: 'Approve research' }));
    await region.findByText(/Request outcome unknown/);
    expect((region.getByRole('button', { name: 'Approve research' }) as HTMLButtonElement).disabled).toBe(true);
    const budgets = [f.dynamo.inspect('BUDGET#research'), f.dynamo.inspect(budgetKey(guidedResearchBudgetId))];
    await f.assertEncrypted(); await f.unmount(); f.mount();
    const reopened = within(await screen.findByRole('region', { name: 'Cloud research' }));
    await reopened.findByText('Existing policy (read-only): active');
    await waitFor(() => expect(reopened.queryByRole('button', { name: 'Retry exact pending request' })).toBeNull());
    expect(f.requests.filter(request => request.path === '/research/setup')).toHaveLength(1);
    expect([f.dynamo.inspect('BUDGET#research'), f.dynamo.inspect(budgetKey(guidedResearchBudgetId))]).toEqual(budgets);
    expect(f.requests.some(request => request.path === '/research/setup/status' && !!(request.body as { requestId?: string }).requestId)).toBe(true);
  } finally { await f.finish(); }
}, 15000);

it('reopens an amended paused policy, explicitly resumes once, and retains the original uncertain reservation after successor completion', async () => {
  const f = await fixture({ now: new Date().toISOString(), discoveryCostMicros: 1000000, researchReservationMicros: 10000 });
  const discovery = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Fictional lost response')).mockImplementation(async () => Response.json({
    status: 'completed', model: 'fictional-reviewed-model', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://fictional-pm.example/' }] } },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies: [{ name: 'Fictional PM', domain: 'fictional-pm.example', sourceUrl: 'https://fictional-pm.example/' }] }), annotations: [{ type: 'url_citation', url: 'https://fictional-pm.example/' }] }] },
    ],
  }));
  const pageHttp = vi.fn(async () => new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }));
  const ssm = { send: vi.fn(async () => ({ $metadata: {}, Parameter: { Type: 'SecureString' as const, Value: JSON.stringify({ apiKey: 'fictional', model: 'fictional-reviewed-model' }) } })) };
  const native = createProductionHandler({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_RESEARCH_ONCE_ENABLED: 'true', DELEGATED_WORKER_SCHEDULE_ARN: '',
    DELEGATED_WORKSPACE_ID: 'research-workflow', DELEGATED_WORKER_TABLE: 'research-workflow', AWS_REGION: 'us-east-1',
    DELEGATED_RESEARCH_REVIEWED_CAPABILITY: JSON.stringify(f.descriptor), DELEGATED_RESEARCH_CREDENTIAL_PARAMETER: '/delegated-worker/research-workflow/research' },
  { dynamo: f.dynamo, ssm, fetch: discovery, pageHttp, resolve: async () => ['93.184.216.34'] });
  try {
    f.mount(); let region = within(await screen.findByRole('region', { name: 'Cloud research' })); await region.findByText('fictional-reviewed-model');
    fillPolicy(region);
    fireEvent.change(region.getByLabelText('Discovery cumulative ceiling (USD)'), { target: { value: '1' } });
    fireEvent.change(region.getByLabelText('Research cumulative ceiling (USD)'), { target: { value: '0.01' } });
    fireEvent.click(region.getByLabelText('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above'));
    fireEvent.click(region.getByRole('button', { name: 'Approve research' })); await region.findByText(/Research policy request applied/);
    const source = ownerResearchSourceSchema.parse(f.dynamo.inspect(ownerResearchSourceKey()));
    const request: ResearchOnceRequest = { version: 1, kind: 'research.once', workspaceId: 'research-workflow', pairingId: f.pairing.pairingId,
      expectedSourceRevision: 1, researchFingerprint: fingerprint(source.research) };
    await f.unmount(); const original = await native(request);
    expect(original).toMatchObject({ state: 'uncertain', settled: false }); expect(discovery).toHaveBeenCalledTimes(1);
    expect(pageHttp).not.toHaveBeenCalled();
    f.mount(); region = within(await screen.findByRole('region', { name: 'Cloud research' })); await region.findByText('Existing policy (read-only): active');
    fireEvent.click(region.getByLabelText('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above'));
    fireEvent.click(region.getByRole('button', { name: 'Pause research' })); await region.findByText(/Research policy request applied/);
    await f.unmount();
    const parentBefore = f.dynamo.inspect(`DISCOVERY#${original.runId}`);
    const researchBefore = f.dynamo.inspect('BUDGET#research');
    const admission: ResearchOnceNextRequest = { version: 1, kind: 'research.once.admit-next', workspaceId: request.workspaceId, pairingId: request.pairingId,
      parentRunId: original.runId!, parentSourceRevision: 1 as const, researchFingerprint: request.researchFingerprint,
      expectedSourceRevision: 2 as const, descriptorFingerprint: fingerprint(f.descriptor),
      expectedDiscoveryBudget: budgetSchema.parse(f.dynamo.inspect(budgetKey(guidedResearchBudgetId))),
      expectedResearchBudget: budgetSchema.parse(researchBefore), proposedDiscoveryLimitMicros: 2000000 };
    const admitted = await native(admission);
    expect(admitted).toMatchObject({ kind: 'research.once.admit-next.result', state: 'applied' });
    if (admitted.kind !== 'research.once.admit-next.result' || !admitted.receipt) throw Error('Expected exact admission receipt');
    expect(f.dynamo.inspect(`DISCOVERY#${original.runId}`)).toEqual(parentBefore);
    expect(f.dynamo.inspect('BUDGET#research')).toEqual(researchBefore);
    expect(discovery).toHaveBeenCalledTimes(1); expect(ssm.send).toHaveBeenCalledTimes(1);
    f.mount(); region = within(await screen.findByRole('region', { name: 'Cloud research' }));
    await region.findByText('Existing policy (read-only): paused');
    expect(region.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $1 USD, remaining $1 USD.')).toBeTruthy();
    expect(region.getByText('Research balance: cumulative ceiling $0.01 USD, reserved-or-spent $0 USD, remaining $0.01 USD.')).toBeTruthy();
    expect(f.requests.filter(request => request.path === '/research/setup')).toHaveLength(2);
    const successor = { ...request, expectedSourceRevision: 3, successor: { parentRunId: original.runId!, admissionFingerprint: admitted.receipt.fingerprint } };
    expect(await native(successor)).toMatchObject({ state: 'held' }); expect(discovery).toHaveBeenCalledTimes(1);
    fireEvent.click(region.getByRole('button', { name: 'Refresh' })); await region.findByText('Existing policy (read-only): paused');
    await waitFor(() => expect((region.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
    expect(f.requests.filter(request => request.path === '/research/setup')).toHaveLength(2);
    fireEvent.click(region.getByLabelText('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above'));
    fireEvent.click(region.getByRole('button', { name: 'Resume research' })); await region.findByText(/Research policy request applied/);
    expect(ownerResearchSourceSchema.parse(f.dynamo.inspect(ownerResearchSourceKey()))).toMatchObject({ revision: 3, state: 'active', research: source.research });
    await f.unmount(); const completed = await native(successor);
    expect(completed).toMatchObject({ state: 'completed', settled: true, evidenceReceiptId: expect.any(String), settlementReceiptId: expect.any(String) });
    expect(await native(successor)).toEqual(completed);
    expect(await native({ ...request, kind: 'research.once.status', runId: original.runId! })).toEqual(original);
    expect(f.dynamo.inspect(`DISCOVERY#${original.runId}`)).toEqual(parentBefore);
    expect(discovery).toHaveBeenCalledTimes(2); expect(pageHttp).toHaveBeenCalledTimes(1);
    f.mount(); region = within(await screen.findByRole('region', { name: 'Cloud research' }));
    await region.findByText('Existing policy (read-only): active');
    expect(region.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $2 USD, remaining $0 USD.')).toBeTruthy();
    expect(region.getByText(/not verified invoice spend/)).toBeTruthy();
    expect(f.requests.filter(request => request.path === '/research/setup')).toHaveLength(3);
    expect(discovery).toHaveBeenCalledTimes(2); await f.assertEncrypted();
  } finally { await f.finish(); }
}, 20000);
