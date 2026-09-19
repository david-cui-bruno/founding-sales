import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settingsViewSchema } from '../../../../../src/shared/contracts/v1Contract';
import { createWorkerHandler, type WorkerHttpResponse } from '../../src/handler';
import { RemoteGoogleAuthorization, type RemoteGoogleConfig } from '../../src/remoteGoogleAuthorization';
import { GOOGLE_GRANT_KEY, grantRecordSchema, stateKey } from '../../src/v1/grant';
import { createWorkerGrantMailboxAccess } from '../../src/v1/mailbox';
import { V1_HOST, v1Fixture } from './v1Fixture';

/**
 * The fresh Google consent on the new client (slice S6, build item 4). The design is explicit that the grant is
 * re-consented at cutover and never copied: the new record is bound to the workspace and the sort key (binding
 * version 2), the OAuth state is bound to the device that began the consent, and the old pairing-bound record is
 * revoked afterwards through the carried revoke. Until the consent is ready, every send holds
 * `mailbox_not_connected`.
 *
 * Every provider call here is an injected fetch. Nothing reaches Google.
 */

const START = '2026-09-19T12:00:00.000Z';
const CONFIG: RemoteGoogleConfig = {
  clientId: 'fictional-cutover.apps.googleusercontent.com',
  clientSecret: 'fictional-client-secret',
  redirectUri: `https://${V1_HOST}/oauth/callback`,
  encryptionKey: Buffer.alloc(32, 0x31),
};
const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

/** The provider, scripted: the token exchange, the identity, and the revoke of the old grant. Never a real call. */
function scriptedGoogle(overrides: { tokenStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      if (overrides.tokenStatus) return new Response('{}', { status: overrides.tokenStatus });
      return Response.json({ access_token: randomBytes(24).toString('base64url'), refresh_token: randomBytes(24).toString('base64url'),
        token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ sub: 'fictional-subject-1', email: 'founder@callie.example', email_verified: true });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    throw new Error(`unscripted fictional call: ${url}`);
  };
  return { fetchImpl, calls };
}

