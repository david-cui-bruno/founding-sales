/**
 * The `transcription` secret's shape (slice C2), read the same way by the worker (which
 * uses the key) and the API (which only says whether it is in place, by field name).
 *
 * `{"provider": "deepgram", "api_key": "..."}`. `provider` names the provider the key is
 * for; only `deepgram` is known today. `api_key` is at least twenty non-space characters.
 * `{}` — what the release puts in the entry before anybody has a key — reads as "not
 * configured", with both field names missing. A problem is a field *name*, never a value,
 * a length or a prefix.
 */

export const TRANSCRIPTION_SECRET_VARIABLE = 'transcription';

export const TRANSCRIPTION_SECRET_FIELDS = ['provider', 'api_key'] as const;

export const TRANSCRIPTION_PROVIDERS = ['deepgram'] as const;
export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDERS)[number];

export type TranscriptionSecretReading =
  | { readonly ok: true; readonly provider: TranscriptionProviderName; readonly apiKey: string }
  | {
      readonly ok: false;
      readonly problem: 'absent' | 'not_json' | 'field:provider' | 'field:api_key';
      /** The field names that are missing or misshapen; empty when the entry itself is unreadable. */
      readonly missing: readonly string[];
    };

const API_KEY = /^\S{20,512}$/u;

export function readTranscriptionSecret(raw: string | undefined): TranscriptionSecretReading {
  if (raw === undefined) return { ok: false, problem: 'absent', missing: [...TRANSCRIPTION_SECRET_FIELDS] };
  if (raw.trim().length === 0) return { ok: false, problem: 'not_json', missing: [...TRANSCRIPTION_SECRET_FIELDS] };
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'not_json', missing: [...TRANSCRIPTION_SECRET_FIELDS] };
  }
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    return { ok: false, problem: 'not_json', missing: [...TRANSCRIPTION_SECRET_FIELDS] };
  }
  const fields = bundle as Readonly<Record<string, unknown>>;
  const provider = typeof fields['provider'] === 'string' ? fields['provider'].trim() : '';
  const key = typeof fields['api_key'] === 'string' ? fields['api_key'].trim() : '';
  const missing: string[] = [];
  if (!(TRANSCRIPTION_PROVIDERS as readonly string[]).includes(provider)) missing.push('provider');
  if (!API_KEY.test(key)) missing.push('api_key');
  if (missing.length > 0) return { ok: false, problem: missing[0] === 'provider' ? 'field:provider' : 'field:api_key', missing };
  return { ok: true, provider: provider as TranscriptionProviderName, apiKey: key };
}
