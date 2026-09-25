import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionQueryable } from '@fss/domain/db';
import type { ClientVersionRange } from '@fss/contracts';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { MAX_REQUEST_BYTES, REFUSAL_STATUS, checkEnvelope, redactError, type RefusalCode } from './limits.ts';
import { authenticate, type AuthDeps } from './auth/index.ts';
import type { VerifiedPrincipal } from './scope.ts';
import {
  DatabaseBusyError,
  requestConnection,
  unconnectedSession,
  type RequestConnections,
} from './bootstrap/connections.ts';
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
 *
 * **One connection per request** (lane g75). `createApiServer` is given a source of
 * connections, never a connection: each request gets its own backend from the pool on
 * its first statement, keeps it for every statement after — the principal, a renewal,
 * the command receipt, the route and the receipt's commit — and gives it back in
 * `handle`'s `finally`, on an error too. `dispatch` and `route` still take one
 * `session`, which their callers (the route tests) promise is theirs alone for the call.
 * Until this lane the server shared one `pg.Client` across every request in flight,
 * and two overlapping commands committed or rolled back each other's work
 * (`docs/decisions/g75-one-connection-per-request.md`).
 */

export interface ApiOptions {
  /** One backend for this call and nobody else's: transactions and locks are opened on it. */
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
  /**
   * Which API image this process is (lane g71): a `sha256:` digest from the ECS task
   * metadata, or `unknown`. The settings command compares it with the API digest of
   * the release record an admin's enable names, and refuses when they differ or when
   * this is unknown.
   */
  readonly imageDigest?: string | undefined;
}

/**
 * What the HTTP server is built from: everything a request needs except its
 * connection, which each request checks out for itself.
 *
 * `auth` comes without its `db` for the same reason — the identity functions run on
 * the request's connection, which `optionsForRequest` adds. There is deliberately no
 * way to hand the server one shared session.
 */
export interface ApiServerOptions extends Omit<ApiOptions, 'session' | 'auth'> {
  readonly connections: RequestConnections;
  readonly auth?: Omit<AuthDeps, 'db'> | undefined;
}

/** The options one request runs under: the server's, on that request's own connection. */
export function optionsForRequest(options: ApiServerOptions, session: SessionQueryable): ApiOptions {
  const { connections: _connections, auth, ...shared } = options;
  return { ...shared, session, ...(auth === undefined ? {} : { auth: { ...auth, db: session } }) };
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
    expectedSystemGeneration: options.expectedSystemGeneration,
    ...(options.imageDigest === undefined ? {} : { imageDigest: options.imageDigest }),
  };
}

/**
 * One registry per `ApiOptions` value.
 *
 * The modules close over `RoutingOptions`, so the registry cannot be a module-level
 * constant; it is built once for each `ApiOptions` value and kept against it. A route
 * test passes the same object for many calls and gets one registry. The server builds
 * one per request, because each request's options carry that request's connection
 * (`optionsForRequest`): the modules are closures over a session, and a closure over a
 * shared one is the defect lane g75 removed. Building it is a few thousand string
 * comparisons, and `createApiServer` still builds one eagerly — a duplicate path claim
 * should refuse when the server is created, not on the first request that reaches it.
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

export function createApiServer(options: ApiServerOptions): Server {
  // For the refusal and the log line only. It is never dispatched, so its session has
  // no connection behind it.
  const registry = registryFor(optionsForRequest(options, unconnectedSession()));
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

/** A stable refusal code: lower-case words joined by underscores. Nothing else is logged. */
const REFUSAL_CODE_SHAPE = /^[a-z][a-z0-9_]{0,79}$/u;

/**
 * The refusal code a route answered with, or null.
 *
 * Two shapes carry one: a command refusal, `{ status: 'refused', reason }` (`crmReply`,
 * `runPolicyCommand`, `contextForPrincipal`), and a redacted error, `{ error, message }`
 * (`redactError`). `reason` is read first, as the desktop's `refusalOf` reads it. A value
 * that is not code-shaped — a sentence, a number, anything with a `+` or a space — is
 * dropped rather than logged.
 */
export function refusalCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as { readonly reason?: unknown; readonly error?: unknown };
  const code = typeof record.reason === 'string' ? record.reason : record.error;
  return typeof code === 'string' && REFUSAL_CODE_SHAPE.test(code) ? code : null;
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ApiServerOptions): Promise<void> {
  const method = request.method ?? 'GET';
  let path = '/';
  // This request's connection. Nothing is checked out until its first statement, so a
  // refused envelope, a body still arriving and `/healthz` hold no backend; from that
  // statement on every one runs on the same backend, and `finally` gives it back.
  const connection = requestConnection(options.connections);
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
      optionsForRequest(options, connection.session),
    );
    if (result.status >= 400) {
      // `reason` stays the HTTP status: it is the Refusals metric's dimension. `code` is
      // what the body said (lane g69), so a 409 from `/calling-identities/register`
      // reads `number_invalid` or `number_registered_to_another` rather than a bare
      // status that fits five refusals. Only a code-shaped string is taken, never the
      // request body, so nothing a person typed reaches the log.
      const code = refusalCodeOf(result.body);
      options.log?.log('info', 'refusal', { reason: String(result.status), path, ...(code === null ? {} : { code }) });
    }
    send(response, result.status, result.body, result.contentType);
  } catch (error) {
    if (error instanceof DatabaseBusyError) {
      // Every connection was in use for the whole checkout timeout. The checkout is
      // the request's first statement, so nothing ran; a 503 the caller may retry, not
      // a hang and not an `internal_error`. Logged like the envelope refusals, with the
      // code as the `reason`, and as the `code` lane g69's route refusals carry.
      options.log?.log('info', 'refusal', { reason: 'database_busy', code: 'database_busy', path });
      send(response, REFUSAL_STATUS.database_busy, redactError('database_busy'));
      return;
    }
    // `level: "error"` is the ApiErrors metric filter. The caller learns nothing
    // about why: the why may name a table, a path or a prospect.
    options.log?.log('error', 'request_failed', { path, ...errorFields(error) });
    send(response, REFUSAL_STATUS.internal_error, redactError('internal_error'));
  } finally {
    connection.release();
  }
}
