import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CandidateInput, QualificationFact } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { runApolloDiscovery } from '@fss/domain/sourcing/apolloDiscovery.ts';
import type { SessionQueryable, QueryResultRowLike } from '@fss/domain/db/queryable.ts';
import { runDiscovery } from '@fss/domain/sourcing/discovery.ts';
import { QUALIFICATION_POLICY_VERSION, QUALIFICATION_PROMPT_VERSION } from '@fss/domain/sourcing/qualificationStore.ts';
import { VERIFIED_FIRM_POLICY_VERSION } from '@fss/domain/sourcing/verifiedFirmPolicy.ts';
import { sourcingQualificationHandler, sourcingQualificationSource } from '../../../worker/src/handlers/sourcingQualification.ts';
import { runSchedulerPass } from '../../../worker/src/scheduler/schedulerPass.ts';
import { runOnce } from '../../../worker/src/runner/jobRunner.ts';
import type { ThinHostApp } from './thinHostApp.ts';
export const supplyEvaluation = { verifiedFirmPolicyVersion: VERIFIED_FIRM_POLICY_VERSION, promptVersion: QUALIFICATION_PROMPT_VERSION, policyVersion: QUALIFICATION_POLICY_VERSION, reportSha256: 'a'.repeat(64), reviewedEligible: 3, falseEligible: 0 };
export function supplyContext(app: ThinHostApp) {
  return repositoryContext(workspaceScope(app.fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), app.fixture.db);
}
export async function configureAutomaticSupply(app: ThinHostApp) {
  const f = app.fixture;
  await f.db.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,100) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,daily_firm_ceiling=100', [f.alpha.workspaceId]);
  await f.db.query('INSERT INTO sourcing_search_account(id) VALUES(true) ON CONFLICT DO NOTHING');
  await f.db.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled,auto_admission_enabled,owner_user_id,qualification_evaluation,query_cursor,searches_per_day) VALUES($1,true,true,$2,$3::jsonb,3,10) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,auto_admission_enabled=true,owner_user_id=$2,qualification_evaluation=$3::jsonb,query_cursor=3,next_run_at=now()', [f.alpha.workspaceId, f.alpha.admin.userId, JSON.stringify(supplyEvaluation)]);
}
export async function supplyPass(app: ThinHostApp) {
  return await runSchedulerPass(app.fixture.db, { sources: [sourcingQualificationSource(true)], now: new Date().toISOString() });
}
/** Controlled search/page/extraction adapters, real registered scheduler and runner.
 * No manual candidate preparation, direct finish, browser mutation or model call.
 */
