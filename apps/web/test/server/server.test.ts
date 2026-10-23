import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect, type TLSSocket } from 'node:tls';
import type { Server } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowserServer } from '../../src/server/server.ts';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY, BROWSER_JSON_CONTENT_TYPE } from '../../src/server/httpPolicy.ts';
import { localCertificate } from '../support/tls.ts';

let certificate: Awaited<ReturnType<typeof localCertificate>>;
const servers: Server[] = [];
const clients: TLSSocket[] = [];
const withRequest = vi.fn(async () => { throw new Error('Parser refusal must not enter runtime'); });
beforeAll(async () => { certificate = await localCertificate(); });
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  vi.restoreAllMocks();
  withRequest.mockClear();
});
afterAll(async () => { await certificate?.remove(); });
async function start(): Promise<{ server: Server; port: number }> {
  const server = await createBrowserServer({
    settings: { origin: 'https://localhost:8443', clientVersion: '1.0.0', cookieKey: randomBytes(32) },
    tls: certificate,
    withRequest,
    assets: new Map([['/', { body: Buffer.from('public'), contentType: 'text/html; charset=utf-8' }]]),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing local server address');
  return { server, port: address.port };
}
async function channel(server: Server, port: number) {
  const accepted = new Promise<TLSSocket>(resolve => server.once('secureConnection', resolve));
  const client = connect({ host: '127.0.0.1', port, servername: 'localhost', ca: certificate.cert });
  clients.push(client);
  const chunks: Buffer[] = [];
  client.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
  client.on('error', () => {});
  const closed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { client.destroy(); reject(new Error('Local socket did not close')); }, 2000);
    client.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
  });
  await once(client, 'secureConnect');
  const socket = await accepted;
  return { client, socket, closed };
}
function assertRefusal(wire: string, status: number): void {
  const separator = wire.indexOf('\r\n\r\n');
  expect(separator).toBeGreaterThan(0);
  const header = wire.slice(0, separator);
  const body = wire.slice(separator + 4);
  expect(header.split('\r\n')[0]).toMatch(new RegExp(`^HTTP/1\\.1 ${String(status)} `, 'u'));
  const headers = Object.fromEntries(header.split('\r\n').slice(1).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  expect(headers).toMatchObject({ ...BROWSER_SECURITY_HEADERS, 'content-type': BROWSER_JSON_CONTENT_TYPE, 'content-length': String(Buffer.byteLength(BROWSER_REFUSAL_BODY)), connection: 'close' });
  expect(headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/u);
  expect(body).toBe(BROWSER_REFUSAL_BODY);
  expect(wire.match(/HTTP\/1\.1/gu)).toHaveLength(1);
  expect(withRequest).not.toHaveBeenCalled();
}
const malformed = 'POST /browser/sign-in HTTP/1.1\r\nHost: localhost:8443\r\nContent-Length: nope\r\nX-Private: must-not-reflect\r\n\r\n';

describe('actual HTTPS factory parser response policy', () => {
  it.each([
    [400, malformed],
    [431, `GET /browser/session HTTP/1.1\r\nHost: localhost:8443\r\nX-Large: ${'x'.repeat(20_000)}\r\n\r\n`],
  ] as const)('uses fixed JSON and handler security policy for parser %s', async (status, request) => {
    const { server, port } = await start();
    const { client, closed } = await channel(server, port);
    client.write(request);
    const wire = await closed;
    assertRefusal(wire, status);
    expect(wire).not.toContain('must-not-reflect');
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
  });
  it('retains 408 for Node parser timeouts', async () => {
    const { server, port } = await start();
    const { socket, closed } = await channel(server, port);
    server.emit('clientError', Object.assign(new Error('not public'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }), socket);
    assertRefusal(await closed, 408);
  });
  it('writes only once on repeated clientError events', async () => {
    const { server, port } = await start();
    const { socket, closed } = await channel(server, port);
    const end = vi.spyOn(socket, 'end');
    server.emit('clientError', new Error('first private message'), socket);
    server.emit('clientError', new Error('second private message'), socket);
    assertRefusal(await closed, 400);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it.each(['destroyed', 'ended', 'reset'] as const)('does not write to %s sockets', async state => {
    const { server, port } = await start();
    const { socket, closed } = await channel(server, port);
    if (state === 'destroyed') socket.destroy();
    if (state === 'ended') socket.end();
    const end = vi.spyOn(socket, 'end');
    server.emit('clientError', Object.assign(new Error('not public'), { code: state === 'reset' ? 'ECONNRESET' : 'HPE_INVALID_CONTENT_LENGTH' }), socket);
    expect(await closed).toBe('');
    expect(end).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(withRequest).not.toHaveBeenCalled();
  });
  it('does not append a refusal after a response has started', async () => {
    const { server, port } = await start();
    const { client, socket, closed } = await channel(server, port);
    const data = once(client, 'data');
    client.write('GET / HTTP/1.1\r\nHost: localhost:8443\r\n\r\n');
    await data;
    expect(socket.bytesWritten).toBeGreaterThan(0);
    client.write(malformed);
    const wire = await closed;
    expect(wire).toContain('HTTP/1.1 200 OK');
    expect(wire).toContain('public');
    expect(wire).not.toContain(BROWSER_REFUSAL_BODY);
    expect(wire.match(/HTTP\/1\.1/gu)).toHaveLength(1);
    expect(withRequest).not.toHaveBeenCalled();
  });
  it('bounds socket close when the final write never completes', async () => {
    const { server, port } = await start();
    const { socket, closed } = await channel(server, port);
    const end = vi.spyOn(socket, 'end').mockImplementationOnce(() => socket);
    server.emit('clientError', new Error('not public'), socket);
    expect(await closed).toBe('');
    expect(end).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
    expect(withRequest).not.toHaveBeenCalled();
  });
  it('contains a synchronous close/write race without a second attempt', async () => {
    const { server, port } = await start();
    const { socket, closed } = await channel(server, port);
    const end = vi.spyOn(socket, 'end').mockImplementationOnce(() => { throw new Error('local write race'); });
    expect(() => server.emit('clientError', new Error('not public'), socket)).not.toThrow();
    expect(await closed).toBe('');
    expect(end).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
    expect(withRequest).not.toHaveBeenCalled();
  });
});
