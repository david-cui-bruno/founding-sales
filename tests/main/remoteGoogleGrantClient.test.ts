import { expect, it, vi } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { googleGrantDisclosure, googleScopes, personalGoogleGrantDisclosure } from '../../src/shared/contracts/googleGrantCapabilities';
import type { RemoteGoogleGrantBegin } from '../../src/shared/contracts/remoteGoogleGrantContract';

const work: RemoteGoogleGrantBegin = { purpose: 'permitted_correspondence', capabilities: ['send', 'relevant_read'], disclosureVersion: googleGrantDisclosure.version, expectedEmail: 'founder@usecali.com' };
const personal: RemoteGoogleGrantBegin = { purpose: 'personal_availability', capabilities: ['availability'], disclosureVersion: personalGoogleGrantDisclosure.version, availabilityCalendars: { calendarIds: ['founder@gmail.com'], confirmed: true } };
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await createPmFixture();
  try {
    const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'grant-fixture', workspaceId: 'grant-workspace', clock: { now: () => PM_NOW } });
    const pairing = await auth.redeemPairing((await auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 })).code, 'fixture');
    const provider = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String(init?.body)); const account = body.get('code') ?? body.get('refresh_token');
        if (account !== 'work' && account !== 'personal') throw Error('Unexpected synthetic account');
        return new Response(JSON.stringify({ access_token: account, refresh_token: account, token_type: 'Bearer', expires_in: 3600,
          scope: ['openid', 'email', ...(account === 'work' ? [googleScopes.send, googleScopes.relevant_read] : [googleScopes.availability])].join(' ') }));
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        const account = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
        if (account !== 'work' && account !== 'personal') throw Error('Unexpected synthetic bearer');
        return new Response(JSON.stringify({ sub: `${account}-subject`, email: account === 'work' ? 'founder@usecali.com' : 'founder@gmail.com', email_verified: true }));
      }
      if (url === 'https://oauth2.googleapis.com/revoke') return new Response('');
      throw Error('Unexpected provider operation');
    });
    const google = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fictional-secret', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 4) }, fetch: provider });
    const handler = createWorkerHandler({ auth, google, host: 'worker.example.test' });
    const requests: string[] = [];
    let mutate: ((path: string, value: unknown) => unknown) | undefined;
    const invoke = async (path: string, method = 'GET', body?: unknown, authorization = `Bearer ${pairing.credential}`) => {
      const url = new URL(path, 'https://worker.example.test');
      return handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { domainName: url.host, http: { method, sourceIp: 'fixture' } } });
    };
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://worker.example.test' || init?.redirect !== 'error' || init.cache !== 'no-store') throw Error('Unexpected transport');
      requests.push(url.pathname + url.search);
      const reply = await invoke(url.pathname + url.search, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined, new Headers(init?.headers).get('authorization') ?? '');
      const data = reply.headers['Content-Type'] === 'text/plain; charset=utf-8' ? reply.body : JSON.parse(reply.body);
      return new Response(JSON.stringify(mutate ? mutate(url.pathname, data) : data), { status: reply.statusCode });
    };
    const client = new ExecutionClient({ pairing: { credential: pairing.credential, endpoint: 'https://worker.example.test', workspaceId: 'grant-workspace' }, repository: new DelegationRepository({ database: f.db, workspaceId: 'grant-workspace', clock: { now: () => PM_NOW } }), transport: new SqlDelegationTransport({ database: f.db, workspaceId: 'grant-workspace', pairingId: pairing.pairingId, clock: { now: () => PM_NOW } }), fetch: http });
    const authorize = async (input: RemoteGoogleGrantBegin, account: 'work' | 'personal') => {
      const result = await client.beginGoogleGrant(input, signal()); const url = new URL(result.authorizationUrl);
      const callback = await invoke(`/oauth/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=${account}`);
      expect(callback.statusCode).toBe(200); return client.googleGrantStatus(input.purpose ?? 'permitted_correspondence', signal());
    };
    return { ...f, auth, google, client, requests, provider, invoke, authorize, mutate(value: typeof mutate) { mutate = value; } };
  } catch (error) { f.close(); throw error; }
}

