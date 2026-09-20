import type { AuthRefusalCode } from '@fss/contracts';
import type { GoogleOidcConfig } from './config.ts';
import type { GoogleClient } from './googleClient.ts';
import { digestsEqual, sha256Hex } from './tokens.ts';

/**
 * Google id-token validation (specification 5.1).
 *
 * "The API validates issuer, audience and `azp` where applicable, signature against
 * current Google keys, bounded clock skew, expiration, `email_verified`, and `hd`.
 * Google `sub` is the durable identifier; email is display data."
 *
 * Each of those is a separate named refusal so that a failure says which rule it
 * broke, and the order is deliberate: shape, then algorithm, then signature, then
 * claims. Nothing unsigned is ever read for its claims, so a token with `alg: none`
 * cannot talk its way past the issuer check.
 */

export interface VerifiedIdTokenClaims {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly hostedDomain: string;
}

export type IdTokenOutcome =
  | { readonly valid: true; readonly claims: VerifiedIdTokenClaims }
  | { readonly valid: false; readonly refusal: AuthRefusalCode };

interface TokenParts {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: Buffer;
  readonly signingInput: string;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function split(token: string): TokenParts | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;
  if (rawHeader === undefined || rawPayload === undefined || rawSignature === undefined) return null;
  const header = decodeSegment(rawHeader);
  const payload = decodeSegment(rawPayload);
  if (header === null || payload === null) return null;
  return {
    header,
    payload,
    signature: Buffer.from(rawSignature, 'base64url'),
    signingInput: `${rawHeader}.${rawPayload}`,
  };
}

const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const asSeconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Whether `aud` — which may be a string or an array — contains exactly our client id. */
function audienceMatches(audience: unknown, clientId: string): boolean {
  if (typeof audience === 'string') return audience === clientId;
  if (Array.isArray(audience)) return audience.length === 1 && audience[0] === clientId;
  return false;
}

export interface ValidateIdTokenInput {
  readonly token: string;
  readonly config: GoogleOidcConfig;
  readonly google: GoogleClient;
  readonly now: Date;
  /** The digest of the nonce this authorization request issued. */
  readonly expectedNonceHash: string;
}

export async function validateIdToken(input: ValidateIdTokenInput): Promise<IdTokenOutcome> {
  const parts = split(input.token);
  if (parts === null) return { valid: false, refusal: 'malformed_token' };

  // RS256 only. `none` and the HMAC families are refused before a claim is read, which
  // is what makes the algorithm-confusion attack a non-event rather than a near miss.
  if (parts.header['alg'] !== 'RS256') return { valid: false, refusal: 'unsupported_algorithm' };
  const kid = asString(parts.header['kid']);
  if (kid === null) return { valid: false, refusal: 'unknown_signing_key' };

  const key = await input.google.signingKey(input.config, kid);
  if (key === null) return { valid: false, refusal: 'unknown_signing_key' };
  if (!input.google.verifySignature(key, parts.signingInput, parts.signature)) {
    return { valid: false, refusal: 'bad_signature' };
  }

  const claims = parts.payload;
  if (asString(claims['iss']) !== input.config.issuer) return { valid: false, refusal: 'issuer_mismatch' };
  if (!audienceMatches(claims['aud'], input.config.clientId)) return { valid: false, refusal: 'audience_mismatch' };

  // `azp` is present whenever the token was issued to a different party than the
  // audience. Where it is present it must be us; where it is absent `aud` already is.
  const azp = claims['azp'];
  if (azp !== undefined && azp !== input.config.clientId) {
    return { valid: false, refusal: 'authorized_party_mismatch' };
  }

  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const skew = input.config.clockSkewSeconds;
  const expiry = asSeconds(claims['exp']);
  if (expiry === null || nowSeconds - skew >= expiry) return { valid: false, refusal: 'token_expired' };
  const issuedAt = asSeconds(claims['iat']);
  if (issuedAt === null || issuedAt - skew > nowSeconds) return { valid: false, refusal: 'token_issued_in_future' };
  const notBefore = asSeconds(claims['nbf']);
  if (notBefore !== null && notBefore - skew > nowSeconds) return { valid: false, refusal: 'token_not_yet_valid' };

  const nonce = asString(claims['nonce']);
  if (nonce === null || !digestsEqual(sha256Hex(nonce), input.expectedNonceHash)) {
    return { valid: false, refusal: 'nonce_mismatch' };
  }

  if (claims['email_verified'] !== true) return { valid: false, refusal: 'email_unverified' };
  const hostedDomain = asString(claims['hd']);
  if (hostedDomain === null || hostedDomain.toLowerCase() !== input.config.hostedDomain.toLowerCase()) {
    return { valid: false, refusal: 'hosted_domain_mismatch' };
  }

  const subject = asString(claims['sub']);
  if (subject === null) return { valid: false, refusal: 'subject_missing' };
  const email = asString(claims['email']);
  if (email === null) return { valid: false, refusal: 'email_unverified' };

  return {
    valid: true,
    claims: {
      subject,
      // Email is display data, lower-cased because the `users` table stores it that way.
      email: email.toLowerCase(),
      displayName: asString(claims['name']) ?? email,
      hostedDomain,
    },
  };
}
