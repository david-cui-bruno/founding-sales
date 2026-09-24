import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import type { GoogleOidcConfig } from './config.ts';

/**
 * Google's discovery document, its JSON Web Key Set, and its token endpoint.
 *
 * Everything reaches the network through one injected `fetch`, so a test gives it a
 * local provider whose keys were generated when the test started and no test ever
 * touches Google. The client caches the discovery document and the keys, honours the
 * `Cache-Control` the provider sends, and refreshes when an id token names a key it
 * has not seen — which is exactly how a real rotation looks from here.
 *
 * It fails closed everywhere: an unreachable document is not "probably the same as
 * last time" once its cache entry has expired, and an unknown `kid` after a bounded
 * refresh is `unknown_signing_key`, never "trust it anyway".
 */

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpRequest {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type HttpFetch = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

/** The real one. `apps/api` has no HTTP client dependency; this is the platform's. */
export const httpFetch: HttpFetch = async (url, request = {}) => {
  const response = await fetch(url, {
    method: request.method ?? 'GET',
    ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
};

export interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

/**
 * Why a token exchange produced no id token, in a closed vocabulary a log line may carry.
 *
 * `discovery_unavailable` is every way `discovery()` can answer null: the document was
 * unreachable, not JSON, incomplete, for another issuer, or named an endpoint on a host
 * the rule below refuses. `token_endpoint_status_<n>` is Google's HTTP status, and
 * `id_token_absent` is a 200 whose body carried no id token.
 */
export type TokenExchangeFailureReason =
  | 'discovery_unavailable'
  | `token_endpoint_status_${number}`
  | 'id_token_absent';

export type TokenExchangeResult =
  | { readonly ok: true; readonly idToken: string }
  | {
      readonly ok: false;
      readonly idToken: null;
      readonly reason: TokenExchangeFailureReason;
      /**
       * Google's own `error` code — `invalid_grant`, `invalid_client`,
       * `redirect_uri_mismatch` — when the token endpoint answered JSON with one, else
       * null. Only the code: never `error_description`, and never the body.
       */
      readonly providerError: string | null;
    };

export interface GoogleClient {
  discovery(config: GoogleOidcConfig): Promise<DiscoveryDocument | null>;
  /** The verifying key for a `kid`, refreshing the key set at most once per window. */
  signingKey(config: GoogleOidcConfig, kid: string): Promise<KeyObject | null>;
  exchangeCode(
    config: GoogleOidcConfig,
    input: { readonly code: string; readonly codeVerifier: string },
  ): Promise<TokenExchangeResult>;
  /** Verify an RS256 signature over `signingInput`. Kept here so the key never leaves. */
  verifySignature(key: KeyObject, signingInput: string, signature: Buffer): boolean;
}

export interface GoogleClientOptions {
  readonly fetch: HttpFetch;
  readonly now: () => Date;
  /** Never refresh the key set more often than this, whatever a token claims. */
  readonly minimumKeyRefreshMs?: number;
  /** Used when the provider sends no `Cache-Control: max-age`. */
  readonly defaultCacheSeconds?: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

function maxAgeSeconds(headers: Readonly<Record<string, string>>, fallback: number): number {
  const match = /max-age=(\d+)/i.exec(headers['cache-control'] ?? '');
  const parsed = match?.[1];
  if (parsed === undefined) return fallback;
  const seconds = Number(parsed);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : fallback;
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * The hosts a discovery document may send this client to.
 *
 * Until 24 September 2026 the rule was "the issuer's origin", and Google's own document
 * does not satisfy it: beside the issuer `https://accounts.google.com` it names the token
 * endpoint `https://oauth2.googleapis.com/token` and the key set
 * `https://www.googleapis.com/oauth2/v3/certs`. `discovery()` answered null, the start
 * step's fallback hid it, and production's first four real sign-ins were refused
 * `token_exchange_failed` (release runbook 8.0u).
 *
 * The attack the rule exists for is unchanged — a document that sends the token exchange,
 * which carries the client secret and the code, to somebody else's host — so an endpoint
 * is accepted only when it is `https:` and its hostname is the issuer's own or ends with
 * `.googleapis.com`, Google's documented API hosts. The issuer's exact origin is also
 * accepted, which in production is that same `https://accounts.google.com` (a constant in
 * `bootstrap/deployment.ts`) and is plain HTTP only for the loopback provider the tests
 * start. A URL that does not parse is refused rather than thrown.
 */
function endpointAllowed(endpoint: string, issuer: URL): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.origin === issuer.origin) return true;
  if (url.protocol !== 'https:') return false;
  return url.hostname === issuer.hostname || url.hostname.endsWith('.googleapis.com');
}

/** Google's `error` code from a token-endpoint body, if it has one that looks like a code. */
function providerErrorOf(body: string): string | null {
  const error = asString(parseJson(body)?.['error']);
  return error !== null && /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : null;
}

export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const defaultCacheSeconds = options.defaultCacheSeconds ?? 3600;
  const minimumKeyRefreshMs = options.minimumKeyRefreshMs ?? 60_000;
  let discoveryCache: CacheEntry<DiscoveryDocument> | null = null;
  let keyCache: CacheEntry<Map<string, KeyObject>> | null = null;
  let lastKeyRefreshMs = Number.NEGATIVE_INFINITY;

  const discovery = async (config: GoogleOidcConfig): Promise<DiscoveryDocument | null> => {
    const nowMs = options.now().getTime();
    if (discoveryCache !== null && discoveryCache.expiresAtMs > nowMs) return discoveryCache.value;

    const response = await options.fetch(config.discoveryUrl);
    if (response.status !== 200) return null;
    const document = parseJson(response.body);
    if (document === null) return null;

    const issuer = asString(document['issuer']);
    const authorizationEndpoint = asString(document['authorization_endpoint']);
    const tokenEndpoint = asString(document['token_endpoint']);
    const jwksUri = asString(document['jwks_uri']);
    if (issuer === null || authorizationEndpoint === null || tokenEndpoint === null || jwksUri === null) return null;

    // The document must describe the issuer we were configured for, and every endpoint
    // it names must be on the issuer's host or one of Google's API hosts, over HTTPS
    // (`endpointAllowed`). A discovery document that redirects the token exchange
    // somewhere else is the whole attack. Google's real document puts the token endpoint
    // on oauth2.googleapis.com and the key set on www.googleapis.com, which the old
    // same-origin rule refused on 24 September 2026.
    if (issuer !== config.issuer) return null;
    const issuerUrl = new URL(config.issuer);
    for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
      if (!endpointAllowed(endpoint, issuerUrl)) return null;
    }

    const value: DiscoveryDocument = { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
    discoveryCache = {
      value,
      expiresAtMs: nowMs + maxAgeSeconds(response.headers, defaultCacheSeconds) * 1000,
    };
    return value;
  };

  const refreshKeys = async (config: GoogleOidcConfig): Promise<Map<string, KeyObject>> => {
    const document = await discovery(config);
    if (document === null) return new Map();
    const response = await options.fetch(document.jwksUri);
    lastKeyRefreshMs = options.now().getTime();
    if (response.status !== 200) return keyCache?.value ?? new Map();
    const parsed = parseJson(response.body);
    const rawKeys = parsed?.['keys'];
    if (!Array.isArray(rawKeys)) return keyCache?.value ?? new Map();

    const keys = new Map<string, KeyObject>();
    for (const raw of rawKeys) {
      if (typeof raw !== 'object' || raw === null) continue;
      const jwk = raw as Record<string, unknown>;
      const kid = asString(jwk['kid']);
      // RSA signing keys only. Google publishes nothing else for id tokens, and an
      // unfamiliar key type is not something to guess at.
      if (kid === null || jwk['kty'] !== 'RSA') continue;
      try {
        keys.set(kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
      } catch {
        // A key we cannot import is a key we do not have.
      }
    }
    keyCache = {
      value: keys,
      expiresAtMs: lastKeyRefreshMs + maxAgeSeconds(response.headers, defaultCacheSeconds) * 1000,
    };
    return keys;
  };

  return {
    discovery,

    async signingKey(config, kid) {
      const nowMs = options.now().getTime();
      const cached = keyCache;
      if (cached !== null && cached.expiresAtMs > nowMs) {
        const key = cached.value.get(kid);
        if (key !== undefined) return key;
        // An unknown `kid` in a live cache is what a rotation looks like: refresh once,
        // but no more often than the window, so a forged `kid` cannot be a fetch loop.
        if (nowMs - lastKeyRefreshMs < minimumKeyRefreshMs) return null;
      }
      return (await refreshKeys(config)).get(kid) ?? null;
    },

    async exchangeCode(config, input) {
      const document = await discovery(config);
      if (document === null) {
        return { ok: false, idToken: null, reason: 'discovery_unavailable', providerError: null };
      }
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      const response = await options.fetch(document.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
      if (response.status !== 200) {
        return {
          ok: false,
          idToken: null,
          reason: `token_endpoint_status_${response.status}`,
          providerError: providerErrorOf(response.body),
        };
      }
      const body = parseJson(response.body);
      const idToken = body === null ? null : asString(body['id_token']);
      return idToken === null
        ? { ok: false, idToken: null, reason: 'id_token_absent', providerError: null }
        : { ok: true, idToken };
    },

    verifySignature(key, signingInput, signature) {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingInput, 'utf8');
      try {
        return verifier.verify(key, signature);
      } catch {
        return false;
      }
    },
  };
}
