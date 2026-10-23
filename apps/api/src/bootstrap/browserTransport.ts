import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY, BROWSER_JSON_CONTENT_TYPE } from '../../../web/src/server/httpPolicy.ts';

/** Pre-request authority is not available to a failed HTTP parser. When browser
 * hosting is enabled its fixed refusal and finite limits protect the whole shared
 * listener. Keep Node's original API defaults untouched when hosting is disabled.
 * The 16KiB header limit and 5s keepalive match Node defaults. 10s headers and 30s
 * request completion intentionally also bound desktop/API uploads on this listener,
 * matching the accepted browser entrypoint rather than weakening its parser edge.
 * These bound receipt of headers/body, not API handler execution or response time.
 */
export const BROWSER_HTTP_LIMITS = Object.freeze({
  maxHeaderSize: 16_384,
  headersTimeout: 10_000,
  requestTimeout: 30_000,
  keepAliveTimeout: 5_000,
});

/** Install once on the existing listener, never create another listener or socket. */
function installBrowserParserRefusals(server: Server): void {
  const refused = new WeakSet<Socket>();
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
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
    // Never reflect or log parser messages/rawPacket. A reset racing the fixed
    // write is contained, and a non-reading peer cannot hold the close indefinitely.
    socket.once('error', () => { socket.destroy(); });
    socket.setTimeout(1000, () => { socket.destroy(); });
    try { socket.end(wire, () => { socket.destroy(); }); }
    catch { socket.destroy(); }
  });
}

export function createApiHttpServer(browserEnabled: boolean, listener: RequestListener): Server {
  const server = createServer(browserEnabled ? BROWSER_HTTP_LIMITS : {}, listener);
  if (browserEnabled) installBrowserParserRefusals(server);
  return server;
}
