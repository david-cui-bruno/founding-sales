import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  researchFirmResponseSchema,
  researchSettingsResultSchema,
  wireDrift,
} from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

/**
 * The four research routes, through the real dispatcher with real sessions.
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`; what is
 * proved here is the wiring, and four pieces of it are this lane's alone:
 *
 *   * the read is the firm page's visibility — a colleague gets `not_found` and not a
 *     redacted answer, because a firm's quotes and what they cost are the shape of
 *     somebody else's work;
 *   * every command has a receipt, and a replay returns the first answer rather than
 *     queueing a second run;
 *   * the settings are admin-only, including the read, because the read *is* the
 *     workspace's budget;
 *   * the answers match the contract exactly, so a field added on this side is a
 *     parse failure here rather than on a laptop.
 */
describe('the research routes', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let adminToken: string;
  let strangerToken: string;
  let firmId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
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
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const worker = () =>
    repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);

  beforeAll(async () => {
    fixture = await createAuthFixture();
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;

    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger-research@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, stranger.rows[0]?.id],
    );
    strangerToken = (
      await issueSessionFor(fixture, fixture.alpha, { googleSub: strangerSub, email: strangerEmail }, {
        deviceLabel: 'Other Mac',
      })
    ).accessToken;

    firmId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings',
      website: 'https://northwind.example.test/',
      regionCode: 'RI',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  beforeEach(async () => {
    await fixture.db.query('DELETE FROM firm_judgments');
    await fixture.db.query('DELETE FROM firm_facts');
    await fixture.db.query('DELETE FROM firm_links');
    await fixture.db.query('DELETE FROM research_runs');
    await fixture.db.query('DELETE FROM research_settings');
    await fixture.db.query('DELETE FROM provider_ledger');
    await fixture.db.query('DELETE FROM daily_counters');
  });

  it('answers the assignee a whole, contract-shaped read for a firm nobody has researched', async () => {
    const answer = await post('/research/firm', assigneeToken, { firmId });
    expect(answer.status).toBe(200);
    expect(wireDrift(researchFirmResponseSchema, answer.body)).toEqual([]);
    expect(answer.body['brief']).toBeNull();
    expect(answer.body['judgments']).toBeNull();
    expect(answer.body['facts']).toEqual([]);
    expect(answer.body['spend']).toEqual({ todayCents: 0, monthToDateCents: 0 });
  });

  it('carries the brief, the facts, the runs and the spend once a run has completed', async () => {
    const run = await fixture.db.query<{ id: string }>(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome, cost_cents, brief)
       VALUES ($1, $2, 1, 'sweep', now(), 'completed', 2,
               '{"questions":["How do you take work orders?","Who handles them?"],"opening":"Hi","generated":true}'::jsonb)
       RETURNING id`,
      [fixture.alpha.workspaceId, firmId],
    );
    const runId = run.rows[0]?.id ?? '';
    const evidence = await fixture.db.query<{ id: string }>(
      `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
       VALUES ($1, $2, 'company_page', 'https://northwind.example.test/', $3) RETURNING id`,
      [fixture.alpha.workspaceId, firmId, 'c'.repeat(64)],
    );
    await fixture.db.query(
      `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
       VALUES ($1, $2, $3, $4, 'target_fit', 'b1', 'We manage property for owners.', now())`,
      [fixture.alpha.workspaceId, firmId, runId, evidence.rows[0]?.id],
    );
    await fixture.db.query(
      `INSERT INTO firm_judgments (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, call_first, reasons)
       VALUES ($1, $2, $3, 'yes', 'unknown', 'unknown', 'yes', true, '{"fit":"its own site says so"}'::jsonb)`,
      [fixture.alpha.workspaceId, firmId, runId],
    );

    const answer = await post('/research/firm', assigneeToken, { firmId });
    expect(answer.status).toBe(200);
    expect(wireDrift(researchFirmResponseSchema, answer.body)).toEqual([]);
    const brief = answer.body['brief'] as Record<string, unknown>;
    expect(brief['generated']).toBe(true);
    expect((brief['whyFit'] as unknown[]).length).toBe(1);
    expect((answer.body['runs'] as Record<string, unknown>[])[0]).toMatchObject({ revision: 1, costCents: 2 });
  });

  it('gives a colleague not_found, exactly as the firm page does', async () => {
    const answer = await post('/research/firm', strangerToken, { firmId });
    expect(answer.status).toBe(404);
    expect((await post('/research/firm/run', strangerToken, command({ firmId }))).status).toBe(409);
    expect((await post('/research/firm/run', strangerToken, command({ firmId }))).body['reason']).toBe('firm_unknown');
  });

  it('refuses without a session, and refuses a method that is not POST', async () => {
    expect((await post('/research/firm', null, { firmId })).status).toBe(401);
    const result = await dispatch(
      { method: 'GET', path: '/research/firm', query: new URLSearchParams(), headers: {}, body: undefined },
      options(),
    );
    expect(result.status).toBe(405);
  });

  it('queues one run under a receipt, and a replay returns the first answer', async () => {
    const body = command({ firmId });
    const first = await post('/research/firm/run', assigneeToken, body);
    expect(first.status).toBe(200);
    expect(first.body['replayed']).toBe(false);
    expect((first.body['result'] as Record<string, unknown>)['revision']).toBe(1);

    const replay = await post('/research/firm/run', assigneeToken, body);
    expect(replay.status).toBe(200);
    expect(replay.body['replayed']).toBe(true);
    expect((replay.body['result'] as Record<string, unknown>)['revision']).toBe(1);

    const { rows } = await fixture.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'research.firm'",
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('answers ceiling_reached when the clearance would refuse now', async () => {
    await post('/research/settings', adminToken, command({ dailyFirmCeiling: 0 }));
    const answer = await post('/research/firm/run', assigneeToken, command({ firmId }));
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('ceiling_reached');

    await post('/research/settings', adminToken, command({ enabled: false, dailyFirmCeiling: 50 }));
    const disabled = await post('/research/firm/run', assigneeToken, command({ firmId }));
    expect(disabled.body['reason']).toBe('research_disabled');
  });

  it('adds an https link and queues the run it triggers, and refuses anything else', async () => {
    const added = await post(
      '/research/firm/links/add',
      assigneeToken,
      command({ firmId, url: 'https://news.example.test/piece' }),
    );
    expect(added.status).toBe(200);
    const result = added.body['result'] as Record<string, unknown>;
    expect((result['link'] as Record<string, unknown>)['url']).toBe('https://news.example.test/piece');
    expect(result['revision']).toBe(1);

    const refused = await post(
      '/research/firm/links/add',
      assigneeToken,
      command({ firmId, url: 'http://news.example.test/piece' }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('link_not_permitted');
  });

  it('keeps the settings admin-only, both the read and the update', async () => {
    const read = await post('/research/settings', adminToken, command({}));
    expect(read.status).toBe(200);
    expect(wireDrift(researchSettingsResultSchema, read.body['result'])).toEqual([]);
    const settings = (read.body['result'] as Record<string, unknown>)['settings'] as Record<string, unknown>;
    expect(settings['enabled']).toBe(true);
    expect(settings['dailyCostCeilingCents']).toBe(50);
    expect((read.body['result'] as Record<string, unknown>)['worstCaseRunCents']).toBe(2);

    const refused = await post('/research/settings', assigneeToken, command({}));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');
  });

  it('refuses a model with no reviewed price, and a page count outside the bounds', async () => {
    expect((await post('/research/settings', adminToken, command({ modelName: 'claude-opus-5' }))).status).toBe(400);
    expect((await post('/research/settings', adminToken, command({ maxPagesPerFirm: 99 }))).status).toBe(400);
  });

  it('refuses a malformed body rather than guessing', async () => {
    expect((await post('/research/firm', assigneeToken, { firmId: 'not-a-uuid' })).status).toBe(400);
    expect((await post('/research/firm', assigneeToken, { firmId, extra: true })).status).toBe(400);
  });

  it('keeps two workspaces apart: beta’s firm is not found from alpha’s session', async () => {
    const betaFirm = await seedFirm(
      fixture,
      { name: 'Beta Holdings', assignedUserId: fixture.beta.salesperson.userId },
      fixture.beta,
    );
    expect((await post('/research/firm', adminToken, { firmId: betaFirm })).status).toBe(404);
    // And the worker's own scope on alpha sees nothing of beta's either.
    const { rows } = await worker().db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM firms WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, betaFirm],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