export async function ingestAutomaticSupply(app: ThinHostApp, suffixes: readonly string[]) {
  assert(suffixes.length > 0 && suffixes.length <= 5);
  await configureAutomaticSupply(app);
  const names = suffixes.map(suffix => `Controlled Supply ${suffix}`);
  const websites = suffixes.map(suffix => `https://supply-${suffix.toLowerCase()}.example.test/`);
  let searches = 0;
  await runDiscovery(supplyContext(app), { providerKey: 'tavily_basic', discover: async () => {
    searches += 1;
    return { ok: true, credits: 1, requestId: `controlled-${suffixes.join('-')}`, hits: names.map((title, i) => ({ title, url: websites[i]!, snippet: 'Residential property management in Arlington Texas' })) };
  } }, { providerKey: 'fixture', fetchPages: async () => ({ ok: false, failureCode: 'fixture_refused', costCents: 0 }) });
  assert.equal(searches, 1);
  const rows = await app.fixture.db.query<{ id: string; revision: number; payload: CandidateInput; attempt_id: string }>('SELECT c.id,c.revision,c.payload,h.attempt_id FROM sourcing_candidates c JOIN sourcing_discovery_hits h ON h.workspace_id=c.workspace_id AND h.candidate_id=c.id WHERE c.workspace_id=$1 AND c.payload->>\'website\'=ANY($2::text[])', [app.fixture.alpha.workspaceId, websites]);
  assert.equal(rows.rows.length, suffixes.length);
  return rows.rows.map(row => ({ candidateId: row.id, candidateRevision: row.revision, name: row.payload.firmName, website: row.payload.website, locality: row.payload.locality, region: row.payload.region, attemptId: row.attempt_id }));
}
export type SupplySeed = Awaited<ReturnType<typeof ingestAutomaticSupply>>[number];
export async function ingestAutomaticApolloSupply(app: ThinHostApp): Promise<SupplySeed> {
  await configureAutomaticSupply(app);
  const f = app.fixture, accountRef = 'controlled-automatic-supply', keyRef = 'controlled-no-provider-key';
  await f.db.query("INSERT INTO sourcing_apollo_allowances(workspace_id,account_ref,key_ref,cycle_start,cycle_end,verified_at,exclusive_attested_at,starting_used,enabled) VALUES($1,$2,$3,clock_timestamp()-interval '1 day',clock_timestamp()+interval '20 days',clock_timestamp(),clock_timestamp(),0,true)", [f.alpha.workspaceId, accountRef, keyRef]);
  let calls = 0;
  const deps = { accountRef, keyRef, provider: { providerKey: 'apollo_free' as const, discoverOrganizations: async () => {
    calls += 1;
    return { ok: true as const, requestId: 'controlled-apollo', returnedCount: 1, organizations: [{ name: 'Controlled Apollo Supply', domain: 'automatic-apollo.example.test', hqCity: 'Arlington', hqState: 'TX' as const, employeeCount: 3 }] };
  } } };
  await runApolloDiscovery(supplyContext(app), deps);
  assert.equal(calls, 1);
  const row = (await f.db.query<{ id: string; revision: number; payload: CandidateInput; attempt_id: string }>('SELECT c.id,c.revision,c.payload,o.attempt_id FROM sourcing_candidates c JOIN sourcing_apollo_candidate_origins o ON o.workspace_id=c.workspace_id AND o.candidate_id=c.id WHERE c.workspace_id=$1 AND o.domain=$2', [f.alpha.workspaceId, 'automatic-apollo.example.test'])).rows[0];
  assert(row);
  return { candidateId: row.id, candidateRevision: row.revision, name: row.payload.firmName, website: row.payload.website, locality: row.payload.locality, region: row.payload.region, attemptId: row.attempt_id };
}
export async function completeAutomaticSupply(app: ThinHostApp, options: { ambiguous?: string; afterExtraction?: () => Promise<void>; loseCompletion?: boolean } = {}) {
  let fetches = 0, extractions = 0;
  const registry = new HandlerRegistry().register(sourcingQualificationHandler({
    pageFetch: { providerKey: 'company_page', fetchPages: async request => {
      fetches += 1;
      assert.equal(await request.shouldContinue?.(), true);
      const row = (await app.fixture.db.query<{ payload: CandidateInput }>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND payload->>\'website\'=$2', [app.fixture.alpha.workspaceId, request.firmWebsite])).rows[0]!;
      const c = row.payload;
      const body = `<p>${c.firmName} provides residential property management in ${c.locality}, ${c.region}.</p>`;
      const emailBody = `<p>${c.firmName} ${c.locality} ${c.region} office info@${new URL(c.website).hostname}</p>${c.firmName === options.ambiguous ? '<p>Competing Residential Management LLC</p>' : ''}`;
      return { ok: true, costCents: 0, value: { pages: [body, emailBody].map((text, i) => ({ url: i === 0 ? c.website : `${c.website}contact`, contentHash: createHash('sha256').update(text).digest('hex'), contentType: 'text/html', body: new TextEncoder().encode(text), retrievedAt: new Date().toISOString(), firstParty: true })), skipped: {} } };
    } },
    extraction: { providerKey: 'aws_bedrock.sourcing_qualification', countInputTokens: async () => 300, extract: async input => {
      extractions += 1;
      const native = input.observations[0]!, email = input.observations[1]!;
      const facts: QualificationFact[] = (['firm_identity', 'service_area', 'residential_management'] as const).map(kind => ({ kind, value: native.blocks[0]!.text, observationId: native.id, blockId: native.blocks[0]!.id }));
      facts.push({ kind: 'business_email', value: email.blocks[0]!.text, observationId: email.id, blockId: email.blocks[0]!.id });
      if (input.candidate.firmName === options.ambiguous) facts.push({ kind: 'firm_identity', value: email.blocks[1]!.text, observationId: email.id, blockId: email.blocks[1]!.id });
      await options.afterExtraction?.();
      return { ok: true, costCents: 1, value: { facts, openingQuestion: null } };
    } },
  }));
  const scheduled = await supplyPass(app);
  assert.equal(scheduled.outcome, 'ran');
  let completionLost = false;
  const runnerSession: SessionQueryable = { query: async <Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) => {
    // Fault only the runner's acknowledgement AFTER the unchanged registered
    // handler has committed extraction/evaluation/publication or refusal.
    if (options.loseCompletion && !completionLost && /^UPDATE jobs\s+SET state = 'done'/u.test(sql)) {
      completionLost = true;
      throw new Error('controlled_completion_acknowledgement_lost');
    }
    return await app.fixture.db.query<Row>(sql, values);
  } };
  const run = () => runOnce(runnerSession, { registry, owner: 'automatic-supply-local-acceptance', limit: 25 });
  let result: Awaited<ReturnType<typeof runOnce>> | null = null;
  if (options.loseCompletion) await assert.rejects(run, /controlled_completion_acknowledgement_lost/u);
  else { result = await run(); assert.equal(result.failed, 0); }
  return { scheduled, result, completionLost, calls: () => ({ fetches, extractions }), registry, recover: async () => {
    await app.fixture.db.query('UPDATE sourcing_qualification_runs SET admission_checked_at=NULL WHERE workspace_id=$1', [app.fixture.alpha.workspaceId]);
    return await supplyPass(app);
  } };
}
