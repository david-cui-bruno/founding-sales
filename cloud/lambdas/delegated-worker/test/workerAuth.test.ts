import { GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { WorkerAuth } from '../src/workerAuth';
import { ConditionalCommandHarness } from './sdkHarness';
import { DynamoExecutionRepository } from '../src/executionRepository';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function fixture() {
  const dynamo = new ConditionalCommandHarness();
  let now = '2026-09-08T00:00:00.000Z';
  const options = { dynamo, tableName: 'fictional-worker', workspaceId: 'fictional-workspace', clock: { now: () => now } };
  return { dynamo, options, auth: new WorkerAuth(options), advance: () => { now = '2026-09-08T00:20:00.000Z'; } };
}
describe('durable scoped worker pairing', () => {
  it('redeems once across independent auth instances and stores only credential hashes', async () => {
    const f = fixture();
    const bootstrap = await f.auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant', 'pairing:revoke'], expiresInSeconds: 300 });
    const grant = await f.auth.redeemPairing(bootstrap.code, 'fictional-source');
    expect(Buffer.from(grant.credential, 'base64url')).toHaveLength(32);
    expect(Buffer.from(grant.emergencyCredential, 'base64url')).toHaveLength(32);
    expect(grant.emergencyCredential).not.toBe(grant.credential);
    expect(grant.workspaceId).toBe(f.options.workspaceId);
    const stored = JSON.stringify(f.dynamo.transactions);
    expect(stored).not.toContain(grant.credential);
    expect(stored).not.toContain(grant.emergencyCredential);
    expect(stored).not.toContain(bootstrap.code);
    expect(stored).toContain(digest(grant.credential));
    await expect(new WorkerAuth(f.options).redeemPairing(bootstrap.code, 'fictional-source')).rejects.toThrow('pairing_unavailable');
  });
  it('has a single transaction winner under competing redemption', async () => {
    const f = fixture();
    const { code } = await f.auth.issuePairing({ scopes: ['events:read'], expiresInSeconds: 300 });
    let firstRead!: () => void; const firstReady = new Promise<void>(resolve => { firstRead = resolve; });
    let release!: () => void; const bothReady = new Promise<void>(resolve => { release = resolve; }); let arrivals = 0;
    const competing = new WorkerAuth({ ...f.options, dynamo: { send: async command => {
      const result = await f.dynamo.send(command);
      if (command instanceof GetItemCommand && command.input.Key?.sk?.S?.startsWith('BOOTSTRAP#')) {
        arrivals++; if (arrivals === 1) firstRead(); else release(); await bothReady;
      }
      return result;
    } } });
    const first = competing.redeemPairing(code, 'one'); await firstReady;
    const results = await Promise.allSettled([first, competing.redeemPairing(code, 'two')]);
    expect(arrivals).toBe(2);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const transactions = f.dynamo.transactions.filter(t => (t.TransactItems?.length ?? 0) >= 4);
    expect(transactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(transactions)).toContain('ConditionExpression');
  });
  it('refuses expired and wrong-workspace codes', async () => {
    const f = fixture();
    const { code } = await f.auth.issuePairing({ scopes: ['events:read'], expiresInSeconds: 60 });
    await expect(new WorkerAuth({ ...f.options, workspaceId: 'another-workspace' }).redeemPairing(code, 'fixture')).rejects.toThrow('pairing_unavailable');
    f.advance();
    await expect(f.auth.redeemPairing(code, 'fixture')).rejects.toThrow('pairing_unavailable');
  });
  it('rate limits invalid redemption durably across instances', async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) await expect(new WorkerAuth(f.options).redeemPairing('A'.repeat(43), 'same-source')).rejects.toThrow('pairing_unavailable');
    await expect(f.auth.redeemPairing('A'.repeat(43), 'same-source')).rejects.toThrow('pairing_rate_limited');
  });
  it('separates emergency powers and checks revocation on each request', async () => {
    const f = fixture();
    const { code } = await f.auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const grant = await f.auth.redeemPairing(code, 'fixture');
    expect((await f.auth.authenticate(`Bearer ${grant.credential}`, ['commands:write'])).pairingId).toBe(grant.pairingId);
    await expect(f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, ['commands:write'])).rejects.toThrow('worker_scope_denied');
    await expect(f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, ['events:read'])).rejects.toThrow('worker_scope_denied');
    expect((await f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, ['emergency:stop'])).kind).toBe('emergency');
    await f.auth.revokePairing(grant.pairingId);
    await expect(f.auth.authenticate(`Bearer ${grant.credential}`, [])).rejects.toThrow('worker_unauthorized');
    await expect(f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, [])).rejects.toThrow('worker_unauthorized');
  });
  it('fences actual C1 mutation against revocation between authorization and commit', async () => {
    const f = fixture();
    const { code } = await f.auth.issuePairing({ scopes: ['commands:write'], expiresInSeconds: 300 });
    const grant = await f.auth.redeemPairing(code, 'fixture');
    const principal = await f.auth.authenticate(`Bearer ${grant.credential}`, ['commands:write']);
    const base = new DynamoExecutionRepository(f.options);
    await base.seedLocalAuthority('fictional-account');
    const repository = new DynamoExecutionRepository({ ...f.options, dynamo: f.auth.fencedDynamo(principal) });
    await f.auth.revokePairing(grant.pairingId);
    await expect(repository.applyCommand({ commandId: 'fictional-command', accountId: 'fictional-account', workspaceId: f.options.workspaceId,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fictional-delegation', approvedAt: f.options.clock.now() } })).rejects.toThrow('worker_unauthorized');
    expect(f.dynamo.inspect('AUTH#fictional-account')).toMatchObject({ authority: { owner: 'local', generation: 0 } });
  });
});

describe('actual authenticated worker HTTP composition', () => {
  it('binds commands to real C1, scopes emergency stop, rejects insecure/headerless and wrong workspace requests', async () => {
    const { createWorkerHandler } = await import('../src/handler');
    const f = fixture(); const bootstrap = await f.auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const handler = createWorkerHandler({ auth: f.auth, host: 'worker.example.test' });
    const event = (path: string, body?: unknown, credential?: string, method = 'POST') => ({ version: '2.0', rawPath: path, rawQueryString: '',
      headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      requestContext: { domainName: 'worker.example.test', http: { method, sourceIp: 'fictional-source' } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const redeemed = await handler(event('/pairing/redeem', { code: bootstrap.code }));
    expect(redeemed.statusCode).toBe(200);
    const pair = JSON.parse(redeemed.body);
    await new DynamoExecutionRepository(f.options).seedLocalAuthority('fictional-account');
    const command = { commandId: 'fictional-delegate', accountId: 'fictional-account', workspaceId: f.options.workspaceId,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fictional-delegation', approvedAt: f.options.clock.now() } };
    expect((await handler(event('/commands', command))).statusCode).toBe(401);
    const insecure = event('/commands', command, pair.credential); insecure.headers['x-forwarded-proto'] = 'http';
    expect((await handler(insecure)).statusCode).toBe(400);
    expect((await handler(event('/commands', { ...command, workspaceId: 'other' }, pair.credential))).statusCode).toBe(400);
    expect((await handler(event('/commands', command, pair.emergencyCredential))).statusCode).toBe(403);
    expect((await handler(event('/emergency', command, pair.emergencyCredential))).statusCode).toBe(403);
    expect((await handler(event('/commands', command, pair.credential))).statusCode).toBe(200);
    const pause = { ...command, commandId: 'fictional-pause', expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'pause', payload: { reason: 'Operator stop' } };
    const stop = { commandId: pause.commandId, accountId: pause.accountId, kind: 'pause', reason: 'Operator stop' };
    const stopped = await handler(event('/emergency', stop, pair.emergencyCredential));
    expect(stopped.statusCode).toBe(200);
    expect(await handler(event('/emergency', stop, pair.emergencyCredential))).toEqual(stopped);
    expect((await handler(event('/emergency', { ...stop, reason: 'changed' }, pair.emergencyCredential))).statusCode).toBe(400);
    expect(f.dynamo.inspect('AUTH#fictional-account')).toMatchObject({ authority: { state: 'paused', owner: 'worker' } });
    expect((await handler(event('/events', undefined, pair.emergencyCredential, 'GET'))).statusCode).toBe(403);
    const events = await handler(event('/events', undefined, pair.credential, 'GET'));
    expect(JSON.parse(events.body).events).toHaveLength(2);
    const queryToken = event('/events', undefined, undefined, 'GET'); queryToken.rawQueryString = `token=${pair.credential}`;
    const rejected = await handler(queryToken); expect(rejected.statusCode).toBe(400); expect(rejected.body).not.toContain(pair.credential);
  });
  it('production entry is inert when disabled and constructs actual adapters only behind activation', async () => {
    const { createProductionServices, handler } = await import('../src/handler');
    expect(await createProductionServices({})).toBeNull();
    expect((await handler({})).statusCode).toBe(503);
  });
});

describe('production secure parameter composition', () => {
  it('constructs the real durable OAuth flow with only SDK/provider boundaries replaced', async () => {
    const { createProductionServices } = await import('../src/handler');
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const f = fixture(); const reads: string[] = [];
    const env = { DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: f.options.tableName, DELEGATED_WORKSPACE_ID: f.options.workspaceId,
      DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1', DELEGATED_GOOGLE_CLIENT_ID: 'fictional.apps.googleusercontent.com',
      DELEGATED_GOOGLE_SECRET_PARAMETER: `/delegated-worker/${f.options.workspaceId}/google-client-secret`, DELEGATED_GOOGLE_KEY_PARAMETER: `/delegated-worker/${f.options.workspaceId}/token-encryption-key` };
    const services = await createProductionServices(env, { dynamo: f.dynamo, ssm: { send: async command => {
      expect(command).toBeInstanceOf(GetParameterCommand); expect(command.input.WithDecryption).toBe(true); reads.push(command.input.Name!);
      return { $metadata: {}, Parameter: { Type: 'SecureString', Value: command.input.Name?.endsWith('token-encryption-key') ? Buffer.alloc(32, 9).toString('base64') : 'fictional-secret' } };
    } }, fetch: async url => String(url).endsWith('/token')
      ? Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.send' })
      : Response.json({ sub: 'fixture-sub', email: 'operator@example.test', email_verified: true }) });
    expect(reads.sort()).toEqual([env.DELEGATED_GOOGLE_SECRET_PARAMETER, env.DELEGATED_GOOGLE_KEY_PARAMETER].sort());
    const bootstrap = await services!.auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 });
    const pairing = await services!.auth.redeemPairing(bootstrap.code, 'fixture');
    const url = new URL((await services!.google.beginGoogleGrant(pairing.pairingId, ['send'])).authorizationUrl);
    expect(await services!.google.completeGoogleGrant(url.searchParams.get('state')!, 'fixture-code')).toMatchObject({ state: 'ready', grant: { subject: 'fixture-sub' } });
  });
  it('keeps emergency authentication available when optional Google parameters are unavailable', async () => {
    const { createProductionHandler } = await import('../src/handler');
    const f = fixture(); const bootstrap = await f.auth.issuePairing({ scopes: ['commands:write'], expiresInSeconds: 300 });
    const pair = await f.auth.redeemPairing(bootstrap.code, 'fixture');
    const handler = createProductionHandler({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: f.options.tableName,
      DELEGATED_WORKSPACE_ID: f.options.workspaceId, DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1',
      DELEGATED_GOOGLE_CLIENT_ID: 'fictional.apps.googleusercontent.com', DELEGATED_GOOGLE_SECRET_PARAMETER: 'unavailable', DELEGATED_GOOGLE_KEY_PARAMETER: 'unavailable' },
    { dynamo: f.dynamo, ssm: { send: async () => { throw new Error('SSM unavailable'); } } });
    const response = await handler({ version: '2.0', rawPath: '/emergency', rawQueryString: '', headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${pair.emergencyCredential}` },
      requestContext: { domainName: 'worker.example.test', http: { method: 'POST', sourceIp: 'fixture' } }, body: JSON.stringify({ commandId: 'stop', accountId: 'absent', kind: 'pause', reason: 'Stop' }) });
    // Authenticated domain refusal, not a Google/SSM availability failure.
    expect(response.statusCode).toBe(400); expect(response.body).toContain('worker_request_rejected');
  });
});

describe('atomic current auth fences', () => {
  it('refuses revocation committed after auth checks but before the actual C1 transaction', async () => {
    const f = fixture(); const { code } = await f.auth.issuePairing({ scopes: ['commands:write'], expiresInSeconds: 300 });
    const pair = await f.auth.redeemPairing(code, 'fixture');
    await new DynamoExecutionRepository(f.options).seedLocalAuthority('account');
    let armed = true;
    const racingAuth = new WorkerAuth({ ...f.options, dynamo: { send: async command => {
      if (armed && command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S === 'AUTH#account')) {
        armed = false; await f.auth.revokePairing(pair.pairingId);
      }
      return f.dynamo.send(command);
    } } });
    const principal = await racingAuth.authenticate(`Bearer ${pair.credential}`, ['commands:write']);
    const repository = new DynamoExecutionRepository({ ...f.options, dynamo: racingAuth.fencedDynamo(principal) });
    await expect(repository.applyCommand({ commandId: 'delegate', accountId: 'account', workspaceId: f.options.workspaceId, expectedAuthorityGeneration: 0, expectedVersion: 0,
      kind: 'delegate', payload: { delegationId: 'delegation', approvedAt: f.options.clock.now() } })).rejects.toThrow();
    expect(f.dynamo.inspect('AUTH#account')).toMatchObject({ authority: { owner: 'local', generation: 0 } });
    expect(f.dynamo.inspect('COMMAND#delegate')).toBeUndefined();
  });
});

describe('credential rotation on the existing pairing', () => {
  const event = (path: string, body?: unknown, credential?: string, method = 'POST') => ({ version: '2.0', rawPath: path, rawQueryString: '',
    headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    requestContext: { domainName: 'worker.example.test', http: { method, sourceIp: 'fictional-source' } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const desktopScopes = ['commands:write', 'events:read'] as const;
  const widened = ['commands:write', 'events:read', 'google:grant', 'pairing:revoke'] as const;
  async function paired() {
    const { createWorkerHandler } = await import('../src/handler');
    const f = fixture();
    const bootstrap = await f.auth.issuePairing({ scopes: [...desktopScopes], expiresInSeconds: 300 });
    const handler = createWorkerHandler({ auth: f.auth, host: 'worker.example.test' });
    const first = JSON.parse((await handler(event('/pairing/redeem', { code: bootstrap.code }))).body) as { pairingId: string; credential: string; emergencyCredential: string; generation: number };
    return { ...f, handler, first };
  }
  it('rotates once through the real handler: same pairing id, next generation, new scopes, old credentials refused', async () => {
    const f = await paired();
    // Before rotation the pairing lacks google:grant, so every /google route is refused by scope.
    expect((await f.handler(event('/google/status', undefined, f.first.credential, 'GET'))).statusCode).toBe(403);
    const rotation = await f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...widened], expiresInSeconds: 300 });
    expect(rotation).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), pairingId: f.first.pairingId, generation: 0 });
    const redeemed = await f.handler(event('/pairing/redeem', { code: rotation.code }));
    expect(redeemed.statusCode).toBe(200);
    const grant = JSON.parse(redeemed.body) as { pairingId: string; workspaceId: string; credential: string; emergencyCredential: string; generation: number; scopes: string[] };
    expect(grant).toMatchObject({ pairingId: f.first.pairingId, workspaceId: f.options.workspaceId, generation: 1, scopes: [...widened] });
    expect(grant.credential).not.toBe(f.first.credential);
    expect(grant.emergencyCredential).not.toBe(f.first.emergencyCredential);
    expect(f.dynamo.inspect(`PAIRING#${f.first.pairingId}`)).toEqual({ pairingId: f.first.pairingId, generation: 1, revoked: false });
    // The old device and emergency credentials die with generation 0 the moment the transaction commits.
    expect((await f.handler(event('/events', undefined, f.first.credential, 'GET'))).statusCode).toBe(401);
    await expect(f.auth.authenticate(`Bearer ${f.first.emergencyCredential}`, ['emergency:stop'])).rejects.toThrow('worker_unauthorized');
    // The new device credential carries the scopes it lacked; the new emergency credential carries only emergency:stop.
    expect((await f.handler(event('/events', undefined, grant.credential, 'GET'))).statusCode).toBe(200);
    expect((await f.auth.authenticate(`Bearer ${grant.credential}`, ['google:grant', 'pairing:revoke'])).generation).toBe(1);
    expect((await f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, ['emergency:stop'])).kind).toBe('emergency');
    await expect(f.auth.authenticate(`Bearer ${grant.emergencyCredential}`, ['commands:write'])).rejects.toThrow('worker_scope_denied');
    // Replay of the consumed rotation code is refused (the handler's fixed 400 for pairing_unavailable) and changes nothing.
    expect((await f.handler(event('/pairing/redeem', { code: rotation.code }))).statusCode).toBe(400);
    expect(f.dynamo.inspect(`PAIRING#${f.first.pairingId}`)).toEqual({ pairingId: f.first.pairingId, generation: 1, revoked: false });
    // Stored records never contain a plaintext code or credential.
    const stored = JSON.stringify(f.dynamo.dump());
    for (const secret of [rotation.code, grant.credential, grant.emergencyCredential]) expect(stored).not.toContain(secret);
  });
  it('refuses a rotation for a revoked or unknown pairing, at issue and at redeem', async () => {
    const f = await paired();
    const rotation = await f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...desktopScopes, 'google:grant'], expiresInSeconds: 300 });
    await f.auth.revokePairing(f.first.pairingId);
    expect((await f.handler(event('/pairing/redeem', { code: rotation.code }))).statusCode).toBe(400);
    expect(f.dynamo.inspect(`PAIRING#${f.first.pairingId}`)).toEqual({ pairingId: f.first.pairingId, generation: 1, revoked: true });
    await expect(f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...desktopScopes], expiresInSeconds: 300 })).rejects.toThrow('pairing_unavailable');
    await expect(f.auth.issueRotation({ pairingId: '00000000-0000-4000-8000-000000000000', scopes: [...desktopScopes], expiresInSeconds: 300 })).rejects.toThrow('pairing_unavailable');
    expect(f.dynamo.dump().filter(item => item.sk?.S?.startsWith('BOOTSTRAP#'))).toHaveLength(2);
  });
  it('refuses a rotation scope set that drops a desktop scope or adds emergency powers', async () => {
    const f = await paired();
    await expect(f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: ['events:read', 'google:grant'], expiresInSeconds: 300 })).rejects.toThrow('worker_scope_denied');
    await expect(f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: ['commands:write', 'google:grant'], expiresInSeconds: 300 })).rejects.toThrow('worker_scope_denied');
    await expect(f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...desktopScopes, 'emergency:stop'], expiresInSeconds: 300 })).rejects.toThrow('worker_scope_denied');
    expect(f.dynamo.dump().filter(item => item.sk?.S?.startsWith('BOOTSTRAP#'))).toHaveLength(1);
  });
  it('keeps a plain bootstrap creating a fresh pairing at generation 0 beside a rotated one', async () => {
    const f = await paired();
    const rotation = await f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...desktopScopes, 'google:grant'], expiresInSeconds: 300 });
    expect((await f.handler(event('/pairing/redeem', { code: rotation.code }))).statusCode).toBe(200);
    const fresh = await f.auth.issuePairing({ scopes: [...desktopScopes], expiresInSeconds: 300 });
    const grant = JSON.parse((await f.handler(event('/pairing/redeem', { code: fresh.code }))).body) as { pairingId: string; generation: number };
    expect(grant.pairingId).not.toBe(f.first.pairingId);
    expect(grant.generation).toBe(0);
    expect(f.dynamo.inspect(`PAIRING#${f.first.pairingId}`)).toEqual({ pairingId: f.first.pairingId, generation: 1, revoked: false });
  });
  it('lets exactly one of two competing rotation redemptions commit', async () => {
    const f = await paired();
    const rotation = await f.auth.issueRotation({ pairingId: f.first.pairingId, scopes: [...desktopScopes, 'google:grant'], expiresInSeconds: 300 });
    let firstRead!: () => void; const firstReady = new Promise<void>(resolve => { firstRead = resolve; });
    let release!: () => void; const bothReady = new Promise<void>(resolve => { release = resolve; }); let arrivals = 0;
    const competing = new WorkerAuth({ ...f.options, dynamo: { send: async command => {
      const result = await f.dynamo.send(command);
      if (command instanceof GetItemCommand && command.input.Key?.sk?.S?.startsWith('PAIRING#')) {
        arrivals++; if (arrivals === 1) firstRead(); else release(); await bothReady;
      }
      return result;
    } } });
    const first = competing.redeemPairing(rotation.code, 'one'); await firstReady;
    const results = await Promise.allSettled([first, competing.redeemPairing(rotation.code, 'two')]);
    expect(arrivals).toBe(2);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.dynamo.inspect(`PAIRING#${f.first.pairingId}`)).toEqual({ pairingId: f.first.pairingId, generation: 1, revoked: false });
    expect(f.dynamo.dump().filter(item => item.sk?.S?.startsWith('TOKEN#'))).toHaveLength(4);
  });
});
