import { request as httpRequest, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientVersionPolicySchema } from '@fss/contracts';
import { REQUIRED_SCHEMA } from '@fss/domain/db/schemaRange.ts';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { AuthDeps } from '../src/auth/config.ts';
import { createApiServer, type ApiServerOptions } from '../src/server.ts';
import { browserMountWithAssets, createFounderBrowserRuntime, readFounderBrowserSettings } from '../src/bootstrap/browser.ts';
import type { BrowserAssets } from '../../web/src/server/hostContract.ts';
import { MAX_REQUEST_BYTES } from '../src/limits.ts';
import type * as Sessions from '../src/auth/sessions.ts';
import { COOKIE_NAMES, sealCookie } from '../../web/src/server/cookies.ts';
const authMocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('../src/auth/sessions.ts', async importOriginal => ({ ...await importOriginal<typeof Sessions>(), authenticate: authMocks.authenticate }));

const id = '11111111-1111-4111-8111-111111111111';
const environment = { FSS_BROWSER_ORIGIN: 'https://browser.example.test', FSS_BROWSER_CLIENT_VERSION: '1.0.47', FSS_BROWSER_COOKIE_KEY_HEX: 'ab'.repeat(32), FSS_BROWSER_FOUNDER_WORKSPACE_ID: id, FSS_BROWSER_FOUNDER_USER_ID: id };
const settings = readFounderBrowserSettings(environment)!;
const assets: BrowserAssets = new Map([['/', { body: Buffer.from('<html>synthetic</html>'), contentType: 'text/html; charset=utf-8' }]]);
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
function fixture() {
  let version = REQUIRED_SCHEMA;
  const release = vi.fn();
  const query: SessionQueryable['query'] = async <Row extends QueryResultRowLike>(text: string) => ({ rows: (text.includes('to_regclass') ? [{ present: true }] : [{ version }]) as unknown as Row[], rowCount: 1 });
  const session: SessionQueryable = { query };
  const checkout = vi.fn(async () => ({ session, release }));
  const auth = { config: { oidc: { redirectUri: 'https://desktop.example.test/callback' } }, now: () => new Date() } as Omit<AuthDeps, 'db'>;
  const options: ApiServerOptions = { connections: { checkout }, auth, sendingEnabled: false, supportedClientVersions: clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.x', incompatible: [] }) };
  return { options, auth, checkout, release, query, version: (next: number) => { version = next; } };
}
async function listen(options: ApiServerOptions): Promise<number> {
  const server = createApiServer(options); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function get(port: number, path: string, host = 'browser.example.test', headers: Record<string, string> = {}): Promise<{ status: number; body: string; cache: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { host, ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, body, cache: res.headers['cache-control'] }));
    }); req.on('error', reject); req.end();
  });
}
async function raw(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(message));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Request timed out')); });
    socket.once('error', reject); socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
  });
}
describe('production founder runtime without PostgreSQL', () => {
  it('disables only all-absent config and refuses every partial/malformed selection', () => {
    expect(readFounderBrowserSettings({})).toBeUndefined();
    for (const field of Object.keys(environment)) {
      const partial: NodeJS.ProcessEnv = { ...environment }; delete partial[field];
      expect(() => readFounderBrowserSettings(partial)).toThrow('Invalid browser host configuration');
      expect(() => readFounderBrowserSettings({ ...environment, [field]: '' })).toThrow();
    }
    expect(() => readFounderBrowserSettings({ ...environment, FSS_BROWSER_FOUNDER_USER_ID: 'other' })).toThrow();
    expect(() => createFounderBrowserRuntime(settings, { ...fixture().options, auth: undefined })).toThrow();
  });
  it('clones callback and releases one lazy connection on success and failure with fresh readiness', async () => {
    const f = fixture(), runtime = createFounderBrowserRuntime(settings, f.options);
    expect(f.checkout).not.toHaveBeenCalled();
    await runtime.withRequest(async context => {
      expect(context.auth.config.oidc.redirectUri).toBe(`${settings.origin}/browser/callback`);
      expect(context.auth.db).toBe(context.api.session);
      await context.auth.db.query('synthetic query');
    });
    expect(f.auth.config.oidc.redirectUri).toBe('https://desktop.example.test/callback');
    expect(f.checkout).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
    await expect(runtime.withRequest(async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(f.release).toHaveBeenCalledTimes(2);
    f.version(0);
    const work = vi.fn(); await expect(runtime.withRequest(work)).rejects.toThrow('Browser unavailable');
    expect(work).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(3);
    f.version(REQUIRED_SCHEMA); await runtime.withRequest(async () => undefined);
    expect(f.release).toHaveBeenCalledTimes(4);
  });
  it('keeps overlapping request contexts independent and releases both on mixed outcomes', async () => {
    const f = fixture(), runtime = createFounderBrowserRuntime(settings, f.options);
    const sessions: SessionQueryable[] = [];
    const results = await Promise.allSettled([true, false].map(fail => runtime.withRequest(async context => {
      sessions.push(context.api.session);
      await context.api.session.query('synthetic overlapping request');
      if (fail) throw new Error('synthetic failure');
      return context.auth.config.oidc.redirectUri;
    })));
    expect(sessions).toHaveLength(2); expect(sessions[0]).not.toBe(sessions[1]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(f.checkout).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledTimes(2);
  });
  it('retains exact browser ownership, desktop/API notices, health and readiness on one listener', async () => {
    const f = fixture(), browser = browserMountWithAssets(settings, f.options, assets);
    const port = await listen({ ...f.options, browser });
    expect((await get(port, '/')).body).toContain('synthetic'); expect(f.checkout).not.toHaveBeenCalled();
    for (const host of ['browser.example.test', 'desktop.example.test']) {
      expect((await get(port, '/healthz', host)).status).toBe(200);
      expect((await get(port, '/readyz', host)).status).toBe(200);
    }
    expect((await get(port, '/auth/client-version', 'desktop.example.test')).status).toBe(200);
    const before = f.checkout.mock.calls.length;
    expect((await get(port, '/auth/client-version')).status).toBe(404);
    expect((await get(port, '/browser/session', 'wrong.example.test')).status).toBe(400);
    expect((await get(port, '/browser/session', 'Browser.example.test')).status).toBe(400);
    expect((await get(port, '/browser/session', 'browser.example.test', { origin: 'https://wrong.test' })).status).toBe(403);
    expect(f.checkout).toHaveBeenCalledTimes(before);
    const signedOut = await get(port, '/browser/session');
    expect(signedOut.status).toBe(200); expect(signedOut.cache).toBe('private, no-store');
    expect(JSON.parse(signedOut.body)).toMatchObject({ status: 'signed_out' });
    f.version(0); expect((await get(port, '/browser/session')).status).toBe(503);
    expect(f.checkout.mock.calls.length).toBe(f.release.mock.calls.length);
  });
  it('refuses another admin in the founder workspace and workspace mismatch over the real listener', async () => {
    const f = fixture(), port = await listen({ ...f.options, browser: browserMountWithAssets(settings, f.options, assets) });
    const cookie = `${COOKIE_NAMES.access}=${sealCookie(settings.cookieKey, settings.origin, COOKIE_NAMES.access, { kind: 'access', token: 't'.repeat(50), csrf: 'c'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() })}`;
    const founder = { workspaceId: id, userId: id, deviceId: id, sessionId: id, role: 'admin' };
    for (const principal of [{ ...founder, userId: '22222222-2222-4222-8222-222222222222' }, { ...founder, workspaceId: '22222222-2222-4222-8222-222222222222' }]) {
      authMocks.authenticate.mockResolvedValue({ authenticated: true, principal });
      const result = await get(port, '/browser/session', 'browser.example.test', { cookie });
      expect(result.status).toBe(401); expect(result.body).toBe('{"error":"browser_request_refused"}');
      expect(result.cache).toBe('private, no-store');
    }
    authMocks.authenticate.mockResolvedValue({ authenticated: true, principal: founder });
    expect(JSON.parse((await get(port, '/browser/session', 'browser.example.test', { cookie })).body)).toMatchObject({ status: 'signed_in', userId: id });
    authMocks.authenticate.mockRejectedValueOnce(new Error('synthetic auth failure'));
    expect((await get(port, '/browser/session', 'browser.example.test', { cookie })).status).toBe(503);
    expect(f.checkout).toHaveBeenCalledTimes(4); expect(f.release).toHaveBeenCalledTimes(4);
  });
  it('rejects duplicate hosts, declared oversized bodies and chunked invalid JSON before checkout', async () => {
    const f = fixture(), port = await listen({ ...f.options, browser: browserMountWithAssets(settings, f.options, assets) });
    const cases = [
      'GET /browser/session HTTP/1.1\r\nHost: browser.example.test\r\nHost: desktop.example.test\r\n\r\n',
      `POST /browser/sign-in HTTP/1.1\r\nHost: browser.example.test\r\nContent-Type: application/json\r\nContent-Length: ${MAX_REQUEST_BYTES + 1}\r\n\r\n`,
      'POST /browser/sign-in HTTP/1.1\r\nHost: browser.example.test\r\nOrigin: https://browser.example.test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n',
    ];
    for (const message of cases) expect(await raw(port, message)).toMatch(/HTTP\/1.1 (400|413)/u);
    expect(f.checkout).not.toHaveBeenCalled();
  });
});
