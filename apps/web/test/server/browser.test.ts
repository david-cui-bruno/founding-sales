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
