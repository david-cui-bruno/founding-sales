import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { BrowserHostSettings, BrowserAssets } from '../../../web/src/server/hostContract.ts';
import type { BrowserRuntime } from '../../../web/src/server/runtime.ts';
import { readBrowserHostSettings } from '../../../web/src/server/settings.ts';
import { createBrowserHostHandler } from '../../../web/src/server/host.ts';
import { loadBrowserAssets } from '../../../web/src/server/publicAssets.ts';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY } from '../../../web/src/server/httpPolicy.ts';
import { optionsForRequest, type ApiServerOptions } from '../server.ts';
import { requestConnection } from './connections.ts';
import { buildReadinessReport } from './readiness.ts';
import type { ApiBrowserMount } from './browserContract.ts';

export interface FounderBrowserSettings extends BrowserHostSettings {
  readonly founder: Readonly<{ workspaceId: string; userId: string }>;
}
const fields = ['FSS_BROWSER_ORIGIN', 'FSS_BROWSER_CLIENT_VERSION', 'FSS_BROWSER_COOKIE_KEY_HEX', 'FSS_BROWSER_FOUNDER_WORKSPACE_ID', 'FSS_BROWSER_FOUNDER_USER_ID'] as const;
export function readFounderBrowserSettings(environment: NodeJS.ProcessEnv): FounderBrowserSettings | undefined {
  if (fields.every(field => environment[field] === undefined)) return undefined;
  const workspaceId = environment['FSS_BROWSER_FOUNDER_WORKSPACE_ID'];
  const userId = environment['FSS_BROWSER_FOUNDER_USER_ID'];
  const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/u);
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(userId).success) throw new Error('Invalid browser host configuration');
  return { ...readBrowserHostSettings(environment), founder: Object.freeze({ workspaceId: workspaceId!, userId: userId! }) };
}

/** Request-owned auth and connection. Readiness is checked anew, never cached here. */
export function createFounderBrowserRuntime(settings: FounderBrowserSettings, options: ApiServerOptions): BrowserRuntime {
  if (options.auth === undefined) throw new Error('Invalid browser host configuration');
  const base = options.auth;
  const auth = { ...base, config: { ...base.config, oidc: { ...base.config.oidc, redirectUri: `${settings.origin}/browser/callback` } } };
  return {
    ...settings,
    founder: Object.freeze({ ...settings.founder }),
    cookieKey: Buffer.from(settings.cookieKey),
    withRequest: async work => {
      const connection = requestConnection(options.connections);
      try {
        if (!(await buildReadinessReport({ session: connection.session })).ready) throw new Error('Browser unavailable');
        const api = optionsForRequest({ ...options, auth }, connection.session);
        return await work({ api, auth: { ...auth, db: connection.session } });
      } finally { connection.release(); }
    },
  };
}

export async function createApiBrowserMount(settings: FounderBrowserSettings, options: ApiServerOptions, directory = '/app/browser-public'): Promise<ApiBrowserMount> {
  return browserMountWithAssets(settings, options, await loadBrowserAssets(directory));
}
export function browserMountWithAssets(settings: FounderBrowserSettings, options: ApiServerOptions, assets: BrowserAssets): ApiBrowserMount {
  return { origin: settings.origin, handler: createBrowserHostHandler({ runtime: createFounderBrowserRuntime(settings, options), assets }) };
}

/** Browser host owns every non-health path. Ambiguous authority never reaches API. */
export function dispatchBrowser(mount: ApiBrowserMount | undefined, request: IncomingMessage, response: ServerResponse): boolean {
  if (mount === undefined) return false;
  const hosts: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]!.toLowerCase() === 'host') hosts.push(request.rawHeaders[i + 1]!);
  }
  if (hosts.length !== 1) {
    response.writeHead(400, { ...BROWSER_SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    response.end(BROWSER_REFUSAL_BODY);
    return true;
  }
  const path = (request.url ?? '').split('?')[0]!;
  const host = new URL(mount.origin).host;
  if (hosts[0] !== host) {
    if (path === '/browser' || path.startsWith('/browser/') || hosts[0]?.toLowerCase() === host) {
      response.writeHead(400, { ...BROWSER_SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      response.end(BROWSER_REFUSAL_BODY);
      return true;
    }
    return false;
  }
  if (['/healthz', '/readyz', '/health'].includes(path)) return false;
  mount.handler(request, response);
  return true;
}
