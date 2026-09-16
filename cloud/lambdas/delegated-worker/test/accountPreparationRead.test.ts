import { randomUUID } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { accountPreparationSchema, accountPreparationRequestSchema, getAccountPreparationSchema } from '../../../../src/shared/contracts/accountPreparationContract';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { createWorkerHandler, createProductionHandler } from '../src/handler';
import { WorkerAuth, pairingKey, secretHash, type WorkerScope } from '../src/workerAuth';
import { executionAuthorityKey } from '../src/executionRepository';
import { accountKey } from '../src/workerAccountRepository';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { DynamoThreadIntakeRepository, mailCursorKey } from '../src/threadIntakeRepository';
import type { DynamoAdapter, DynamoCommand } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';

const now = '2026-09-16T00:00:00.000Z';
const accountId = 'fictional-preparation-account';
const mailbox = 'fictional-mailbox';
const host = 'worker.example.test';
const request = { workspaceId: 'ws', accountId };
function researchConfiguration(): NonNullable<OwnerSourceConfiguration['research']> {
  const limits = { maxCompanies: 2, maxPages: 2, maxBytes: 4096, maxCostMicros: 1000 };
  return { workspaceId: 'ws', budgetId: 'research-budget', audience: { residential: true, regions: ['Fictional'], terms: ['management'] },
    audienceRevision: 2, sourceRevision: 3, budgetRevision: 4, discoveryLimits: limits, researchLimits: limits,
    capability: { model: 'fictional-model', webSearch: true, searchCostMicros: 2, modelCostMicros: 3 },
    maxAccountBudgetMicros: 1000, permittedSources: ['https://example.invalid/research'], preparationCommandId: randomUUID() };
}
function event(body: unknown = request, authorization = '', rawQueryString = '', path = '/accounts/preparation') {
  return { version: '2.0', rawPath: path, rawQueryString, headers: { host, 'x-forwarded-proto': 'https', authorization },
    body: typeof body === 'string' ? body : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { domainName: host, http: { method: 'POST', sourceIp: 'fictional-device' } } };
}

/** Real public handler/auth/bootstrap/delegate/configure. Only the SDK and OAuth
 * boundary are synthetic. Never seed a positive OWNER_SOURCE or cursor row. */
