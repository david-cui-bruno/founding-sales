import { describe, expect, it } from 'vitest';
import { createWorkerHandler } from '../src/handler';
import { RemoteGoogleAuthorization, senderFirstSendKey } from '../src/remoteGoogleAuthorization';
import { dispatchCapPolicyKey } from '../src/dispatchRepository';
import { googleGrantDisclosure, googleScopes } from '../src/googleGrantCapabilities';
import { SENDER_RAMP_DEFAULT, senderCapForDay } from '../../../../src/shared/contracts/workerPolicyContract';
import { remoteGoogleGrantStatusSchema } from '../../../../src/shared/contracts/remoteGoogleGrantContract';
import { WorkerAuth } from '../src/workerAuth';
import { DynamoStore } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';

const host = 'worker.example.test';
const mailbox = 'callie@usecallie.com';
// Deliberately fictional. No value here is or resembles a real client id, secret, key or token.
const accessTokenValue = 'fictional-access-token';
const refreshTokenValue = 'fictional-refresh-token';

function fixture() {
  const dynamo = new ConditionalCommandHarness();
  let now = '2026-09-18T09:00:00.000Z';
  const options = { dynamo, tableName: 'fictional-worker', workspaceId: 'fictional-workspace', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const store = new DynamoStore(options);
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (!body.get('code_verifier')) throw new Error('unconfigured fictional boundary');
      return Response.json({ access_token: accessTokenValue, refresh_token: refreshTokenValue, token_type: 'Bearer',
        expires_in: 3600, scope: `openid email ${googleScopes.send} ${googleScopes.relevant_read}` });
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'fictional-subject', email: mailbox, email_verified: true });
    throw new Error('unconfigured fictional boundary');
  };
  const google = new RemoteGoogleAuthorization({ auth, fetch,
    config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional-secret',
      redirectUri: `https://${host}/oauth/callback`, encryptionKey: Buffer.alloc(32, 7) } });
  return { auth, store, dynamo, calls, options, google,
    handler: createWorkerHandler({ auth, host, google }),
    unconfigured: createWorkerHandler({ auth, host }),
    advance: (value: string) => { now = value; },
    event: (path: string, method = 'POST', body?: unknown, credential?: string, rawQueryString = '') => ({
      version: '2.0', rawPath: path, rawQueryString,
      headers: { host, 'x-forwarded-proto': 'https', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      requestContext: { domainName: host, http: { method, sourceIp: 'fictional-source' } },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) };
}
type Fixture = ReturnType<typeof fixture>;
async function paired(f: Fixture) {
  const { code } = await f.auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 });
  const redeemed = await f.handler(f.event('/pairing/redeem', 'POST', { code }));
  expect(redeemed.statusCode).toBe(200);
  return JSON.parse(redeemed.body) as { pairingId: string; credential: string };
}
async function connected(f: Fixture, pair: { credential: string }) {
  const begun = await f.handler(f.event('/google/begin', 'POST',
    { capabilities: ['send', 'relevant_read'], disclosureVersion: googleGrantDisclosure.version, expectedEmail: mailbox }, pair.credential));
  expect(begun.statusCode).toBe(200);
  const url = new URL(JSON.parse(begun.body).authorizationUrl);
  const state = url.searchParams.get('state')!;
  const callback = await f.handler(f.event('/oauth/callback', 'GET', undefined, undefined, `state=${encodeURIComponent(state)}&code=fictional-code`));
  expect(callback.statusCode).toBe(200);
  return { url, state };
}
const statusOf = async (f: Fixture, pair: { credential: string }) => {
  const reply = await f.handler(f.event('/google/status', 'GET', undefined, pair.credential, 'purpose=permitted_correspondence'));
  expect(reply.statusCode).toBe(200);
  return { parsed: remoteGoogleGrantStatusSchema.parse(JSON.parse(reply.body)), body: reply.body };
};

