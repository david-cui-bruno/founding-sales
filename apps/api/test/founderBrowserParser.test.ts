import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientVersionPolicySchema } from '@fss/contracts';
import { createApiServer } from '../src/server.ts';
import { BROWSER_HTTP_LIMITS } from '../src/bootstrap/browserTransport.ts';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY, BROWSER_JSON_CONTENT_TYPE } from '../../web/src/server/httpPolicy.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
function shared(browserEnabled = true) {
  const checkout = vi.fn(async () => { throw new Error('Parser refusal must not reach a database'); });
  const handler = vi.fn();
  const server = createApiServer({
    connections: { checkout }, sendingEnabled: false,
    supportedClientVersions: clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.x', incompatible: [] }),
    ...(browserEnabled ? { browser: { origin: 'https://sales.example.test', handler } } : {}),
  });
  servers.push(server);
  return { server, checkout, handler };
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function exchange(port: number, message: string, afterFirstResponse?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(message); });
    let wire = '', sent = false;
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Parser refusal did not close within the local test bound')); }, 2000);
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      wire += String(chunk);
      if (!sent && afterFirstResponse !== undefined && wire.includes('\r\n\r\n')) {
        sent = true; socket.write(afterFirstResponse);
      }
    });
    socket.once('error', error => { clearTimeout(deadline); reject(error); });
    socket.once('close', () => { clearTimeout(deadline); resolve(wire); });
  });
}
function fixed(wire: string, status: number): void {
  expect(wire).toMatch(new RegExp(`^HTTP/1.1 ${status} `, 'u'));
  const split = wire.indexOf('\r\n\r\n');
  const headers = new Map(wire.slice(0, split).split('\r\n').slice(1).map(line => {
    const separator = line.indexOf(': '); return [line.slice(0, separator).toLowerCase(), line.slice(separator + 2)];
  }));
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) expect(headers.get(name)).toBe(value);
  expect(headers.get('content-type')).toBe(BROWSER_JSON_CONTENT_TYPE);
  expect(headers.get('content-length')).toBe(String(Buffer.byteLength(BROWSER_REFUSAL_BODY)));
  expect(headers.get('connection')).toBe('close');
  expect(wire.slice(split + 4)).toBe(BROWSER_REFUSAL_BODY);
  expect(wire.match(/HTTP\/1.1 /gu)).toHaveLength(1);
}
function fakeSocket(overrides: Partial<{ destroyed: boolean; writable: boolean; writableEnded: boolean; bytesWritten: number }> = {}) {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, writable: true, writableEnded: false, bytesWritten: 0,
    destroy: vi.fn(), end: vi.fn(), setTimeout: vi.fn(), ...overrides,
  });
  return { socket, transport: socket as unknown as Socket };
}
function parserError(code = 'HPE_INVALID_HEADER_TOKEN'): NodeJS.ErrnoException {
  return Object.assign(new Error('private-parser-message-never-reflect'), { code, rawPacket: Buffer.from('private-parser-packet-never-reflect') });
}
describe('S1 shared listener pre-request parser boundary, no PostgreSQL', () => {
  it.each([
    ['malformed header token', 'GET /browser/session HTTP/1.1\r\nHost: sales.example.test\r\ninvalid header: private-marker\r\n\r\n', 400],
    ['header overflow', `GET /browser/session HTTP/1.1\r\nHost: sales.example.test\r\nX-Large: ${'x'.repeat(20_000)}\r\n\r\n`, 431],
  ])('returns fixed hardened JSON and closes actual shared HTTP on %s', async (_name, message, status) => {
    const f = shared(), wire = await exchange(await listen(f.server), message);
    fixed(wire, status); expect(wire).not.toContain('private-marker');
    expect(f.checkout).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled();
  });
  it('does not append a parser response after a real application response on keepalive', async () => {
    const f = shared(), wire = await exchange(await listen(f.server),
      'GET /healthz HTTP/1.1\r\nHost: sales.example.test\r\n\r\n',
      'GET /browser/session HTTP/1.1\r\nHost: sales.example.test\r\ninvalid header: private-marker\r\n\r\n');
    expect(wire).toMatch(/^HTTP\/1.1 200 /u); expect(wire).toContain('"status":"live"');
    expect(wire.match(/HTTP\/1.1 /gu)).toHaveLength(1); expect(wire).not.toContain('browser_request_refused');
    expect(f.checkout).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled();
  });
  it('leaves disabled API parser behavior/default limits unchanged and pins enabled limits explicitly', async () => {
    const native = createServer(); servers.push(native);
    const disabled = shared(false), enabled = shared();
    for (const name of ['headersTimeout', 'requestTimeout', 'keepAliveTimeout'] as const) {
      expect(disabled.server[name]).toBe(native[name]); expect(enabled.server[name]).toBe(BROWSER_HTTP_LIMITS[name]);
    }
    expect(Reflect.get(disabled.server, 'maxHeaderSize')).toBe(Reflect.get(native, 'maxHeaderSize'));
    expect(Reflect.get(enabled.server, 'maxHeaderSize')).toBe(BROWSER_HTTP_LIMITS.maxHeaderSize);
    expect(disabled.server.listenerCount('clientError')).toBe(0); expect(enabled.server.listenerCount('clientError')).toBe(1);
    const wire = await exchange(await listen(disabled.server), 'GET / HTTP/1.1\r\nHost: desktop.example.test\r\ninvalid header: x\r\n\r\n');
    expect(wire).toMatch(/^HTTP\/1.1 400 /u); expect(wire).not.toContain(BROWSER_REFUSAL_BODY);
    expect(disabled.checkout).not.toHaveBeenCalled();
  });
  it.each([
    ['reset', {}, 'ECONNRESET'], ['destroyed', { destroyed: true }, 'HPE_INVALID_HEADER_TOKEN'],
    ['nonwritable', { writable: false }, 'HPE_INVALID_HEADER_TOKEN'], ['ended', { writableEnded: true }, 'HPE_INVALID_HEADER_TOKEN'],
    ['already written', { bytesWritten: 1 }, 'HPE_INVALID_HEADER_TOKEN'],
  ])('destroys %s socket without a new response, including repeated errors', (_name, state, code) => {
    const f = shared(), fake = fakeSocket(state);
    f.server.emit('clientError', parserError(code), fake.transport);
    f.server.emit('clientError', parserError(), fake.transport);
    expect(fake.socket.end).not.toHaveBeenCalled(); expect(fake.socket.destroy).toHaveBeenCalledTimes(1);
    expect(fake.socket.setTimeout).not.toHaveBeenCalled(); expect(f.checkout).not.toHaveBeenCalled();
  });
  it.each(['HPE_INVALID_HEADER_TOKEN', 'HPE_HEADER_OVERFLOW', 'ERR_HTTP_REQUEST_TIMEOUT'])('contains repeated parser errors and destroys after final write for %s', code => {
    const f = shared(), fake = fakeSocket();
    f.server.emit('clientError', parserError(code), fake.transport);
    f.server.emit('clientError', parserError(code), fake.transport);
    expect(fake.socket.end).toHaveBeenCalledTimes(1);
    const [wire, complete] = fake.socket.end.mock.calls[0] as unknown as [string, () => void];
    fixed(wire, code === 'HPE_HEADER_OVERFLOW' ? 431 : code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400);
    expect(wire).not.toContain('private-parser');
    complete(); expect(fake.socket.destroy).toHaveBeenCalledTimes(1);
    expect(fake.socket.setTimeout.mock.calls[0]?.[0]).toBe(1000);
  });
  it('bounds non-reading close and contains reset/error racing the final write', () => {
    const f = shared(), stalled = fakeSocket(), reset = fakeSocket();
    f.server.emit('clientError', parserError(), stalled.transport);
    const timeout = stalled.socket.setTimeout.mock.calls[0]?.[1] as () => void;
    timeout(); expect(stalled.socket.destroy).toHaveBeenCalledTimes(1);
    f.server.emit('clientError', parserError(), reset.transport);
    expect(() => reset.socket.emit('error', new Error('synthetic reset'))).not.toThrow();
    expect(reset.socket.destroy).toHaveBeenCalledTimes(1);
  });
  it('contains synchronous final-write failure without retrying another response', () => {
    const f = shared(), fake = fakeSocket(); fake.socket.end.mockImplementation(() => { throw new Error('synthetic write failure'); });
    expect(() => f.server.emit('clientError', parserError(), fake.transport)).not.toThrow();
    f.server.emit('clientError', parserError(), fake.transport);
    expect(fake.socket.end).toHaveBeenCalledTimes(1); expect(fake.socket.destroy).toHaveBeenCalledTimes(1);
  });
});