function handlerOf(f: ReturnType<typeof v1Fixture>, fetchImpl: typeof globalThis.fetch) {
  const google = new RemoteGoogleAuthorization({ auth: f.auth, config: CONFIG, fetch: fetchImpl });
  const handle = createWorkerHandler({ auth: f.auth, host: V1_HOST, google });
  const request = (method: 'GET' | 'POST', path: string, options: { body?: unknown; authorization?: string; query?: string } = {}): Promise<WorkerHttpResponse> =>
    handle({ version: '2.0', rawPath: path, rawQueryString: options.query ?? '',
      headers: { host: V1_HOST, 'x-forwarded-proto': 'https', ...(options.authorization === undefined ? {} : { authorization: options.authorization }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      isBase64Encoded: false, requestContext: { domainName: V1_HOST, http: { method, sourceIp: 'fictional-device' } } });
  return { google, request };
}

/** The `state` value of the authorization URL the begin route returned. */
const stateOf = (authorizationUrl: string): string => new URL(authorizationUrl).searchParams.get('state')!;

describe('the fresh Google consent at cutover', () => {
  it('begins a device-bound consent, completes it, and reads as connected through the new record', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const google = scriptedGoogle();
    const { request } = handlerOf(f, google.fetchImpl);

    const begun = await request('POST', '/v1/google/begin', { authorization: device.bearer, body: {} });
    expect(begun.statusCode).toBe(200);
    const { authorizationUrl } = JSON.parse(begun.body) as { authorizationUrl: string };
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Only the two mailbox capabilities, plus the identity scopes. No calendar, no drive, nothing else.
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual(SCOPES.split(' ').sort());
    // Beginning is not a grant: nothing to send with yet, and no provider was called at all.
    expect(f.db.inspect(GOOGLE_GRANT_KEY)).toBeUndefined();
    expect(google.calls).toEqual([]);
    expect(await createWorkerGrantMailboxAccess({ store: f.store, authorization: handlerOf(f, google.fetchImpl).google })
      .access(new AbortController().signal)).toEqual({ connected: false, reason: 'mailbox_not_connected' });

    // The state is bound to the device that asked for it.
    const state = stateOf(authorizationUrl);
    expect(f.db.inspect(stateKey(state))).toMatchObject({ bindingVersion: 2, deviceId: device.deviceId, consumed: false });

    const callback = await request('GET', '/oauth/callback', { query: new URLSearchParams({ state, code: 'fictional-code' }).toString() });
    expect(callback.statusCode).toBe(200);
    const record = grantRecordSchema.parse(f.db.inspect(GOOGLE_GRANT_KEY));
    expect(record).toMatchObject({ bindingVersion: 2, status: 'ready', consentedBy: device.deviceId });
    expect(record.grant).toMatchObject({ email: 'founder@callie.example', owner: 'remote' });
    expect(record.ciphertext!.startsWith('v2.')).toBe(true);
    // No token, no refresh token and no client secret is readable in the stored item.
    expect(JSON.stringify(f.db.inspect(GOOGLE_GRANT_KEY))).not.toContain(CONFIG.clientSecret);

    // Settings says reconsented, through the new record and not the old one.
    const settings = settingsViewSchema.parse(f.json(await request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(settings.google).toMatchObject({ status: 'connected', reconsented: true, email: 'founder@callie.example', oldGrants: 0 });

    // And the mailbox seam now answers through it.
    const access = await createWorkerGrantMailboxAccess({ store: f.store, authorization: handlerOf(f, google.fetchImpl).google })
      .access(new AbortController().signal);
    expect(access).toMatchObject({ connected: true, email: 'founder@callie.example' });
  });

  it('refuses a replayed callback, an unknown state and a cancelled consent, and writes nothing for any of them', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const google = scriptedGoogle();
    const { request } = handlerOf(f, google.fetchImpl);
    const begun = JSON.parse((await request('POST', '/v1/google/begin', { authorization: device.bearer, body: {} })).body) as { authorizationUrl: string };
    const state = stateOf(begun.authorizationUrl);

    // An unknown state reaches no provider and writes no grant.
    const unknown = randomBytes(32).toString('base64url');
    await request('GET', '/oauth/callback', { query: new URLSearchParams({ state: unknown, code: 'fictional-code' }).toString() });
    expect(f.db.inspect(GOOGLE_GRANT_KEY)).toBeUndefined();

    await request('GET', '/oauth/callback', { query: new URLSearchParams({ state, code: 'fictional-code' }).toString() });
    const first = grantRecordSchema.parse(f.db.inspect(GOOGLE_GRANT_KEY));
    const exchanges = google.calls.filter(call => call === 'https://oauth2.googleapis.com/token').length;
    // The same callback again: the state is consumed, so nothing is exchanged and the record is untouched.
    await request('GET', '/oauth/callback', { query: new URLSearchParams({ state, code: 'fictional-code' }).toString() });
    expect(google.calls.filter(call => call === 'https://oauth2.googleapis.com/token').length).toBe(exchanges);
    expect(grantRecordSchema.parse(f.db.inspect(GOOGLE_GRANT_KEY)).consentedAt).toBe(first.consentedAt);

    // A second consent is refused while one is ready, rather than quietly starting over the top of it.
    const again = await request('POST', '/v1/google/begin', { authorization: device.bearer, body: {} });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body)).toEqual({ error: 'already_connected' });
  });

  it('revokes the old pairing-bound grant on request, and never touches the new record', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const google = scriptedGoogle();
    const { request } = handlerOf(f, google.fetchImpl);
    // The old grant as the carried flow wrote it, for one real pairing.
    const pairing = await f.auth.issuePairing({ scopes: ['events:read', 'commands:write', 'google:grant'], expiresInSeconds: 600 });
    const redeemed = await f.auth.redeemPairing(pairing.code, 'fictional-operator');
    await f.store.transact([f.store.put(`GOOGLE_GRANT#${redeemed.pairingId}`,
      { grant: { provider: 'google', subject: 'old-subject', email: 'old@callie.example', grantedScopes: SCOPES.split(' '),
        capabilities: ['send', 'relevant_read'], owner: 'remote', purpose: 'permitted_correspondence' },
      revoked: false, ciphertext: null }, null)]);

    // Before the fresh consent, Settings counts the old grant and says the reconsent has not happened.
    const before = settingsViewSchema.parse(f.json(await request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(before.google).toMatchObject({ reconsented: false, oldGrants: 1 });

    const begun = JSON.parse((await request('POST', '/v1/google/begin', { authorization: device.bearer, body: {} })).body) as { authorizationUrl: string };
    await request('GET', '/oauth/callback', { query: new URLSearchParams({ state: stateOf(begun.authorizationUrl), code: 'fictional-code' }).toString() });
    const fresh = grantRecordSchema.parse(f.db.inspect(GOOGLE_GRANT_KEY));
    const withOld = settingsViewSchema.parse(f.json(await request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(withOld.google).toMatchObject({ status: 'connected', reconsented: true, oldGrants: 1 });
    expect(withOld.google!.note).toContain('revoke it');

    const revoked = await request('POST', '/v1/google/revoke-old', { authorization: device.bearer, body: {} });
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.body)).toMatchObject({ revoked: 1 });
    // The new record is exactly as it was; only the old one moved.
    expect(grantRecordSchema.parse(f.db.inspect(GOOGLE_GRANT_KEY))).toEqual(fresh);
    const after = settingsViewSchema.parse(f.json(await request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(after.google).toMatchObject({ status: 'connected', reconsented: true, oldGrants: 0 });
  });

  it('refuses both routes without a device token, and answers google_unconfigured with no client', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const handle = createWorkerHandler({ auth: f.auth, host: V1_HOST });
    const call = (path: string, authorization?: string) => handle({ version: '2.0', rawPath: path, rawQueryString: '',
      headers: { host: V1_HOST, 'x-forwarded-proto': 'https', ...(authorization === undefined ? {} : { authorization }) },
      body: '{}', isBase64Encoded: false, requestContext: { domainName: V1_HOST, http: { method: 'POST', sourceIp: 'fictional' } } });
    for (const path of ['/v1/google/begin', '/v1/google/revoke-old']) {
      expect((await call(path)).statusCode, path).toBe(401);
      expect((await call(path, device.bearer)).statusCode, path).toBe(503);
    }
    expect(f.db.inspect(GOOGLE_GRANT_KEY)).toBeUndefined();
  });
});
