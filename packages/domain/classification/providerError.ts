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
 * ## What may reach a log (C3 review, finding 6)
 *
 * The status and the error type, always. The API's message **only** for a 400
 * `invalid_request_error` — the one class whose text is about the request's shape (a schema
 * it rejected) rather than its content — and even then with every quoted span ('…', "…",
 * ‘…’, “…”) removed, everything from an unmatched quote on removed, and anything past the
 * first 160 characters cut. An error that echoes a request quotes it, so what remains is
 * the API's own sentence and none of the request's words. Every other status keeps no
 * message at all. The SDK error object is never carried.
 */

export interface ProviderErrorDetail {
  readonly status: number | null;
  readonly type: string | null;
  /** Only for a 400 `invalid_request_error`, and redacted (`loggableProviderMessage`); else null. */
  readonly message: string | null;
  /** True for a 4xx other than 408: refused before generation, settled at 0, not retried. */
  readonly refused: boolean;
}

/** The longest provider message kept, after its quoted spans are removed. */
export const PROVIDER_MESSAGE_MAX = 160;

/** The marker a removed quoted span leaves behind. */
const REMOVED = '…';

/**
 * The part of an API error message that may be logged: quoted spans removed (paired
 * straight or curly quotes), everything from an unpaired quote on removed, whitespace
 * folded, then the first `PROVIDER_MESSAGE_MAX` characters.
 */
export function loggableProviderMessage(message: string): string {
  const unquoted = message
    .replace(/'[^']*'|"[^"]*"|‘[^’]*’|“[^”]*”/gu, REMOVED)
    .replace(/['"‘’“”][\s\S]*$/u, REMOVED)
    .replace(/\s+/gu, ' ')
    .trim();
  return unquoted.slice(0, PROVIDER_MESSAGE_MAX);
}

/** Only a 400 `invalid_request_error` keeps a message; the type is the API's own word. */
function keepsMessage(status: number | null, type: string | null): boolean {
  return status === 400 && type === 'invalid_request_error';
}

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
  const kind = type === null ? null : type.replace(/[^a-z0-9_]/giu, '').slice(0, 64);
  const message = keepsMessage(status, kind) && typeof inner.message === 'string' ? loggableProviderMessage(inner.message) : null;
  return { status, type: kind, message, refused: isRefusedBeforeGeneration(status) };
}