async function fixture(mail = false, delegate = true) {
  const harness = new ConditionalCommandHarness();
  const observed: DynamoCommand[] = [];
  const snapshot = () => structuredClone((harness as unknown as { items: Record<string, Record<string, AttributeValue>> }).items);
  let tracing = false;
  let beforeProof: (() => Promise<void>) | undefined;
  let sdkFailure: Error | undefined;
  let readFailure = false;
  const dynamo: DynamoAdapter = { async send(command) {
    if (tracing && readFailure && command instanceof GetItemCommand) throw Error('secret-provider-token https://private.invalid');
    if (command instanceof TransactWriteItemsCommand && command.input.TransactItems?.every(item => !!item.ConditionCheck)) {
      if (beforeProof) {
        const hook = beforeProof; beforeProof = undefined; tracing = false;
        try { await hook(); } finally { tracing = true; }
      }
      if (sdkFailure) { const failure = sdkFailure; sdkFailure = undefined; throw failure; }
    }
    if (tracing) observed.push(command);
    return harness.send(command);
  } };
  const options = { dynamo, tableName: 'fictional-preparation', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  async function pair(scopes: WorkerScope[] = ['commands:write', 'events:read']) {
    return auth.redeemPairing((await auth.issuePairing({ scopes, expiresInSeconds: 300 })).code, randomUUID());
  }
  const pairing = await pair();
  const bearer = `Bearer ${pairing.credential}`;
  const providerCalls: string[] = [];
  const google = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional',
    encryptionKey: Buffer.alloc(32, 9), redirectUri: `https://${host}/oauth/callback` }, fetch: async input => {
    const url = String(input); providerCalls.push(url);
    if (tracing) throw Error('provider I/O forbidden during read');
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read}` });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: mailbox, email: 'owner@example.invalid', email_verified: true });
    throw Error('unexpected external boundary');
  } });
  if (mail) {
    const grant = await google.beginGoogleGrant(pairing.pairingId, ['relevant_read']);
    await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  }
  const handle = createWorkerHandler({ auth, host, google });
  async function command(kind: string, payload: unknown, version: number, generation: number) {
    const result = await handle(event({ commandId: randomUUID(), ...request, expectedAuthorityGeneration: generation, expectedVersion: version, kind, payload }, bearer, '', '/commands'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'applied' });
    return JSON.parse(result.body);
  }
  const account = { id: accountId, name: 'Fictional Preparation Company', domain: null, version: 1 };
  const sources = mail ? [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Published team@example.invalid', permitted: true }] : [];
  const routes = mail ? [{ id: 'route', accountId, personId: null, channel: 'email', value: 'team@example.invalid', version: 1, purpose: 'business', verification: 'published', evidenceIds: ['source'] }] : [];
  await command('bootstrap-selected-account', { record: { account, sources, routes, claims: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes }] }, asOf: now, expectedResearchRevision: null, suppression: [] }, 0, 0);
  if (delegate) await command('delegate', { delegationId: randomUUID(), approvedAt: now }, 1, 0);
  async function configure(overrides: Partial<OwnerSourceConfiguration> = {}) {
    const previous = await auth.store.get<OwnerSourceConfiguration>(ownerSourceKey(accountId));
    const current = await auth.store.get<{ version: number; authority: { generation: number } }>(executionAuthorityKey(accountId));
    const configuration: OwnerSourceConfiguration = { version: 1, ...request, pairingId: pairing.pairingId, revision: (previous?.data.revision ?? 0) + 1,
      state: 'active', mailboxSubject: mail ? mailbox : null, calendarId: null, research: null, ...overrides };
    const cursor = await new DynamoThreadIntakeRepository(options).cursorState(accountId, mailbox);
    await command('configure-owner', { expectedConfigurationRevision: previous?.data.revision ?? 0, configuration,
      mailScope: configuration.state === 'active' && configuration.mailboxSubject ? { expectedEnvelopeRevision: cursor?.rev ?? null, since: now } : null }, current!.data.version, current!.data.authority.generation);
    return configuration;
  }
  async function transition(kind: 'pause' | 'revoke') {
    const current = await auth.store.get<{ version: number; authority: { generation: number } }>(executionAuthorityKey(accountId));
    await command(kind, { reason: 'Explicit fictional owner stop' }, current!.data.version, current!.data.authority.generation);
  }
  async function read(body: unknown = request, credential = bearer, query = '') {
    const before = snapshot(); const providers = [...providerCalls];
    observed.length = 0; tracing = true;
    const reply = await handle(event(body, credential, query));
    tracing = false;
    expect(providerCalls).toEqual(providers);
    expect(observed.some(cmd => cmd instanceof QueryCommand)).toBe(false);
    for (const cmd of observed) {
      if (cmd instanceof GetItemCommand) {
        expect(cmd.input.ConsistentRead).toBe(true);
        expect(cmd.input.Key?.sk?.S).not.toMatch(/^(GOOGLE_|MAIL_THREAD|INTAKE|EVENT|COMMAND)/);
      }
      if (cmd instanceof TransactWriteItemsCommand) expect(cmd.input.TransactItems?.every(item => Object.keys(item).length === 1 && !!item.ConditionCheck)).toBe(true);
    }
    return { reply, before, data: JSON.parse(reply.body) };
  }
  async function unchangedRead(body: unknown = request, credential = bearer, query = '') {
    const result = await read(body, credential, query);
    expect(snapshot()).toEqual(result.before);
    return result;
  }
  return { harness, snapshot, auth, google, options, pairing, pair, bearer, handle, command, configure, transition, read, unchangedRead, observed, providerCalls,
    proofHook(hook: () => Promise<void>) { beforeProof = hook; }, failProof(error: Error) { sdkFailure = error; }, failRead() { readFailure = true; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Exact row alteration is ONLY used for corruption/absence negatives, never
 * positive acceptance or fixture admission. Keep the existing harness untouched. */
function corrupt(f: Fixture, key: string, change: (item: Record<string, AttributeValue>) => void) {
  const items = (f.harness as unknown as { items: Record<string, Record<string, AttributeValue>> }).items;
  const entry = Object.entries(items).find(([, item]) => item.sk?.S === key);
  if (!entry) throw Error('negative fixture row missing');
  change(entry[1]);
}
function removeNegative(f: Fixture, key: string) {
  const items = (f.harness as unknown as { items: Record<string, Record<string, AttributeValue>> }).items;
  const identity = Object.keys(items).find(id => items[id]?.sk?.S === key);
  if (!identity) throw Error('negative fixture row missing');
  delete items[identity];
}
type NegativeRow = { account: { id: string }; authority: { accountId: string }; workspaceId: string; research: { workspaceId: string }; scope: { accountId: string }; poll: { mailboxSubject: string }; checkpoint: { mailboxSubject: string } };
function changeData(f: Fixture, key: string, change: (value: NegativeRow) => void) {
  corrupt(f, key, item => { const data = JSON.parse(item.data!.S!); change(data); item.data = { S: JSON.stringify(data) }; });
}
function expectHeld(result: { reply: { statusCode: number }; data: unknown }, status: number, error: string) {
  expect(result.reply.statusCode).toBe(status); expect(result.data).toEqual({ error });
}
function proofKeys(f: Fixture) {
  const proofs = f.observed.filter((cmd): cmd is TransactWriteItemsCommand => cmd instanceof TransactWriteItemsCommand);
  expect(proofs).toHaveLength(1);
  const keys = proofs[0]!.input.TransactItems!.map(item => item.ConditionCheck!.Key!.sk!.S!);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toContain(`TOKEN#${secretHash(f.pairing.credential)}`);
  expect(keys).toContain(pairingKey(f.pairing.pairingId));
  const authorityCheck = proofs[0]!.input.TransactItems!.find(item => item.ConditionCheck?.Key?.sk?.S === executionAuthorityKey(accountId))!.ConditionCheck!;
  expect(Object.values(authorityCheck.ExpressionAttributeNames!)).toEqual(expect.arrayContaining(['rev', 'workspaceId', 'accountId', 'generation', 'version', 'owner', 'state']));
  return keys;
}