describe('worker-held Google client for the named company mailbox', () => {
  it('walks begin to callback to a ready grant on the real handler routes', async () => {
    const f = fixture(); const pair = await paired(f);
    const { url } = await connected(f, pair);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`https://${host}/oauth/callback`);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', googleScopes.send, googleScopes.relevant_read]);
    const { parsed, body } = await statusOf(f, pair);
    expect(parsed.state).toBe('ready');
    expect(parsed.grant).toMatchObject({ email: mailbox, owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['send', 'relevant_read'] });
    // The status reply is a read of recorded facts. No token material may travel on it.
    expect(body).not.toContain(accessTokenValue);
    expect(body).not.toContain(refreshTokenValue);
    expect(body.toLowerCase()).not.toContain('token');
    expect(Object.keys(parsed).filter(key => /token|secret|credential/i.test(key))).toEqual([]);
    expect(JSON.stringify(f.dynamo.transactions)).not.toContain(refreshTokenValue);
  });
  it('refuses a callback whose state was never issued and leaves no grant', async () => {
    const f = fixture(); const pair = await paired(f);
    const wrong = 'A'.repeat(43);
    const refused = await f.handler(f.event('/oauth/callback', 'GET', undefined, undefined, `state=${wrong}&code=fictional-code`));
    expect(refused.statusCode).toBe(400);
    expect(f.calls).toEqual([]);
    expect((await statusOf(f, pair)).parsed).toEqual({ state: 'unconfigured', grant: null });
  });
  it('answers google_unconfigured with 503 when this deployment has no client id, and still serves the disclosure', async () => {
    const f = fixture(); const pair = await paired(f);
    const disclosure = await f.unconfigured(f.event('/google/disclosure', 'GET', undefined, pair.credential, 'purpose=permitted_correspondence'));
    expect(disclosure.statusCode).toBe(200);
    expect(JSON.parse(disclosure.body)).toEqual({ version: googleGrantDisclosure.version, text: googleGrantDisclosure.text });
    for (const path of ['/google/status', '/google/begin', '/google/revoke']) {
      const reply = await f.unconfigured(f.event(path, path === '/google/status' ? 'GET' : 'POST', path === '/google/status' ? undefined : {}, pair.credential));
      expect(reply.statusCode).toBe(503);
      expect(JSON.parse(reply.body)).toEqual({ error: 'google_unconfigured' });
    }
    expect((await f.unconfigured(f.event('/oauth/callback', 'GET', undefined, undefined, 'state=x&code=y'))).statusCode).toBe(400);
  });
  it('shows today sender cap and ramp position beside the grant once a cap policy exists', async () => {
    const f = fixture(); const pair = await paired(f);
    await connected(f, pair);
    expect((await statusOf(f, pair)).parsed.senderCap).toBeUndefined();
    await f.store.transact([f.store.put(dispatchCapPolicyKey(mailbox), { sender: mailbox, dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT }, null)]);
    expect((await statusOf(f, pair)).parsed.senderCap).toEqual({ today: 10, position: { day: 1, ...SENDER_RAMP_DEFAULT }, firstSendAt: null });
    await f.store.transact([f.store.put(senderFirstSendKey(mailbox), { sender: mailbox, firstSendAt: '2026-09-15T12:00:00.000Z' }, null)]);
    const ramped = (await statusOf(f, pair)).parsed.senderCap;
    expect(ramped).toEqual({ today: 16, position: { day: 4, ...SENDER_RAMP_DEFAULT }, firstSendAt: '2026-09-15T12:00:00.000Z' });
    expect(ramped).toEqual(senderCapForDay({ dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT }, '2026-09-15T12:00:00.000Z', '2026-09-18T09:00:00.000Z'));
    f.advance('2026-10-30T09:00:00.000Z');
    expect((await statusOf(f, pair)).parsed.senderCap?.today).toBe(40);
  });
});
