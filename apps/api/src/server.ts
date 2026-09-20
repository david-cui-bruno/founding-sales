import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionQueryable } from '@fss/domain/db';
import type { ClientVersionRange } from '@fss/contracts';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { MAX_REQUEST_BYTES, REFUSAL_STATUS, checkEnvelope, redactError, type RefusalCode } from './limits.ts';
import { authenticate, type AuthDeps } from './auth/index.ts';
import type { VerifiedPrincipal } from './scope.ts';
import { dispatch as dispatchMounted } from './bootstrap/dispatch.ts';
import { errorFields, type Logger } from './bootstrap/log.ts';
import { readBody } from './bootstrap/requestBody.ts';
import { createRouteRegistry, type RouteModule, type RouteRegistry } from './bootstrap/routeRegistry.ts';
import { mountedRoutes } from './bootstrap/routes.ts';
import { apiRouteModules } from './routes/modules.ts';
import { localNoopSuppressionJournal } from './journal/index.ts';
import {
  DEFAULT_UPGRADE_URL,
  type ApiRequest,
  type MailRoutingDeps,
  type RouteResult,
  type RoutingOptions,
} from './routes/types.ts';

/**
 * The API's one handler, and the only one: this is what `Dockerfile.api` runs and
 * what every route test calls.
 *
 * `route` stays a pure async function of the request envelope, so every route is
 * tested without binding a port (docs/decisions/g0-api-http-server.md). What changed
 * in lane G3b is what sits underneath it: G5b's route registry rather than a `for`
 * loop over modules that each check whether the path is their own. A module declares
 * the paths it owns and gets them, or the registry refuses to be built — two modules
 * claiming one path is a startup refusal rather than a silent race between imports.
 * `apps/api/src/routes/modules.ts` is that declaration.
 *
 * The order inside `handle` is the order in which a request can do damage:
 *
 * 1. the envelope — method, content type, declared length — before a byte is read;
 * 2. the body, counted as it arrives, so a lying `Content-Length` is caught too;
 * 3. the principal, which `authenticate` produces and which is null without one;
 * 4. the route, which is mounted or the request is refused with a redacted
 *    `not_found`.
 *
 * Identity arrives as `options.auth`. Without it the API serves `/health`, `/healthz`,
 * `/readyz` and the client-version notice and refuses the rest, which is what a
 * deployment that has not been given its Google configuration should do.
 */

export interface ApiOptions {
  readonly session: SessionQueryable;
  readonly supportedClientVersions: ClientVersionRange;
  readonly sendingEnabled: boolean;
  /**
   * Appendix E step 1: the generation an operator pinned, or null when none is.
   * `/readyz` refuses to serve traffic when the database's generation is not it.
   */
  readonly expectedSystemGeneration: number | null;
  /** Present once the deployment has its Google configuration. */
  readonly auth?: AuthDeps;
  /**
   * Present once the deployment has its Gmail configuration (12.1). Without it the
   * four mail paths answer `not_found`, which is what a deployment that has not been
   * given a Gmail client id, a Pub/Sub audience and an envelope key should do.
   */
  readonly mail?: MailRoutingDeps;
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
  /** Extra route modules, so a lane mounts without editing this file. */
  readonly extraRoutes?: readonly RouteModule[] | undefined;
  /** The structured log the CloudWatch metric filters read. Absent in unit tests. */
  readonly log?: Logger | undefined;
}

export type { ApiRequest, RouteResult } from './routes/types.ts';

function routingOptions(options: ApiOptions): RoutingOptions {
  return {
    session: options.session,
    supportedClientVersions: options.supportedClientVersions,
    sendingEnabled: options.sendingEnabled,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    ...(options.mail === undefined ? {} : { mail: options.mail }),
    ...(options.log === undefined ? {} : { log: options.log }),
    upgradeUrl: options.upgradeUrl ?? DEFAULT_UPGRADE_URL,
    suppressionJournal: options.suppressionJournal ?? localNoopSuppressionJournal(),
  };
}