describe('POST /accounts/preparation fixed-row authenticated read', () => {
  it('rejects strict request violations, selectors, malformed JSON and query parameters', async () => {
    const f = await fixture();
    for (const body of [{ accountId }, { ...request, pairingId: f.pairing.pairingId }, { ...request, mailboxSubject: mailbox }, { ...request, expectedVersion: 2 }, { ...request, accountId: '' }, [], null, '{']) {
      expectHeld(await f.unchangedRead(body), 400, 'worker_invalid_request');
    }
    for (const query of ['accountId=other', 'cursor=x&cursor=y', 'purpose=permitted_correspondence']) expectHeld(await f.unchangedRead(request, f.bearer, query), 400, 'worker_invalid_request');
  });
  it('enforces exactly 1KiB UTF-8, not a character count', async () => {
    const f = await fixture(); const json = JSON.stringify(request);
    expect((await f.unchangedRead(json + ' '.repeat(1024 - Buffer.byteLength(json)))).reply.statusCode).toBe(200);
    expectHeld(await f.unchangedRead(json + ' '.repeat(1025 - Buffer.byteLength(json))), 400, 'worker_invalid_request');
    const unicode = JSON.stringify({ ...request, accountId: '界'.repeat(340) });
    expect(unicode.length).toBeLessThan(1024); expect(Buffer.byteLength(unicode)).toBeGreaterThan(1024);
    expectHeld(await f.unchangedRead(unicode), 400, 'worker_invalid_request');
  });
  it.each(['missing', 'wrong scope', 'emergency', 'revoked'] as const)('holds %s credentials without configuration disclosure', async kind => {
    const f = await fixture(); await f.configure();
    let bearer = f.bearer;
    if (kind === 'missing') bearer = '';
    if (kind === 'wrong scope') bearer = `Bearer ${(await f.pair(['commands:write'])).credential}`;
    if (kind === 'emergency') bearer = `Bearer ${f.pairing.emergencyCredential}`;
    if (kind === 'revoked') await f.auth.revokePairing(f.pairing.pairingId);
    const denied = kind === 'wrong scope' || kind === 'emergency';
    expectHeld(await f.unchangedRead(request, bearer), denied ? 403 : 401, denied ? 'worker_scope_denied' : 'worker_unauthorized');
  });
  it('denies foreign workspace and genuine other-pairing source without returning its fields', async () => {
    const f = await fixture(); await f.configure();
    expectHeld(await f.unchangedRead({ ...request, workspaceId: 'foreign' }), 403, 'worker_scope_denied');
    const other = await f.pair(['events:read']);
    expectHeld(await f.unchangedRead(request, `Bearer ${other.credential}`), 403, 'worker_scope_denied');
  });
  it.each(['ACCOUNT', 'AUTH'] as const)('holds actual missing %s instead of manufacturing local authority', async kind => {
    const f = await fixture(); removeNegative(f, kind === 'ACCOUNT' ? accountKey(accountId) : executionAuthorityKey(accountId));
    expectHeld(await f.unchangedRead(), 409, 'preparation_unavailable');
  });
  it.each(['local', 'active', 'paused', 'revoked'] as const)('displays genuine %s authority without transitioning it', async state => {
    const f = await fixture(false, state !== 'local');
    if (state === 'paused' || state === 'revoked') await f.transition(state === 'paused' ? 'pause' : 'revoke');
    const { reply, data } = await f.unchangedRead(); expect(reply.statusCode).toBe(200);
    expect(accountPreparationSchema.parse(data)).toEqual(data);
    const authority = await f.auth.store.get<{ authority: unknown; version: number }>(executionAuthorityKey(accountId));
    expect(data).toEqual({ ...request, pairingId: f.pairing.pairingId, checkedAt: now, authority: authority!.data.authority,
      executionVersion: authority!.data.version, configuration: null, mailCursor: null });
    expect(data.authority.state).toBe(state);
    expect(proofKeys(f).sort()).toEqual([accountKey(accountId), executionAuthorityKey(accountId), ownerSourceKey(accountId), pairingKey(f.pairing.pairingId), `TOKEN#${secretHash(f.pairing.credential)}`].sort());
  });
  it('returns genuine no-mail configuration in full, without no-mail eligibility or grant metadata', async () => {
    const f = await fixture(); const configuration = await f.configure();
    const { reply, data } = await f.unchangedRead(); expect(reply.statusCode).toBe(200);
    expect(data.configuration).toEqual(configuration); expect(data.mailCursor).toBeNull();
    expect(Object.keys(data).sort()).toEqual(['workspaceId', 'accountId', 'pairingId', 'checkedAt', 'authority', 'executionVersion', 'configuration', 'mailCursor'].sort());
    expect(proofKeys(f)).toHaveLength(5);
  });
  it('preserves full paused calendar/research/source fields and proves selected cursor absence', async () => {
    const f = await fixture();
    const configuration = await f.configure({ state: 'paused', mailboxSubject: mailbox, calendarId: 'fictional-calendar', research: researchConfiguration() });
    const { reply, data } = await f.unchangedRead(); expect(reply.statusCode).toBe(200);
    expect(data.configuration).toEqual(configuration);
    expect(data.mailCursor).toEqual({ mailboxSubject: mailbox, envelopeRevision: null, scope: null });
    expect(proofKeys(f)).toContain(mailCursorKey(accountId, mailbox));
  });
  it('reads configured mail without a current grant and returns envelope rev, not scope rev, after poll-only update', async () => {
    const f = await fixture(true); const configuration = await f.configure();
    const intake = new DynamoThreadIntakeRepository(f.options);
    const scope = await intake.scope(accountId, mailbox);
    await intake.beginPoll(accountId, mailbox, 'fictional-poll');
    await intake.applyPage({ complete: true, threads: [], nextCursor: { version: 1, accountId, mailboxSubject: mailbox, mode: 'history',
      historyId: '987654321', pageToken: null, since: now, scopeRevision: scope!.revision, scopeFingerprint: mailScopeFingerprint(scope!) } }, null, 'fictional-poll');
    // Genuine grant revocation is fixture setup, not a synthetic positive row.
    await f.google.revokeGoogleGrant(f.pairing.pairingId);
    const cursor = await intake.cursorState(accountId, mailbox); expect(cursor!.rev).not.toBe(scope!.revision);
    const { reply, data } = await f.unchangedRead(); expect(reply.statusCode).toBe(200);
    expect(data.configuration).toEqual(configuration);
    expect(data.mailCursor).toEqual({ mailboxSubject: mailbox, envelopeRevision: cursor!.rev, scope });
    expect(Object.keys(data.mailCursor).sort()).toEqual(['envelopeRevision', 'mailboxSubject', 'scope']);
    expect(proofKeys(f)).toHaveLength(6);
  });
  it.each(['account identity', 'authority identity', 'source workspace', 'research workspace', 'cursor identity', 'poll identity', 'checkpoint identity', 'unsafe envelope revision'] as const)('refuses corrupt %s with sanitized unavailable', async kind => {
    const f = await fixture(true); await f.configure();
    if (kind === 'research workspace') await f.configure({ state: 'paused', research: researchConfiguration() });
    if (kind === 'poll identity' || kind === 'checkpoint identity') {
      const intake = new DynamoThreadIntakeRepository(f.options); const scope = (await intake.scope(accountId, mailbox))!;
      await intake.beginPoll(accountId, mailbox, 'corruption-fixture-poll');
      await intake.applyPage({ complete: true, threads: [], nextCursor: { version: 1, accountId, mailboxSubject: mailbox, mode: 'history',
        historyId: '987654322', pageToken: null, since: now, scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) } }, null, 'corruption-fixture-poll');
      changeData(f, mailCursorKey(accountId, mailbox), data => { data[kind === 'poll identity' ? 'poll' : 'checkpoint'].mailboxSubject = 'foreign'; });
    }
    if (kind === 'unsafe envelope revision') corrupt(f, mailCursorKey(accountId, mailbox), item => { item.rev = { N: '9007199254740992' }; });
    if (kind === 'account identity') changeData(f, accountKey(accountId), data => { data.account.id = 'foreign'; });
    if (kind === 'authority identity') changeData(f, executionAuthorityKey(accountId), data => { data.authority.accountId = 'foreign'; });
    if (kind === 'source workspace') changeData(f, ownerSourceKey(accountId), data => { data.workspaceId = 'foreign'; });
    if (kind === 'research workspace') changeData(f, ownerSourceKey(accountId), data => { data.research.workspaceId = 'foreign'; });
    if (kind === 'cursor identity') changeData(f, mailCursorKey(accountId, mailbox), data => { data.scope.accountId = 'foreign'; });
    expectHeld(await f.unchangedRead(), 503, 'worker_unavailable');
  });
  it.each(['AUTH pause', 'source update', 'source creation', 'cursor poll', 'cursor creation', 'pairing revoke', 'token rotation'] as const)('holds deterministic %s race immediately before check-only proof', async kind => {
    const f = await fixture(kind === 'cursor poll');
    if (kind === 'source update' || kind === 'cursor poll') await f.configure();
    if (kind === 'cursor creation') await f.configure({ state: 'paused', mailboxSubject: mailbox });
    let afterMutation: unknown;
    f.proofHook(async () => {
      if (kind === 'AUTH pause') await f.transition('pause');
      if (kind === 'source update') await f.configure({ state: 'paused', mailboxSubject: 'switched-mailbox' });
      if (kind === 'source creation') await f.configure();
      if (kind === 'cursor poll') await new DynamoThreadIntakeRepository(f.options).beginPoll(accountId, mailbox, 'racing-poll');
      if (kind === 'cursor creation') await new DynamoThreadIntakeRepository(f.options).admitScope({ version: 1, accountId, mailboxSubject: mailbox, revision: 1,
        participantAddresses: ['team@example.invalid'], knownThreadIds: [], since: now, approvedAt: now }, null);
      if (kind === 'pairing revoke') await f.auth.revokePairing(f.pairing.pairingId);
      if (kind === 'token rotation') {
        const key = `TOKEN#${secretHash(f.pairing.credential)}`; const token = await f.auth.store.get<Record<string, unknown>>(key);
        await f.auth.store.transact([f.auth.store.put(key, { ...token!.data, generation: 1 }, token!.rev)]);
      }
      afterMutation = f.snapshot();
    });
    // Harness throws plain Error, not an SDK ConditionalCheckFailed reason.
    expectHeld(await f.read(), 503, 'worker_unavailable');
    expect(f.snapshot()).toEqual(afterMutation);
    expect(proofKeys(f).length).toBeGreaterThanOrEqual(5);
  });
  it('distinguishes structured conditional conflict from opaque infrastructure failures without leaking messages', async () => {
    for (const conditional of [false, true]) {
      const f = await fixture();
      const error = Object.assign(Error('private-token https://private.invalid provider payload'), conditional ? {
        name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed', Message: 'private-token' }] } : { name: 'TransactionCanceledException' });
      f.failProof(error);
      expectHeld(await f.unchangedRead(), conditional ? 409 : 503, conditional ? 'preparation_changed' : 'worker_unavailable');
    }
    const f = await fixture(); f.failRead();
    expectHeld(await f.unchangedRead(), 503, 'worker_unavailable');
  });
  it('production route does not initialize optional broken Google/SSM or call providers', async () => {
    const f = await fixture(); let externalCalls = 0;
    const production = createProductionHandler({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: f.options.tableName,
      DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_WORKER_HOST: host, AWS_REGION: 'us-east-1', DELEGATED_GOOGLE_CLIENT_ID: 'broken-partial-config' },
    { dynamo: f.options.dynamo, ssm: { async send() { externalCalls++; throw Error('SSM forbidden'); } }, fetch: async () => { externalCalls++; throw Error('provider forbidden'); } });
    const before = f.snapshot(); const offset = f.harness.transactions.length;
    const reply = await production(event(request, f.bearer)); expect(reply.statusCode).toBe(200);
    expect(accountPreparationSchema.parse(JSON.parse(reply.body))).toMatchObject({ ...request, pairingId: f.pairing.pairingId, configuration: null });
    expect(externalCalls).toBe(0); expect(f.snapshot()).toEqual(before);
    expect(f.harness.transactions.slice(offset).flatMap(tx => tx.TransactItems ?? []).every(item => !!item.ConditionCheck)).toBe(true);
  });
  it('strict shared request/reply contracts reject extra fields, unsafe versions and mismatched nested identities', async () => {
    const f = await fixture(true); await f.configure(); const { data } = await f.unchangedRead();
    expect(getAccountPreparationSchema.safeParse({ accountId }).success).toBe(true);
    expect(getAccountPreparationSchema.safeParse({ ...request }).success).toBe(false);
    expect(accountPreparationRequestSchema.safeParse({ ...request, pairingId: 'caller' }).success).toBe(false);
    expect(accountPreparationSchema.safeParse(data).success).toBe(true);
    for (const value of [{ ...data, grant: {} }, { ...data, executionVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...data, authority: { ...data.authority, accountId: 'foreign' } },
      { ...data, configuration: { ...data.configuration, pairingId: 'foreign' } },
      { ...data, mailCursor: { ...data.mailCursor, mailboxSubject: 'foreign' } },
      { ...data, mailCursor: { ...data.mailCursor, envelopeRevision: null } },
      { ...data, mailCursor: { ...data.mailCursor, checkpoint: {} } }]) expect(accountPreparationSchema.safeParse(value).success).toBe(false);
  });
});
