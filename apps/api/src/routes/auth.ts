import {
  clientVersionNoticeSchema,
  publishedClientVersions,
  signInClaimRequestSchema,
  signInStartRequestSchema,
  sessionRenewRequestSchema,
  type ClientVersionNotice,
} from '@fss/contracts';
import { authenticate, claimSignIn, endSession, handleCallback, renewSession } from '../auth/index.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The sign-in, session and client-version routes (specification 5.1, 5.3, 14.1).
 *
 * Three of these are reachable without a session, and each one is reachable without
 * a session for a reason: the Mac has no session yet when it starts sign-in, Google's
 * browser redirect carries no session at all, and the client-version notice is what
 * an outdated client is allowed to read (Appendix G 40).
 *
 * Every refusal leaves as a stable code from `AUTH_REFUSAL_CODES` with a fixed
 * sentence. Nothing here ever echoes back a state, a nonce, a code, a token or an
 * email address.
 */

const REFUSAL_HTTP_STATUS = 401;

const refusal = (code: string, status = REFUSAL_HTTP_STATUS): RouteResult => ({
  status,
  body: { error: code, message: 'The request was refused.' },
});

/**
 * The two pages Google's browser lands on. Fixed documents with no interpolation at
 * all: nothing about the sign-in reaches the browser, which is the point of handing
 * the grant to the Mac over its own handoff secret instead.
 */
const CALLBACK_PAGE = (heading: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Callie</title></head><body><h1>${heading}</h1><p>${body}</p></body></html>`;

const SIGNED_IN_PAGE = CALLBACK_PAGE('Signed in', 'You can close this tab and return to Callie.');
const REFUSED_PAGE = CALLBACK_PAGE('Sign-in refused', 'Return to Callie; it will tell you what to do next.');

function notice(options: RoutingOptions): ClientVersionNotice {
  return clientVersionNoticeSchema.parse({
    // The range a 1.0.x Mac can parse: the policy's minimum and its ceiling's top
    // (lane g78). The incompatible list is enforced here, never published.
    supported: publishedClientVersions(options.supportedClientVersions),
    upgradeUrl: options.upgradeUrl,
    instruction:
      'This version of Callie is no longer supported. Install the current build, then sign in again.',
  });
}

/** Returns null when the path is not one of this module's. */
export async function routeAuth(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/auth/')) return null;

  // Readable by anyone, at any version, with no session: this is the upgrade path
  // an outdated client is left with (5.3).
  if (request.path === '/auth/client-version') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    return { status: 200, body: notice(options) };
  }

  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  if (request.path === '/auth/google/callback') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    const state = request.query.get('state') ?? '';
    const code = request.query.get('code');
    const error = request.query.get('error');
    const outcome = await handleCallback(auth, {
      state,
      ...(code === null ? {} : { code }),
      ...(error === null ? {} : { error }),
    });
    return {
      status: outcome.authenticated ? 200 : 400,
      contentType: 'text/html; charset=utf-8',
      body: outcome.authenticated ? SIGNED_IN_PAGE : REFUSED_PAGE,
    };
  }

  // An unknown path under /auth/ is not found, not "wrong method": the router says
  // there is no such endpoint before it says anything about how to call one.
  const POST_PATHS = ['/auth/sign-in/start', '/auth/sign-in/claim', '/auth/session/renew', '/auth/sign-out'];
  if (!POST_PATHS.includes(request.path)) {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  if (request.path === '/auth/sign-in/start') {
    const parsed = signInStartRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const { startSignIn } = await import('../auth/signIn.ts');
    const outcome = await startSignIn(auth, parsed.data);
    if (!outcome.started) {
      return {
        status: outcome.refusal === 'client_upgrade_required' ? 426 : 400,
        body: { error: outcome.refusal, upgrade: notice(options) },
      };
    }
    return {
      status: 200,
      body: {
        authorizationUrl: outcome.authorizationUrl,
        handoffSecret: outcome.handoffSecret,
        expiresAt: outcome.expiresAt,
      },
    };
  }

  if (request.path === '/auth/sign-in/claim') {
    const parsed = signInClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const outcome = await claimSignIn(auth, parsed.data);
    if (!outcome.claimed) {
      return {
        status: outcome.refusal === 'client_upgrade_required' ? 426 : REFUSAL_HTTP_STATUS,
        body: { error: outcome.refusal, upgrade: notice(options) },
      };
    }
    return { status: 200, body: outcome.grant };
  }

  if (request.path === '/auth/session/renew') {
    const parsed = sessionRenewRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: 400, body: redactError('malformed_body') };
    const outcome = await renewSession(auth, parsed.data);
    if (!outcome.renewed) {
      return {
        status: outcome.refusal === 'client_upgrade_required' ? 426 : REFUSAL_HTTP_STATUS,
        body: { error: outcome.refusal, upgrade: notice(options) },
      };
    }
    return { status: 200, body: outcome.grant };
  }

  if (request.path === '/auth/sign-out') {
    const principal = await authenticate(auth, request.headers['authorization']);
    if (!principal.authenticated) return refusal(principal.refusal);
    await endSession(auth, principal.principal);
    return { status: 200, body: { signedOut: true } };
  }

  return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
}
