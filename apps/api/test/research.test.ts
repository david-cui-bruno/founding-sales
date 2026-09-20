import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch, type ApiRequest } from '../src/server.ts';
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  OUTDATED_CLIENT_VERSION,
  type AuthFixture,
} from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The research endpoints, through the real dispatcher with real sessions.
 *
 * What is proved here is the wiring, as in `crm.test.ts`: the rules have their own
 * tests against a real PostgreSQL in `@fss/domain`. Four things are wiring, and each
 * of them is one forgotten line away from being wrong:
 *
 *   * every mutation is a command, so a replay returns the original result;
 *   * an unauthenticated or outdated client reaches no research path at all;
 *   * the admin-only reads refuse a salesperson with a redacted sentence that does not
 *     confirm the endpoint exists;
 *   * the two enqueue commands write a job row inside the command transaction and
 *     never call a provider from inside an HTTP request.
 */
describe('research routes', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;
  let firmId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const get = async (
    path: string,
    token: string | null,
    query = new URLSearchParams(),
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      {
        method: 'GET',
        path,
        query,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        body: undefined,
      },
      options(),
    );
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    const admin = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin);
    const salesperson = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    adminToken = admin.accessToken;
    salespersonToken = salesperson.accessToken;

    const created = await post(
      '/firms/create',
      adminToken,
      command({
        name: 'Northgate Residential Management',
        website: 'https://northgate-residential.example.test/',
        regionCode: 'TX',
        postalCode: '79901',
        assignedUserId: fixture.alpha.salesperson.userId,
      }),
    );
    expect(created.status).toBe(200);
    firmId = (created.body['result'] as { id: string } | null)?.id ?? '';
    expect(firmId).not.toBe('');

    // Research on, with every provider enabled, so the enqueue paths are reachable.
    const settings = await post(
      '/research/config',
      adminToken,
      command({ enabled: true, dailyPageCeiling: 20, dailyFirmCeiling: 20, dailyCostCeilingMicros: 2_000_000 }),
    );
    expect(settings.status).toBe(200);
    for (const providerKey of ['places', 'company_page', 'page_facts']) {
      const provider = await post(
        '/research/providers',
        adminToken,
        command({ providerKey, enabled: true, costPerCallMicros: 1_000, dailyCallCeiling: 50 }),
      );
      expect(provider.status, providerKey).toBe(200);
    }
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every research path without a session', async () => {
    for (const path of [
      '/research/config',
      '/research/providers',
      '/research/policy',
      '/research/suggestions/review',
      '/research/discover',
      '/research/enrich',
    ]) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
    expect((await get('/research/config', null)).status).toBe(401);
    expect((await get('/research/suggestions', null)).status).toBe(401);
  });

  it('refuses a path nobody mounted, so a typo is not a silent success', async () => {
    expect((await get('/research', adminToken)).status).toBe(404);
    expect((await post('/research/everything', adminToken, command())).status).toBe(404);
  });

  it('refuses an outdated client and leaves its command id unspent', async () => {
    const commandId = randomUUID();
    const outdated = await post('/research/config', adminToken, {
      commandId,
      clientVersion: OUTDATED_CLIENT_VERSION,
      dailyPageCeiling: 5,
    });
    expect(outdated.status).toBe(426);
    expect(outdated.body['reason']).toBe('client_upgrade_required');

    const retried = await post('/research/config', adminToken, {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      dailyPageCeiling: 5,
    });
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
    // Put the ceiling back for the rest of the file.
    await post('/research/config', adminToken, command({ dailyPageCeiling: 20 }));
  });

  it('replays a command by id rather than running it again', async () => {
    const body = command({ providerKey: 'places', dailyCallCeiling: 40 });
    const first = await post('/research/providers', adminToken, body);
    const second = await post('/research/providers', adminToken, body);
    expect(first.status).toBe(200);
    expect(first.body['replayed']).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body['replayed']).toBe(true);
  });

  it('refuses a malformed body before it reaches a command', async () => {
    for (const body of [
      command({ providerKey: 'Places' }),
      command({ dailyPageCeiling: -1 }),
      command({ version: 'route-policy.2' }),
      { clientVersion: CURRENT_CLIENT_VERSION },
    ]) {
      const answer = await post('/research/providers', adminToken, body);
      expect([400, 422]).toContain(answer.status);
    }
  });

  // ------------------------------------------------------------ the read matrix
  it('gives an admin the configuration and refuses a salesperson without confirming it exists', async () => {
    const asAdmin = await get('/research/config', adminToken);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body['settings']).toMatchObject({ enabled: true });
    expect(asAdmin.body['businessTimeZone']).toBe('America/New_York');
    expect((asAdmin.body['providers'] as unknown[]).length).toBe(3);
    expect(asAdmin.body['activePolicy']).toMatchObject({ version: 'route-policy.1' });

    const asSalesperson = await get('/research/config', salespersonToken);
    expect(asSalesperson.status).toBe(403);
    // The same redacted sentence every refused read gets: it does not say what this
    // endpoint would have returned, or that it exists.
    expect(asSalesperson.body['error']).toBe('unauthenticated');
  });

  it('publishes a threshold version, reports whether it relaxes the previous one, and keeps the history', async () => {
    const tightened = await post(
      '/research/policy',
      adminToken,
      command({
        version: 'route-policy.2',
        minimumAssociationConfidence: 0.95,
        note: 'Tightened after a wrong-number call.',
      }),
    );
    expect(tightened.status).toBe(200);
    expect(tightened.body['result']).toMatchObject({ version: 'route-policy.2', relaxesThePrevious: false });

    const relaxed = await post(
      '/research/policy',
      adminToken,
      command({ version: 'route-policy.3', minimumAssociationConfidence: 0.6 }),
    );
    expect(relaxed.status).toBe(200);
    // Reported, never refused: an admin may relax a threshold, and the history says so.
    expect(relaxed.body['result']).toMatchObject({ relaxesThePrevious: true });

    const history = await get('/research/policy', adminToken);
    expect(history.status).toBe(200);
    expect((history.body['history'] as { version: string }[]).map(entry => entry.version)).toEqual([
      'route-policy.3',
      'route-policy.2',
      'route-policy.1',
    ]);
    expect(history.body['active']).toMatchObject({ version: 'route-policy.3' });

    // The same version name is refused rather than editing the row.
    const again = await post(
      '/research/policy',
      adminToken,
      command({ version: 'route-policy.2', minimumAssociationConfidence: 0.1 }),
    );
    expect(again.status).toBe(409);
    expect(again.body['reason']).toBe('policy_version_exists');
  });

  it('refuses a salesperson every configuration command with the domain\'s own code', async () => {
    for (const [path, body] of [
      ['/research/config', command({ enabled: false })],
      ['/research/providers', command({ providerKey: 'places', enabled: false })],
      ['/research/policy', command({ version: 'route-policy.9', minimumAssociationConfidence: 0.9 })],
    ] as const) {
      const answer = await post(path, salespersonToken, body);
      expect(answer.status, path).toBe(409);
      expect(answer.body['reason'], path).toBe('admin_only');
    }
  });

  // --------------------------------------------------------------- the enqueues
  it('enqueues a discovery page in the command transaction and calls no provider', async () => {
    const enqueued = await post(
      '/research/discover',
      adminToken,
      command({ query: 'property management in the fictional county', providerKey: 'places' }),
    );
    expect(enqueued.status).toBe(200);
    expect(enqueued.body['result']).toMatchObject({ kind: 'research.page', inserted: true });

    const jobs = await fixture.db.query<{ kind: string; state: string; idempotency_key: string }>(
      "SELECT kind, state, idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'research.page'",
      [fixture.alpha.workspaceId],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ state: 'queued' });
    expect(jobs.rows[0]?.idempotency_key.startsWith('research:')).toBe(true);

    // Nothing was researched: no page row, no evidence, no firm.
    const pages = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM research_pages WHERE workspace_id = $1',
      [fixture.alpha.workspaceId],
    );
    expect(Number(pages.rows[0]?.count)).toBe(0);
  });

  it('collapses two requests for the same page of the same query into one job', async () => {
    const body = { query: 'the same territory', providerKey: 'places' };
    const first = await post('/research/discover', adminToken, command(body));
    const second = await post('/research/discover', adminToken, command(body));
    expect(first.body['result']).toMatchObject({ inserted: true });
    expect(second.body['result']).toMatchObject({ inserted: false });
    expect((first.body['result'] as { idempotencyKey: string }).idempotencyKey).toBe(
      (second.body['result'] as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('enqueues an enrichment at the firm\'s next revision', async () => {
    const enqueued = await post(
      '/research/enrich',
      adminToken,
      command({ firmId, providerKey: 'company_page', extractionProviderKey: 'page_facts' }),
    );
    expect(enqueued.status).toBe(200);
    expect(enqueued.body['result']).toMatchObject({ kind: 'research.firm', inserted: true });
    expect((enqueued.body['result'] as { idempotencyKey: string }).idempotencyKey).toBe(
      `research-firm:${firmId}:1`,
    );
  });

  it('refuses an enrichment for a firm that does not exist', async () => {
    const answer = await post(
      '/research/enrich',
      adminToken,
      command({ firmId: '00000000-0000-4000-8000-000000000000', providerKey: 'company_page' }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('firm_unknown');
  });

  it('refuses a discovery enqueue by a salesperson', async () => {
    const answer = await post(
      '/research/discover',
      salespersonToken,
      command({ query: 'not mine to spend', providerKey: 'places' }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('admin_only');
  });

  // ------------------------------------------------------------- the review queue
  it('lists the suggestions a person may review and refuses a bad filter', async () => {
    const empty = await get('/research/suggestions', salespersonToken);
    expect(empty.status).toBe(200);
    expect(empty.body['suggestions']).toEqual([]);

    const filtered = await get(
      '/research/suggestions',
      adminToken,
      new URLSearchParams({ state: 'proposed', limit: '10' }),
    );
    expect(filtered.status).toBe(200);

    const bad = await get('/research/suggestions', adminToken, new URLSearchParams({ state: 'sent' }));
    expect([400, 422]).toContain(bad.status);
  });

  it('refuses a review of a suggestion that does not exist', async () => {
    const answer = await post(
      '/research/suggestions/review',
      adminToken,
      command({ suggestionId: '00000000-0000-4000-8000-000000000000', decision: 'accepted' }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('suggestion_unknown');
  });

  it('refuses GET on a command path and POST-only semantics on the reads', async () => {
    expect((await get('/research/discover', adminToken)).status).toBe(405);
    const put = await dispatch(
      {
        method: 'PUT',
        path: '/research/config',
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${adminToken}` },
        body: {},
      },
      options(),
    );
    expect(put.status).toBe(405);
  });
});
