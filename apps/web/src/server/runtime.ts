import type { ApiRequest, RouteResult } from '../../../api/src/routes/types.ts';
import type { ApiOptions } from '../../../api/src/server.ts';
import type { AuthDeps } from '../../../api/src/auth/config.ts';

export interface BrowserRequestContext {
  readonly auth: AuthDeps;
  readonly api: ApiOptions;
}

/** Each invocation obtains its own request connection, never a shared transaction. */
export interface BrowserRuntime {
  readonly founder?: Readonly<{ workspaceId: string; userId: string }>;
  readonly origin: string;
  readonly clientVersion: string;
  /** AES-256-GCM key, server-only. Rotation invalidates browser cookies. */
  readonly cookieKey: Buffer;
  readonly withRequest: <T>(work: (context: BrowserRequestContext) => Promise<T>) => Promise<T>;
}

export interface BrowserResponse extends RouteResult {
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}
export type BrowserHandler = (request: ApiRequest) => Promise<BrowserResponse | null>;
