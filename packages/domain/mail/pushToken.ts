import { createSign, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * The Pub/Sub push token (specification 4.1, Appendix G 27).
 *
 * "The webhook validates signature, issuer, exact audience, service-account email,
 * `email_verified`, expiration, and issued-at bounds."
 *
 * Seven checks, and only the first of them needs a key. So the signature is behind
 * `PushTokenVerifier`, which has one method, and the other six are `decidePushToken`,
 * which is pure and takes an instant. That split is what makes Appendix G 27 — "a
 * Pub/Sub token with a valid Google signature but wrong audience or service-account
 * email is refused" — a test with no key material in it at all: the signature is
 * valid by construction and the refusal comes from the claims.
 *
 * `fixturePushTokens` generates an RSA key pair when it is called. Nothing in this
 * repository contains a key, and in particular nothing contains a PEM armour line:
 * the pair exists only in memory, for the length of one test.
 */

export interface PushTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly azp?: string | undefined;
  readonly email: string;
  readonly email_verified: boolean;
  readonly exp: number;
  readonly iat: number;
  readonly sub?: string | undefined;
}

/** The signature check, and nothing else. Returns null for anything it cannot verify. */
export interface PushTokenVerifier {
  verify(token: string): Promise<PushTokenClaims | null>;
}

export interface PushTokenPolicy {
  /** Google's OIDC issuer for a service-account token. */
  readonly issuer: string;
  /** The exact audience `infra/modules/pubsub` was given. Compared as a whole string. */
  readonly audience: string;
  /** The push identity `infra/modules/pubsub` created. Compared lower-cased. */
  readonly serviceAccountEmail: string;
  readonly clockSkewSeconds: number;
  /**
   * How old a token may be even if it has not expired. A replay bound, and it is the
   * lifetime Google gives the token (`DEFAULT_PUSH_TOKEN_POLICY`), not anything shorter.
   */
  readonly maximumAgeSeconds: number;
}

export const PUSH_TOKEN_REFUSALS = [
  'signature_invalid',
  'issuer_mismatch',
  'audience_mismatch',
  'service_account_mismatch',
  'email_unverified',
  'expired',
  'issued_in_future',
  'too_old',
] as const;
export type PushTokenRefusal = (typeof PUSH_TOKEN_REFUSALS)[number];

export type PushTokenDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: PushTokenRefusal };

/**
 * `maximumAgeSeconds` is the lifetime of a Pub/Sub push token: one hour.
 *
 * Pub/Sub mints the OIDC token it presents with `exp` an hour after `iat`, and it sends
 * the *same* token with every delivery until it mints the next one. A genuine push can
 * therefore carry a token up to an hour old. The bound was 600 seconds until lane g63,
 * and production refused every push whose token was past its eleventh minute as
 * `too_old`: 138 `gmail_push_too_old` refusals in three hours on 24 and 25 September
 * 2026, with the mailbox kept current only by the scheduler's one-minute sweep. A
 * refused push is retried with the same token, so the retries were refused as well
 * until Google rotated it.
 *
 * A token more than an hour old is still refused, whatever its `exp` says; that is the
 * replay bound. The hour is a fact about Google, not a deployment choice, so
 * `pushTokenPolicyOf` takes it from here and no environment variable overrides it.
 */
export const DEFAULT_PUSH_TOKEN_POLICY = Object.freeze({
  issuer: 'https://accounts.google.com',
  clockSkewSeconds: 60,
  maximumAgeSeconds: 3600,
});

/**
 * The six claim checks, in the order 4.1 lists them, first refusal winning.
 *
 * Every comparison is exact. An audience that merely starts with the configured one
 * is a different audience, and a service-account address that differs only in case is
 * the same address — Google lower-cases them — so that one is compared lower-cased
 * and the audience is not.
 */
export function decidePushToken(
  claims: PushTokenClaims,
  policy: PushTokenPolicy,
  nowEpochSeconds: number,
): PushTokenDecision {
  if (claims.iss !== policy.issuer) return { accepted: false, refusal: 'issuer_mismatch' };
  if (claims.aud !== policy.audience) return { accepted: false, refusal: 'audience_mismatch' };
  if (claims.email.trim().toLowerCase() !== policy.serviceAccountEmail.trim().toLowerCase()) {
    return { accepted: false, refusal: 'service_account_mismatch' };
  }
  if (claims.email_verified !== true) return { accepted: false, refusal: 'email_unverified' };
  if (!Number.isFinite(claims.exp) || claims.exp + policy.clockSkewSeconds <= nowEpochSeconds) {
    return { accepted: false, refusal: 'expired' };
  }
  if (!Number.isFinite(claims.iat) || claims.iat - policy.clockSkewSeconds > nowEpochSeconds) {
    return { accepted: false, refusal: 'issued_in_future' };
  }
  // The replay bound. A genuine Google token has `exp - iat` equal to the hour this
  // allows, so `expired` above refuses it first; this refuses a token whose `exp` claims
  // a longer life than Google gives one. Deriving the bound from `exp - iat` with an
  // hour's cap would behave the same, because below the cap `exp` already bounds the age.
  if (nowEpochSeconds - claims.iat > policy.maximumAgeSeconds + policy.clockSkewSeconds) {
    return { accepted: false, refusal: 'too_old' };
  }
  return { accepted: true };
}

