import { createServer, type Server } from 'node:https';
import { buildBrowserAssets } from './assets.ts';
import { createBrowserHostHandler } from './host.ts';
import type { BrowserServerOptions } from './hostContract.ts';

/** Actual host entry. Composition supplies existing auth/API request ownership;
 * no local test identity/router, process environment or real credentials live here. */
export async function createBrowserServer(options: BrowserServerOptions): Promise<Server> {
  const assets = options.assets ?? await buildBrowserAssets();
  const handler = createBrowserHostHandler({
    runtime: { ...options.settings, cookieKey: Buffer.from(options.settings.cookieKey), withRequest: options.withRequest },
    assets,
    ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: options.bodyTimeoutMs }),
  });
  return createServer({
    ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16_384,
    headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000,
  }, handler);
}
