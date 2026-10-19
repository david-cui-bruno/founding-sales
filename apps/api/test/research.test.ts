import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  researchFirmResponseSchema,
  researchSettingsResultSchema,
  wireDrift,
} from '@fss/contracts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import {runFirmResearch} from '@fss/domain/research/enrichment.ts';
import {officeProviders} from '@fss/domain/test/support/officeProviders.ts';
import {databaseNow} from '@fss/domain/policy/clock.ts';

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
    session: SessionQueryable = fixture.db,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, {...options(), session, auth: {...fixture.deps, db: session}});
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
    vi.stubEnv('FSS_MODEL_TRANSPORT', 'anthropic');
    await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.salesperson.userId]);
    await fixture.db.query('DELETE FROM firm_judgments');
    await fixture.db.query('DELETE FROM firm_facts');
    await fixture.db.query('DELETE FROM firm_links');
    await fixture.db.query('DELETE FROM research_runs');
    await fixture.db.query('DELETE FROM research_settings');
    await fixture.db.query('DELETE FROM provider_ledger');
    await fixture.db.query('DELETE FROM daily_counters');
    await fixture.db.query("DELETE FROM jobs WHERE kind='research.firm'");
    await fixture.db.query('DELETE FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2',[fixture.alpha.workspaceId,firmId]);
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(['brief', 'office_evidence'] as const)('refuses a former assignee after the %s public command waits for reassignment', async purpose => {
    const administrator = await fixture.database.appRuntimeSession();
    const requester = await fixture.database.appRuntimeSession();
    const adminPid = (await administrator.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const requestPid = (await requester.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await administrator.query('BEGIN');
    await administrator.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.admin.userId]);
    const request = post('/research/firm/run', assigneeToken, command({firmId, purpose}), requester);
    try {
      // The public visibility check sees A's old committed assignment. Observe the
      // subsequent enqueue row-lock wait behind B's uncommitted assignment.
      await expect.poll(async () => (await fixture.db.query<{blocked: boolean}>(
        'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [requestPid, adminPid],
      )).rows[0]?.blocked, {timeout: 2000}).toBe(true);
    } finally {
      await administrator.query('COMMIT');
    }
    expect(await request).toMatchObject({status: 409, body: {reason: 'not_assigned'}});
    for (const table of ['jobs', 'research_runs', 'provider_reservations']) {
      expect((await fixture.db.query<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [fixture.alpha.workspaceId])).rows[0]?.n).toBe(0);
    }
  });

  it.each(['brief', 'office_evidence'] as const)('keeps assigned-user and admin %s enqueue authority', async purpose => {
    expect(await post('/research/firm/run', assigneeToken, command({firmId, purpose})))
      .toMatchObject({status: 200, body: {result: {purpose, queued: true}}});
    // An administrator retains authority over a firm assigned to somebody else,
    // including reuse of the existing pending job after the locked decision.
    expect(await post('/research/firm/run', adminToken, command({firmId, purpose})))
      .toMatchObject({status: 200, body: {result: {purpose, queued: false}}});
  });

  it('queues strict purpose explicitly with replay protection and a separate pending reader',async()=>{
    const body=command({firmId,purpose:'office_evidence'});
    const first=await post('/research/firm/run',assigneeToken,body);
    expect(first).toMatchObject({status:200,body:{replayed:false,result:{purpose:'office_evidence',revision:1}}});
    expect(await post('/research/firm/run',assigneeToken,body)).toMatchObject({status:200,body:{replayed:true,result:{purpose:'office_evidence',revision:1}}});
    expect((await post('/research/firm/run',assigneeToken,{...body,purpose:'brief'})).status).toBe(409);
    const read=await post('/research/firm',assigneeToken,{firmId});
    expect(read.body['officeAssessment']).toMatchObject({status:'pending',reason:'queued'});expect(read.body['runs']).toEqual([]);expect(read.body['brief']).toBeNull();
    const ordinary=await post('/research/firm/run',assigneeToken,command({firmId}));
    expect(ordinary).toMatchObject({status:200,body:{result:{purpose:'brief',revision:2}}});
    expect((await fixture.db.query("SELECT payload->>'purpose' purpose FROM jobs WHERE kind='research.firm' ORDER BY created_at,id")).rows.map(r=>r['purpose']).sort()).toEqual(['office_evidence',null].sort());
  });

  it('does not let a completed strict run replace or delay the ordinary brief view',async()=>{
    await fixture.db.query(`INSERT INTO research_runs(workspace_id,firm_id,revision,trigger,outcome,completed_at) VALUES($1,$2,1,'sweep','completed',now())`,[fixture.alpha.workspaceId,firmId]);
    await fixture.db.query(`INSERT INTO research_runs(workspace_id,firm_id,revision,trigger,requested_by_user_id,purpose,outcome,completed_at) VALUES($1,$2,2,'user_request',$3,'office_evidence','completed',now())`,[fixture.alpha.workspaceId,firmId,fixture.alpha.salesperson.userId]);
    const read=await post('/research/firm',assigneeToken,{firmId});
    expect((read.body['runs'] as {revision:number}[]).map(r=>r.revision)).toEqual([1]);expect(read.body['officeAssessment']).toMatchObject({status:'stale'});
  });

  it('reads rebuilt strict support independently and invalidates it after actual source deletion',async()=>{
    await fixture.db.query("UPDATE firms SET locality='Providence' WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,firmId]);
    await fixture.db.query(`INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550187','research_provider',now(),1,'passed','usable','test')`,[fixture.alpha.workspaceId,firmId]);
    const providers=officeProviders();expect((await runFirmResearch(worker(),{firmId,revision:1,trigger:'user_request',requestedByUserId:fixture.alpha.salesperson.userId,purpose:'office_evidence',at:await databaseNow(worker()),...providers})).ok).toBe(true);
    const read=await post('/research/firm',assigneeToken,{firmId});expect(read.body['officeAssessment']).toMatchObject({status:'supported',sourceCount:1});expect(read.body['runs']).toEqual([]);expect(read.body['brief']).toBeNull();expect(providers.stats().calls).toBe(1);
    await fixture.db.query('DELETE FROM evidence_items WHERE workspace_id=$1 AND firm_id=$2',[fixture.alpha.workspaceId,firmId]);
    expect((await post('/research/firm',assigneeToken,{firmId})).body['officeAssessment']).toMatchObject({status:'stale',reason:'source_lost'});
    expect((await fixture.db.query('SELECT count(*)::int n FROM firm_office_assessment_sources WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows).toEqual([{n:0}]);
  });

  it.each([undefined, 'unknown'])('refuses preview when the explicit worker transport is %s', async transport => {
    vi.stubEnv('FSS_MODEL_TRANSPORT', transport);
    const answer = await post('/research/firm/run', assigneeToken, command({ firmId }));
    expect(answer).toMatchObject({ status: 409, body: { reason: 'research_transport_unavailable' } });
    const settings = await post('/research/settings', adminToken, command({}));
    expect(settings).toMatchObject({ status: 409, body: { reason: 'research_transport_unavailable' } });
  });

  it('prices a Bedrock preview from credit-inclusive spend, independent of cash headroom', async () => {
    vi.stubEnv('FSS_MODEL_TRANSPORT', 'bedrock');
    await fixture.db.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
      VALUES($1,'monthly_cash_ceiling_cents',1,'{"cents":0}',$2)`, [fixture.alpha.workspaceId, fixture.alpha.admin.userId]);
    expect((await post('/research/firm/run', assigneeToken, command({ firmId }))).status).toBe(200);
    await fixture.db.query(`INSERT INTO provider_ledger(workspace_id,provider_key,business_date,business_time_zone,cost_cents)
      SELECT id,'aws_bedrock.extraction',(now() AT TIME ZONE business_time_zone)::date,business_time_zone,50
        FROM workspaces WHERE id=$1`, [fixture.alpha.workspaceId]);
    expect(await post('/research/firm/run', assigneeToken, command({ firmId }))).toMatchObject({ status: 409, body: { reason: 'ceiling_reached' } });
    const settings = await post('/research/settings', adminToken, command({}));
    expect((settings.body['result'] as { spend: { todayCents: number } }).spend.todayCents).toBe(50);
    await fixture.db.query("DELETE FROM workspace_settings WHERE setting_key='monthly_cash_ceiling_cents'");
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
    expect(brief['generated']).toBe(false);
    expect(brief['questions']).toBeNull();
    expect(brief['opening']).toBeNull();
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
    // Three cents at the defaults: four pages, twelve thousand characters each, priced
    // at 2.5 characters to a token with two thousand tokens of prompt overhead.
    expect((read.body['result'] as Record<string, unknown>)['worstCaseRunCents']).toBe(3);

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
