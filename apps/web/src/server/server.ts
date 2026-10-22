import { createServer, type Server } from 'node:https';
import { buildBrowserAssets } from './assets.ts';
import { createBrowserHostHandler } from './host.ts';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY, BROWSER_JSON_CONTENT_TYPE } from './httpPolicy.ts';
import type { Socket } from 'node:net';
import type { BrowserServerOptions } from './hostContract.ts';

/** Actual host entry. Composition supplies existing auth/API request ownership;
 * no local test identity/router, process environment or real credentials live here. */
export async function createBrowserServer(options: BrowserServerOptions): Promise<Server> {
  const assets = options.assets ?? await buildBrowserAssets();
  const handler = createBrowserHostHandler({
    runtime: { ...options.settings, cookieKey: Buffer.from(options.settings.cookieKey), withRequest: options.withRequest },
    assets,
    ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: options.bodyTimeoutMs }),
  });
  const server = createServer({
    ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16_384,
    headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000,
  }, handler);
  const refused = new WeakSet<Socket>();
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
    // A parser may report more than once for the same packet. Never append another
    // response, including after an earlier application response on this socket.
    if (refused.has(socket)) return;
    refused.add(socket);
    if (error.code === 'ECONNRESET' || socket.destroyed || !socket.writable || socket.writableEnded || socket.bytesWritten > 0) {
      socket.destroy();
      return;
    }
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
      : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
    const headers = {
      ...BROWSER_SECURITY_HEADERS,
      'content-type': BROWSER_JSON_CONTENT_TYPE,
      'content-length': String(Buffer.byteLength(BROWSER_REFUSAL_BODY)),
      connection: 'close',
    };
    const wire = `HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${BROWSER_REFUSAL_BODY}`;
    // No parser message/rawPacket is reflected or logged. Bound the close even if
    // the peer never reads, and contain a reset racing the final fixed write.
    socket.once('error', () => { socket.destroy(); });
    socket.setTimeout(1000, () => { socket.destroy(); });
    try { socket.end(wire, () => { socket.destroy(); }); }
    catch { socket.destroy(); }
  });
  return server;
}
