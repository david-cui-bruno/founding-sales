import type { BrowserRuntime } from './runtime.ts';

/** Public build artifacts only. Exact paths are allowlisted, never filesystem lookups. */
export interface BrowserStaticAsset {
  readonly body: Uint8Array;
  readonly contentType: 'text/html; charset=utf-8' | 'text/javascript; charset=utf-8' | 'text/css; charset=utf-8';
}
export type BrowserAssets = ReadonlyMap<string, BrowserStaticAsset>;

/** All credentials/configuration enter through the server composition, never the bundle. */
export type BrowserHostSettings = Pick<BrowserRuntime, 'origin' | 'clientVersion' | 'cookieKey'>;

export interface BrowserHostOptions {
  readonly runtime: BrowserRuntime;
  readonly assets: BrowserAssets;
  /** Finite upload deadline. Overrides may shorten, never exceed 30 seconds. */
  readonly bodyTimeoutMs?: number;
}

/** Reusable server composition. TLS/key material is supplied, never read or generated. */
export interface BrowserServerOptions {
  readonly settings: BrowserHostSettings;
  readonly withRequest: BrowserRuntime['withRequest'];
  readonly tls: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly assets?: BrowserAssets;
  readonly bodyTimeoutMs?: number;
}

/** Transport implementations must cap raw bytes at the existing API MAX_REQUEST_BYTES
 * before parsing or entering withRequest. No proxy-derived origin or shared auth state.
 * Production-shaped handler: createBrowserHostHandler(options): RequestListener.
 * Build: buildBrowserAssets(): Promise<BrowserAssets>.
 * Server-only settings: readBrowserHostSettings(values): BrowserHostSettings.
 * External TLS/service/callback/key provisioning remains outside this local slice. */
