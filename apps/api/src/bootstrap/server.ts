import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionQueryable } from '@fss/domain/db';
import { MAX_REQUEST_BYTES, REFUSAL_STATUS, checkEnvelope, redactError, type RefusalCode } from '../limits.ts';
import type { VerifiedPrincipal } from '../scope.ts';
import { dispatch } from './dispatch.ts';
import { errorFields, type Logger } from './log.ts';
import { readBody } from './requestBody.ts';
import { createRouteRegistry, type RouteModule, type RouteRegistry } from './routeRegistry.ts';
import { mountedRoutes } from './routes.ts';

/**
 * The API container's HTTP surface.
 *
 * G0's `apps/api/src/server.ts` is the skeleton with one route on it and is owned by
 * the identity lane while that is in flight. This is the same thirty lines with the
 * registry mounted, and it is what `Dockerfile.api` runs. When the two are merged
 * there should be one of them; `docs/greenfield/processes.md` says which lines move.
 *
 * The order is the contract, and it is the order in which a request can do damage:
 *
 * 1. the envelope — method, content type, declared length — before a byte is read;
 * 2. the body, counted as it arrives, so a lying `Content-Length` is caught too;
 * 3. the principal, which G2's verification produces and which is null until it does;
 * 4. the route, which is mounted or the request is refused.
 *
 * Every refusal is logged as `{"event":"refusal","reason":…}`, which is the filter
 * `infra/modules/observability/main.tf` turns into the `Refusals` metric, and every
 * thrown error as `level: "error"`, which is `ApiErrors`. Neither line carries a body,
 * a path parameter or a header value.
 */

export interface BootstrapServerOptions {
  readonly session: SessionQueryable;
  readonly expectedSystemGeneration: number | null;
  readonly log: Logger;
  /** Extra route modules, so a lane mounts without editing this file. */
  readonly extraRoutes?: readonly RouteModule[] | undefined;
  /**
   * How a request becomes a verified principal. Absent until G2 lands, and absent
   * means every authenticated route refuses — which is the conservative default.
   */
  readonly principalFor?: ((request: IncomingMessage) => Promise<VerifiedPrincipal | null>) | undefined;
}

export function createBootstrapServer(options: BootstrapServerOptions): Server {
  const registry = createRouteRegistry(mountedRoutes(options.extraRoutes ?? []));
  options.log.log('info', 'routes_mounted', { paths: registry.paths().join(' ') });
  return createServer((request, response) => {
    void handle(request, response, options, registry);
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // Nothing this API says is about anything but right now.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

/**
 * Refuse, and close the connection.
 *
 * The body is never read. Node closes the socket once the response has flushed,
 * because the request was not consumed and the connection is marked `close` — so the
 * refusal reaches the caller first and the unread body is discarded after it. The
 * earlier draft destroyed the socket immediately, which is correct about the bytes and
 * wrong about the answer: the client got a broken pipe instead of a 413.
 */
function refuse(response: ServerResponse, log: Logger, code: RefusalCode, path: string): void {
  // `$.event = "refusal"` with the `reason` dimension. The path is the mounted route,
  // never a query string and never an identifier.
  log.log('info', 'refusal', { reason: code, path });
  send(response, REFUSAL_STATUS[code], redactError(code), { connection: 'close' });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: BootstrapServerOptions,
  registry: RouteRegistry,
): Promise<void> {
  const method = request.method ?? 'GET';
  let path = '/';
  try {
    path = new URL(request.url ?? '/', 'http://localhost').pathname;

    const envelope = checkEnvelope({
      method,
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
    });
    if (!envelope.accepted) {
      // Refused before a byte of body is read: reading a body this process has already
      // refused is the attack.
      refuse(response, options.log, envelope.code, path);
      return;
    }

    let body: Readonly<Record<string, unknown>> | undefined;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const read = await readBody(request, MAX_REQUEST_BYTES);
      if (!read.accepted) {
        refuse(response, options.log, read.code, path);
        return;
      }
      body = read.body;
    }

    const principal = options.principalFor === undefined ? null : await options.principalFor(request);

    const result = await dispatch(registry, {
      method,
      path,
      headers: request.headers as Readonly<Record<string, string | undefined>>,
      principal,
      body,
      db: options.session,
      readiness: { session: options.session, expectedSystemGeneration: options.expectedSystemGeneration },
    });
    if (result === null) {
      refuse(response, options.log, 'not_found', path);
      return;
    }
    if (result.status >= 400) options.log.log('info', 'refusal', { reason: String(result.status), path });
    send(response, result.status, result.body);
  } catch (error) {
    // `level: "error"` is the ApiErrors metric filter. The caller learns nothing about
    // why: the why may name a table, a path or a prospect.
    options.log.log('error', 'request_failed', { path, ...errorFields(error) });
    send(response, REFUSAL_STATUS.internal_error, redactError('internal_error'));
  }
}
