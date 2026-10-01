import { createHmac, timingSafeEqual } from 'node:crypto';
import { VOICE_ACCESS_TOKEN_SECONDS } from '@fss/contracts';
import { twilioRecordingFetcher, type RecordingFetch, type RecordingHttp } from '@fss/domain/calls/twilioRecording.ts';
import { CALCOM_SECRET_VARIABLE, readCalcomSecret } from '@fss/domain/meetings/calcomSecret.ts';
import { TRANSCRIPTION_SECRET_VARIABLE, readTranscriptionSecret } from '@fss/domain/calls/transcriptionSecret.ts';

/**
 * The two provider integrations of the call-to-booking milestone, as the API holds them
 * (slice W): Twilio Voice and Cal.com.
 *
 * ## Secrets
 *
 * Both arrive the way every other secret does (`bootstrap/deployment.ts`): the ECS task
 * definition's `secrets` block injects the value of a Secrets Manager entry into an
 * environment variable named after the entry — `twilio-voice` and `calcom` — and the
 * process reads it once. Each is a JSON object:
 *
 *   * `fss-prod/twilio-voice`: `account_sid`, `api_key_sid`, `api_key_secret`,
 *     `twiml_app_sid`, `auth_token`, `caller_id_e164`;
 *   * `fss-prod/calcom`: `webhook_secret`, and optionally `api_key` — the worker's, for
 *     reconciliation (slice M1); the API reads only the webhook secret.
 *
 * The secret values are captured in closures and never stored on an object: what the
 * rest of the API holds is a set of functions (verify a signature, mint a token) and the
 * public identifiers. A function does not serialize into a log line or a JSON body.
 *
 * A missing or malformed entry is **not** a refusal to start: with the switches off
 * (the default) nothing needs it. With a switch on, the route answers 503 and logs
 * `integration_unconfigured`; the startup line says which of the two is configured.
 */

export interface TwilioVoice {
  readonly accountSid: string;
  readonly twimlAppSid: string;
  readonly callerIdE164: string;
  /**
   * Twilio's request signature: base64 HMAC-SHA1, keyed by the auth token, over the full
   * external URL followed by every POST parameter's name and value, sorted by name.
   */
  verifySignature(externalUrl: string, params: Readonly<Record<string, string>>, header: string | undefined): boolean;
  /** A Voice access token: identity, outgoing application only, no incoming grant. */
  mintAccessToken(identity: string, nowSeconds: number): { readonly token: string; readonly expiresAtSeconds: number };
  /**
   * One recording's audio, read from Twilio's REST API with the account's API key (slice
   * C1). `path` is the stored recording path; anything that is not one of this account's
   * recordings is `not_found` without a request. The bytes come back to the API, never a
   * URL to the Mac.
   */
  fetchRecording(path: string): Promise<RecordingFetch>;
}

// The recording read is shared with the worker's transcription job (slice C2), so it
// lives in the domain; these names are re-exported for the API's own callers and tests.
export type { RecordingFetch, RecordingHttp } from '@fss/domain/calls/twilioRecording.ts';
export { TWILIO_API_ORIGIN } from '@fss/domain/calls/twilioRecording.ts';

export interface Calcom {
  /** Cal.com's `X-Cal-Signature-256`: hex HMAC-SHA256 of the raw body, keyed by the webhook secret. */
  verifySignature(rawBody: Buffer, header: string | undefined): boolean;
}

export interface IntegrationDeps {
  /** `FSS_PUBLIC_ORIGIN`: the scheme and host Twilio signed. Never the Host header. */
  readonly publicOrigin: string | null;
  readonly twilio: TwilioVoice | null;
  readonly calcom: Calcom | null;
  /**
   * Field NAMES the secrets lack or hold misshapen (slice S1: `GET /settings/integrations`).
   * Names only, never a value. Absent (a test's fakes) reads as "none missing" when the
   * integration is configured.
   */
  readonly missing?:
    | { readonly twilioVoice: readonly string[]; readonly calcom: readonly string[]; readonly transcription?: readonly string[] | undefined }
    | undefined;
  /**
   * Slice C2: whether the `transcription` entry holds a key of a known provider. The API
   * never uses the key — the worker does — and keeps only this answer, so the recording
   * callback queues no transcription while it is missing and Settings can say so. Absent
   * reads as not configured.
   */
  readonly transcriptionConfigured?: boolean | undefined;
  /**
   * The instant the dial decision is taken at, for a test that must be inside the calling
   * window whatever the wall clock says. Production passes none: database time.
   */
  readonly decisionAt?: (() => string) | undefined;
}