it('uses actual paired client and authenticated routes for distinct work and personal grants without local mail writes or cross-slot revocation', async () => {
  const f = await fixture();
  try {
    expect(await f.client.googleGrantStatus('personal_availability', signal())).toEqual({ state: 'unconfigured', grant: null });
    expect(await f.client.googleGrantDisclosure('personal_availability', signal())).toEqual(personalGoogleGrantDisclosure);
    expect(await f.client.googleGrantDisclosure('permitted_correspondence', signal())).toEqual(googleGrantDisclosure);
    expect((await f.authorize(work, 'work')).grant).toMatchObject({ subject: 'work-subject', purpose: 'permitted_correspondence', email: 'founder@usecali.com' });
    const before = await f.auth.store.list('GOOGLE_GRANT#'); expect(before).toHaveLength(1);
    const result = await f.authorize(personal, 'personal');
    expect(result.grant).toMatchObject({ subject: 'personal-subject', purpose: 'personal_availability', capabilities: ['availability'] });
    expect(result.grant?.grantedScopes).not.toContain(googleScopes.send);
    expect(result.grant?.grantedScopes).not.toContain(googleScopes.relevant_read);
    expect(result.grant?.grantedScopes).not.toContain(googleScopes.event_write);
    const rows = await f.auth.store.list('GOOGLE_GRANT#'); expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(before[0]);
    expect(await f.client.revokeGoogleGrant('personal_availability', signal())).toMatchObject({ state: 'revoked', providerRevocation: 'confirmed' });
    expect((await f.client.googleGrantStatus('permitted_correspondence', signal())).state).toBe('ready');
    expect(await f.auth.store.list('GOOGLE_GRANT#')).toContainEqual(before[0]);
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|ciphertext|verifier|accessEvidence/);
    expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

it('rejects wrong-purpose responses, token-bearing status, unsafe authorization URLs and aborted requests without automatic retry', async () => {
  const f = await fixture();
  try {
    const saved = await f.authorize(work, 'work');
    f.mutate(path => path === '/google/status' ? saved : {});
    await expect(f.client.googleGrantStatus('personal_availability', signal())).rejects.toThrow();
    f.mutate(() => ({ ...saved, accessToken: 'fictional-forbidden-token' }));
    await expect(f.client.googleGrantStatus('permitted_correspondence', signal())).rejects.toThrow();
    f.mutate(() => ({ authorizationUrl: 'https://attacker.invalid/authorize' }));
    const before = f.requests.length;
    await expect(f.client.beginGoogleGrant(personal, signal())).rejects.toThrow();
    expect(f.requests).toHaveLength(before + 1);
    const controller = new AbortController(); controller.abort();
    await expect(f.client.googleGrantStatus('permitted_correspondence', controller.signal)).rejects.toThrow();
    expect(f.requests).toHaveLength(before + 1);
  } finally { f.close(); }
});

it.each([
  ['include_granted_scopes', 'true'], ['include_granted_scopes', null],
  ['access_type', 'online'], ['prompt', 'none'], ['unknown_consent_option', 'true'],
] as const)('rejects authorization consent parameter %s=%s without retry', async (key, value) => {
  const f = await fixture();
  try {
    f.mutate((path, data) => {
      if (path !== '/google/begin') return data;
      const url = new URL((data as { authorizationUrl: string }).authorizationUrl);
      if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
      return { authorizationUrl: url.href };
    });
    await expect(f.client.beginGoogleGrant(personal, signal())).rejects.toThrow();
    expect(f.requests).toEqual(['/google/begin']);
    expect(f.provider).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it('keeps old route defaults and refuses malformed purpose, disclosure, callback overrides and unauthorized access', async () => {
  const f = await fixture();
  try {
    expect(JSON.parse((await f.invoke('/google/status')).body)).toEqual({ state: 'unconfigured', grant: null });
    for (const path of ['/google/status?purpose=anything', '/google/status?purpose=personal_availability&purpose=permitted_correspondence', '/google/disclosure?purpose=anything', '/oauth/callback?state=fictional&code=fictional&purpose=personal_availability']) {
      expect((await f.invoke(path)).statusCode).toBe(400);
    }
    expect((await f.invoke('/google/status?purpose=personal_availability', 'GET', undefined, '')).statusCode).toBe(401);
    expect((await f.invoke('/google/begin', 'POST', { ...personal, capabilities: ['send'] })).statusCode).toBe(400);
    expect((await f.invoke('/google/begin', 'POST', { ...personal, disclosureVersion: googleGrantDisclosure.version })).statusCode).toBe(400);
    expect((await f.invoke('/google/revoke', 'POST', {})).statusCode).toBe(200);
    expect(JSON.parse((await f.invoke('/google/status?purpose=personal_availability')).body)).toEqual({ state: 'unconfigured', grant: null });
    expect(f.provider).not.toHaveBeenCalled();
  } finally { f.close(); }
});
