import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ACCESS_TOKEN_PREFIX, REFRESH_CREDENTIAL_PREFIX } from '@fss/contracts';

/**
 * Digests, derivations and the two credential spellings.
 *
 * Nothing in this file keeps state and nothing in it logs. `sha256Hex` is the only
 * way a secret becomes a database value, and the CHECK constraints in migration 0003
 * refuse anything that is not its output, so a plaintext credential cannot be stored
 * by mistake.
 */

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Compare two hex digests without leaking where they first differ. */
export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** base64url of a sha256 digest: the PKCE S256 code challenge, and nothing else. */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/**
 * The PKCE verifier for one authorization request, derived from its `state`.
 *
 * Deriving means the database holds no value that could be presented to Google: the
 * row keeps the digest of the state and the challenge, and the verifier exists only
 * while a callback is being handled. See docs/decisions/g2-pkce-verifier-derivation.md.
 */
export function deriveCodeVerifier(stateSigningKey: Buffer, state: string): string {
  return createHmac('sha256', stateSigningKey).update(state, 'utf8').digest('base64url');
}

export interface ParsedAccessToken {
  readonly workspaceId: string;
  readonly secret: string;
}

export interface ParsedRefreshCredential {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly secret: string;
}

export function formatAccessToken(workspaceId: string, secret: string): string {
  return `${ACCESS_TOKEN_PREFIX}.${workspaceId}.${secret}`;
}

export function formatRefreshCredential(
  workspaceId: string,
  deviceId: string,
  generation: number,
  secret: string,
): string {
  return `${REFRESH_CREDENTIAL_PREFIX}.${workspaceId}.${deviceId}.${String(generation)}.${secret}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Null on anything that is not this API's own access token. Fails closed. */
export function parseAccessToken(value: string): ParsedAccessToken | null {
  const parts = value.split('.');
  const [prefix, workspaceId, secret] = parts;
  if (parts.length !== 3 || prefix !== ACCESS_TOKEN_PREFIX) return null;
  if (workspaceId === undefined || secret === undefined) return null;
  if (!UUID.test(workspaceId) || !SECRET.test(secret)) return null;
  return { workspaceId, secret };
}

/** Null on anything that is not this API's own refresh credential. Fails closed. */
export function parseRefreshCredential(value: string): ParsedRefreshCredential | null {
  const parts = value.split('.');
  const [prefix, workspaceId, deviceId, generation, secret] = parts;
  if (parts.length !== 5 || prefix !== REFRESH_CREDENTIAL_PREFIX) return null;
  if (workspaceId === undefined || deviceId === undefined || generation === undefined || secret === undefined) {
    return null;
  }
  if (!UUID.test(workspaceId) || !UUID.test(deviceId) || !SECRET.test(secret)) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(generation)) return null;
  return { workspaceId, deviceId, generation: Number(generation), secret };
}

/** The bearer value of an `Authorization` header, or null. Case-insensitive scheme. */
export function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The canonical JSON of a command payload, so that the same payload always hashes to
 * the same digest whatever order the client serialized its keys in. Arrays keep their
 * order — an array's order is data — and `undefined` members become `null`, because a
 * client that omits a key and a client that sends `null` mean the same thing here.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return 'null';
}

export function payloadHashOf(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
