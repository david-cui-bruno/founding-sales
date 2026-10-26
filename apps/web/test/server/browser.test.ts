import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDeps } from '../../../api/src/auth/config.ts';
import type { ApiOptions, ApiRequest } from '../../../api/src/server.ts';
import { createBrowserHandler } from '../../src/server/browser.ts';
import { COOKIE_NAMES, openCookie, parseCookies, sealCookie, type Custody } from '../../src/server/cookies.ts';
import type { BrowserResponse } from '../../src/server/runtime.ts';
const mocks = vi.hoisted(() => ({ start: vi.fn(), callback: vi.fn(), claim: vi.fn(), authenticate: vi.fn(), end: vi.fn(), route: vi.fn() }));
vi.mock('../../../api/src/auth/signIn.ts', () => ({ startSignIn: mocks.start, handleCallback: mocks.callback, claimSignIn: mocks.claim }));
vi.mock('../../../api/src/auth/sessions.ts', () => ({ authenticate: mocks.authenticate, endSession: mocks.end }));
vi.mock('../../../api/src/server.ts', () => ({ route: mocks.route }));
const origin = 'https://localhost:8443';
const now = new Date('2026-10-22T06:00:00Z');
const expiresAt = '2026-10-22T07:00:00Z';
const key = randomBytes(32);
const id = '11111111-1111-4111-8111-111111111111';
const csrf = 'c'.repeat(43);
const token = 't'.repeat(50);
const principal = { workspaceId: id, userId: id, deviceId: id, sessionId: 'session-one', role: 'admin', membershipStatus: 'active', deviceStatus: 'active' };
const auth = { now: () => now, config: { oidc: { redirectUri: `${origin}/browser/callback` } } } as AuthDeps;
const withRequest = vi.fn();
const handler = createBrowserHandler({ origin, cookieKey: key, clientVersion: '1.4.0', withRequest: async work => { withRequest(); return work({ auth, api: {} as ApiOptions }); } });
function cookie(name: string, value: Custody): string { return `${name}=${sealCookie(key, origin, name, value)}`; }
const access = (): string => cookie(COOKIE_NAMES.access, { kind: 'access', token, csrf, expiresAt });
function request(path: string, options: Partial<ApiRequest> = {}): ApiRequest {
  return { method: 'GET', path, query: new URLSearchParams(), headers: { 'sec-fetch-site': 'same-origin' }, body: undefined, ...options };
}
function post(path: string, body: unknown = {}, extra: Record<string, string> = {}): ApiRequest {
  return request(path, { method: 'POST', body, headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra } });
}
function sets(result: BrowserResponse | null): readonly string[] {
  const value = result?.headers['set-cookie'];
  return Array.isArray(value) ? value : [];
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ authenticated: true, principal });
  mocks.route.mockResolvedValue({ status: 200, body: { firms: [] } });
  mocks.end.mockResolvedValue(undefined);
});
describe('cookie custody', () => {
  it('encrypts and authenticates purpose, origin and key', () => {
    const value: Custody = { kind: 'access', token, csrf, expiresAt };
    const encoded = sealCookie(key, origin, COOKIE_NAMES.access, value);
    expect(encoded).not.toContain(token);
    expect(openCookie(key, origin, COOKIE_NAMES.access, encoded)).toEqual(value);
    for (const work of [() => openCookie(randomBytes(32), origin, COOKIE_NAMES.access, encoded), () => openCookie(key, 'https://other.test', COOKIE_NAMES.access, encoded), () => openCookie(key, origin, COOKIE_NAMES.pending, encoded), () => openCookie(key, origin, COOKIE_NAMES.access, `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`)]) expect(work).toThrow();
  });
  it.each(['a=1; a=2', 'missing', 'a=bad value', 'a=1;', '=oops'])('rejects ambiguous or malformed cookies %s', input => expect(() => parseCookies(input)).toThrow());
});
describe('browser request boundary', () => {
  it('admits only exact guided Social commands and pins the gateway version', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const body = { commandId: id, mode: 'linkedin_grounded', sourceRefs: [], factBlocks: [{ id, version: 1 }], voiceGuideRef: { guideId: id, revision: 2 } };
    expect((await handler(post('/browser/api/social/drafts/request', body, headers)))?.status).toBe(200);
    expect(mocks.route.mock.calls[0]?.[3].body).toEqual({ ...body, clientVersion: '1.4.0' });
    for (const invalid of [
      { ...body, mode: undefined }, { ...body, voiceGuideRef: undefined }, { ...body, factBlocks: [] },
      { ...body, sourceRefs: [{ kind: 'call', id, revision: 1 }] },
      { ...body, guidance: 'private content' }, { ...body, clientVersion: '9.9.9' },
    ]) expect((await handler(post('/browser/api/social/drafts/request', invalid, headers)))?.status).toBe(400);
    const receipt = { commandId: id, payloadSHA256: 'a'.repeat(64) };
    expect((await handler(post('/browser/api/social/drafts/request/receipt', receipt, headers)))?.status).toBe(200);
    expect(mocks.route.mock.calls[1]?.[3].body).toEqual(receipt);
    expect(mocks.route).toHaveBeenCalledTimes(2);
  });
  it('fences guided Social requests and receipts by current admin, CSRF and session revision', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    for (const path of ['/social/drafts/request', '/social/drafts/request/receipt']) {
      expect((await handler(post(`/browser/api${path}`, {}, { ...headers, 'x-callie-csrf': '' })))?.status).toBe(403);
      expect((await handler(post(`/browser/api${path}`, {}, { ...headers, 'x-callie-session': 'stale' })))?.status).toBe(409);
    }
    mocks.authenticate.mockResolvedValue({ authenticated: true, principal: { ...principal, role: 'salesperson' } });
    const memberSession = await handler(request('/browser/session', { headers: { cookie: access() } }));
    for (const path of ['/social/drafts/request', '/social/drafts/request/receipt']) {
      expect((await handler(post(`/browser/api${path}`, {}, { ...headers, 'x-callie-session': (memberSession?.body as { revision: string }).revision })))?.status).toBe(403);
    }
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('refuses unused call history including private notes before API dispatch', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-session': (session?.body as { revision: string }).revision };
    for (const include of ['', 'notes', 'summary,outcome,notes']) {
      const result = await handler(request('/browser/api/calls/history', { headers, query: new URLSearchParams({ firmId: id, include }) }));
      expect(result?.status).toBe(404);
    }
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('normalizes only closed Voice product refusals through the actual gateway', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const body = { status: 'refused', replayed: false, reason: 'telephony_budget_disabled' };
    mocks.route.mockResolvedValueOnce({ status: 409, body });
    expect(await handler(post('/browser/api/calls/session', { commandId: id }, headers))).toMatchObject({ status: 200, body });
    for (const reason of ['command_payload_mismatch', 'command_device_mismatch', 'session_changed', 'unknown_reason']) {
      mocks.route.mockResolvedValueOnce({ status: 409, body: { ...body, reason } });
      expect(await handler(post('/browser/api/calls/session', { commandId: id }, headers))).toMatchObject({ status: 409, body: { error: 'browser_request_refused' } });
    }
    mocks.route.mockResolvedValueOnce({ status: 503, body: { error: 'integration_unconfigured' } });
    expect(await handler(post('/browser/api/calls/access-token', {}, headers))).toMatchObject({ status: 200, body: { availability: 'unavailable', reason: 'integration_unconfigured' } });
    mocks.route.mockResolvedValueOnce({ status: 503, body: { error: 'integration_unconfigured' } });
    expect(await handler(post('/browser/api/calling/execution/receipt', { firmId: id, commandId: id, payloadSHA256: 'a'.repeat(64) }, headers))).toMatchObject({ status: 503, body: { error: 'browser_request_refused' } });
  });
  it('pins explicit Voice start and leaves receipt identity unchanged', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const start = { commandId: id, firmId: id, routeId: id, routeVersion: 1, callingIdentityId: id };
    expect((await handler(post('/browser/api/calls/session', start, headers)))?.status).toBe(200);
    expect(mocks.route.mock.calls[0]?.[3].body).toEqual({ ...start, clientVersion: '1.4.0' });
    const receipt = { firmId: id, commandId: id, payloadSHA256: 'a'.repeat(64) };
    expect((await handler(post('/browser/api/calling/execution/receipt', receipt, headers)))?.status).toBe(200);
    expect(mocks.route.mock.calls[1]?.[3].body).toEqual(receipt);
    expect((await handler(post('/browser/api/calls/session', { ...start, clientVersion: '9.9.9' }, headers)))?.status).toBe(400);
    expect(mocks.route).toHaveBeenCalledTimes(2);
  });
  it('requires current Voice token CSRF and revision before any mint dispatch', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    expect((await handler(post('/browser/api/calls/access-token', {}, { ...headers, 'x-callie-csrf': '' })))?.status).toBe(403);
    expect((await handler(post('/browser/api/calls/access-token', {}, { ...headers, 'x-callie-session': 'stale' })))?.status).toBe(409);
    expect(mocks.route).not.toHaveBeenCalled();
    mocks.route.mockResolvedValueOnce({ status: 200, body: { token: 'fictional-voice-grant', identity: id, expiresAt } });
    const result = await handler(post('/browser/api/calls/access-token', {}, headers));
    expect(result?.status).toBe(200);
    expect(result?.headers['cache-control']).toBe('private, no-store');
    expect(result?.headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
    expect(mocks.route.mock.calls[0]?.[3].body).toEqual({});
  });
  it.each(['request', 'admit'])('preserves typed qualification %s product refusals without changing command identity', async action => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const body = { status: 'refused', replayed: true, reason: 'research_held' };
    mocks.route.mockResolvedValueOnce({ status: 409, body });
    const result = await handler(post(`/browser/api/sourcing/qualification/${action}`, { commandId: id, candidateId: id, expectedRevision: 1 }, { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision }));
    expect(result?.status).toBe(200);
    expect(result?.body).toEqual(body);
    expect(result?.headers['cache-control']).toBe('private, no-store');
    expect(mocks.route.mock.calls[0]?.[3].body).toMatchObject({ commandId: id, clientVersion: '1.4.0' });
  });
  it.each(['admin_only', 'session_changed', 'command_payload_mismatch', 'command_device_mismatch', 'command_kind_mismatch', 'firm_assigned_elsewhere', 'sourcing_owner_inactive', 'unknown_reason'])('keeps qualification authority/custody refusal %s generic', async reason => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    mocks.route.mockResolvedValueOnce({ status: 409, body: { status: 'refused', replayed: false, reason } });
    const result = await handler(post('/browser/api/sourcing/qualification/request', { commandId: id }, { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision }));
    expect(result?.status).toBe(409);
    expect(result?.body).toEqual({ error: 'browser_request_refused' });
  });
  it('returns only null for exact qualification evidence absence, not arbitrary errors or private refusal fields', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    mocks.route.mockResolvedValueOnce({ status: 404, body: { error: 'not_found' } });
    expect(await handler(post('/browser/api/sourcing/qualification/read', { candidateId: id }, headers))).toMatchObject({ status: 200, body: null });
    mocks.route.mockResolvedValueOnce({ status: 404, body: { error: 'not_found', private: 'hidden' } });
    expect(await handler(post('/browser/api/sourcing/qualification/read', { candidateId: id }, headers))).toMatchObject({ status: 404, body: { error: 'browser_request_refused' } });
    mocks.route.mockResolvedValueOnce({ status: 409, body: { status: 'refused', replayed: true, reason: 'research_held', private: 'hidden' } });
    expect(await handler(post('/browser/api/sourcing/qualification/request', { commandId: id }, headers))).toMatchObject({ status: 409, body: { error: 'browser_request_refused' } });
  });
  it.each(['read', 'request', 'admit'])('refuses qualification %s before dispatch for current non-admin, stale revision and missing CSRF', async action => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const path = `/browser/api/sourcing/qualification/${action}`;
    expect((await handler(post(path, {}, { ...headers, 'x-callie-session': 'stale' })))?.status).toBe(409);
    expect((await handler(post(path, {}, { ...headers, 'x-callie-csrf': '' })))?.status).toBe(403);
    mocks.authenticate.mockResolvedValue({ authenticated: true, principal: { ...principal, role: 'salesperson' } });
    const memberSession = await handler(request('/browser/session', { headers: { cookie: access() } }));
    expect((await handler(post(path, {}, { ...headers, 'x-callie-session': (memberSession?.body as { revision: string }).revision })))?.status).toBe(403);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it.each(['generation_already_attempted', 'generation_outcome_unknown', 'source_changed', 'context_incomplete', 'generation_held'])('preserves authenticated generation refusal %s without invalidating custody', async reason => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const body = { status: 'refused', replayed: true, reason };
    mocks.route.mockResolvedValueOnce({ status: 409, body });
    const result = await handler(post('/browser/api/replies/composer/generate', { commandId: id }, { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision }));
    expect(result?.status).toBe(200);
    expect(result?.body).toEqual(body);
    expect(result?.headers['cache-control']).toBe('private, no-store');
  });
  it.each([
    [{ status: 'refused', replayed: false, reason: 'session_changed' }, 401],
    [{ status: 'refused', replayed: false, reason: 'not_assigned' }, 401],
    [{ status: 'refused', replayed: false, reason: 'owner_changed' }, 401],
    [{ status: 'refused', replayed: false, reason: 'unknown_reason' }, 409],
    [{ status: 'refused', replayed: false, reason: 'source_changed', private: 'never expose' }, 409],
  ])('keeps authority and unknown generation refusals fail-closed %#', async (body, status) => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    mocks.route.mockResolvedValueOnce({ status: 409, body });
    const result = await handler(post('/browser/api/replies/composer/generate', { commandId: id }, { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision }));
    expect(result?.status).toBe(status);
    expect(result?.body).toEqual({ error: 'browser_request_refused' });
  });
  it('establishes only public signed-out CSRF and hardened cookie/response headers', async () => {
    const result = await handler(request('/browser/session'));
    expect(result?.body).toEqual({ status: 'signed_out', csrfToken: expect.any(String) });
    expect(sets(result).some(value => value.includes('__Host-callie-csrf=') && value.includes('HttpOnly; Secure; SameSite=Lax'))).toBe(true);
    expect(result?.headers['cache-control']).toBe('private, no-store');
    expect(result?.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(result?.headers['referrer-policy']).toBe('no-referrer');
  });
  it.each(['/browser/api', '/browser/api/auth/session', '/browser/api/firms/../settings', '/browser/nope'])('refuses unknown path %s before acquiring a request connection', async path => {
    expect((await handler(request(path)))?.status).toBe(404);
    expect(withRequest).not.toHaveBeenCalled();
  });
  it('leaves non-browser paths unhandled', async () => expect(await handler(request('/health'))).toBeNull());
  it('rejects cross-origin and same-site fetches and POSTs without origin', async () => {
    for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) expect((await handler(request('/browser/session', { headers })))?.status).toBe(403);
    expect((await handler(request('/browser/sign-in', { method: 'POST', body: {}, headers: { 'content-type': 'application/json' } })))?.status).toBe(403);
  });
  it('rejects duplicate cookies and authenticated tampering', async () => {
    expect((await handler(request('/browser/session', { headers: { cookie: `${access()}; ${access()}` } })))?.status).toBe(400);
    expect((await handler(request('/browser/session', { headers: { cookie: `${COOKIE_NAMES.access}=tampered` } })))?.status).toBe(400);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
  it('requires CSRF even on POST reads and refuses media/body limits', async () => {
    expect((await handler(post('/browser/api/today/firm', {}, { cookie: access() })))?.status).toBe(403);
    expect((await handler(post('/browser/sign-in', {}, { 'content-type': 'text/plain' })))?.status).toBe(415);
    expect((await handler(post('/browser/sign-in', { huge: 'x'.repeat(1024 * 1024) })))?.status).toBe(413);
  });
  it('derives revision from current identity and refuses stale reads before API dispatch', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    expect(session?.body).toEqual({ status: 'signed_in', csrfToken: csrf, revision: expect.any(String), workspaceId: id, userId: id, deviceId: id, role: 'admin', expiresAt });
    expect(JSON.stringify(session?.body)).not.toContain(token);
    expect((await handler(request('/browser/api/today', { headers: { cookie: access() } })))?.status).toBe(409);
    expect(mocks.route).not.toHaveBeenCalled();
    const revision = (session?.body as { revision: string }).revision;
    await handler(request('/browser/api/today', { headers: { cookie: access(), 'x-callie-session': revision, authorization: 'Bearer attacker' } }));
    expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({ headers: { authorization: `Bearer ${token}` } });
    mocks.authenticate.mockResolvedValue({ authenticated: true, principal: { ...principal, role: 'salesperson' } });
    expect((await handler(request('/browser/api/today', { headers: { cookie: access(), 'x-callie-session': revision } })))?.status).toBe(409);
  });
  it('refuses expired and revoked sessions', async () => {
    const expired = cookie(COOKIE_NAMES.access, { kind: 'access', token, csrf, expiresAt: '2026-10-21T07:00:00Z' });
    expect((await handler(request('/browser/api/today', { headers: { cookie: expired } })))?.status).toBe(401);
    mocks.authenticate.mockResolvedValue({ authenticated: false, refusal: 'membership_inactive' });
    expect((await handler(request('/browser/api/today', { headers: { cookie: access() } })))?.status).toBe(401);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('binds callback to exact pending state before existing callback/claim and never exposes grants', async () => {
    const state = 's'.repeat(43), handoff = 'h'.repeat(43);
    const pending = cookie(COOKIE_NAMES.pending, { kind: 'pending', state, handoff, expiresAt });
    const callback = (query: string) => request('/browser/callback', { headers: { cookie: pending, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, query: new URLSearchParams(query) });
    expect((await handler(callback('state=wrong&code=code')))?.status).toBe(403);
    expect(mocks.callback).not.toHaveBeenCalled();
    expect((await handler(callback(`state=${state}&state=${state}&code=code`)))?.status).toBe(403);
    mocks.callback.mockResolvedValue({ authenticated: true, workspaceId: id, userId: id });
    mocks.claim.mockResolvedValue({ claimed: true, grant: { accessToken: token, accessTokenExpiresAt: expiresAt, deviceSecret: 'never-public' } });
    const result = await handler(callback(`state=${state}&code=code`));
    expect(mocks.callback).toHaveBeenCalledWith(auth, { state, code: 'code' });
    expect(mocks.claim).toHaveBeenCalledWith(auth, { handoffSecret: handoff, clientVersion: '1.4.0' });
    expect(result?.status).toBe(303);
    expect(result?.headers['location']).toBe('/');
    expect(JSON.stringify(result)).not.toContain('never-public');
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('requires anonymous CSRF for sign in and returns only authorization URL', async () => {
    const anonymous = cookie(COOKIE_NAMES.anonymous, { kind: 'anonymous', csrf, expiresAt });
    mocks.start.mockResolvedValue({ started: true, authorizationUrl: `https://issuer.test/authorize?state=${'s'.repeat(43)}`, handoffSecret: 'h'.repeat(43), expiresAt });
    const result = await handler(post('/browser/sign-in', { workspaceId: id, deviceLabel: 'Browser' }, { cookie: anonymous, 'x-callie-csrf': csrf }));
    expect(result?.body).toEqual({ authorizationUrl: expect.any(String) });
    expect(JSON.stringify(result?.body)).not.toContain('handoff');
    expect(mocks.start).toHaveBeenCalledWith(auth, { workspaceId: id, deviceLabel: 'Browser', clientVersion: '1.4.0' });
  });
  it('preserves command identity and pins version without accepting replacement credentials', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    await handler(post('/browser/api/meetings/notes', { commandId: id, meetingId: id, notes: 'draft' }, headers));
    expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({ body: { commandId: id, meetingId: id, notes: 'draft', clientVersion: '1.4.0' } });
    expect((await handler(post('/browser/api/meetings/notes', { commandId: id, clientVersion: '9.9.9' }, headers)))?.status).toBe(400);
    for (const field of ['authorization', 'Cookie', 'headers', 'origin']) expect((await handler(post('/browser/api/today/firm', { [field]: 'attacker' }, headers)))?.status).toBe(400);
    mocks.route.mockResolvedValueOnce({ status: 403, body: { secret: 'not-public' } });
    const refused = await handler(post('/browser/api/today/firm', { firmId: id }, headers));
    expect(refused?.body).toEqual({ error: 'browser_request_refused' });
  });
  it('pins qualified research command versions without replacing source identity', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const body = { commandId: id, discoveryCandidateId: id, discoveryRevision: 2, candidateId: id, candidateRevision: 3, runId: id };
    await handler(post('/browser/api/sourcing/research-firms/create', body, headers));
    expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({ body: { ...body, clientVersion: '1.4.0' } });
    expect((await handler(post('/browser/api/sourcing/research-firms/create', { ...body, clientVersion: '9.9.9' }, headers)))?.status).toBe(400);
    expect(mocks.route).toHaveBeenCalledTimes(1);
  });
  it('pins approved email campaign command versions without adding recipient or sending authority', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    for (const action of ['approve', 'revoke']) {
      const body = { commandId: id, id, expectedRevision: 1 };
      await handler(post(`/browser/api/outreach/email-campaigns/${action}`, body, headers));
      expect(mocks.route.mock.calls.at(-1)?.[3]).toMatchObject({ body: { ...body, clientVersion: '1.4.0' } });
      expect((await handler(post(`/browser/api/outreach/email-campaigns/${action}`, { ...body, clientVersion: '9.9.9' }, headers)))?.status).toBe(400);
    }
    expect(mocks.route).toHaveBeenCalledTimes(2);
  });

  it('pins only explicit reply generation to the server version and cannot dispatch a send', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    const body = { commandId: id, messageId: id, sourceRevision: 'a'.repeat(64), factRefs: [], envelope: { to: ['synthetic@example.test'], cc: [] } };
    await handler(post('/browser/api/replies/composer/generate', body, headers));
    expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({ body: { ...body, clientVersion: '1.4.0' } });
    expect((await handler(post('/browser/api/replies/composer/generate', { ...body, clientVersion: '9.9.9' }, headers)))?.status).toBe(400);
    for (const path of ['/replies/composer/send', '/replies/confirm', '/meetings/match']) {
      expect((await handler(post(`/browser/api${path}`, body, headers)))?.status).toBe(404);
    }
    expect(mocks.route).toHaveBeenCalledTimes(1);
  });

  it('calls real logout seam, clears local cookies but never reports success on uncertain failure', async () => {
    const session = await handler(request('/browser/session', { headers: { cookie: access() } }));
    const headers = { cookie: access(), 'x-callie-csrf': csrf, 'x-callie-session': (session?.body as { revision: string }).revision };
    mocks.end.mockRejectedValueOnce(new Error('secret provider detail'));
    const result = await handler(post('/browser/sign-out', {}, headers));
    expect(result?.status).toBe(503);
    expect(result?.body).toEqual({ error: 'browser_request_refused' });
    expect(sets(result).filter(value => value.includes('Max-Age=0'))).toHaveLength(3);
    expect(mocks.end).toHaveBeenCalledWith(auth, principal);
    expect((await handler(post('/browser/sign-out', {}, headers)))?.body).toEqual({ status: 'signed_out' });
  });
  it('redacts thrown and API error details with no-store headers', async () => {
    mocks.authenticate.mockRejectedValue(new Error('secret access token'));
    const result = await handler(request('/browser/session', { headers: { cookie: access() } }));
    expect(result?.status).toBe(503);
    expect(result?.body).toEqual({ error: 'browser_request_refused' });
    expect(result?.headers['cache-control']).toBe('private, no-store');
  });
});