export const TWILIO_SECRET_VARIABLE = 'twilio-voice';
export { CALCOM_SECRET_VARIABLE } from '@fss/domain/meetings/calcomSecret.ts';

function equalText(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The string Twilio signs: the URL, then each parameter name and value, sorted by name. */
export function twilioSignedString(externalUrl: string, params: Readonly<Record<string, string>>): string {
  return (
    externalUrl +
    Object.keys(params)
      .sort()
      .map(name => `${name}${params[name] ?? ''}`)
      .join('')
  );
}

export function twilioSignature(authToken: string, externalUrl: string, params: Readonly<Record<string, string>>): string {
  return createHmac('sha1', authToken).update(twilioSignedString(externalUrl, params), 'utf8').digest('base64');
}

export function calcomSignature(webhookSecret: string, rawBody: Buffer): string {
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export function twilioVoice(
  values: {
    readonly accountSid: string;
    readonly apiKeySid: string;
    readonly apiKeySecret: string;
    readonly twimlAppSid: string;
    readonly authToken: string;
    readonly callerIdE164: string;
  },
  ports: { readonly http?: RecordingHttp } = {},
): TwilioVoice {
  const { authToken, apiKeySecret, apiKeySid } = values;
  const recordings = twilioRecordingFetcher(values, ports.http === undefined ? {} : { http: ports.http });
  return {
    accountSid: values.accountSid,
    twimlAppSid: values.twimlAppSid,
    callerIdE164: values.callerIdE164,
    verifySignature: (externalUrl, params, header) =>
      equalText(twilioSignature(authToken, externalUrl, params), header),
    mintAccessToken: (identity, nowSeconds) => {
      const exp = nowSeconds + VOICE_ACCESS_TOKEN_SECONDS;
      const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
      const payload = {
        jti: `${apiKeySid}-${String(nowSeconds)}`,
        iss: apiKeySid,
        sub: values.accountSid,
        iat: nowSeconds,
        nbf: nowSeconds,
        exp,
        grants: {
          identity,
          // Outgoing only, through the one TwiML application. No `incoming` grant: nobody
          // can ring this identity.
          voice: { outgoing: { application_sid: values.twimlAppSid } },
        },
      };
      const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
      const signature = createHmac('sha256', apiKeySecret).update(signingInput).digest('base64url');
      return { token: `${signingInput}.${signature}`, expiresAtSeconds: exp };
    },
    fetchRecording: async path => await recordings.fetchRecording(path),
  };
}

export function calcom(values: { readonly webhookSecret: string }): Calcom {
  const { webhookSecret } = values;
  return {
    verifySignature: (rawBody, header) =>
      header !== undefined && /^[0-9a-f]{64}$/iu.test(header) && equalText(calcomSignature(webhookSecret, rawBody), header.toLowerCase()),
  };
}

function jsonObject(raw: string | undefined): Readonly<Record<string, unknown>> | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const field = (bundle: Readonly<Record<string, unknown>>, name: string, shape: RegExp): string | null => {
  const value = bundle[name];
  return typeof value === 'string' && shape.test(value.trim()) ? value.trim() : null;
};

const TWILIO_FIELD_NAMES = ['account_sid', 'api_key_sid', 'api_key_secret', 'twiml_app_sid', 'auth_token', 'caller_id_e164'] as const;
const TWILIO_FIELD_BY_KEY: Readonly<Record<string, string>> = {
  accountSid: 'account_sid',
  apiKeySid: 'api_key_sid',
  apiKeySecret: 'api_key_secret',
  twimlAppSid: 'twiml_app_sid',
  authToken: 'auth_token',
  callerIdE164: 'caller_id_e164',
};
const CALCOM_FIELD_NAMES = ['webhook_secret'] as const;

/**
 * Read both entries from the task environment. Each is null when absent or when any
 * required field is missing or misshapen; the reason is a field *name*, never a value.
 */
export function readIntegrationSecrets(environment: Readonly<Record<string, string | undefined>>): {
  readonly twilio: TwilioVoice | null;
  readonly calcom: Calcom | null;
  readonly twilioProblem: string | null;
  readonly calcomProblem: string | null;
  readonly missing: { readonly twilioVoice: readonly string[]; readonly calcom: readonly string[]; readonly transcription: readonly string[] };
  /** Whether the optional reconciliation key is there: `configured`, `absent` or `field:api_key`. */
  readonly calcomApiKey: string;
  /** Slice C2: whether the transcription key is in place; the key itself is not kept. */
  readonly transcriptionConfigured: boolean;
  readonly transcriptionProblem: string | null;
} {
  let twilioMissing: readonly string[] = TWILIO_FIELD_NAMES;
  let calcomMissing: readonly string[] = CALCOM_FIELD_NAMES;
  let twilio: TwilioVoice | null = null;
  let twilioProblem: string | null = 'absent';
  const twilioBundle = jsonObject(environment[TWILIO_SECRET_VARIABLE]);
  if (twilioBundle !== null) {
    const values = {
      accountSid: field(twilioBundle, 'account_sid', /^AC[0-9a-f]{32}$/u),
      apiKeySid: field(twilioBundle, 'api_key_sid', /^SK[0-9a-f]{32}$/u),
      apiKeySecret: field(twilioBundle, 'api_key_secret', /^.{16,}$/u),
      twimlAppSid: field(twilioBundle, 'twiml_app_sid', /^AP[0-9a-f]{32}$/u),
      authToken: field(twilioBundle, 'auth_token', /^.{16,}$/u),
      callerIdE164: field(twilioBundle, 'caller_id_e164', /^\+[1-9][0-9]{7,14}$/u),
    };
    twilioMissing = Object.entries(values)
      .filter(([, value]) => value === null)
      .map(([name]) => TWILIO_FIELD_BY_KEY[name] ?? name);
    const missing = Object.entries(values).find(([, value]) => value === null)?.[0] ?? null;
    if (missing === null) {
      twilio = twilioVoice(values as { [K in keyof typeof values]: string });
      twilioProblem = null;
    } else {
      twilioProblem = `field:${missing}`;
    }
  } else if (environment[TWILIO_SECRET_VARIABLE] !== undefined) {
    twilioProblem = 'not_json';
  }

  // The shape is `meetings/calcomSecret.ts`'s, shared with the worker, which reads the
  // optional `api_key` for reconciliation (slice M1). The API needs the webhook secret
  // only; the key's absence is not a problem here.
  let calcomDeps: Calcom | null = null;
  let calcomProblem: string | null = 'absent';
  let calcomApiKey: string | null = 'absent';
  const calcomReading = readCalcomSecret(environment[CALCOM_SECRET_VARIABLE]);
  if (calcomReading.ok) {
    // `api_key` is optional (the worker's, for reconciliation) and never listed missing.
    calcomMissing = [];
    calcomDeps = calcom({ webhookSecret: calcomReading.webhookSecret });
    calcomProblem = null;
    calcomApiKey = calcomReading.apiKeyProblem ?? 'configured';
  } else {
    calcomProblem = calcomReading.problem;
  }
  if (twilio !== null) twilioMissing = [];
  // Slice C2. Read for its shape only: the reading's key is dropped here, on purpose.
  const transcription = readTranscriptionSecret(environment[TRANSCRIPTION_SECRET_VARIABLE]);
  return {
    twilio,
    calcom: calcomDeps,
    twilioProblem,
    calcomProblem,
    missing: { twilioVoice: twilioMissing, calcom: calcomMissing, transcription: transcription.ok ? [] : transcription.missing },
    calcomApiKey,
    transcriptionConfigured: transcription.ok,
    transcriptionProblem: transcription.ok ? null : transcription.problem,
  };
}
