import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionQueryable } from '@fss/domain/db';
import type { ClientVersionRange } from '@fss/contracts';
import { buildHealthReport, type HealthReport } from './health.ts';
import { REFUSAL_STATUS, checkEnvelope, redactError, type RefusalCode } from './limits.ts';

/**
 * The API skeleton.
 *
 * One route: `GET /health`. No business route exists yet, and the router refuses
 * everything else with a redacted `not_found` rather than falling through to a
 * default handler, so a route added later is added deliberately.
 */

export interface ApiOptions {
  readonly session: SessionQueryable;
  readonly supportedClientVersions: ClientVersionRange;
  readonly sendingEnabled: boolean;
}

export type RouteResult =
  | { readonly status: number; readonly body: HealthReport }
  | { readonly status: number; readonly body: { readonly error: RefusalCode; readonly message: string } };

/** The router as a pure function of method, path and options, so it is testable without a socket. */
export async function route(method: string, path: string, options: ApiOptions): Promise<RouteResult> {
  if (path !== '/health') return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const report = await buildHealthReport(options);
  // A degraded API still answers 200 on /health: the load balancer's decision and the
  // operator's are different questions, and the body says which one this is.
  return { status: 200, body: report };
}

export function createApiServer(options: ApiOptions): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, options);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ApiOptions): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      // No caching of anything this API says: everything it says is about right now.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(payload);
  };

  try {
    const envelope = checkEnvelope({
      method: request.method ?? 'GET',
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
    });
    if (!envelope.accepted) {
      // Refused before a byte of body is read.
      request.destroy();
      send(REFUSAL_STATUS[envelope.code], redactError(envelope.code));
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const result = await route(request.method ?? 'GET', path, options);
    send(result.status, result.body);
  } catch {
    send(REFUSAL_STATUS.internal_error, redactError('internal_error'));
  }
}
