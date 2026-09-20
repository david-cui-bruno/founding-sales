import type { RefusalCode } from '../limits.ts';

/**
 * Reading a request body without trusting anything about it.
 *
 * `checkEnvelope` in `limits.ts` refuses on the *declared* `Content-Length` before a
 * byte is read, which is the cheap half. This is the other half: a client may declare
 * one length and send another, or send a chunked body with no length at all, so the
 * bytes are counted as they arrive and the read stops the moment the limit is passed.
 * Nothing is buffered past the limit, so an attacker cannot make the process hold a
 * gigabyte by lying in a header.
 *
 * A body is a JSON object or it is nothing. Not an array, not a bare string, not a
 * number: every command in section 14.1 takes named fields, and accepting anything
 * else means a handler somewhere has to ask what shape it got.
 */

export type BodySource = AsyncIterable<Uint8Array>;

export type BodyOutcome =
  | { readonly accepted: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly accepted: false; readonly code: RefusalCode };

export async function readBody(source: BodySource, limitBytes: number): Promise<BodyOutcome> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limitBytes) return { accepted: false, code: 'payload_too_large' };
    chunks.push(chunk);
  }
  if (size === 0) return { accepted: true, body: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return { accepted: false, code: 'malformed_body' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { accepted: false, code: 'malformed_body' };
  }
  return { accepted: true, body: parsed as Readonly<Record<string, unknown>> };
}
