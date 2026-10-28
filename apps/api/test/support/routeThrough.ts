import { localNoopSuppressionJournal } from '../../src/journal/index.ts';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { dispatch, type ApiOptions } from '../../src/server.ts';
import type { AuthFixture } from './authFixture.ts';

/** Exercise the oldest admitted client against the container's actual policy. */
export const CLIENT_VERSION_UNDER_TEST = '1.0.47';

export function routeOptions(fixture: AuthFixture): ApiOptions {
  return {
    session: fixture.db,
    supportedClientVersions: CONTAINER_CLIENT_VERSIONS,
    sendingEnabled: false,
    // Commands read the auth policy independently of ApiOptions.
    auth: { ...fixture.deps, config: { ...fixture.deps.config, supportedClientVersions: CONTAINER_CLIENT_VERSIONS } },
    upgradeUrl: 'https://callie.example/update',
    suppressionJournal: localNoopSuppressionJournal(),
  };
}

/** Authenticated real API dispatch with a JSON response boundary. */
export async function routeAnswer(
  fixture: AuthFixture,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<{ status: number; body: unknown }> {
  const address = new URL(path, 'https://api.example.test');
  const result = await dispatch({
    method, path: address.pathname, query: address.searchParams,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  }, routeOptions(fixture));
  return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as unknown };
}
