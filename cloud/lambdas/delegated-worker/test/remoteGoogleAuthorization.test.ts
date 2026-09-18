import { describe, expect, it, vi } from 'vitest';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleGrantDisclosure, googleScopes, requireCapabilities } from '../src/googleGrantCapabilities';
import { WorkerAuth } from '../src/workerAuth';
import { ConditionalCommandHarness } from './sdkHarness';
function fixture() {
  const dynamo = new ConditionalCommandHarness();
  let now = '2026-09-08T00:00:00.000Z';
  const options = { dynamo, tableName: 'fictional-worker', workspaceId: 'fictional-workspace', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const calls: { url: string; init?: RequestInit }[] = [];
  let scopes = `openid email ${googleScopes.send} ${googleScopes.relevant_read}`;
  let subject = 'fictional-subject';
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional-access-token', refresh_token: 'fictional-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: scopes });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: subject, email: 'operator@example.test', email_verified: true });
    if (String(url) === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    throw new Error('unconfigured external boundary');
  };
  const config = { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional-secret', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 7) };
  const remote = () => new RemoteGoogleAuthorization({ auth, config, fetch });
  return { auth, dynamo, options, config, fetch, calls, remote, advance: () => { now = '2026-09-08T00:20:00.000Z'; }, expireToken: () => { now = '2026-09-08T02:00:00.000Z'; },
    scope: (value: string) => { scopes = value; }, subject: (value: string) => { subject = value; } };
}
async function paired(f: ReturnType<typeof fixture>) {
  const { code } = await f.auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 });
  return f.auth.redeemPairing(code, 'fictional-source');
}
async function begun(f: ReturnType<typeof fixture>, pairingId: string) {
  const result = await f.remote().beginGoogleGrant(pairingId, ['send', 'relevant_read']);
  return new URL(result.authorizationUrl);
}
describe('remote scoped Google grant', () => {
  it('uses explicit PKCE and persists only authenticated ciphertext, returns status not tokens', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', googleScopes.send, googleScopes.relevant_read]);
    const state = url.searchParams.get('state')!;
    const status = await f.remote().completeGoogleGrant(state, 'fictional-code');
    expect(status).toMatchObject({ state: 'ready', grant: { subject: 'fictional-subject', email: 'operator@example.test', capabilities: ['send', 'relevant_read'], owner: 'remote', purpose: 'permitted_correspondence' } });
    const serialized = JSON.stringify(f.dynamo.transactions);
    expect(serialized).not.toContain('fictional-refresh-token');
    expect(serialized).not.toContain('fictional-access-token');
    expect(serialized).not.toContain(state);
    expect(JSON.stringify(status)).not.toContain('token');
    const tokenRequest = new URLSearchParams(String(f.calls[0]?.init?.body));
    expect(tokenRequest.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(serialized).not.toContain(tokenRequest.get('code_verifier')!);
    expect(await f.remote().authorizedAccess(pair.pairingId, ['relevant_read'])).toMatchObject({ accessToken: 'fictional-access-token', grant: status.grant });
  });
  it('claims state durably before exchange, races and replay perform one exchange', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId); const state = url.searchParams.get('state')!;
    const results = await Promise.allSettled([f.remote().completeGoogleGrant(state, 'one'), f.remote().completeGoogleGrant(state, 'two')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.calls.filter(c => c.url.endsWith('/token'))).toHaveLength(1);
    await expect(f.remote().completeGoogleGrant(state, 'again')).rejects.toThrow('oauth_state_unavailable');
    expect(f.calls.filter(c => c.url.endsWith('/token'))).toHaveLength(1);
  });
  it('expired state and revoked pairing fail before provider I/O', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    f.advance();
    await expect(f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_state_unavailable');
    const next = await begun(f, pair.pairingId); await f.auth.revokePairing(pair.pairingId);
    await expect(f.remote().completeGoogleGrant(next.searchParams.get('state')!, 'code')).rejects.toThrow('worker_unauthorized');
    expect(f.calls).toHaveLength(0);
  });
  it('cancellation consumes state and preserves the existing grant', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    const old = await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const next = await begun(f, pair.pairingId);
    await expect(f.remote().completeGoogleGrant(next.searchParams.get('state')!, null)).rejects.toThrow('oauth_cancelled');
    expect(await f.remote().status(pair.pairingId)).toEqual(old);
    await expect(f.remote().completeGoogleGrant(next.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_state_unavailable');
    expect(f.calls).toHaveLength(2);
  });
  it('scope downgrade and changed verified subject cannot replace a valid grant', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    const old = await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const downgrade = await begun(f, pair.pairingId); f.scope(`openid email ${googleScopes.send}`);
    await expect(f.remote().completeGoogleGrant(downgrade.searchParams.get('state')!, 'code')).rejects.toThrow('grant_missing_capability');
    expect(await f.remote().status(pair.pairingId)).toEqual(old);
    f.scope(`openid email ${googleScopes.send} ${googleScopes.relevant_read}`); f.subject('different-subject');
    const changed = await begun(f, pair.pairingId);
    await expect(f.remote().completeGoogleGrant(changed.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_subject_mismatch');
    expect(await f.remote().status(pair.pairingId)).toEqual(old);
  });
  it('revoking a grant invalidates pending callbacks and blocks access without affecting pairing', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const pending = await begun(f, pair.pairingId);
    expect(await f.remote().revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked' });
    const count = f.calls.length;
    await expect(f.remote().completeGoogleGrant(pending.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_state_unavailable');
    await expect(f.remote().authorizedAccess(pair.pairingId, ['send'])).rejects.toThrow('google_grant_unavailable');
    expect(f.calls).toHaveLength(count);
    expect((await f.auth.authenticate(`Bearer ${pair.credential}`, ['google:grant'])).pairingId).toBe(pair.pairingId);
  });
  it('wrong workspace and wrong encryption context cannot redeem state', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    const foreign = new RemoteGoogleAuthorization({ auth: new WorkerAuth({ ...f.options, workspaceId: 'other-workspace' }), config: f.config, fetch: f.fetch });
    await expect(foreign.completeGoogleGrant(url.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_state_unavailable');
    const wrongKey = new RemoteGoogleAuthorization({ auth: f.auth, config: { ...f.config, encryptionKey: Buffer.alloc(32, 8) }, fetch: f.fetch });
    await expect(wrongKey.completeGoogleGrant(url.searchParams.get('state')!, 'code')).rejects.toThrow('google_secret_unavailable');
    expect(f.calls).toHaveLength(0);
  });
  it('legacy/send-only and forged capabilities cannot read mail or create events', () => {
    const grant = { provider: 'google' as const, subject: 'fictional-subject', email: 'operator@example.test', grantedScopes: [googleScopes.send], owner: 'local' as const, purpose: 'permitted_correspondence' as const, capabilities: ['send' as const] };
    expect(() => requireCapabilities(grant, ['send'])).not.toThrow();
    expect(() => requireCapabilities(grant, ['relevant_read'])).toThrow('grant_missing_capability');
    expect(() => requireCapabilities({ ...grant, capabilities: ['send', 'event_write'] }, ['event_write'])).toThrow('grant_missing_capability');
    expect(() => requireCapabilities(undefined, ['relevant_read'])).toThrow('grant_missing_capability');
  });
  it('no configuration is inert and makes no provider call', async () => {
    const f = fixture(); const pair = await paired(f);
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, fetch: vi.fn(() => { throw new Error('network forbidden'); }) });
    expect(await remote.status(pair.pairingId)).toEqual({ state: 'unconfigured', grant: null });
    await expect(remote.beginGoogleGrant(pair.pairingId, ['send'])).rejects.toThrow('google_unconfigured');
  });
});

describe('remote refresh cancellation', () => {
  it('does not replace ciphertext when refresh is cancelled after provider response', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const before = f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`);
    f.expireToken(); const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await f.fetch(url, init);
      if (String(url).includes('userinfo')) controller.abort();
      return response;
    };
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch });
    await expect(remote.authorizedAccess(pair.pairingId, ['send'], controller.signal)).rejects.toThrow('oauth_cancelled');
    expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toEqual(before);
  });
});

describe('OAuth HTTP handler binding', () => {
  it('requires disclosure acknowledgement, callback finishes only its grant and status never returns tokens', async () => {
    const { createWorkerHandler } = await import('../src/handler');
    const f = fixture(); const pair = await paired(f);
    const handler = createWorkerHandler({ auth: f.auth, host: 'worker.example.test', google: f.remote() });
    const event = (path: string, body?: unknown, query = '', credential?: string) => ({ version: '2.0', rawPath: path, rawQueryString: query,
      headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      requestContext: { domainName: 'worker.example.test', http: { method: body ? 'POST' : 'GET', sourceIp: 'fixture' } }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await handler(event('/google/begin', { capabilities: ['send', 'relevant_read'] }, '', pair.credential))).statusCode).toBe(400);
    const begin = await handler(event('/google/begin', { capabilities: ['send', 'relevant_read'], disclosureVersion: googleGrantDisclosure.version }, '', pair.credential));
    expect(begin.statusCode).toBe(200);
    const state = new URL(JSON.parse(begin.body).authorizationUrl).searchParams.get('state')!;
    const callback = await handler(event('/oauth/callback', undefined, new URLSearchParams({ state, code: 'fictional-code' }).toString()));
    expect(callback.statusCode).toBe(200); expect(callback.body).toBe('Authorization completed. Return to FSS.');
    expect(callback.headers['Referrer-Policy']).toBe('no-referrer');
    expect((await handler(event('/oauth/callback', undefined, `state=${state}&state=${state}&code=again`))).statusCode).toBe(400);
    const status = await handler(event('/google/status', undefined, '', pair.credential));
    expect(JSON.parse(status.body)).toMatchObject({ state: 'ready', grant: { subject: 'fictional-subject' } });
    expect(status.body).not.toContain('fictional-access-token'); expect(status.body).not.toContain('fictional-refresh-token');
    expect(f.dynamo.inspect('EVENT_HEAD')).toBeUndefined();
  });
});

describe('calendar grant selection', () => {
  it('requires confirmed owned and conflict calendars rather than inferring them from OAuth powers', async () => {
    const f = fixture(); const pair = await paired(f);
    await expect(f.remote().beginGoogleGrant(pair.pairingId, ['event_write', 'availability'])).rejects.toThrow('google_calendar_selection_required');
    const calendars = { ownedCalendarId: 'owned@example.test', conflictCalendarIds: ['owned@example.test'], confirmed: true as const };
    const begun = await f.remote().beginGoogleGrant(pair.pairingId, ['event_write', 'availability'], calendars);
    f.scope(`openid email ${googleScopes.event_write} ${googleScopes.availability}`);
    const status = await f.remote().completeGoogleGrant(new URL(begun.authorizationUrl).searchParams.get('state')!, 'code');
    expect(status.grant?.calendars).toEqual(calendars);
  });
});

describe('provider revocation races', () => {
  it('cannot install tokens if pairing is revoked during the provider exchange', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async (url, init) => {
      const response = await f.fetch(url, init);
      if (String(url).includes('userinfo')) await f.auth.revokePairing(pair.pairingId);
      return response;
    } });
    await expect(remote.completeGoogleGrant(url.searchParams.get('state')!, 'code')).rejects.toThrow();
    expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toBeUndefined();
  });
  it('retains revoked encrypted tokens after a definite HTTP failure for an explicit retry, never execution', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async () => new Response('', { status: 503 }) });
    expect(await remote.revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    await expect(remote.authorizedAccess(pair.pairingId, ['send'])).rejects.toThrow('google_grant_unavailable');
    expect(JSON.stringify(await remote.status(pair.pairingId))).not.toContain('fictional-refresh-token');
    expect(await f.remote().revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'confirmed' });
    expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toMatchObject({ ciphertext: null });
  });
});

describe('ciphertext context binding', () => {
  it('rejects token ciphertext transplanted to another paired device', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const other = await paired(f); const source = await f.auth.store.get(`GOOGLE_GRANT#${pair.pairingId}`);
    await f.auth.store.transact([f.auth.store.put(`GOOGLE_GRANT#${other.pairingId}`, source!.data, null)]);
    const count = f.calls.length;
    await expect(f.remote().authorizedAccess(other.pairingId, ['send'])).rejects.toThrow('google_secret_unavailable');
    expect(f.calls).toHaveLength(count);
  });
  it('never logs or reflects provider exceptions containing tokens through HTTP', async () => {
    const { createWorkerHandler } = await import('../src/handler');
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async () => { throw new Error('fictional-token-secret'); } });
      const handler = createWorkerHandler({ auth: f.auth, google: remote, host: 'worker.example.test' });
      const result = await handler({ version: '2.0', rawPath: '/oauth/callback', rawQueryString: new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture' }).toString(),
        headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https' }, requestContext: { domainName: 'worker.example.test', http: { method: 'GET', sourceIp: 'fixture' } } });
      expect(result.statusCode).toBe(400); expect(result.body).not.toContain('fictional-token-secret');
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});

describe('prepared access evidence for final atomic reservation', () => {
  it.each(['grant', 'pairing'] as const)('fences %s revocation after preparation without an async pre-reservation recheck', async kind => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const prepared = await f.remote().authorizedAccess(pair.pairingId, ['send']);
    expect(prepared.accessEvidence).toMatchObject({ workspaceId: f.options.workspaceId, pairingId: pair.pairingId, subject: 'fictional-subject', requiredCapabilities: ['send'] });
    const checks = f.remote().accessChecks(prepared.accessEvidence, { pairingId: pair.pairingId, subject: prepared.grant.subject, requiredCapabilities: ['send'] });
    expect(Array.isArray(checks)).toBe(true); expect(checks).toHaveLength(2);
    if (kind === 'grant') await f.remote().revokeGoogleGrant(pair.pairingId); else await f.auth.revokePairing(pair.pairingId);
    await expect(f.auth.store.transact([...checks, f.auth.store.put('FINAL_RESERVATION#fixture', { state: 'dispatching' }, null)])).rejects.toThrow();
    expect(f.dynamo.inspect('FINAL_RESERVATION#fixture')).toBeUndefined();
  });
  it('uses the committed post-refresh grant revision and succeeds in an actual conditional transaction', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const before = await f.auth.store.get(`GOOGLE_GRANT#${pair.pairingId}`); f.expireToken();
    const prepared = await f.remote().authorizedAccess(pair.pairingId, ['send']);
    expect(prepared.accessEvidence?.grantRevision).toBe(before!.rev + 1);
    expect(prepared.accessEvidence?.pairingRevision).toBe(1);
    const checks = f.remote().accessChecks(prepared.accessEvidence, { pairingId: pair.pairingId, subject: prepared.grant.subject, requiredCapabilities: ['send'] });
    await f.auth.store.transact([...checks, f.auth.store.put('FINAL_RESERVATION#refreshed', { state: 'dispatching' }, null)]);
    expect(f.dynamo.inspect('FINAL_RESERVATION#refreshed')).toEqual({ state: 'dispatching' });
    expect(JSON.stringify(await f.remote().status(pair.pairingId))).not.toContain('accessEvidence');
  });
  it('rejects foreign identity, capability escalation and modified evidence synchronously', async () => {
    const f = fixture(); const pair = await paired(f); const url = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'code');
    const { accessEvidence } = await f.remote().authorizedAccess(pair.pairingId, ['send']);
    expect(accessEvidence).toBeDefined();
    const expected = { pairingId: pair.pairingId, subject: 'fictional-subject', requiredCapabilities: ['send' as const] };
    expect(() => f.remote().accessChecks(accessEvidence, { ...expected, subject: 'other-subject' })).toThrow('google_access_evidence_invalid');
    expect(() => f.remote().accessChecks(accessEvidence, { ...expected, pairingId: 'a937811c-628f-4a68-9a12-000000000001' })).toThrow('google_access_evidence_invalid');
    expect(() => f.remote().accessChecks(accessEvidence, { ...expected, requiredCapabilities: ['relevant_read'] })).toThrow('google_access_evidence_invalid');
    expect(() => f.remote().accessChecks({ ...accessEvidence, grantRevision: accessEvidence.grantRevision + 1 }, expected)).toThrow('google_access_evidence_invalid');
    const foreign = new RemoteGoogleAuthorization({ auth: new WorkerAuth({ ...f.options, workspaceId: 'foreign-workspace' }), config: f.config, fetch: f.fetch });
    expect(() => foreign.accessChecks(accessEvidence, expected)).toThrow('google_access_evidence_invalid');
    const otherTable = new RemoteGoogleAuthorization({ auth: new WorkerAuth({ ...f.options, tableName: 'other-table' }), config: f.config, fetch: f.fetch });
    expect(() => otherTable.accessChecks(accessEvidence, expected)).toThrow('google_access_evidence_invalid');
    f.expireToken();
    expect(() => f.remote().accessChecks(accessEvidence, expected)).toThrow('google_access_evidence_invalid');
  });
});

