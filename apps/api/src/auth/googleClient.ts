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

export interface TokenExchangeResult {
  readonly ok: boolean;
  readonly idToken: string | null;
}

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
    // it names must live at that same origin. A discovery document that redirects the
    // token exchange somewhere else is the whole attack.
    if (issuer !== config.issuer) return null;
    const origin = new URL(config.issuer).origin;
    for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
      if (new URL(endpoint).origin !== origin) return null;
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
      if (document === null) return { ok: false, idToken: null };
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
      if (response.status !== 200) return { ok: false, idToken: null };
      const body = parseJson(response.body);
      const idToken = body === null ? null : asString(body['id_token']);
      return idToken === null ? { ok: false, idToken: null } : { ok: true, idToken };
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
