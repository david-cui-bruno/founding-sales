import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDeps } from '../../../api/src/auth/config.ts';
import type { ApiOptions, ApiRequest } from '../../../api/src/server.ts';
import { createBrowserHandler } from '../../src/server/browser.ts';
import { COOKIE_NAMES, sealCookie, type Custody } from '../../src/server/cookies.ts';
const mocks = vi.hoisted(() => ({ callback: vi.fn(), claim: vi.fn(), authenticate: vi.fn(), route: vi.fn() }));
vi.mock('../../../api/src/auth/signIn.ts', () => ({ startSignIn: vi.fn(), handleCallback: mocks.callback, claimSignIn: mocks.claim }));
vi.mock('../../../api/src/auth/sessions.ts', () => ({ authenticate: mocks.authenticate, endSession: vi.fn() }));
vi.mock('../../../api/src/server.ts', () => ({ route: mocks.route }));
const origin = 'https://browser.example.test', key = randomBytes(32);
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const expiresAt = '2026-10-23T04:00:00Z', csrf = 'c'.repeat(43), token = 't'.repeat(50), state = 's'.repeat(43);
const principal = { workspaceId: id, userId: id, deviceId: id, sessionId: 'session-one', role: 'admin', membershipStatus: 'active', deviceStatus: 'active' };
const auth = { now: () => new Date('2026-10-23T03:00:00Z'), config: { oidc: { redirectUri: `${origin}/browser/callback` } } } as AuthDeps;
const grant = { workspaceId: id, userId: id, accessToken: token, accessTokenExpiresAt: expiresAt, deviceSecret: 'synthetic-private-device-secret' };
function cookie(name: string, value: Custody): string { return `${name}=${sealCookie(key, origin, name, value)}`; }
const access = () => cookie(COOKIE_NAMES.access, { kind: 'access', token, csrf, expiresAt });
function request(path: string, headers: Record<string, string> = {}, query = ''): ApiRequest { return { method: 'GET', path, headers, query: new URLSearchParams(query), body: undefined }; }
function handler(founder = { workspaceId: id, userId: id }) {
  return createBrowserHandler({ origin, cookieKey: key, clientVersion: '1.0.47', founder, withRequest: async work => work({ auth, api: {} as ApiOptions }) });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticate.mockResolvedValue({ authenticated: true, principal });
  mocks.callback.mockResolvedValue({ authenticated: true }); mocks.claim.mockResolvedValue({ claimed: true, grant });
  mocks.route.mockResolvedValue({ status: 200, body: { synthetic: true } });
});
describe('founder-only browser authority', () => {
  it.each([{ userId: other }, { workspaceId: other }])('refuses current non-founder identity %j before metadata or product and clears all custody', async replacement => {
    mocks.authenticate.mockResolvedValue({ authenticated: true, principal: { ...principal, ...replacement } });
    const run = handler();
    for (const path of ['/browser/session', '/browser/api/meetings/firm']) {
      const result = await run(request(path, { cookie: access() }));
      expect(result?.status).toBe(401); expect(result?.body).toEqual({ error: 'browser_request_refused' });
      expect(result?.headers['cache-control']).toBe('private, no-store');
      expect(result?.headers['set-cookie']).toEqual(expect.arrayContaining(Object.values(COOKIE_NAMES).map(name => expect.stringContaining(`${name}=;`))));
    }
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it.each([{ userId: other }, { workspaceId: other }])('refuses callback claim %j before issuing access cookie', async replacement => {
    mocks.claim.mockResolvedValue({ claimed: true, grant: { ...grant, ...replacement } });
    const pending = cookie(COOKIE_NAMES.pending, { kind: 'pending', state, handoff: 'h'.repeat(43), expiresAt });
    const result = await handler()(request('/browser/callback', { cookie: pending }, `state=${state}&code=synthetic`));
    expect(result?.status).toBe(401); expect(result?.body).toEqual({ error: 'browser_request_refused' });
    expect((result?.headers['set-cookie'] as string[]).every(value => value.includes('Max-Age=0'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(grant.deviceSecret);
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.route).not.toHaveBeenCalled();
  });
  it('admits founder callback, reauthenticates each request, and refuses changed identity without cached metadata', async () => {
    const run = handler();
    const pending = cookie(COOKIE_NAMES.pending, { kind: 'pending', state, handoff: 'h'.repeat(43), expiresAt });
    const callback = await run(request('/browser/callback', { cookie: pending }, `state=${state}&code=synthetic`));
    expect(callback?.status).toBe(303); expect(callback?.headers['location']).toBe('/');
    const issued = (callback?.headers['set-cookie'] as string[]).find(value => value.startsWith(`${COOKIE_NAMES.access}=`))!.split(';')[0]!;
    expect((await run(request('/browser/session', { cookie: issued })))?.body).toMatchObject({ status: 'signed_in', workspaceId: id, userId: id });
    mocks.authenticate.mockResolvedValueOnce({ authenticated: true, principal: { ...principal, userId: other } });
    expect((await run(request('/browser/session', { cookie: issued })))?.status).toBe(401);
    mocks.authenticate.mockResolvedValueOnce({ authenticated: false, refusal: 'session_revoked' });
    expect((await run(request('/browser/session', { cookie: issued })))?.body).toMatchObject({ status: 'signed_out' });
    expect(mocks.authenticate).toHaveBeenCalledTimes(3);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('snapshots founder selection so caller mutation cannot change authority', async () => {
    const founder = { workspaceId: id, userId: id }, run = handler(founder);
    founder.userId = other;
    expect((await run(request('/browser/session', { cookie: access() })))?.status).toBe(200);
  });
});
