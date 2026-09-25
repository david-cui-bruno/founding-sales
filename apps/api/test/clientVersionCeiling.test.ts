import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientVersionNoticeSchema,
  clientVersionPolicySchema,
  clientVersionRangeSchema,
  mayMutate,
  publishedClientVersions,
  sessionGrantSchema,
  signInStartResponseSchema,
  wireDrift,
  type ClientVersionPolicy,
} from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../src/bootstrap/main.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiOptions, type ApiRequest } from '../src/server.ts';
import type { AuthDeps } from '../src/auth/index.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The version gate as a compatibility ceiling (lane g78, audit item O04;
 * `docs/decisions/g78-version-ceiling.md`).
 *
 * Until g78 the API published the exact latest desktop as its maximum, and every
 * desktop-only release needed an API deployment first. Now the container holds a
 * policy — a minimum, a release line, and a list of known-bad builds — and publishes
 * the range derived from it. What has to be true, through the real dispatcher:
 *
 *   * a build on the line the API has never heard of is admitted — the point;
 *   * a build on the incompatible list is refused every sign-in, renewal and command,
 *     exactly as an outdated one is;
 *   * a build above the line is still refused;
 *   * what goes on the wire is `{ minimum, maximum }` and nothing else, because desktops
 *     1.0.0 to 1.0.4 parse it with a strict schema and a third key would lock every
 *     one of them out of its own sign-in.
 *
 * The vacuous-pass trap is a list nobody reads: a policy whose `incompatible` entry is
 * published but never checked would pass every "admits" test. The refusal tests name a
 * listed build explicitly, and `scripts/releaseMutationCheck.mjs` removes the check to
 * prove they go red.
 */

const LISTED = '1.4.1';
const UNHEARD_OF_PATCH = '1.4.7';
const ABOVE_THE_LINE = '1.5.0';

const policy: ClientVersionPolicy = clientVersionPolicySchema.parse({
  minimum: '1.2.0',
  ceiling: '1.4.x',
  incompatible: [LISTED],
});

describe('the compatibility ceiling, through the real routes', () => {
  let fixture: AuthFixture;
  let deps: AuthDeps;
  let adminToken = '';
  let refreshCredential = '';

  const options = (): ApiOptions => ({
    session: fixture.db,
    supportedClientVersions: policy,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    deps = { ...fixture.deps, config: { ...fixture.deps.config, supportedClientVersions: policy } };
    const grant = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin);
    adminToken = grant.accessToken;
    refreshCredential = grant.refreshCredential;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('publishes the line’s top as the maximum, in the two-key shape a 1.0.x Mac parses', async () => {
    const notice = await call('GET', '/auth/client-version');
    expect(notice.status).toBe(200);
    expect(clientVersionNoticeSchema.safeParse(notice.body).success).toBe(true);
    expect(notice.body['supported']).toEqual({ minimum: '1.2.0', maximum: '1.4.999' });
    // Never the list, and never the ceiling: the strict schema would refuse either.
    expect(JSON.stringify(notice.body)).not.toContain(LISTED);
    expect(JSON.stringify(notice.body)).not.toContain('ceiling');
  });

  it('admits a patch on the line that did not exist when the API was deployed', async () => {
    const started = await call('POST', '/auth/sign-in/start', {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: 'Ceiling Mac',
      clientVersion: UNHEARD_OF_PATCH,
    });
    expect(started.status).toBe(200);
    // The handoff the Mac reads with `signInHandoffSchema`, which is this contract (lane g78).
    expect(wireDrift(signInStartResponseSchema, started.body)).toEqual([]);

    const command = await call(
      'POST',
      '/sequences/create',
      { commandId: randomUUID(), clientVersion: UNHEARD_OF_PATCH, name: 'Admitted by the line' },
      adminToken,
    );
    expect(command.status).toBe(200);
  });

  it('refuses a listed build every sign-in, renewal and command, as it refuses an outdated one', async () => {
    const started = await call('POST', '/auth/sign-in/start', {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: 'Listed Mac',
      clientVersion: LISTED,
    });
    expect(started.status).toBe(426);
    expect(started.body['error']).toBe('client_upgrade_required');

    const renewed = await call('POST', '/auth/session/renew', { refreshCredential, clientVersion: LISTED });
    expect(renewed.status).toBe(426);

    const command = await call(
      'POST',
      '/sequences/create',
      { commandId: randomUUID(), clientVersion: LISTED, name: 'Refused by the list' },
      adminToken,
    );
    expect(command.status).toBe(426);
    expect(command.body['reason']).toBe('client_upgrade_required');
  });

  it('still refuses a build above the line', async () => {
    const started = await call('POST', '/auth/sign-in/start', {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: 'Ahead Mac',
      clientVersion: ABOVE_THE_LINE,
    });
    expect(started.status).toBe(426);
  });

  it('puts the published range, not the policy, in the renewal grant', async () => {
    const renewed = await call('POST', '/auth/session/renew', { refreshCredential, clientVersion: '1.4.0' });
    expect(renewed.status).toBe(200);
    expect(renewed.body['supportedClientVersions']).toEqual({ minimum: '1.2.0', maximum: '1.4.999' });
    expect(sessionGrantSchema.omit({ deviceSecret: true }).safeParse(renewed.body).success).toBe(true);
  });
});

describe('the policy this container ships (lane g78)', () => {
  it('is 1.0.0 and up on the 1.x line, with nothing listed', () => {
    expect(CONTAINER_CLIENT_VERSIONS).toEqual({ minimum: '1.0.0', ceiling: '1.x', incompatible: [] });
  });

  it('publishes a range desktop 1.0.4 parses and reads as admitting itself, with no desktop change', () => {
    const published = publishedClientVersions(CONTAINER_CLIENT_VERSIONS);
    expect(published).toEqual({ minimum: '1.0.0', maximum: '1.999.999' });
    // `clientVersionRangeSchema` is the strict schema 1.0.0 to 1.0.4 were built with.
    expect(clientVersionRangeSchema.safeParse(published).success).toBe(true);
    for (const installed of ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
      expect(mayMutate(published, installed), installed).toBe(true);
      expect(mayMutate(CONTAINER_CLIENT_VERSIONS, installed), installed).toBe(true);
    }
  });

  it('admits 1.0.5 and later 1.x builds without another API deployment, and not 2.0.0', () => {
    for (const later of ['1.0.5', '1.0.6', '1.1.0', '1.12.3']) {
      expect(mayMutate(CONTAINER_CLIENT_VERSIONS, later), later).toBe(true);
    }
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, '2.0.0')).toBe(false);
  });
});
