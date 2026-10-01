/**
 * The `calcom` secret's shape, read the same way by the API (the webhook's
 * `webhook_secret`) and the worker (reconciliation's `api_key`) — slice M1.
 *
 * `{"webhook_secret": "...", "api_key": "cal_..."}`. `webhook_secret` is required (at
 * least 16 characters): without it the entry is not configured at all. `api_key` is
 * optional: without it reconciliation is simply off, which is not an error; a value
 * that is present but not a Cal.com key (`cal_` / `cal_live_` followed by at least
 * eight characters, per https://cal.com/docs/api-reference/v2/introduction) is reported
 * as `field:api_key` and reconciliation stays off. A problem is a field *name*, never a
 * value.
 */

export const CALCOM_SECRET_VARIABLE = 'calcom';

export type CalcomSecretReading =
  | {
      readonly ok: true;
      readonly webhookSecret: string;
      readonly apiKey: string | null;
      /** `null`, `absent` or `field:api_key`: why reconciliation is off, by name. */
      readonly apiKeyProblem: string | null;
    }
  | { readonly ok: false; readonly problem: 'absent' | 'not_json' | 'field:webhook_secret' };

const WEBHOOK_SECRET = /^.{16,}$/u;
const API_KEY = /^cal_\S{8,}$/u;

export function readCalcomSecret(raw: string | undefined): CalcomSecretReading {
  if (raw === undefined) return { ok: false, problem: 'absent' };
  // An empty value is an entry that exists and says nothing: `not_json`, as before M1.
  if (raw.trim().length === 0) return { ok: false, problem: 'not_json' };
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'not_json' };
  }
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return { ok: false, problem: 'not_json' };
  const fields = bundle as Readonly<Record<string, unknown>>;
  const secret = typeof fields['webhook_secret'] === 'string' ? fields['webhook_secret'].trim() : '';
  if (!WEBHOOK_SECRET.test(secret)) return { ok: false, problem: 'field:webhook_secret' };
  const key = fields['api_key'];
  if (key === undefined || key === null || (typeof key === 'string' && key.trim().length === 0)) {
    return { ok: true, webhookSecret: secret, apiKey: null, apiKeyProblem: 'absent' };
  }
  if (typeof key !== 'string' || !API_KEY.test(key.trim())) {
    return { ok: true, webhookSecret: secret, apiKey: null, apiKeyProblem: 'field:api_key' };
  }
  return { ok: true, webhookSecret: secret, apiKey: key.trim(), apiKeyProblem: null };
}
