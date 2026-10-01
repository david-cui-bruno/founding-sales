/**
 * What the API said when it did not answer — the one helper for every Anthropic call that
 * logs a provider failure: the reply classifier (`classification/adapter.ts`) and the
 * after-call summary (`calls/summaryAdapter.ts`).
 *
 * A request the API refuses with a 4xx (not 408) was refused before any generation: it
 * billed nothing, and the next attempt would be refused the same way. That is the
 * difference between a refusal and an ambiguous failure (5xx, 408, a dropped connection),
 * which may have been billed and is estimated and retried once.
 *
 * ## What may reach a log (C3 review, finding 6; follow-up review)
 *
 * **Never the API's free text.** An error message can echo the request — an e-mail, a
 * transcript — quoted, escaped or bare, so no redaction of it is trusted. What is kept:
 * the status, the error type (letters, digits and underscores only), and for a 400
 * `invalid_request_error` at most the parameter path the message starts with
 * (`output_config.format.schema` from "output_config.format.schema: Invalid schema: …"),
 * which names a field of the request and none of its contents. Nothing after the colon is
 * kept, and a message that does not start with such a path keeps nothing. The SDK error
 * object is never carried.
 */

export interface ProviderErrorDetail {
  readonly status: number | null;
  /** The API's error type, `[A-Za-z0-9_]` only. */
  readonly type: string | null;
  /**
   * For a 400 `invalid_request_error` only: the request parameter path its message starts
   * with (`output_config.format.schema`), without the colon or anything after it. Else null.
   */
  readonly parameter: string | null;
  /** True for a 4xx other than 408: refused before generation, settled at 0, not retried. */
  readonly refused: boolean;
}

/** A parameter path at the very start of a message, up to its colon. */
const LEADING_PARAMETER = /^([a-z_][a-z0-9_.[\]]{0,80}):/u;

/** The parameter path a 400 `invalid_request_error` message starts with, or null. */
export function leadingParameter(message: string): string | null {
  return LEADING_PARAMETER.exec(message)?.[1] ?? null;
}

/** A 4xx other than 408 (a timeout) is a refusal before generation; everything else is ambiguous. */
export function isRefusedBeforeGeneration(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

/** Read an error the SDK threw: `status` and the response body's `error.type` / `error.message`. */
export function providerErrorOf(error: unknown): ProviderErrorDetail {
  if (typeof error !== 'object' || error === null) return { status: null, type: null, parameter: null, refused: false };
  const record = error as { status?: unknown; type?: unknown; error?: unknown };
  const status = typeof record.status === 'number' && Number.isInteger(record.status) ? record.status : null;
  const body = typeof record.error === 'object' && record.error !== null ? (record.error as { error?: unknown }).error : undefined;
  const inner = typeof body === 'object' && body !== null ? (body as { type?: unknown; message?: unknown }) : {};
  const type = typeof inner.type === 'string' ? inner.type : typeof record.type === 'string' ? record.type : null;
  const kind = type === null ? null : type.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 64) || null;
  const parameter =
    status === 400 && kind === 'invalid_request_error' && typeof inner.message === 'string' ? leadingParameter(inner.message) : null;
  return { status, type: kind, parameter, refused: isRefusedBeforeGeneration(status) };
}