/**
 * One registry per server.
 *
 * The modules close over `RoutingOptions`, so the registry cannot be a module-level
 * constant; it is built once for each `ApiOptions` value and kept against it. A
 * server passes the same object for its whole life, so it is built once there, and
 * `createApiServer` builds it eagerly — a duplicate path claim should refuse when the
 * server is created, not on the first request that happens to reach it.
 */
const registries = new WeakMap<ApiOptions, RouteRegistry>();

export function registryFor(options: ApiOptions): RouteRegistry {
  const existing = registries.get(options);
  if (existing !== undefined) return existing;
  const registry = createRouteRegistry(mountedRoutes([...apiRouteModules(routingOptions(options)), ...(options.extraRoutes ?? [])]));
  registries.set(options, registry);
  return registry;
}

/**
 * The verified principal for this request, or null.
 *
 * Produced once, here, because the registry hands a module a principal rather than a
 * credential — a route must not be able to reach for an `authorization` header and
 * decide for itself what it means. G3a's CRM modules still authenticate for
 * themselves, which costs a second indexed session read on an authenticated CRM
 * request; `authenticate` is a pure read, so the two agree by construction.
 */
async function principalOf(routing: RoutingOptions, request: ApiRequest): Promise<VerifiedPrincipal | null> {
  if (routing.auth === undefined) return null;
  const header = request.headers['authorization'];
  if (header === undefined) return null;
  const outcome = await authenticate(routing.auth, header);
  return outcome.authenticated ? outcome.principal : null;
}

export async function dispatch(request: ApiRequest, options: ApiOptions): Promise<RouteResult> {
  const routing = routingOptions(options);
  const registry = registryFor(options);
  const principal = await principalOf(routing, request);

  const mounted = await dispatchMounted(registry, {
    method: request.method,
    path: request.path,
    headers: request.headers,
    query: request.query,
    principal,
    body: request.body as Readonly<Record<string, unknown>> | undefined,
    db: options.session,
    readiness: { session: options.session, expectedSystemGeneration: options.expectedSystemGeneration },
  });
  if (mounted !== null) {
    return {
      status: mounted.status,
      body: mounted.body,
      ...(mounted.contentType === undefined ? {} : { contentType: mounted.contentType }),
    };
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
  const registry = registryFor(options);
  options.log?.log('info', 'routes_mounted', {
    paths: registry.paths().join(' '),
    prefixes: registry.prefixes().join(' '),
  });
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, options);
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  contentType?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const isJson = contentType === undefined;
  const payload = isJson ? JSON.stringify(body) : String(body);
  response.writeHead(status, {
    ...extraHeaders,
    'content-type': contentType ?? 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // No caching of anything this API says: everything it says is about right now.
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
 * refusal reaches the caller first and the unread body is discarded after it.
 * Destroying the socket immediately is correct about the bytes and wrong about the
 * answer: the client gets a broken pipe instead of a 413.
 */
function refuse(response: ServerResponse, log: Logger | undefined, code: RefusalCode, path: string): void {
  // `$.event = "refusal"` with the `reason` dimension, which
  // `infra/modules/observability/main.tf` turns into the `Refusals` metric. The path
  // is the requested route, never a query string and never a body.
  log?.log('info', 'refusal', { reason: code, path });
  send(response, REFUSAL_STATUS[code], redactError(code), undefined, { connection: 'close' });
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ApiOptions): Promise<void> {
  const method = request.method ?? 'GET';
  let path = '/';
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    path = url.pathname;

    const envelope = checkEnvelope({
      method,
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
    });
    if (!envelope.accepted) {
      // Refused before a byte of body is read: reading a body this process has
      // already refused is the attack.
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

    const result = await dispatch(
      {
        method,
        path,
        query: url.searchParams,
        headers: request.headers as Readonly<Record<string, string | undefined>>,
        body,
      },
      options,
    );
    if (result.status >= 400) options.log?.log('info', 'refusal', { reason: String(result.status), path });
    send(response, result.status, result.body, result.contentType);
  } catch (error) {
    // `level: "error"` is the ApiErrors metric filter. The caller learns nothing
    // about why: the why may name a table, a path or a prospect.
    options.log?.log('error', 'request_failed', { path, ...errorFields(error) });
    send(response, REFUSAL_STATUS.internal_error, redactError('internal_error'));
  }
}
