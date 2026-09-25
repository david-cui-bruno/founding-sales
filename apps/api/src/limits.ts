/**
 * Request limits and redacted errors (specification 4.1 and 14.1).
 *
 * "The public API enforces request-size limits, rate limits, strict content types,
 * redacted error handling, and endpoint-specific authentication." The rate limit and
 * the authentication belong to later slices; the three that are pure functions of a
 * request live here, so every route gets them by construction rather than by memory.
 */

/** One mebibyte. Nothing version one accepts is larger, and a larger body is refused unread. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** The only content type a body-carrying request may declare. */
export const REQUIRED_CONTENT_TYPE = 'application/json';

export const REFUSAL_CODES = [
  'method_not_allowed',
  'not_found',
  'payload_too_large',
  'unsupported_media_type',
  'malformed_body',
  'unauthenticated',
  'internal_error',
  'database_busy',
  'not_ready',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const REFUSAL_STATUS: Readonly<Record<RefusalCode, number>> = Object.freeze({
  method_not_allowed: 405,
  not_found: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  malformed_body: 400,
  unauthenticated: 401,
  internal_error: 500,
  // Lane g75: no database connection came free inside the checkout timeout. 503, not
  // 500: nothing is broken, the request was not run, and the same request may be sent
  // again.
  database_busy: 503,
  // Lane g86: the task's own readiness check says it must not serve — the database did
  // not answer, its schema is outside this binary's range, or its system generation is
  // not the pinned one (`bootstrap/readinessGate.ts`). 503 for the same reason: the
  // route did not run, and another task, or this one shortly, may answer.
  not_ready: 503,
});

export interface RequestEnvelope {
  readonly method: string;
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
}

export type EnvelopeDecision = { readonly accepted: true } | { readonly accepted: false; readonly code: RefusalCode };

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether the request envelope is acceptable before a single byte of body is read.
 * Fails closed: an absent or unparseable `Content-Length` on a body-carrying request
 * is refused rather than streamed and counted.
 */
export function checkEnvelope(request: RequestEnvelope): EnvelopeDecision {
  if (BODYLESS_METHODS.has(request.method)) return { accepted: true };

  const declaredType = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (declaredType !== REQUIRED_CONTENT_TYPE) return { accepted: false, code: 'unsupported_media_type' };

  const declaredLength = Number(request.contentLength);
  if (request.contentLength === undefined || !Number.isInteger(declaredLength) || declaredLength < 0) {
    return { accepted: false, code: 'payload_too_large' };
  }
  if (declaredLength > MAX_REQUEST_BYTES) return { accepted: false, code: 'payload_too_large' };
  return { accepted: true };
}

export interface RedactedError {
  readonly error: RefusalCode;
  /** A short, fixed sentence. Never a stack, a SQL fragment, a path or a value. */
  readonly message: string;
}

const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = Object.freeze({
  method_not_allowed: 'That method is not allowed on this path.',
  not_found: 'No such endpoint.',
  payload_too_large: 'The request body is larger than this API accepts.',
  unsupported_media_type: 'This API accepts application/json only.',
  malformed_body: 'The request body could not be read as JSON.',
  unauthenticated: 'This endpoint requires an authenticated session.',
  internal_error: 'The request could not be completed.',
  database_busy: 'The API is busy. Nothing was changed; try again.',
  not_ready: 'The API is not ready to serve requests. Nothing was changed; try again shortly.',
});

/**
 * The only shape an error ever leaves the API in. Anything thrown becomes
 * `internal_error`: a caller learns that the request failed and nothing about why,
 * because the why may name a table, a path or a prospect.
 */
export function redactError(code: RefusalCode): RedactedError {
  return { error: code, message: REFUSAL_MESSAGES[code] };
}