describe('regrant waits for completed remote revocation', () => {
  it('retains failed-revocation retry material and blocks new authorization until cleanup confirms', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const failed = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async () => new Response('', { status: 503 }) });
    await failed.revokeGoogleGrant(pair.pairingId);
    const pending = f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`);
    await expect(f.remote().beginGoogleGrant(pair.pairingId, ['send', 'relevant_read'])).rejects.toThrow('google_revocation_pending');
    expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toEqual(pending);
    expect(await f.remote().revokeGoogleGrant(pair.pairingId)).toMatchObject({ providerRevocation: 'confirmed' });
    const next = await begun(f, pair.pairingId);
    expect(await f.remote().completeGoogleGrant(next.searchParams.get('state')!, 'code')).toMatchObject({ state: 'ready' });
  });
  it('blocks begin and old callback completion while provider revocation is in flight', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const oldCallback = await begun(f, pair.pairingId);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async (url, init) => {
      if (String(url).endsWith('/revoke')) { entered(); await held; }
      return f.fetch(url, init);
    } });
    const revoke = remote.revokeGoogleGrant(pair.pairingId); await started;
    try {
      await expect(f.remote().beginGoogleGrant(pair.pairingId, ['send', 'relevant_read'])).rejects.toThrow('google_revocation_pending');
      await expect(f.remote().completeGoogleGrant(oldCallback.searchParams.get('state')!, 'code')).rejects.toThrow('oauth_state_unavailable');
      expect(await f.remote().status(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    } finally { release(); await revoke; }
    expect(await f.remote().status(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'confirmed' });
  });
  it('does not let a competing revoke report confirmation while an earlier revoke remains in flight', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async (url, init) => {
      if (String(url).endsWith('/revoke')) { entered(); await held; }
      return f.fetch(url, init);
    } });
    const firstRevoke = remote.revokeGoogleGrant(pair.pairingId); await started;
    // Attach rejection handling immediately so a RED assertion cannot orphan it.
    const settled = firstRevoke.catch(() => null);
    try {
      const second = await f.remote().revokeGoogleGrant(pair.pairingId);
      expect(second).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
      await expect(f.remote().beginGoogleGrant(pair.pairingId, ['send', 'relevant_read'])).rejects.toThrow('google_revocation_pending');
    } finally { release(); await settled; }
    expect(await f.remote().status(pair.pairingId)).toMatchObject({ providerRevocation: 'confirmed' });
  });
});

describe('regrant completion and uncertain revocation claim', () => {
  it('cannot overwrite cleanup when a previously claimed OAuth exchange completes after revoke', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const next = await begun(f, pair.pairingId);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const remote = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async (url, init) => {
      if (String(url).endsWith('/token')) { entered(); await held; }
      return f.fetch(url, init);
    } });
    const complete = remote.completeGoogleGrant(next.searchParams.get('state')!, 'code');
    const outcome = complete.then(() => 'unexpected-ready', () => 'fenced'); await started;
    try { await f.remote().revokeGoogleGrant(pair.pairingId); } finally { release(); }
    expect(await outcome).toBe('fenced');
    expect(await f.remote().status(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'confirmed' });
    expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toMatchObject({ ciphertext: null });
  });
  it('keeps an ambiguously committed revoke claim pending without automatic takeover or regrant', async () => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw new Error('fictional lost claim response'); };
    const calls = f.calls.length;
    await expect(f.remote().revokeGoogleGrant(pair.pairingId)).rejects.toThrow('fictional lost claim response');
    expect(await f.remote().revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    await expect(f.remote().beginGoogleGrant(pair.pairingId, ['send', 'relevant_read'])).rejects.toThrow('google_revocation_pending');
    expect(f.calls).toHaveLength(calls);
  });
});

describe('lost provider response retains uncertain revoke ownership', () => {
  it.each(['disconnect', 'timeout'] as const)('does not let revoke B confirm or regrant while remote revoke A continues after %s', async failure => {
    const f = fixture(); const pair = await paired(f); const first = await begun(f, pair.pairingId);
    await f.remote().completeGoogleGrant(first.searchParams.get('state')!, 'code');
    const original = f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`) as { ciphertext: string };
    let finishRemote!: () => void; const remoteWork = new Promise<void>(resolve => { finishRemote = resolve; });
    let remoteFinished = false; const processing = remoteWork.then(() => { remoteFinished = true; });
    let submissions = 0;
    const remoteA = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async url => {
      if (!String(url).endsWith('/revoke')) throw new Error('unconfigured external boundary');
      submissions++;
      // The request was submitted. Its local response is lost, but simulated
      // provider processing continues independently until finishRemote().
      throw failure === 'timeout' ? new DOMException('fictional response timeout', 'TimeoutError') : new Error('fictional connection lost after submission');
    } });
    try {
      expect(await remoteA.revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
      expect(remoteFinished).toBe(false);
      const remoteB = new RemoteGoogleAuthorization({ auth: f.auth, config: f.config, fetch: async () => { submissions++; return new Response('', { status: 200 }); } });
      expect(await remoteB.revokeGoogleGrant(pair.pairingId)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
      expect(submissions).toBe(1);
      expect(f.dynamo.inspect(`GOOGLE_GRANT#${pair.pairingId}`)).toMatchObject({ ciphertext: original.ciphertext, revocationInFlight: true, providerRevocation: 'pending', revoked: true });
      await expect(remoteB.beginGoogleGrant(pair.pairingId, ['send', 'relevant_read'])).rejects.toThrow('google_revocation_pending');
      finishRemote(); await processing;
      // Completion without a definitive observed response cannot clear a hold.
      expect(await remoteB.revokeGoogleGrant(pair.pairingId)).toMatchObject({ providerRevocation: 'pending' });
      expect(submissions).toBe(1);
    } finally { finishRemote(); await processing; }
  });
});

describe('Google callback iss parameter', () => {
  it('admits iss=https://accounts.google.com and refuses any other issuer before the provider is contacted', async () => {
    const { createWorkerHandler } = await import('../src/handler');
    const f = fixture(); const pair = await paired(f);
    const handler = createWorkerHandler({ auth: f.auth, google: f.remote(), host: 'worker.example.test' });
    const call = (query: Record<string, string>) => handler({ version: '2.0', rawPath: '/oauth/callback', rawQueryString: new URLSearchParams(query).toString(),
      headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https' }, requestContext: { domainName: 'worker.example.test', http: { method: 'GET', sourceIp: 'fixture' } } });
    const first = await begun(f, pair.pairingId); const before = f.calls.length;
    const refused = await call({ state: first.searchParams.get('state')!, code: 'code', iss: 'https://accounts.example.invalid' });
    expect(refused.statusCode).toBe(400); expect(refused.body).toContain('worker_invalid_request'); expect(f.calls).toHaveLength(before);
    const accepted = await call({ state: first.searchParams.get('state')!, code: 'code', iss: 'https://accounts.google.com' });
    expect(accepted.statusCode).toBe(200); expect(accepted.body).toContain('Authorization completed');
  });
});
