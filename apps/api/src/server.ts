import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionQueryable } from '@fss/domain/db';
import type { ClientVersionRange } from '@fss/contracts';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { buildHealthReport } from './health.ts';
import { MAX_REQUEST_BYTES, REFUSAL_STATUS, checkEnvelope, redactError } from './limits.ts';
import { authenticate, type AuthDeps } from './auth/index.ts';
import { routeAuth } from './routes/auth.ts';
import { routeAdminDevices } from './routes/admin/devices.ts';
import { ADMIN_JOBS_PATHS, routeAdminJobs } from './routes/admin/jobs.ts';
import { routeAdminMemberships } from './routes/admin/memberships.ts';
import { routeContacts } from './routes/contacts.ts';
import { routeFirms } from './routes/firms.ts';
import { routeMerges } from './routes/merges.ts';
import { routeOpportunities } from './routes/opportunities.ts';
import { routePipeline } from './routes/pipeline.ts';
// Lane G4's policy, suppression and dialing surface.
import { routeCallbacks } from './routes/callbacks.ts';
import { routeCalls } from './routes/calls.ts';
import { routeDial } from './routes/dial.ts';
import { routePauses } from './routes/pauses.ts';
import { routePostures } from './routes/postures.ts';
import { routeSuppressions } from './routes/suppressions.ts';
import { localNoopSuppressionJournal } from './journal/index.ts';
import { DEFAULT_UPGRADE_URL, type ApiRequest, type RouteResult, type RoutingOptions } from './routes/types.ts';

/**
 * The API's one handler.
 *
 * `route` stays a pure async function of the request envelope, so every route is
 * tested without binding a port (docs/decisions/g0-api-http-server.md). Each module
 * under `routes/` answers `null` for a path that is not its own, and the dispatcher
 * below refuses anything nobody claimed with a redacted `not_found` rather than
 * falling through — so a route cannot appear without its authentication.
 *
 * Identity arrives as `options.auth`. Without it the API serves `/health` and the
 * client-version notice and refuses the rest, which is what a deployment that has not
 * been given its Google configuration should do.
 */

export interface ApiOptions {
  readonly session: SessionQueryable;
  readonly supportedClientVersions: ClientVersionRange;
  readonly sendingEnabled: boolean;
  /** Present once the deployment has its Google configuration. */
  readonly auth?: AuthDeps;
  /** Where a person is told to get the current build. Defaults to the public page. */
  readonly upgradeUrl?: string;
  /**
   * The object-locked suppression journal (10.2). A deployment without one falls
   * back to the local no-op, which is right for a laptop and wrong for production;
   * `requireDurableJournal` in `journal/index.ts` is what a production bootstrap
   * calls so that a missing bucket is a refusal to start rather than a silently
   * discarded audit trail.
   */
  readonly suppressionJournal?: SuppressionJournal;
}

export type { ApiRequest, RouteResult } from './routes/types.ts';

function routingOptions(options: ApiOptions): RoutingOptions {
  return {
    session: options.session,
    supportedClientVersions: options.supportedClientVersions,
    sendingEnabled: options.sendingEnabled,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    upgradeUrl: options.upgradeUrl ?? DEFAULT_UPGRADE_URL,
    suppressionJournal: options.suppressionJournal ?? localNoopSuppressionJournal(),
  };
}

export async function dispatch(request: ApiRequest, options: ApiOptions): Promise<RouteResult> {
  const routing = routingOptions(options);

  if (request.path === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    // A degraded API still answers 200 on /health: the load balancer's decision and the
    // operator's are different questions, and the body says which one this is.
    return { status: 200, body: await buildHealthReport(options) };
  }

  // Lane G5's admin job and alert routes. They take a verified principal rather than a
  // request, which is why they arrived unmounted: producing one is this lane's session
  // and device verification. `authenticate` is the only thing that makes a principal,
  // so a revoked device or an ended membership never becomes one and arrives as null.
  //
  // A salesperson's principal is passed through rather than flattened to null: G5's
  // module refuses a non-admin itself, with `unauthenticated`'s redacted sentence, so
  // an admin-only endpoint still does not tell a salesperson it exists. The domain
  // commands behind it check `isAdminScope` again — this is the first of two gates.
  if (routing.auth !== undefined && (ADMIN_JOBS_PATHS as readonly string[]).includes(request.path)) {
    const outcome = await authenticate(routing.auth, request.headers['authorization']);
    const principal = outcome.authenticated ? outcome.principal : null;
    const answer = await routeAdminJobs({
      method: request.method,
      path: request.path,
      principal,
      body: request.body as Readonly<Record<string, unknown>> | undefined,
      db: routing.auth.db,
    });
    if (answer !== null) return answer;
  }

  for (const module of [
    routeAuth,
    routeAdminMemberships,
    routeAdminDevices,
    // Lane G3a's CRM surface. Each answers null for a path that is not its own and
    // authenticates for itself, in the same style as the modules above.
    routeFirms,
    routeContacts,
    routeOpportunities,
    routePipeline,
    routeMerges,
    // Lane G4's. Same shape: each answers null for a path that is not its own and
    // authenticates for itself.
    routePostures,
    routeSuppressions,
    routeDial,
    routeCalls,
    routeCallbacks,
    routePauses,
  ]) {
    const result = await module(request, routing);
    if (result !== null) return result;
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}

/**
 * The router as a pure function of method and path, kept for the health-only callers
 * and for tests that have no body or headers to give.
 */
export async function route(
  method: string,
  path: string,
  options: ApiOptions,
  extra: { readonly query?: URLSearchParams; readonly headers?: Readonly<Record<string, string | undefined>>; readonly body?: unknown } = {},
): Promise<RouteResult> {
  return await dispatch(
    {
      method,
      path,
      query: extra.query ?? new URLSearchParams(),
      headers: extra.headers ?? {},
      body: extra.body,
    },
    options,
  );
}

export function createApiServer(options: ApiOptions): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, options);
  });
}

async function readBody(request: IncomingMessage): Promise<{ readonly ok: boolean; readonly value: unknown }> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    seen += buffer.length;
    // The declared length was already checked; this is the guard against a body that
    // lied about it, and it stops reading rather than buffering the whole thing.
    if (seen > MAX_REQUEST_BYTES) return { ok: false, value: undefined };
    chunks.push(buffer);
  }
  if (seen === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, value: undefined };
  }
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ApiOptions): Promise<void> {
  const send = (status: number, body: unknown, contentType?: string): void => {
    const isJson = contentType === undefined;
    const payload = isJson ? JSON.stringify(body) : String(body);
    response.writeHead(status, {
      'content-type': contentType ?? 'application/json; charset=utf-8',
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
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = await readBody(request);
    if (!body.ok) {
      send(REFUSAL_STATUS.malformed_body, redactError('malformed_body'));
      return;
    }
    const result = await dispatch(
      {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers as Readonly<Record<string, string | undefined>>,
        body: body.value,
      },
      options,
    );
    send(result.status, result.body, result.contentType);
  } catch {
    send(REFUSAL_STATUS.internal_error, redactError('internal_error'));
  }
}
