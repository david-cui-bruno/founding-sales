import { localNoopSuppressionJournal } from '../../src/journal/index.ts';
import { dispatch, type ApiOptions } from '../../src/server.ts';
import { CURRENT_CLIENT_VERSION, type AuthFixture } from './authFixture.ts';
import type { HttpAnswer, HttpSend } from '../../../desktop/src/main/apiClient.ts';
import { createAuthedClient, type AuthedClient } from '../../../desktop/src/main/authedClient.ts';

/**
 * The real API route, in the real desktop transport, with the socket replaced by the
 * dispatcher (lane g78), for the checks in `test/wire/`.
 *
 * Everything on both sides is the shipped code: the route over a real PostgreSQL and a
 * real session, and `createAuthedClient` with the parser the bridge names. The one
 * substitution is the socket, and what crosses it is JSON, exactly as a socket would
 * carry it, so an instant arrives as a string.
 */

/** The desktop build every window check reads as: the one lane g78 ships. */
export const DESKTOP_VERSION_UNDER_TEST = '1.0.5';

export function routeOptions(fixture: AuthFixture): ApiOptions {
  return {
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  };
}

/** The desktop's `HttpSend`, bound to the real dispatcher. `calls` records `METHOD /path`. */
export function throughTheRoute(fixture: AuthFixture, calls: string[] = []): HttpSend {
  return async (url, init) => {
    const parsed = new URL(url);
    calls.push(`${init.method} ${parsed.pathname}`);
    const result = await dispatch(
      {
        method: init.method,
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: init.headers,
        body: init.body === undefined ? undefined : (JSON.parse(init.body) as Readonly<Record<string, unknown>>),
      },
      routeOptions(fixture),
    );
    const answer: HttpAnswer = { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) };
    return answer;
  };
}

/**
 * The desktop's authenticated client for one session, over the real route. The version
 * it announces is the fixture's current client: the fixture's policy is its own
 * (`1.2.0` to the `1.4.x` line), and the container's policy is checked separately by
 * each check's last test.
 */
export function desktopClient(fixture: AuthFixture, token: string, calls: string[] = []): AuthedClient {
  return createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: CURRENT_CLIENT_VERSION,
    accessToken: async () => await Promise.resolve(token),
    send: throughTheRoute(fixture, calls),
  });
}

/** One answer straight from the route, as the Mac would receive it. */
export async function routeAnswer(
  fixture: AuthFixture,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<HttpAnswer> {
  return await throughTheRoute(fixture)(`https://api.example.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A value's shape: every key, sorted, down to the type of each leaf. */
export function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, shapeOf(entry)]),
    );
  }
  return typeof value;
}
