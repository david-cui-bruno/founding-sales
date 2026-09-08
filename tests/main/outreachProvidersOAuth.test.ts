import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeGoogle } from '../../src/main/outreach/providers/googleOAuth';

const controllers: AbortController[] = [];
afterEach(() => controllers.splice(0).forEach((controller) => controller.abort()));
function signal() { const controller = new AbortController(); controllers.push(controller); return controller; }
const client = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret' };
const scopes = 'openid email https://www.googleapis.com/auth/gmail.send';

describe('explicit desktop Google OAuth', () => {
  it('uses loopback/state/PKCE, exact scopes, verified userinfo identity and closes callback server', async () => {
    let authorization: URL;
    let callback: string;
    let tokenBody: URLSearchParams;
    const endpoints: string[] = [];
    const result = await authorizeGoogle({ ...client, signal: signal().signal, now: () => 1000,
      openExternal: async (url) => {
        authorization = new URL(url);
        callback = authorization.searchParams.get('redirect_uri');
        const redirect = new URL(callback);
        redirect.searchParams.set('state', authorization.searchParams.get('state'));
        redirect.searchParams.set('code', 'fixture-code');
        expect((await fetch(redirect)).status).toBe(200); // Real loopback only.
      }, fetch: async (url, init) => {
        endpoints.push(String(url));
        expect(init.redirect).toBe('error');
        if (String(url).endsWith('/token')) {
          tokenBody = new URLSearchParams(String(init.body));
          return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
            token_type: 'Bearer', scope: scopes });
        }
        return Response.json({ sub: 'fixture-account', email: 'founder@example.com', email_verified: true });
      } });
    expect(authorization.origin + authorization.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('scope').split(' ').sort()).toEqual(scopes.split(' ').sort());
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state').length).toBeGreaterThanOrEqual(32);
    expect(new URL(callback).hostname).toBe('127.0.0.1');
    expect(tokenBody.get('redirect_uri')).toBe(callback);
    expect(createHash('sha256').update(tokenBody.get('code_verifier')).digest('base64url'))
      .toBe(authorization.searchParams.get('code_challenge'));
    expect(endpoints).toEqual(['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo']);
    expect(result).toMatchObject({ email: 'founder@example.com', refreshToken: 'fixture-refresh', expiresAt: 3601000 });
    await expect(fetch(callback)).rejects.toThrow();
  });
  it('rejects wrong paths/state before token exchange and permits the legitimate callback', async () => {
    let tokenRequests = 0;
    await authorizeGoogle({ ...client, signal: signal().signal, openExternal: async (url) => {
      const auth = new URL(url);
      const callback = auth.searchParams.get('redirect_uri');
      const valid = new URL(callback);
      valid.searchParams.set('code', 'fixture-code');
      valid.searchParams.set('state', auth.searchParams.get('state'));
      const wrongPath = new URL(valid); wrongPath.pathname = '/wrong';
      expect((await fetch(wrongPath)).status).toBe(404);
      const wrongState = new URL(valid); wrongState.searchParams.set('state', 'wrong');
      expect((await fetch(wrongState)).status).toBe(400);
      expect(tokenRequests).toBe(0);
      expect((await fetch(valid)).status).toBe(200);
    }, fetch: async (url) => {
      if (String(url).endsWith('/token')) { tokenRequests++; return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: scopes }); }
      return Response.json({ sub: 'id', email: 'founder@example.com', email_verified: true });
    } });
    expect(tokenRequests).toBe(1);
  });
  it('cleans up on cancellation, timeout and browser failure without exposing causes', async () => {
    for (const mode of ['cancel', 'timeout', 'browser'] as const) {
      const controller = signal();
      let callback: string;
      const pending = authorizeGoogle({ ...client, signal: controller.signal, timeoutMs: 25,
        openExternal: async (url) => {
          callback = new URL(url).searchParams.get('redirect_uri');
          if (mode === 'cancel') controller.abort();
          if (mode === 'browser') throw new Error('fixture-secret');
        }, fetch: async () => { throw new Error('Must not exchange token'); } });
      await expect(pending).rejects.toThrow(/^(oauth_cancelled|oauth_timeout|oauth_browser_failed)$/);
      await expect(fetch(callback)).rejects.toThrow();
    }
  });
  it.each([false, 'true'])('rejects unverified identity value %s', async (emailVerified) => {
    await expect(authorizeGoogle({ ...client, signal: signal().signal, openExternal: async (url) => {
      const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'code');
      await fetch(callback);
    }, fetch: async (url) => String(url).endsWith('/token')
      ? Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: scopes })
      : Response.json({ sub: 'id', email: 'founder@example.com', email_verified: emailVerified }),
    })).rejects.toThrow('oauth_identity_invalid');
  });
  it('rejects same-length non-ASCII state without throwing from the HTTP handler', async () => {
    const controller = signal();
    let malformedStatus = 0;
    const result = authorizeGoogle({ ...client, signal: controller.signal, timeoutMs: 150,
      openExternal: async (url) => {
        const auth = new URL(url);
        const callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', 'é'.repeat(auth.searchParams.get('state').length));
        callback.searchParams.set('code', 'code');
        try { malformedStatus = (await fetch(callback, { signal: AbortSignal.timeout(60) })).status; }
        finally { controller.abort(); }
      }, fetch: async () => { throw new Error('Must not call provider'); } });
    await expect(result).rejects.toThrow('oauth_cancelled');
    expect(malformedStatus).toBe(400);
  });
});
