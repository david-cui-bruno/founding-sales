import { randomBytes } from 'node:crypto';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { localCertificate } from '../support/tls.ts';
import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BYTES } from '../../../api/src/limits.ts';
import type { AuthDeps } from '../../../api/src/auth/config.ts';
import type { ApiOptions } from '../../../api/src/server.ts';
import { createBrowserHostHandler } from '../../src/server/host.ts';
import type { BrowserHostOptions } from '../../src/server/hostContract.ts';

const origin = 'https://localhost:8443';
const servers: Server[] = [];
const calls = vi.fn();
async function start(overrides: Partial<BrowserHostOptions> = {}): Promise<number> {
  calls.mockClear();
  const server = createServer(createBrowserHostHandler({
    runtime: { origin, clientVersion: '1.0.0', cookieKey: randomBytes(32), withRequest: async work => {
      calls();
      return work({ auth: { now: () => new Date(), config: { oidc: { redirectUri: `${origin}/browser/callback` } } } as AuthDeps, api: {} as ApiOptions });
    } },
    assets: new Map([['/', { body: Buffer.from('public'), contentType: 'text/html; charset=utf-8' }]]),
    bodyTimeoutMs: 100,
    ...overrides,
  }));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test address');
  return address.port;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function send(port: number, path = '/', method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers: { host: 'localhost:8443', ...headers } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
async function raw(port: number, wire: string, abort = false): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  let output = '';
  socket.on('data', chunk => { output += chunk.toString(); });
  socket.write(wire);
  if (abort) socket.destroy();
  await once(socket, 'close');
  return output;
}
const postHeaders = { origin, 'content-type': 'application/json' };

describe('thin host HTTP transport', () => {
  it('is directly consumable by an actual Node HTTPS server', async () => {
    const certificate = await localCertificate();
    const handler = createBrowserHostHandler({
      runtime: { origin, clientVersion: '1.0.0', cookieKey: randomBytes(32), withRequest: async () => { throw new Error('Static must not authenticate'); } },
      assets: new Map([['/', { body: Buffer.from('TLS public'), contentType: 'text/html; charset=utf-8' }]]),
    });
    const server = createHttpsServer(certificate, handler);
    servers.push(server);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing test address');
      const result = await new Promise<string>((resolve, reject) => {
        const outgoing = httpsRequest({ hostname: '127.0.0.1', port: address.port, path: '/', ca: certificate.cert, servername: 'localhost', headers: { host: 'localhost:8443' } }, incoming => {
          let body = '';
          incoming.on('data', chunk => { body += String(chunk); });
          incoming.on('end', () => resolve(body));
          incoming.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      expect(result).toBe('TLS public');
    } finally { await certificate.remove(); }
  });
  it('serves immutable exact assets with security headers, HEAD and no fallback', async () => {
    const bytes = Buffer.from('public');
    const asset = { body: bytes, contentType: 'text/html; charset=utf-8' as const };
    const assets = new Map([['/', asset]]);
    const port = await start({ assets });
    bytes.fill(120);
    assets.clear();
    const result = await send(port);
    expect(result.body).toBe('public');
    expect(result.headers).toMatchObject({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(self), geolocation=()' });
    expect(result.headers['content-security-policy']).toContain("script-src 'self'");
    expect(result.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/u);
    const head = await send(port, '/', 'HEAD');
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('6');
    expect((await send(port, '/', 'POST', postHeaders, '{}')).status).toBe(405);
    expect((await send(port, '/missing.js')).status).toBe(404);
    expect((await send(port, '/browserish')).status).toBe(404);
    expect(calls).not.toHaveBeenCalled();
  });
  it.each(['/../', '/a/../', '/%2e%2e/', '/%62rowser/session', '//localhost/', 'https://localhost:8443/browser/session', '/browser\\session', '/browser/session#x'])('rejects noncanonical path %s before authority', async path => {
    const result = await send(await start(), path);
    expect(result.status).toBe(400);
    expect(result.body).toBe('{"error":"browser_request_refused"}');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(calls).not.toHaveBeenCalled();
  });
  it('routes a real adapter session and retains separate cookies', async () => {
    const port = await start();
    const result = await send(port, '/browser/session');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'signed_out', csrfToken: expect.any(String) });
    expect(result.headers['set-cookie']).toHaveLength(2);
    expect(calls).toHaveBeenCalledTimes(1);
    expect((await send(port, '/browser/session', 'HEAD')).status).toBe(405);
    expect((await send(port, '/browser/nope', 'POST', postHeaders, '{}')).status).toBe(404);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it.each(['broken', 'null', '[]', '1', '"value"'])('refuses malformed/nonobject JSON %s before auth', async body => {
    expect((await send(await start(), '/browser/sign-in', 'POST', postHeaders, body)).status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });
  it('refuses invalid envelopes before waiting for any upload bytes', async () => {
    const port = await start({ bodyTimeoutMs: 1000 });
    for (const [path, extra, status] of [['/unknown', '', 404], ['/browser/nope', '', 404], ['/browser/sign-in', 'Content-Type: text/plain\r\n', 415]] as const) {
      const output = await raw(port, `POST ${path} HTTP/1.1\r\nHost: localhost:8443\r\nOrigin: ${origin}\r\nContent-Length: 100\r\n${extra}\r\n`);
      expect(output).toContain(` ${String(status)} `);
    }
    expect(calls).not.toHaveBeenCalled();
  });
  it('rejects declared and chunked raw oversize before parsing or auth', async () => {
    const port = await start({ bodyTimeoutMs: 2000 });
    const declared = await send(port, '/browser/sign-in', 'POST', { ...postHeaders, 'content-length': String(MAX_REQUEST_BYTES + 1) });
    expect(declared.status).toBe(413);
    const chunked = await send(port, '/browser/sign-in', 'POST', { ...postHeaders, 'transfer-encoding': 'chunked' }, ' '.repeat(MAX_REQUEST_BYTES + 1));
    expect(chunked.status).toBe(413);
    expect(calls).not.toHaveBeenCalled();
  });
  it('rejects host spoofing, encodings, media types and GET bodies', async () => {
    const port = await start();
    for (const headers of [{ host: 'evil.test' }, { host: 'evil.test', 'x-forwarded-host': 'localhost:8443' }, { 'content-encoding': 'gzip' }]) {
      expect((await send(port, '/browser/session', 'GET', headers)).status).toBeGreaterThanOrEqual(400);
    }
    for (const contentType of ['text/plain', 'application/json; charset=latin1', 'application/json; arbitrary=yes']) {
      expect((await send(port, '/browser/sign-in', 'POST', { ...postHeaders, 'content-type': contentType }, '{}')).status).toBe(415);
    }
    expect((await send(port, '/browser/session', 'GET', { 'content-length': '2' }, '{}')).status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });
  it.each(['Cookie: a=1\r\nCookie: b=2', 'Origin: https://localhost:8443\r\nOrigin: https://localhost:8443', 'X-Callie-CSRF: a\r\nX-Callie-CSRF: b', 'Host: localhost:8443', 'Content-Type: application/json\r\nContent-Type: application/json'])('refuses duplicate security headers %s', async extra => {
    const output = await raw(await start(), `GET /browser/session HTTP/1.1\r\nHost: localhost:8443\r\n${extra}\r\nConnection: close\r\n\r\n`);
    expect(output).toContain('400');
    expect(calls).not.toHaveBeenCalled();
  });
  it('refuses malformed declared lengths at the Node parser boundary', async () => {
    const output = await raw(await start(), 'POST /browser/sign-in HTTP/1.1\r\nHost: localhost:8443\r\nContent-Length: nope\r\nConnection: close\r\n\r\n');
    expect(output).toContain('400');
    expect(calls).not.toHaveBeenCalled();
  });
  it('times out stalled uploads and never routes aborted uploads', async () => {
    const port = await start({ bodyTimeoutMs: 30 });
    const prefix = 'POST /browser/sign-in HTTP/1.1\r\nHost: localhost:8443\r\nOrigin: https://localhost:8443\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{';
    expect(await raw(port, prefix)).toContain('408');
    await raw(port, prefix, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).not.toHaveBeenCalled();
    expect((await send(port, '/browser/session')).status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it('leaves Origin and CSRF decisions with the unchanged browser adapter', async () => {
    const port = await start();
    expect((await send(port, '/browser/sign-in', 'POST', { ...postHeaders, origin: 'https://evil.test' }, '{}')).status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
    expect((await send(port, '/browser/sign-in', 'POST', postHeaders, '{}')).status).toBe(403);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, NaN, Infinity, 30001])('rejects invalid upload timeout %s', async bodyTimeoutMs => {
    await expect(start({ bodyTimeoutMs })).rejects.toThrow('Invalid browser host configuration');
  });
});