const base64url = (value: Buffer | string): string =>
  (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The claims of a JWS, if it has three segments and the payload is an object. */
export function readPushTokenClaims(token: string): PushTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1] === undefined ? null : parseSegment(parts[1]);
  if (payload === null) return null;
  const iss = payload['iss'];
  const aud = payload['aud'];
  const email = payload['email'];
  const exp = payload['exp'];
  const iat = payload['iat'];
  if (typeof iss !== 'string' || typeof aud !== 'string' || typeof email !== 'string') return null;
  if (typeof exp !== 'number' || typeof iat !== 'number') return null;
  return {
    iss,
    aud,
    email,
    email_verified: payload['email_verified'] === true,
    exp,
    iat,
    ...(typeof payload['azp'] === 'string' ? { azp: payload['azp'] } : {}),
    ...(typeof payload['sub'] === 'string' ? { sub: payload['sub'] } : {}),
  };
}

/** An RS256 verifier over one public key. The production one fetches Google's key set. */
export function publicKeyPushTokenVerifier(key: KeyObject): PushTokenVerifier {
  return {
    verify: async token => {
      await Promise.resolve();
      const parts = token.split('.');
      const [header, payload, signature] = parts;
      if (parts.length !== 3 || header === undefined || payload === undefined || signature === undefined) {
        return null;
      }
      const algorithm = parseSegment(header)?.['alg'];
      // RS256 only. `none` and a symmetric algorithm are the two classic forgeries,
      // and neither is something Google issues.
      if (algorithm !== 'RS256') return null;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${header}.${payload}`, 'utf8');
      let valid = false;
      try {
        valid = verifier.verify(key, Buffer.from(signature, 'base64url'));
      } catch {
        return null;
      }
      return valid ? readPushTokenClaims(token) : null;
    },
  };
}

export interface FixturePushTokens {
  readonly verifier: PushTokenVerifier;
  /** Sign a claim set with the pair generated for this fixture. */
  sign(claims: PushTokenClaims): string;
  /** A token whose signature is not this pair's. */
  signWithAnotherKey(claims: PushTokenClaims): string;
}

/**
 * A key pair generated here and now, for one test.
 *
 * 2,048 bits rather than 3,072: this key exists for the length of a test and
 * generation time is the only cost that matters. Nothing it signs leaves the process.
 */
export function fixturePushTokens(): FixturePushTokens {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const signWith = (privateKey: KeyObject, claims: PushTokenClaims): string => {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture' }));
    const payload = base64url(JSON.stringify(claims));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`, 'utf8');
    return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
  };

  return {
    verifier: publicKeyPushTokenVerifier(pair.publicKey),
    sign: claims => signWith(pair.privateKey, claims),
    signWithAnotherKey: claims => signWith(other.privateKey, claims),
  };
}

/**
 * The body Pub/Sub posts. `data` is base64 of the Gmail notification, which carries
 * an email address and a history id and never business state (4.1).
 */
export interface PubSubPushBody {
  readonly message: {
    readonly data?: string | undefined;
    readonly messageId?: string | undefined;
    readonly message_id?: string | undefined;
    readonly publishTime?: string | undefined;
    readonly publish_time?: string | undefined;
  };
  readonly subscription?: string | undefined;
}

export interface GmailNotification {
  readonly emailAddress: string;
  readonly historyId: string;
  readonly providerMessageId: string;
  readonly publishedAt: string | null;
}

/**
 * Read a push body, or null.
 *
 * Both spellings of the message id and the publish time are accepted because Pub/Sub
 * uses the camel-cased pair over HTTP push and the snake-cased pair elsewhere, and a
 * webhook that understood only one would drop every notification after a Google
 * change nobody told us about.
 */
export function readGmailNotification(body: unknown): GmailNotification | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = (body as PubSubPushBody).message;
  if (typeof envelope !== 'object' || envelope === null) return null;

  const providerMessageId = envelope.messageId ?? envelope.message_id;
  if (typeof providerMessageId !== 'string' || providerMessageId.trim().length === 0) return null;
  if (typeof envelope.data !== 'string' || envelope.data.length === 0) return null;

  let decoded: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    decoded = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const emailAddress = decoded['emailAddress'];
  const historyId = decoded['historyId'];
  if (typeof emailAddress !== 'string' || emailAddress.trim().length === 0) return null;
  // Gmail sends the history id as a number in JSON; it is a decimal integer either way.
  const history =
    typeof historyId === 'number' ? String(Math.trunc(historyId)) : typeof historyId === 'string' ? historyId : null;
  if (history === null || !/^[0-9]{1,20}$/.test(history)) return null;

  const published = envelope.publishTime ?? envelope.publish_time;
  return {
    emailAddress: emailAddress.trim().toLowerCase(),
    historyId: history,
    providerMessageId: providerMessageId.trim(),
    publishedAt: typeof published === 'string' && !Number.isNaN(Date.parse(published)) ? published : null,
  };
}
