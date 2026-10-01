/**
 * What the API said when it did not answer (the reply classifier's copy of C3b's
 * `providerErrorOf`, which lives in `calls/summaryAdapter.ts`).
 *
 * A request the API refuses with a 4xx (not 408) was refused before any generation: it
 * billed nothing, and the next attempt would be refused the same way. That is the
 * difference between a refusal and an ambiguous failure (5xx, 408, a dropped connection),
 * which may have been billed and is estimated and retried once.
 *
 * Only the API's own words about the request are kept — its status, error type and message,
 * bounded. The SDK error object is never carried: its text can quote the request body, and
 * the request body is somebody's email. (A schema complaint is about the schema, not the email.)
 */

export interface ProviderErrorDetail {
  readonly status: number | null;
  readonly type: string | null;
  readonly message: string | null;
  /** True for a 4xx other than 408: refused before generation, settled at 0, not retried. */
  readonly refused: boolean;
}

/** The longest provider message kept: enough for a schema complaint, not a body. */
export const PROVIDER_MESSAGE_MAX = 300;

/** A 4xx other than 408 (a timeout) is a refusal before generation; everything else is ambiguous. */
export function isRefusedBeforeGeneration(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

/** Read an error the SDK threw: `status` and the response body's `error.type` / `error.message`. */
export function providerErrorOf(error: unknown): ProviderErrorDetail {
  if (typeof error !== 'object' || error === null) return { status: null, type: null, message: null, refused: false };
  const record = error as { status?: unknown; type?: unknown; error?: unknown };
  const status = typeof record.status === 'number' && Number.isInteger(record.status) ? record.status : null;
  const body = typeof record.error === 'object' && record.error !== null ? (record.error as { error?: unknown }).error : undefined;
  const inner = typeof body === 'object' && body !== null ? (body as { type?: unknown; message?: unknown }) : {};
  const type = typeof inner.type === 'string' ? inner.type : typeof record.type === 'string' ? record.type : null;
  const message = typeof inner.message === 'string' ? inner.message.slice(0, PROVIDER_MESSAGE_MAX) : null;
  return { status, type: type === null ? null : type.slice(0, 64), message, refused: isRefusedBeforeGeneration(status) };
}
