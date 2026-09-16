// @vitest-environment jsdom
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import { delegationCommandSchema } from '../../src/shared/contracts/delegationContract';
import { ownerSourceKey, type OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { DynamoThreadIntakeRepository } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import type { DynamoAdapter } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { accountPreparationSchema, type AccountPreparation } from '../../src/shared/contracts/accountPreparationContract';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PM_NOW));
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Real network forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Narrow composition from guidedCampaignEntrypoint. No UI engine, source/config
// seed, fabricated public API, direct AUTH seed or owner success stub.
async function fixture(options: { mail?: boolean; configure?: boolean } = {}) {
  const local = await createPmFixture();
  const database = local.db;
  const clock = { now: () => new Date().toISOString() };
  const workspaceId = randomUUID();
  let runtime: ReturnType<typeof createDelegationRuntime> | undefined;
  const unregister: (() => void)[] = [];
  try {
    const services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
    const domain = new FounderSalesDomain({ database, services, clock, ids: { next: randomUUID } });
    domain.transitionWorkflow({ commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' });
    const provider = createLocalWorkspaceProvider({ withDatabase: async fn => fn(database), withDomain: async fn => fn(domain) });
    const dynamo = new ConditionalCommandHarness();
    const sdkReads: string[] = [];
    let beforeProof: (() => Promise<void>) | undefined;
    const adapter: DynamoAdapter = { send: async command => {
      const request = command.input;
      if ('Key' in request) sdkReads.push(request.Key?.sk?.S ?? '');
      if ('KeyConditionExpression' in request) sdkReads.push('QUERY');
      if ('TransactItems' in request && request.TransactItems?.every(item => item.ConditionCheck)) {
        const hook = beforeProof; beforeProof = undefined; await hook?.();
      }
      return dynamo.send(command);
    } };
    const workerOptions = { dynamo: adapter, tableName: 'fictional-owner-preparation', workspaceId, clock };
    const auth = new WorkerAuth(workerOptions);
    const issued = await auth.issuePairing({ scopes: options.mail ? ['commands:write', 'events:read', 'google:grant'] : ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const pairing = { ...await auth.redeemPairing(issued.code, 'fictional-preparation-device'), endpoint: 'https://preparation.example.invalid' };
    const providerCalls: string[] = [];
    const google = new RemoteGoogleAuthorization({ auth,
      config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://preparation.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 9) },
      fetch: async input => {
        const url = String(input); providerCalls.push(new URL(url).pathname);
        if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read}` });
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'fictional-mailbox', email: 'owner@example.invalid', email_verified: true });
        throw Error('Unrelated provider effect forbidden');
      } });
    if (options.mail) {
      const grant = await google.beginGoogleGrant(pairing.pairingId, ['relevant_read']);
      await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
      expect((await google.status(pairing.pairingId)).grant?.grantedScopes).toContain(googleScopes.relevant_read);
      expect((await google.status(pairing.pairingId)).grant?.grantedScopes).not.toContain(googleScopes.send);
    }
    const handler = createWorkerHandler({ auth, host: 'preparation.example.invalid', google });
    let transform: ((response: Response, signal?: AbortSignal | null) => Promise<Response>) | undefined;
    const paths: string[] = [], kinds: string[] = [];
    const requestShapes: { path: string; method: string; keys: string[] }[] = [];
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.origin !== pairing.endpoint || !['/commands', '/events', '/commands/reconcile', '/accounts/preparation'].includes(url.pathname)) throw Error('Unexpected fixture endpoint');
      if (url.pathname === '/commands') {
        const command = delegationCommandSchema.parse(JSON.parse(String(init?.body)));
        kinds.push(command.kind);
        if (!['bootstrap-selected-account', 'delegate', ...(options.configure || options.mail ? ['configure-owner', 'pause', 'revoke'] : [])].includes(command.kind)) throw Error('Unrelated preparation command forbidden');
      }
      requestShapes.push({ path: url.pathname, method: init?.method ?? 'GET', keys: init?.body ? Object.keys(JSON.parse(String(init.body))).sort() : [] });
      const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1),
        headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
        requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } },
        ...(init?.body ? { body: String(init.body) } : {}) });
      const wrapped = new Response(response.body, { status: response.statusCode, headers: response.headers });
      return url.pathname === '/accounts/preparation' && transform ? transform(wrapped, init?.signal) : wrapped;
    };
    const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrelated public effect forbidden'); });
    const outreach: OutreachApi = { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden,
      openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden };
    runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(database) }, pairing, clock, fetch: http });
    electron.handle.mockClear();
    unregister.push(registerOutreachIpc({ provider: outreach, delegation: runtime }),
      registerDailyIpc({ get: async () => services.daily.get() }), registerLocalWorkspaceIpc(provider));
    const api = createCallieApi({ invoke: async (channel, ...args) =>
      registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
    await api.delegation.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
    const admit = async (name: string) => {
      const input: { name: string; domain: null } = { name, domain: null };
      expect(await api.localWorkspace.reviewCompany(input)).toMatchObject({ complete: true, candidates: [] });
      const result = await api.localWorkspace.createCompany({ ...input, commandId: randomUUID() });
      if (result.status !== 'saved') throw Error('Fictional local company admission failed');
      return result.account;
    };
    const selected = await admit('Fictional Owner Preparation PM');
    const untouched = await admit('Fictional Untouched PM');
    if (options.mail) {
      local.repo.admitEvidence({ commandId: randomUUID(), accountId: selected.id, expectedVersion: 1,
        sources: [{ id: 'fictional-source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64),
          excerpt: 'Fictional residential property manager. Business email: team@example.invalid', permitted: true }], claims: [], routes: [] });
      await api.localWorkspace.admitCompanyDraftEmail({ commandId: randomUUID(), accountId: selected.id,
        expectedAccountVersion: 2, email: 'team@example.invalid', sourceId: 'fictional-source',
        quote: 'Business email: team@example.invalid', selection: 'published_company_business_inbox' });
    }
    expect(readFileSync(database.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const repository = new DelegationRepository({ database, workspaceId, clock });
    return { api, database, repository, selected, untouched, dynamo, paths, kinds, forbidden, workspaceId, pairingId: pairing.pairingId,
      sdkReads, providerCalls, requestShapes, auth, google, workerOptions, runtime,
      transformReply(value?: typeof transform) { transform = value; },
      beforeProof(value: () => Promise<void>) { beforeProof = value; },
      async finish() {
        unregister.splice(0).reverse().forEach(fn => fn());
        await runtime!.dispose();
        local.close();
      } };
  } catch (error) {
    unregister.splice(0).reverse().forEach(fn => fn());
    await runtime?.dispose(); local.close(); throw error;
  }
}

it('reads genuine owner configuration absence through the public bridge after actual bootstrap and delegation', async () => {
  const f = await fixture();
  try {
    for (const account of [f.selected, f.untouched]) {
      expect(f.dynamo.inspect(`ACCOUNT#${account.id}`)).toBeUndefined();
      expect(f.dynamo.inspect(`AUTH#${account.id}`)).toBeUndefined();
    }
    expect(await f.api.delegation.bootstrap({ commandId: randomUUID(), accountId: f.selected.id })).toMatchObject({ status: 'applied' });
    expect(f.repository.authority(f.selected.id)).toMatchObject({ owner: 'local', state: 'local', generation: 0 });
    expect(f.repository.executionVersion(f.selected.id)).toBe(1);
    const commandId = randomUUID();
    await f.api.delegation.submit({ commandId, workspaceId: f.workspaceId, accountId: f.selected.id,
      expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'delegate',
      payload: { delegationId: randomUUID(), approvedAt: PM_NOW } });
    expect(await f.api.delegation.sync()).toMatchObject({ ownerFresh: true });
    expect(f.repository.commandStatus(commandId)).toMatchObject({ status: 'applied' });
    const authority = { accountId: f.selected.id, owner: 'worker', state: 'active', generation: 1 };
    expect(f.repository.authority(f.selected.id)).toEqual(authority);
    expect(f.repository.executionVersion(f.selected.id)).toBe(2);
    expect(f.dynamo.inspect(`AUTH#${f.selected.id}`)).toMatchObject({ authority, version: 2 });
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toMatchObject({ account: { id: f.selected.id } });
    expect(f.dynamo.inspect(ownerSourceKey(f.selected.id))).toBeUndefined();
    expect(f.dynamo.inspect(`ACCOUNT#${f.untouched.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
    expect([...new Set(f.kinds)]).toEqual(['bootstrap-selected-account', 'delegate']);
    expect(f.forbidden).not.toHaveBeenCalled();
    const pathsBefore = f.paths.length;
    const writesBefore = f.dynamo.transactions.length;
    const changesBefore = f.database.raw.prepare('SELECT total_changes() AS changes').get();
    // FIRST CAUSAL RED: this is the actual public API object, not an injected
    // method. The test-only intersection allows the absent entrypoint to run.
    const publicDelegation = f.api.delegation as typeof f.api.delegation & {
      getAccountPreparation(input: { accountId: string }): Promise<unknown>;
    };
    const result = await publicDelegation.getAccountPreparation({ accountId: f.selected.id });
    expect(result).toEqual({ workspaceId: f.workspaceId, accountId: f.selected.id, pairingId: f.pairingId,
      checkedAt: PM_NOW, authority, executionVersion: 2, configuration: null, mailCursor: null });
    expect(f.paths.slice(pathsBefore)).toEqual(['/accounts/preparation']);
    expect(f.database.raw.prepare('SELECT total_changes() AS changes').get()).toEqual(changesBefore);
    for (const transaction of f.dynamo.transactions.slice(writesBefore)) {
      expect(transaction.TransactItems?.every(item => item.ConditionCheck && !item.Put && !item.Update && !item.Delete)).toBe(true);
    }
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Preparation = AccountPreparation;
function readPreparation(f: Fixture, accountId = f.selected.id): Promise<Preparation> {
  return f.api.delegation.getAccountPreparation({ accountId });
}
async function prepare(f: Fixture) {
  expect(await f.api.delegation.bootstrap({ commandId: randomUUID(), accountId: f.selected.id })).toMatchObject({ status: 'applied' });
  const commandId = randomUUID();
  await f.api.delegation.submit({ commandId, workspaceId: f.workspaceId, accountId: f.selected.id,
    expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: PM_NOW } });
  expect(await f.api.delegation.sync()).toMatchObject({ ownerFresh: true });
  expect(f.repository.commandStatus(commandId)).toMatchObject({ status: 'applied' });
  expect(f.repository.authority(f.selected.id)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
  expect(f.repository.executionVersion(f.selected.id)).toBe(2);
}
async function configure(f: Fixture, mail = false, revision = 1, state: 'active' | 'paused' = 'active') {
  const configuration: OwnerSourceConfiguration = { version: 1, workspaceId: f.workspaceId, accountId: f.selected.id,
    pairingId: f.pairingId, revision, state, mailboxSubject: mail ? 'fictional-mailbox' : null, calendarId: null, research: null };
  const commandId = randomUUID();
  await f.api.delegation.submit({ commandId, workspaceId: f.workspaceId, accountId: f.selected.id,
    expectedAuthorityGeneration: f.repository.authority(f.selected.id)!.generation,
    expectedVersion: f.repository.executionVersion(f.selected.id), kind: 'configure-owner', payload: {
      expectedConfigurationRevision: revision - 1, configuration,
      mailScope: mail && revision === 1 ? { expectedEnvelopeRevision: null, since: PM_NOW } : null,
    } });
  expect(await f.api.delegation.sync()).toMatchObject({ ownerFresh: true });
  expect(f.repository.commandStatus(commandId)).toMatchObject({ status: 'applied' });
  expect(f.dynamo.inspect(ownerSourceKey(f.selected.id))).toEqual(configuration);
  return configuration;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function durable(f: Fixture) {
  const tables = f.database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const sql = tables.map(({ name }) => [name, f.database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]);
  const keys = [...new Set(f.dynamo.transactions.flatMap(tx => tx.TransactItems ?? []).flatMap(item => item.Put?.Item?.sk?.S ? [item.Put.Item.sk.S] : []))].sort();
  // Hash complete fictional state so failures cannot dump credential-bearing rows.
  return { sql: digest(sql), worker: digest(keys.map(key => [key, f.dynamo.inspect(key)])),
    changes: f.database.raw.prepare('SELECT total_changes() AS changes').get() };
}
function purityBaseline(f: Fixture) {
  return { durable: durable(f), paths: f.paths.length, transactions: f.dynamo.transactions.length,
    providers: f.providerCalls.length, reads: f.sdkReads.length, requests: f.requestShapes.length };
}
function assertReadOnly(f: Fixture, before: ReturnType<typeof purityBaseline>, requests = 1) {
  expect(durable(f)).toEqual(before.durable);
  expect(f.paths.slice(before.paths)).toEqual(Array.from({ length: requests }, () => '/accounts/preparation'));
  expect(f.providerCalls).toHaveLength(before.providers);
  expect(f.requestShapes.slice(before.requests)).toEqual(Array.from({ length: requests }, () => ({ path: '/accounts/preparation', method: 'POST', keys: ['accountId', 'workspaceId'] })));
  const transactions = f.dynamo.transactions.slice(before.transactions);
  for (const transaction of transactions) {
    expect(transaction.TransactItems?.length).toBeGreaterThan(0);
    for (const item of transaction.TransactItems ?? []) expect(Object.keys(item)).toEqual(['ConditionCheck']);
  }
  expect(f.sdkReads.slice(before.reads).some(key => key === 'QUERY' || key.startsWith('DISPATCH_INTAKE#') || key.startsWith('MAIL_THREAD#'))).toBe(false);
  expect(f.forbidden).not.toHaveBeenCalled();
}

it('distinguishes actual absence from exact configured and paused no-mail state without writes or sync', async () => {
  const f = await fixture({ configure: true });
  try {
    await prepare(f);
    let before = purityBaseline(f);
    expect(await readPreparation(f)).toEqual({ workspaceId: f.workspaceId, accountId: f.selected.id, pairingId: f.pairingId,
      checkedAt: PM_NOW, authority: f.repository.authority(f.selected.id), executionVersion: 2, configuration: null, mailCursor: null });
    assertReadOnly(f, before);
    const configuration = await configure(f);
    before = purityBaseline(f);
    expect(await readPreparation(f)).toEqual({ workspaceId: f.workspaceId, accountId: f.selected.id, pairingId: f.pairingId,
      checkedAt: PM_NOW, authority: f.repository.authority(f.selected.id), executionVersion: 3, configuration, mailCursor: null });
    assertReadOnly(f, before);
    const paused = await configure(f, false, 2, 'paused');
    before = purityBaseline(f);
    expect(await readPreparation(f)).toMatchObject({ configuration: paused, executionVersion: 4, mailCursor: null });
    assertReadOnly(f, before);
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
  } finally { await f.finish(); }
}, 20_000);

it('reads an authentic existing-mail cursor with envelope revision distinct from scope and no provider calls', async () => {
  const f = await fixture({ mail: true });
  try {
    await prepare(f);
    const configuration = await configure(f, true);
    const threads = new DynamoThreadIntakeRepository(f.workerOptions);
    await threads.beginPoll(f.selected.id, 'fictional-mailbox', randomUUID());
    const cursor = (await threads.cursorState(f.selected.id, 'fictional-mailbox'))!;
    expect(cursor.rev).not.toBe(cursor.data.scope!.revision);
    const before = purityBaseline(f);
    expect(await readPreparation(f)).toEqual({ workspaceId: f.workspaceId, accountId: f.selected.id, pairingId: f.pairingId,
      checkedAt: PM_NOW, authority: f.repository.authority(f.selected.id), executionVersion: 3, configuration,
      mailCursor: { mailboxSubject: 'fictional-mailbox', envelopeRevision: cursor.rev, scope: cursor.data.scope } });
    assertReadOnly(f, before);
    expect(await threads.cursorState(f.selected.id, 'fictional-mailbox')).toEqual(cursor);
  } finally { await f.finish(); }
}, 20_000);

it('rejects a poll-only cursor revision race instead of returning an obsolete envelope proof', async () => {
  const f = await fixture({ mail: true });
  try {
    await prepare(f); await configure(f, true);
    const threads = new DynamoThreadIntakeRepository(f.workerOptions);
    const old = (await threads.cursorState(f.selected.id, 'fictional-mailbox'))!;
    let afterConcurrentWrite: ReturnType<typeof durable> | undefined;
    f.beforeProof(async () => {
      await threads.beginPoll(f.selected.id, 'fictional-mailbox', randomUUID());
      afterConcurrentWrite = durable(f);
    });
    const paths = f.paths.length, providers = f.providerCalls.length;
    await expect(readPreparation(f)).rejects.toThrow();
    expect(afterConcurrentWrite).toBeDefined();
    expect(durable(f)).toEqual(afterConcurrentWrite);
    expect(f.paths.slice(paths)).toEqual(['/accounts/preparation']);
    expect(f.providerCalls).toHaveLength(providers);
    const current = (await threads.cursorState(f.selected.id, 'fictional-mailbox'))!;
    expect(current.data.scope).toEqual(old.data.scope);
    expect(current.rev).toBe(old.rev + 1);
    expect((await readPreparation(f)).mailCursor?.envelopeRevision).toBe(current.rev);
  } finally { await f.finish(); }
}, 20_000);

it('does not synthesize owner absence for a genuinely unbootstrapped selected company', async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const before = purityBaseline(f);
    await expect(readPreparation(f, f.untouched.id)).rejects.toThrow();
    assertReadOnly(f, before);
    expect(f.dynamo.inspect(`ACCOUNT#${f.untouched.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
  } finally { await f.finish(); }
}, 20_000);

it.each(['workspace', 'account', 'pairing', 'authority', 'configuration', 'unknown-field', 'malformed-json'] as const)('rejects %s substitution at the real HTTP reply seam without publishing or persisting it', async scenario => {
  const f = await fixture({ configure: true });
  try {
    await prepare(f); await configure(f);
    f.transformReply(async response => {
      if (scenario === 'malformed-json') return new Response('{', { status: 200 });
      const actual = await response.json() as Preparation;
      const changed: Record<string, unknown> = structuredClone(actual);
      if (scenario === 'workspace') changed.workspaceId = randomUUID();
      if (scenario === 'account') changed.accountId = f.untouched.id;
      if (scenario === 'pairing') changed.pairingId = randomUUID();
      if (scenario === 'authority') changed.authority = { ...actual.authority, accountId: f.untouched.id };
      if (scenario === 'configuration') changed.configuration = { ...actual.configuration, accountId: f.untouched.id };
      if (scenario === 'unknown-field') changed.noMailObservation = { hasEmailRoutes: false };
      return Response.json(changed);
    });
    const before = purityBaseline(f);
    await expect(readPreparation(f)).rejects.toThrow();
    assertReadOnly(f, before);
    f.transformReply();
    expect((await readPreparation(f)).accountId).toBe(f.selected.id);
  } finally { await f.finish(); }
}, 20_000);

it('rejects genuine pairing revocation before the final read proof', async () => {
  const f = await fixture();
  try {
    await prepare(f);
    let afterRevoke: ReturnType<typeof durable> | undefined;
    f.beforeProof(async () => { await f.auth.revokePairing(f.pairingId); afterRevoke = durable(f); });
    await expect(readPreparation(f)).rejects.toThrow();
    expect(afterRevoke).toBeDefined();
    expect(durable(f)).toEqual(afterRevoke);
    const before = purityBaseline(f);
    await expect(readPreparation(f)).rejects.toThrow();
    assertReadOnly(f, before);
  } finally { await f.finish(); }
}, 20_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Read did not release its operation lease')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

it.each(['lock', 'dispose', 'invalidate'] as const)('settles %s with an abort-ignoring transport and never publishes its delayed successful response', async action => {
  const f = await fixture();
  const entered = deferred<void>(), released = deferred<Response>();
  let captured: Response | undefined;
  let observedSignal: AbortSignal | null | undefined;
  try {
    await prepare(f);
    const before = purityBaseline(f);
    f.transformReply(async (response, signal) => {
      captured = response; observedSignal = signal; entered.resolve();
      return released.promise; // External adapter deliberately ignores AbortSignal.
    });
    const result = readPreparation(f).then(() => 'published', () => 'held');
    await bounded(entered.promise);
    if (action === 'dispose') await bounded(f.runtime.dispose());
    else f.runtime.invalidate(action === 'lock' ? true : undefined);
    expect(await bounded(result)).toBe('held');
    expect(observedSignal?.aborted).toBe(true);
    assertReadOnly(f, before);
    released.resolve(captured!);
    await Promise.resolve();
    expect(await result).toBe('held');
    expect(durable(f)).toEqual(before.durable);
  } finally {
    released.resolve(captured ?? new Response('{}'));
    await f.finish();
  }
}, 20_000);

it('accepts a complete real response split across streamed chunks without extra effects', async () => {
  const f = await fixture();
  try {
    await prepare(f);
    f.transformReply(async response => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7);
      } }), { status: 200 });
    });
    const before = purityBaseline(f);
    expect(await readPreparation(f)).toMatchObject({ accountId: f.selected.id, configuration: null, mailCursor: null });
    assertReadOnly(f, before);
  } finally { await f.finish(); }
}, 20_000);

it('enforces the UTF8 byte limit while streaming and cancels without consuming the oversized reply', async () => {
  const f = await fixture();
  let pulls = 0, cancelled = false;
  try {
    await prepare(f);
    f.transformReply(async () => {
      const chunk = new TextEncoder().encode('é'.repeat(64 * 1024)); // 128KiB, only 64Ki characters.
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"padding":"'));
          else if (pulls <= 11) controller.enqueue(chunk);
          else { controller.enqueue(new TextEncoder().encode('"}')); controller.close(); }
        },
        cancel() { cancelled = true; },
      }), { status: 200 });
    });
    const before = purityBaseline(f);
    await expect(readPreparation(f)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10); // A read-all/character-count implementation consumes all twelve pulls.
    assertReadOnly(f, before);
  } finally { await f.finish(); }
}, 20_000);

