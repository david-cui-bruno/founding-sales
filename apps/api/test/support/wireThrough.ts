import { localNoopSuppressionJournal } from '../../src/journal/index.ts';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { dispatch, type ApiOptions } from '../../src/server.ts';
import type { AuthFixture } from './authFixture.ts';
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
 *
 * **The version is the shipped one on both sides** (review of PR 305, P2-4). These checks
 * are about what the installed Mac and the deployed container say to each other, so the
 * client announces `DESKTOP_VERSION_UNDER_TEST` and the route is given
 * `CONTAINER_CLIENT_VERSIONS` — the container's own policy, minimum 1.0.47 — rather than
 * the identity fixture's `1.2.0`-to-`1.4.x` one. A check that needs a version outside
 * that policy builds its own options and says why: `clientVersionCeiling.test.ts` is the
 * one that does, because the ceiling is what it is about.
 */

/** The desktop build every window check reads as: the oldest the container admits, 1.0.47 (lane M1). */
export const DESKTOP_VERSION_UNDER_TEST = '1.0.47';

/**
 * The route, under the container's policy rather than the fixture's.
 *
 * The auth deps carry their own copy of the policy — `runCommand`, `claimSignIn` and
 * `openSession` read `deps.config.supportedClientVersions`, not `ApiOptions` — so both
 * have to be replaced or a command would be judged against a policy the container does
 * not ship.
 */
export function routeOptions(fixture: AuthFixture): ApiOptions {
  return {
    session: fixture.db,
    supportedClientVersions: CONTAINER_CLIENT_VERSIONS,
    sendingEnabled: false,
    auth: { ...fixture.deps, config: { ...fixture.deps.config, supportedClientVersions: CONTAINER_CLIENT_VERSIONS } },
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
 * The desktop's authenticated client for one session, over the real route. The version it
 * announces is the installed build, judged by the container's own policy.
 */
export function desktopClient(fixture: AuthFixture, token: string, calls: string[] = []): AuthedClient {
  return createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: DESKTOP_VERSION_UNDER_TEST,
    accessToken: async () => await Promise.resolve({ token, generation: 0 }),
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
