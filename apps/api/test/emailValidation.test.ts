import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, routeDtoSchema, wireDrift } from '@fss/contracts';
import { z } from 'zod';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Lane g90 through the API: the Firm page's second version, which puts each route's
 * technical validation on it, and "Check again" (`/contacts/routes/check`).
 *
 * The domain proves the rules (`packages/domain/test/crm/routeValidation.test.ts`) and
 * the worker proves the job (`apps/worker/test/routeValidate.test.ts`). What is proved
 * here is the surface, and above all the compatibility promise: **an installed 1.0.5
 * keeps parsing the Firm page.** It parses each route with a strict schema of its own
 * that has no `technicalValidation`, so the check below parses the first version's answer
 * with exactly that schema — and requires the second version's answer to *fail* it, which
 * is the proof the version flag is what keeps the key away from 1.0.5.
 *
 * Addresses are under `.fsstest`, a top-level name that does not exist.
 */

/** Desktop 1.0.5's route schema: this lane's contract without the key it adds. */
const ROUTE_1_0_5 = routeDtoSchema.omit({ technicalValidation: true });

describe('lane g90 through the API', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let betaToken = '';
  let firmId = '';
  let contactId = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) as Record<string, unknown> };
  };
  const command = (extra: Readonly<Record<string, unknown>>) => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  const result = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  const addAddress = async (value: string, extra: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const added = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'email', value, source: 'salesperson', ...extra }),
    );
    expect(added.status).toBe(200);
    return String(result(added)['id']);
  };

  const validateJobs = async (routeId: string) =>
    (
      await fixture.db.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'route.validate' AND payload ->> 'routeId' = $2
          ORDER BY created_at`,
        [fixture.alpha.workspaceId, routeId],
      )
    ).rows.map(row => row.idempotency_key);

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    const firm = await post(
      '/firms/create',
      adminToken,
      command({ name: 'Linden Test Advisors', regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId }),
    );
    firmId = String(result(firm)['id']);
    contactId = String(result(await post('/contacts/create', salespersonToken, command({ firmId, fullName: 'Rowan Placeholder' })))['id']);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('adds an address as an unchecked candidate with its check queued in the same command', async () => {
    const routeId = await addAddress('rowan@mx.fsstest');
    const { rows } = await fixture.db.query<{ eligibility: string; technical_validation: string }>(
      'SELECT eligibility, technical_validation FROM email_addresses WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, routeId],
    );
    expect(rows[0]).toEqual({ eligibility: 'candidate', technical_validation: 'unknown' });
    expect(await validateJobs(routeId)).toEqual([`route-validate:${routeId}:1:new`]);
  });

  it('answers 1.0.5’s Firm page without the key, and the second version with it', async () => {
    const first = await post('/crm/firm-page', salespersonToken, { firmId });
    expect(first.status).toBe(200);
    const read = first.body['read'] as { firm: { emailRoutes: Record<string, unknown>[] } };
    expect(read.firm.emailRoutes.length).toBeGreaterThan(0);
    for (const route of read.firm.emailRoutes) {
      expect(Object.keys(route).sort()).toEqual(['contactId', 'eligibility', 'id', 'value', 'version']);
      expect(ROUTE_1_0_5.safeParse(route).success).toBe(true);
    }
    expect(wireDrift(firmPageResponseSchema, first.body)).toEqual([]);

    const second = await post('/crm/firm-page', salespersonToken, { firmId, pageVersion: 2 });
    expect(second.status).toBe(200);
    expect(wireDrift(firmPageResponseSchema, second.body)).toEqual([]);
    const routes = (second.body['read'] as { firm: { emailRoutes: Record<string, unknown>[] } }).firm.emailRoutes;
    expect(routes.map(route => route['technicalValidation'])).toEqual(routes.map(() => 'unknown'));
    // The key is exactly what would break 1.0.5, which is why only version 2 gets it.
    expect(ROUTE_1_0_5.safeParse(routes[0]).success).toBe(false);
    expect(z.array(routeDtoSchema).safeParse(routes).success).toBe(true);

    expect((await post('/crm/firm-page', salespersonToken, { firmId, pageVersion: 3 })).status).toBe(400);
  });

  it('queues one more check for an address being checked, once per command, at the version on screen', async () => {
    const routeId = await addAddress('dana@slow.fsstest');
    const body = command({ routeKind: 'email', routeId, routeVersion: 1 });
    const checked = await post('/contacts/routes/check', salespersonToken, body);
    expect(checked.status).toBe(200);
    expect(result(checked)).toEqual({ routeId, routeVersion: 1, queued: true });
    const keys = await validateJobs(routeId);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(new RegExp(`^route-validate:${routeId}:1:check-[0-9a-f]{32}$`, 'u'));

    const replayed = await post('/contacts/routes/check', salespersonToken, body);
    expect(replayed.body['replayed']).toBe(true);
    expect(await validateJobs(routeId)).toHaveLength(2);

    const stale = await post('/contacts/routes/check', salespersonToken, command({ routeKind: 'email', routeId, routeVersion: 2 }));
    expect(stale.status).toBe(409);
    expect(stale.body['reason']).toBe('route_version_stale');

    const elsewhere = await post('/contacts/routes/check', betaToken, command({ routeKind: 'email', routeId, routeVersion: 1 }));
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body['reason']).toBe('route_unknown');

    const phone = await post('/contacts/routes/check', salespersonToken, command({ routeKind: 'phone', routeId, routeVersion: 1 }));
    expect(phone.status).toBe(400);
  });

  it('queues nothing for an address that is usable, and refuses one that failed', async () => {
    const usable = await addAddress('desk@mx.fsstest', { technicalValidation: 'passed', associationConfidence: 1 });
    const answer = await post('/contacts/routes/check', salespersonToken, command({ routeKind: 'email', routeId: usable, routeVersion: 1 }));
    expect(answer.status).toBe(200);
    expect(result(answer)).toEqual({ routeId: usable, routeVersion: 1, queued: false });
    expect(await validateJobs(usable)).toEqual([]);

    const failed = await addAddress('nobody@gone.fsstest', { technicalValidation: 'failed' });
    const refused = await post('/contacts/routes/check', salespersonToken, command({ routeKind: 'email', routeId: failed, routeVersion: 1 }));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('route_invalid');
  });
});
