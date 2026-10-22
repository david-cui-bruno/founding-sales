import { createHash, timingSafeEqual } from 'node:crypto';
import { startSignIn, handleCallback, claimSignIn } from '../../../api/src/auth/signIn.ts';
import { authenticate, endSession, type AuthenticatedPrincipal } from '../../../api/src/auth/sessions.ts';
import { route } from '../../../api/src/server.ts';
import { MAX_REQUEST_BYTES } from '../../../api/src/limits.ts';
import type { ApiRequest } from '../../../api/src/routes/types.ts';
import { BROWSER_PATHS, BROWSER_COMMAND_PATHS, BROWSER_CSRF_HEADER, BROWSER_REVISION_HEADER, browserApiPathAllowed, browserSessionSchema, browserSignInSchema } from '../shared/browserContract.ts';
import type { BrowserHandler, BrowserResponse, BrowserRuntime, BrowserRequestContext } from './runtime.ts';
import { COOKIE_NAMES, clearCookie, cookieHeader, freshCsrf, openCookie, parseCookies, sealCookie, type Custody } from './cookies.ts';

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});
class Refusal extends Error {
  constructor(readonly status: number) { super('browser_request_refused'); }
}
function response(status: number, body: unknown, cookies: string[] = [], headers: Record<string, string> = {}): BrowserResponse {
  return { status, body, headers: { ...SECURITY_HEADERS, ...headers, ...(cookies.length === 0 ? {} : { 'set-cookie': cookies }) } };
}
function equal(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function revision(principal: AuthenticatedPrincipal): string {
  return createHash('sha256').update(JSON.stringify([principal.workspaceId, principal.userId, principal.deviceId, principal.sessionId, principal.role])).digest('base64url');
}
function envelope(request: ApiRequest, origin: string): void {
  const site = request.headers['sec-fetch-site'];
  const callback = request.path === BROWSER_PATHS.callback && request.method === 'GET';
  if (callback) {
    if (request.headers['sec-fetch-mode'] !== undefined && request.headers['sec-fetch-mode'] !== 'navigate') throw new Refusal(403);
    if (request.headers['sec-fetch-dest'] !== undefined && request.headers['sec-fetch-dest'] !== 'document') throw new Refusal(403);
  } else {
    if (site !== undefined && site !== 'same-origin') throw new Refusal(403);
    if (request.headers['origin'] !== undefined && request.headers['origin'] !== origin) throw new Refusal(403);
    if (request.method === 'POST' && request.headers['origin'] !== origin) throw new Refusal(403);
  }
  if (request.method !== 'GET' && request.method !== 'POST') throw new Refusal(405);
  if (request.query.toString().length > 16384) throw new Refusal(413);
  if (request.method === 'GET' && request.body !== undefined) throw new Refusal(400);
  if (request.method === 'POST') {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Refusal(415);
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new Refusal(413);
    const encoded = JSON.stringify(request.body);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Refusal(413);
  }
}

/** Stateless adapter. Only request-local values ever contain credentials or principals. */
export function createBrowserHandler(runtime: BrowserRuntime): BrowserHandler {
  const originUrl = new URL(runtime.origin);
  if (originUrl.origin !== runtime.origin || originUrl.protocol !== 'https:' || runtime.cookieKey.length !== 32) throw new Error('Invalid browser runtime configuration');
  const key = Buffer.from(runtime.cookieKey);
  return async request => {
    if (request.path !== '/browser' && !request.path.startsWith('/browser/')) return null;
    const outgoing: string[] = [];
    const put = (name: string, value: Custody): void => {
      outgoing.push(cookieHeader(name, sealCookie(key, runtime.origin, name, value), value.expiresAt));
    };
    try {
      envelope(request, runtime.origin);
      if (request.path === BROWSER_PATHS.apiPrefix) throw new Refusal(404);
      const apiPath = request.path.startsWith(`${BROWSER_PATHS.apiPrefix}/`) ? request.path.slice(BROWSER_PATHS.apiPrefix.length) : null;
      const expectedMethod = request.path === BROWSER_PATHS.session || request.path === BROWSER_PATHS.callback ? 'GET' : 'POST';
      if (apiPath !== null ? !browserApiPathAllowed(request.method, apiPath) : !Object.values(BROWSER_PATHS).some(path => path === request.path)) throw new Refusal(404);
      if (apiPath === null && request.method !== expectedMethod) throw new Refusal(405);
      let cookies: Map<string, string>;
      try { cookies = parseCookies(request.headers['cookie']); } catch { throw new Refusal(400); }
      const values = new Map<string, Custody>();
      for (const name of Object.values(COOKIE_NAMES)) {
        const encoded = cookies.get(name);
        if (encoded !== undefined) {
          let decoded: Custody;
          try { decoded = openCookie(key, runtime.origin, name, encoded); } catch { throw new Refusal(400); }
          if (decoded.kind !== (name === COOKIE_NAMES.access ? 'access' : name === COOKIE_NAMES.pending ? 'pending' : 'anonymous')) throw new Refusal(400);
          values.set(name, decoded);
        }
      }
      return await runtime.withRequest(async context => {
        const now = context.auth.now().getTime();
        const live = (name: string): Custody | undefined => {
          const value = values.get(name);
          return value !== undefined && Date.parse(value.expiresAt) > now ? value : undefined;
        };
        if (context.auth.config.oidc.redirectUri !== `${runtime.origin}${BROWSER_PATHS.callback}`) throw new Refusal(503);
        if (request.path === BROWSER_PATHS.callback) {
          const pending = live(COOKIE_NAMES.pending);
          if (pending?.kind !== 'pending' || request.query.getAll('state').length !== 1 || !equal(request.query.get('state') ?? undefined, pending.state)) throw new Refusal(403);
          outgoing.push(clearCookie(COOKIE_NAMES.pending));
          if (request.query.getAll('code').length > 1 || request.query.getAll('error').length > 1) throw new Refusal(400);
          const code = request.query.get('code'), error = request.query.get('error');
          const callback = await handleCallback(context.auth, { state: pending.state, ...(code === null ? {} : { code }), ...(error === null ? {} : { error }) });
          if (!callback.authenticated) throw new Refusal(401);
          const claim = await claimSignIn(context.auth, { handoffSecret: pending.handoff, clientVersion: runtime.clientVersion });
          if (!claim.claimed) throw new Refusal(401);
          put(COOKIE_NAMES.access, { kind: 'access', token: claim.grant.accessToken, csrf: freshCsrf(), expiresAt: claim.grant.accessTokenExpiresAt });
          outgoing.push(clearCookie(COOKIE_NAMES.anonymous));
          return response(303, null, outgoing, { location: '/' });
        }
        const access = live(COOKIE_NAMES.access);
        const authentication = access?.kind === 'access' ? await authenticate(context.auth, `Bearer ${access.token}`) : null;
        const principal = authentication?.authenticated === true ? authentication.principal : null;
        if (request.path === BROWSER_PATHS.session) {
          if (principal !== null && access?.kind === 'access') return response(200, browserSessionSchema.parse({ status: 'signed_in', csrfToken: access.csrf, revision: revision(principal), workspaceId: principal.workspaceId, userId: principal.userId, deviceId: principal.deviceId, role: principal.role, expiresAt: access.expiresAt }), outgoing);
          outgoing.push(clearCookie(COOKIE_NAMES.access));
          const anonymous = live(COOKIE_NAMES.anonymous);
          const csrf = anonymous?.kind === 'anonymous' ? anonymous.csrf : freshCsrf();
          if (anonymous === undefined) put(COOKIE_NAMES.anonymous, { kind: 'anonymous', csrf, expiresAt: new Date(now + 3600_000).toISOString() });
          return response(200, browserSessionSchema.parse({ status: 'signed_out', csrfToken: csrf }), outgoing);
        }
        const anonymous = live(COOKIE_NAMES.anonymous);
        const csrf = principal !== null && access?.kind === 'access' ? access.csrf : anonymous?.kind === 'anonymous' ? anonymous.csrf : undefined;
        if (request.method === 'POST' && (csrf === undefined || !equal(request.headers[BROWSER_CSRF_HEADER], csrf))) throw new Refusal(403);
        if (request.path === BROWSER_PATHS.signIn) {
          if (principal !== null) throw new Refusal(409);
          const input = browserSignInSchema.safeParse(request.body);
          if (!input.success) throw new Refusal(400);
          const started = await startSignIn(context.auth, { ...input.data, clientVersion: runtime.clientVersion });
          if (!started.started) throw new Refusal(401);
          const state = new URL(started.authorizationUrl).searchParams.get('state');
          if (state === null) throw new Refusal(503);
          put(COOKIE_NAMES.pending, { kind: 'pending', state, handoff: started.handoffSecret, expiresAt: started.expiresAt });
          return response(200, { authorizationUrl: started.authorizationUrl }, outgoing);
        }
        if (principal === null || access?.kind !== 'access') {
          outgoing.push(clearCookie(COOKIE_NAMES.access));
          throw new Refusal(401);
        }
        if (!equal(request.headers[BROWSER_REVISION_HEADER], revision(principal))) throw new Refusal(409);
        if (request.path === BROWSER_PATHS.signOut) {
          // Clear local custody on uncertainty, but never claim remote revocation succeeded.
          outgoing.push(...Object.values(COOKIE_NAMES).map(clearCookie));
          await endSession(context.auth, principal);
          return response(200, { status: 'signed_out' }, outgoing);
        }
        return await product(request, apiPath!, context, access.token, outgoing, runtime.clientVersion);
      });
    } catch (error) {
      return response(error instanceof Refusal ? error.status : 503, { error: 'browser_request_refused' }, outgoing);
    }
  };
}

async function product(request: ApiRequest, path: string, context: BrowserRequestContext, token: string, cookies: string[], clientVersion: string): Promise<BrowserResponse> {
  let body = request.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    for (const name of Object.keys(body)) {
      if (['authorization', 'cookie', 'headers', 'origin'].includes(name.toLowerCase())) throw new Refusal(400);
    }
  }
  if ((BROWSER_COMMAND_PATHS as readonly string[]).includes(path)) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400);
    const command = body as Record<string, unknown>;
    if (command['clientVersion'] !== undefined && command['clientVersion'] !== clientVersion) throw new Refusal(400);
    body = { ...command, clientVersion };
  }
  // Construct a closed transport envelope. Neither body nor browser headers set API credentials.
  const result = await route(request.method, path, { ...context.api, auth: context.auth }, {
    query: request.query,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
  return result.status >= 400
    ? response(result.status, { error: 'browser_request_refused' }, cookies)
    : response(result.status, result.body, cookies);
}