it('rejects invalid UTF8 bytes at the external stream boundary', async () => {
  const f = await fixture({ configure: true });
  let replacementWouldPass = false;
  try {
    await prepare(f); await configure(f);
    f.transformReply(async response => {
      // A nonfatal decoder would replace this byte with U+FFFD in a schema-valid
      // calendar selector and incorrectly accept the otherwise genuine reply.
      const text = (await response.text()).replace('"calendarId":null', '"calendarId":"X"');
      const bytes = new TextEncoder().encode(text);
      const marker = new TextEncoder().encode(text.slice(0, text.indexOf('"calendarId":"X"') + '"calendarId":"'.length)).length;
      bytes[marker] = 0xff;
      replacementWouldPass = accountPreparationSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes))).success;
      return new Response(bytes, { status: 200 });
    });
    const before = purityBaseline(f);
    await expect(readPreparation(f)).rejects.toThrow();
    expect(replacementWouldPass).toBe(true);
    assertReadOnly(f, before);
  } finally { await f.finish(); }
}, 20_000);

it('rejects a schema-valid coherent foreign pairing reply against the captured trusted pairing', async () => {
  const f = await fixture({ configure: true });
  let schemaAccepted = false;
  try {
    await prepare(f); await configure(f);
    const foreignPairingId = randomUUID();
    f.transformReply(async response => {
      const actual = accountPreparationSchema.parse(await response.json());
      const substituted = { ...actual, pairingId: foreignPairingId,
        configuration: { ...actual.configuration!, pairingId: foreignPairingId } };
      expect(accountPreparationSchema.safeParse(substituted).success).toBe(true);
      schemaAccepted = true;
      return Response.json(substituted);
    });
    const before = purityBaseline(f);
    await expect(readPreparation(f)).rejects.toThrow();
    expect(schemaAccepted).toBe(true);
    assertReadOnly(f, before);
  } finally { await f.finish(); }
}, 20_000);
