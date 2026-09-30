import { createHmac, timingSafeEqual } from 'node:crypto';
import { VOICE_ACCESS_TOKEN_SECONDS } from '@fss/contracts';

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
 *   * `fss-prod/calcom`: `webhook_secret`, `api_key`.
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
}

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
   * The instant the dial decision is taken at, for a test that must be inside the calling
   * window whatever the wall clock says. Production passes none: database time.
   */
  readonly decisionAt?: (() => string) | undefined;
}

export const TWILIO_SECRET_VARIABLE = 'twilio-voice';
export const CALCOM_SECRET_VARIABLE = 'calcom';

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

export function twilioVoice(values: {
  readonly accountSid: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  readonly twimlAppSid: string;
  readonly authToken: string;
  readonly callerIdE164: string;
}): TwilioVoice {
  const { authToken, apiKeySecret, apiKeySid } = values;
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

/**
 * Read both entries from the task environment. Each is null when absent or when any
 * required field is missing or misshapen; the reason is a field *name*, never a value.
 */
export function readIntegrationSecrets(environment: Readonly<Record<string, string | undefined>>): {
  readonly twilio: TwilioVoice | null;
  readonly calcom: Calcom | null;
  readonly twilioProblem: string | null;
  readonly calcomProblem: string | null;
} {
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

  let calcomDeps: Calcom | null = null;
  let calcomProblem: string | null = 'absent';
  const calcomBundle = jsonObject(environment[CALCOM_SECRET_VARIABLE]);
  if (calcomBundle !== null) {
    const webhookSecret = field(calcomBundle, 'webhook_secret', /^.{16,}$/u);
    if (webhookSecret !== null) {
      calcomDeps = calcom({ webhookSecret });
      calcomProblem = null;
    } else {
      calcomProblem = 'field:webhook_secret';
    }
  } else if (environment[CALCOM_SECRET_VARIABLE] !== undefined) {
    calcomProblem = 'not_json';
  }
  return { twilio, calcom: calcomDeps, twilioProblem, calcomProblem };
}
