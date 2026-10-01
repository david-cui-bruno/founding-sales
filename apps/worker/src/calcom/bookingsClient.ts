import {
  CALCOM_API_ORIGIN,
  CALCOM_BOOKINGS_API_VERSION,
  type CalcomBookingsClient,
  type CalcomBookingsPage,
} from '@fss/domain/meetings/reconcile.ts';
import { CALCOM_SECRET_VARIABLE, readCalcomSecret } from '@fss/domain/meetings/calcomSecret.ts';

/**
 * Cal.com API v2's bookings list, over `fetch` (slice M1). The only request this worker
 * makes to Cal.com, and only from the `calcom.reconcile` job.
 *
 * Built from Cal.com's public documentation, and nothing else:
 *
 *   * https://cal.com/docs/api-reference/v2/bookings/get-all-bookings — `GET /v2/bookings`;
 *     the `cal-api-version: 2026-05-01` header ("Must be set to 2026-05-01"); the
 *     `afterStart`, `beforeEnd`, `limit` (1–100) and `cursor` query parameters; the
 *     answer `{ status, data, pagination: { nextCursor, hasMore } }`;
 *   * https://cal.com/docs/api-reference/v2/introduction — `Authorization: Bearer <key>`,
 *     keys prefixed `cal_` (test) or `cal_live_` (live), HTTPS only, 120 requests a minute;
 *   * https://cal.com/docs/api-reference/v2/v1-v2-differences — the `https://api.cal.com/v2`
 *     host and the required version header.
 *
 * The key lives in this closure and nowhere else: not on the returned object, not in an
 * error, not in a log line. A non-2xx answer, a body that is not the documented shape, a
 * network failure or a timeout all throw a plain `Error` naming the kind of failure, and
 * the job is retried by the runner.
 */

export type CalcomHttp = (
  url: string,
  init: { readonly method: 'GET'; readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>;

/** One page must answer within this; the whole run has its own deadline. */
export const CALCOM_REQUEST_TIMEOUT_MS = 10_000;
/** A page of 100 bookings is far below this. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function calcomBookingsClient(options: { readonly apiKey: string; readonly http?: CalcomHttp }): CalcomBookingsClient {
  const { apiKey } = options;
  const http: CalcomHttp = options.http ?? (async (url, init) => await fetch(url, init));
  return {
    listBookings: async (query): Promise<CalcomBookingsPage> => {
      const url = new URL('/v2/bookings', CALCOM_API_ORIGIN);
      url.searchParams.set('afterStart', query.afterStart);
      url.searchParams.set('beforeEnd', query.beforeEnd);
      url.searchParams.set('limit', String(query.limit));
      if (query.cursor !== null) url.searchParams.set('cursor', query.cursor);
      let response: Response;
      try {
        response = await http(url.toString(), {
          method: 'GET',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'cal-api-version': CALCOM_BOOKINGS_API_VERSION,
            accept: 'application/json',
          },
          // The request's own bound, or what is left of the run's budget if that is less.
          signal: AbortSignal.timeout(Math.max(1, Math.min(CALCOM_REQUEST_TIMEOUT_MS, Math.floor(query.timeoutMs)))),
        });
      } catch {
        throw new Error('calcom_unreachable');
      }
      if (response.status !== 200) throw new Error(`calcom_http_${String(response.status)}`);
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('calcom_answer_too_large');
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_BODY_BYTES) throw new Error('too large');
        body = JSON.parse(text);
      } catch {
        throw new Error('calcom_answer_unreadable');
      }
      const top = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const pagination = typeof top['pagination'] === 'object' && top['pagination'] !== null ? (top['pagination'] as Record<string, unknown>) : {};
      if (top['status'] !== 'success' || !Array.isArray(top['data'])) throw new Error('calcom_answer_unreadable');
      const next = pagination['hasMore'] === true && typeof pagination['nextCursor'] === 'string' && pagination['nextCursor'].length > 0
        ? pagination['nextCursor']
        : null;
      return { bookings: top['data'] as unknown[], nextCursor: next };
    },
  };
}

/**
 * The worker's reconciliation client, from the task environment's `calcom` entry, or
 * null with the reason by field name. Without `api_key` reconciliation is off; that is
 * a configuration, not a failure.
 */
export function readCalcomReconcileClient(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly http?: CalcomHttp } = {},
): { readonly client: CalcomBookingsClient | null; readonly problem: string | null } {
  const reading = readCalcomSecret(environment[CALCOM_SECRET_VARIABLE]);
  if (!reading.ok) return { client: null, problem: reading.problem };
  if (reading.apiKey === null) return { client: null, problem: reading.apiKeyProblem ?? 'absent' };
  return {
    client: calcomBookingsClient({ apiKey: reading.apiKey, ...(options.http === undefined ? {} : { http: options.http }) }),
    problem: null,
  };
}
