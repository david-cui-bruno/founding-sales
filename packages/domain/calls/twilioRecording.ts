import { CALL_RECORDING_MAX_BYTES } from '@fss/contracts';

/**
 * One call recording's audio, read from Twilio's REST API with the account's API key.
 *
 * Slice C1 wrote this in the API, for the playback proxy (`GET /calls/recording`). Slice
 * C2's transcription job reads the same bytes in the worker, so the fetch lives here and
 * both processes use it: the path check, the host, the basic auth and the size bound are
 * one implementation, not two.
 *
 * Only a path of this account's recordings is fetched (`/2010-04-01/Accounts/<sid>/
 * Recordings/RE…`), from `https://api.twilio.com` and nowhere else, as `.mp3`, at most
 * `CALL_RECORDING_MAX_BYTES`. The key lives in the closure; an outcome is a reason word,
 * never a URL, a header or a body.
 */

export type RecordingFetch =
  | { readonly ok: true; readonly contentType: 'audio/mpeg'; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'not_found' | 'too_large' | 'unavailable' };

/** The HTTP port the fetch uses; `fetch` in production, a stub in tests. */
export type RecordingHttp = (
  url: string,
  init: { readonly method: 'GET'; readonly headers: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<Response>;

/** Twilio's REST host. The stored path never carries a host; this is the only one asked. */
export const TWILIO_API_ORIGIN = 'https://api.twilio.com';

/** Read a response body, refusing one larger than `limit` without holding more than that. */
export async function boundedBody(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export interface TwilioRecordingCredentials {
  readonly accountSid: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
}

export interface TwilioRecordingFetcher {
  fetchRecording(path: string): Promise<RecordingFetch>;
}

export function twilioRecordingFetcher(
  credentials: TwilioRecordingCredentials,
  ports: { readonly http?: RecordingHttp; readonly timeoutMs?: number } = {},
): TwilioRecordingFetcher {
  const { apiKeySid, apiKeySecret } = credentials;
  const http: RecordingHttp = ports.http ?? (async (url, init) => await fetch(url, init));
  const recordingPath = new RegExp(`^/2010-04-01/Accounts/${credentials.accountSid}/Recordings/RE[0-9a-f]{32}$`, 'u');
  return {
    fetchRecording: async path => {
      if (!recordingPath.test(path)) return { ok: false, reason: 'not_found' };
      let response: Response;
      try {
        response = await http(`${TWILIO_API_ORIGIN}${path}.mp3`, {
          method: 'GET',
          headers: {
            authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
            accept: 'audio/mpeg',
          },
          ...(ports.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(ports.timeoutMs) }),
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (response.status === 404) return { ok: false, reason: 'not_found' };
      if (response.status !== 200) return { ok: false, reason: 'unavailable' };
      const bytes = await boundedBody(response, CALL_RECORDING_MAX_BYTES).catch(() => undefined);
      if (bytes === undefined) return { ok: false, reason: 'unavailable' };
      if (bytes === null) return { ok: false, reason: 'too_large' };
      return { ok: true, contentType: 'audio/mpeg', bytes };
    },
  };
}

/** The task environment variable the `twilio-voice` Secrets Manager entry arrives under. */
export const TWILIO_SECRET_VARIABLE = 'twilio-voice';

/**
 * The three fields of the `twilio-voice` entry a recording read needs, for the worker
 * (slice C2), or null with the reason by field *name*. The API reads the whole entry
 * (`apps/api/src/integrations/providers.ts`); the shapes are the same.
 */
export function readTwilioRecordingCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly credentials: TwilioRecordingCredentials | null; readonly problem: string | null } {
  const raw = environment[TWILIO_SECRET_VARIABLE];
  if (raw === undefined) return { credentials: null, problem: 'absent' };
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch {
    return { credentials: null, problem: 'not_json' };
  }
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return { credentials: null, problem: 'not_json' };
  const fields = bundle as Readonly<Record<string, unknown>>;
  const field = (name: string, shape: RegExp): string | null => {
    const value = fields[name];
    return typeof value === 'string' && shape.test(value.trim()) ? value.trim() : null;
  };
  const accountSid = field('account_sid', /^AC[0-9a-f]{32}$/u);
  if (accountSid === null) return { credentials: null, problem: 'field:account_sid' };
  const apiKeySid = field('api_key_sid', /^SK[0-9a-f]{32}$/u);
  if (apiKeySid === null) return { credentials: null, problem: 'field:api_key_sid' };
  const apiKeySecret = field('api_key_secret', /^.{16,}$/u);
  if (apiKeySecret === null) return { credentials: null, problem: 'field:api_key_secret' };
  return { credentials: { accountSid, apiKeySid, apiKeySecret }, problem: null };
}
