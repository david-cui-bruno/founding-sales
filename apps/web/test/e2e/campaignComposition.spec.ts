import { createHash, randomUUID } from 'node:crypto';
import { todayActionsV4ResponseSchema, todayActionOpenV4ResponseSchema, type EmailCampaignAdmission } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import { test, expect, routeAutomaticSupplyProvider, loginAutomaticSupply } from '../support/automaticSupplyApp.ts';
import { startThinHostApp } from '../support/thinHostApp.ts';
import { reserveCompositionLane, compositionStorageAbsent } from '../support/campaignCompositionResources.ts';
import { ingestAutomaticSupply, completeAutomaticSupply, supplyContext, supplyEvaluation } from '../support/automaticSupplySeed.ts';
import { seedEmailCampaign, seedCampaignResearch } from '../support/emailCampaignSeed.ts';
import { deleteCampaignSubject } from '../support/emailCampaignReview.ts';
import { suppressCampaignAddress, confirmCampaignReply } from '../support/emailCampaignStops.ts';
import { browserRequest } from '../support/browser.ts';
import { checkCompositionProvenance } from '../support/campaignCompositionProvenance.ts';
import { approveComposition, approveCompositionInUi, compositionControl, compositionOff, campaignCompositionBase } from '../support/campaignCompositionApp.ts';
let owned: { app: Awaited<ReturnType<typeof startThinHostApp>> };
let release: () => Promise<void>;
test.beforeAll(async () => { release = await reserveCompositionLane(); });
test.afterAll(async () => { await release?.(); if (owned) await compositionStorageAbsent(owned.app.storagePath, owned.app.postgresPid); });
test.afterEach(async ({ supplyPage: page }) => {
  await page.context().close();
  if (owned) { try { await compositionOff(owned.app); } finally { await owned.app.stop(); } }
});

test('lost completion and concurrent registered recovery never redispatch providers or duplicate composition', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const { policy } = await seedEmailCampaign(app);
  await approveComposition(page, policy);
  await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='admin'", [f.alpha.workspaceId, f.alpha.outsider.userId]);
  const [seed] = await ingestAutomaticSupply(app, ['CompositionRecovery']);
  const completed = await completeAutomaticSupply(app, { loseCompletion: true, afterExtraction: async () => {
    await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
  } });
  expect(completed.completionLost).toBe(true);
  expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE candidate_id=$1', [seed!.candidateId])).rows).toEqual([]);
  await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
  await completed.recover();
  const other = await f.database.appRuntimeSession();
  const { runSchedulerPass } = await import('../../../worker/src/scheduler/schedulerPass.ts');
  const { sourcingQualificationSource } = await import('../../../worker/src/handlers/sourcingQualification.ts');
  await Promise.all([completed.recover(), runSchedulerPass(other, { sources: [sourcingQualificationSource(true)], now: new Date().toISOString() })]);
  await completed.recover();
  const admissions = (await compositionControl(page)).admissions.filter(row => row.candidateId === seed!.candidateId);
  expect(admissions).toHaveLength(1);
  await exactAdmission(admissions[0]!);
  expect((await f.db.query('SELECT 1 FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [seed!.candidateId])).rows).toHaveLength(1);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
});

test('ambiguous evidence, raw discovery and unsupported geography never become campaign recipients', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  await approveComposition(page, (await seedEmailCampaign(app)).policy);
  const seeds = await ingestAutomaticSupply(app, ['CompositionAmbiguous', 'CompositionRaw', 'CompositionGeography']);
  const raw = seeds.find(row => row.name.endsWith('Raw'))!, geography = seeds.find(row => row.name.endsWith('Geography'))!;
  await f.db.query("UPDATE sourcing_candidates SET payload='{\"kind\":\"discovery-v1\"}'::jsonb WHERE id=$1", [raw.candidateId]);
  await f.db.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{region}','\"CA\"'::jsonb) WHERE id=$1", [geography.candidateId]);
  await completeAutomaticSupply(app, { ambiguous: seeds.find(row => row.name.endsWith('Ambiguous'))!.name });
  for (const seed of seeds) {
    expect((await f.db.query('SELECT 1 FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [seed.candidateId])).rows).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE candidate_id=$1', [seed.candidateId])).rows).toEqual([]);
  }
  expect((await f.db.query('SELECT 1 FROM sourcing_qualification_runs WHERE candidate_id=$1', [raw.candidateId])).rows).toEqual([]);
});

test('unknown admission write error rolls back partial recipient work and registered recovery reuses committed evidence', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  await approveComposition(page, (await seedEmailCampaign(app)).policy);
  const [seed] = await ingestAutomaticSupply(app, ['CompositionUnknown']);
  const recipientState = async () => {
    const counts: Record<string, unknown> = {};
    for (const table of ['contacts', 'email_addresses', 'outreach_plans', 'sequence_enrollments', 'step_executions', 'outreach_email_campaign_admissions']) counts[table] = (await f.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows;
    return counts;
  };
  const before = await recipientState();
  await f.db.query("CREATE FUNCTION composition_unknown() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled_composition_unknown'; END; $$");
  await f.db.query('CREATE TRIGGER composition_unknown BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION composition_unknown()');
  try {
    await expect(completeAutomaticSupply(app)).rejects.toThrow();
    expect((await f.db.query<{ error_detail: string }>("SELECT error_detail FROM jobs WHERE kind='sourcing.qualify' AND payload->>'candidateId'=$1", [seed!.candidateId])).rows[0]?.error_detail).toContain('controlled_composition_unknown');
    expect(await recipientState()).toEqual(before);
    for (const table of ['outreach_email_sources', 'outreach_plans', 'outreach_email_campaign_admissions']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE candidate_id=$1`, [seed!.candidateId])).rows, table).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM contacts WHERE workspace_id=$1 AND firm_id IN (SELECT firm_id FROM sourcing_automatic_research_firms WHERE candidate_id=$2)', [f.alpha.workspaceId, seed!.candidateId])).rows).toEqual([]);
  } finally {
    await f.db.query('DROP TRIGGER composition_unknown ON outreach_email_campaign_admissions');
    await f.db.query('DROP FUNCTION composition_unknown()');
  }
  const { supplyPass } = await import('../support/automaticSupplySeed.ts');
  await f.db.query('UPDATE sourcing_qualification_runs SET admission_checked_at=NULL WHERE candidate_id=$1', [seed!.candidateId]);
  await supplyPass(app);
  const admissions = (await compositionControl(page)).admissions.filter(row => row.candidateId === seed!.candidateId);
  expect(admissions).toHaveLength(1);
  await exactAdmission(admissions[0]!);
  expect((await f.db.query('SELECT count(*)::int AS count FROM provider_reservations WHERE subject_id=$1', [admissions[0]!.qualificationRunId])).rows).toEqual([{ count: 1 }]);
});

test('bounded union backlog preserves discovery semantics and shared daily caps survive ordinary source/contact deletion and replacement approval', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const legacy = await seedCampaignResearch(app, 'CompositionLegacy');
  const created = await browserRequest(page, '/sourcing/research-firms/create', { body: { ...legacy.selection, commandId: randomUUID() } });
  expect(created.status).toBe(200);
  const [seed] = await ingestAutomaticSupply(app, ['CompositionBacklog']);
  const completed = await completeAutomaticSupply(app);
  expect((await compositionControl(page)).admissions).toEqual([]);
  const { policy } = await seedEmailCampaign(app, { maxEnrollments: 2, dailyAdmissionLimit: 5 });
  const first = await approveComposition(page, policy);
  let admissions = (await compositionControl(page)).admissions;
  expect(admissions).toHaveLength(2);
  expect(admissions.map(row => row.candidateId).sort()).toEqual([legacy.selection.candidateId, seed!.candidateId].sort());
  const automatic = admissions.find(row => row.candidateId === seed!.candidateId)!;
  await exactAdmission(automatic);
  expect((await f.db.query('SELECT source_kind,publication_id FROM outreach_email_campaign_admissions WHERE candidate_id=$1', [legacy.selection.candidateId])).rows).toEqual([{ source_kind: 'discovery_research', publication_id: null }]);
  const extras = await ingestAutomaticSupply(app, ['CompositionCapA', 'CompositionCapB', 'CompositionCapC']);
  await completeAutomaticSupply(app);
  expect((await compositionControl(page)).admissions).toHaveLength(2);
  await browserRequest(page, `${campaignCompositionBase}/revoke`, { body: { id: first.campaignId, expectedRevision: first.revision, commandId: randomUUID() } });
  await approveComposition(page, { ...policy, maxEnrollments: 25 });
  admissions = (await compositionControl(page)).admissions;
  expect(admissions).toHaveLength(5);
  for (const extra of extras) expect(admissions.some(row => row.candidateId === extra.candidateId)).toBe(true);
  await f.db.query('DELETE FROM sourcing_discovery_hits WHERE candidate_id=$1', [seed!.candidateId]);
  await deleteCampaignSubject(app, automatic, 'contact');
  await completed.recover();
  expect((await compositionControl(page)).admissions).toHaveLength(5);
  const [late] = await ingestAutomaticSupply(app, ['CompositionAfterDeletion']);
  await completeAutomaticSupply(app);
  expect((await compositionControl(page)).admissions.some(row => row.candidateId === late!.candidateId)).toBe(false);
  expect((await f.db.query('SELECT 1 FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [late!.candidateId])).rows).toHaveLength(1);
  expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE firm_id=$1', [automatic.firmId])).rows).toHaveLength(1);
});
test.beforeEach(async ({ supplyPage: page }) => {
  owned = { app: await startThinHostApp() };
  console.log('COMPOSITION_HTTPS', owned.app.origin);
  await routeAutomaticSupplyProvider(page, owned.app);
  await loginAutomaticSupply(page, owned.app);
  for (const row of (await compositionControl(page)).campaigns.filter(row => row.revokedAt === null)) {
    expect((await browserRequest(page, `${campaignCompositionBase}/revoke`, { body: { id: row.id, expectedRevision: row.revision, commandId: randomUUID() } })).status).toBe(200);
  }
});
async function exactAdmission(admission: EmailCampaignAdmission) {
  const f = owned.app.fixture;
  for (const [table, id] of [['contacts', admission.contactId], ['email_addresses', admission.routeId], ['outreach_plans', admission.planId], ['sequence_enrollments', admission.enrollmentId]]) {
    expect((await f.db.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, admission.firmId])).rows, table).toEqual([{ id }]);
  }
  expect((await f.db.query('SELECT 1 FROM step_executions WHERE enrollment_id=$1', [admission.enrollmentId])).rows).toHaveLength(1);
  expect((await f.db.query('SELECT reviewed FROM outreach_email_sources WHERE candidate_id=$1', [admission.candidateId])).rows).toEqual([{ reviewed: false }]);
  expect((await f.db.query('SELECT 1 FROM sourcing_discovery_promotions WHERE legacy_candidate_id=$1', [admission.candidateId])).rows).toEqual([]);
}

test('approved campaign then actual registered source completion composes exact canonical Today and one reviewed:false enrollment, reload is read-only', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const { policy } = await seedEmailCampaign(app);
  const approval = await approveCompositionInUi(page, policy);
  const exchange = f.google.tokenExchanges().at(-1)!;
  expect(exchange.clientSecretPresented).toBe(true);
  expect(f.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = (await f.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1')).rows[0]!;
  expect(createHash('sha256').update(exchange.codeVerifier ?? '').digest('base64url')).toBe(oidc.code_challenge);
  const [seed] = await ingestAutomaticSupply(app, ['CompositionReady']);
  const completed = await completeAutomaticSupply(app);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  const admission = (await compositionControl(page)).admissions.find(row => row.candidateId === seed!.candidateId)!;
  expect(admission).toMatchObject({ campaignId: approval.campaignId });
  await exactAdmission(admission);
  await checkCompositionProvenance(app, admission);
  const publication = (await f.db.query('SELECT * FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [seed!.candidateId])).rows;
  expect(publication).toHaveLength(1);
  expect(publication[0]).toMatchObject({ firm_id: admission.firmId, run_id: admission.qualificationRunId, owner_user_id: f.alpha.admin.userId });
  const actions = todayActionsV4ResponseSchema.parse((await browserRequest(page, '/today/actions/v4')).body);
  const action = actions.actions.find(row => row.target.kind === 'automatic_research' && row.target.candidateId === seed!.candidateId)!;
  expect(action).toBeDefined();
  const proof = todayActionOpenV4ResponseSchema.parse((await browserRequest(page, '/today/actions/open/v4', { body: { actionId: action.actionId, target: action.target } })).body).automaticResearch!;
  expect(proof.target.firmId).toBe(admission.firmId);
  expect(proof.source.attemptId).toBe(seed!.attemptId);
  const baseline = await compositionControl(page);
  await page.reload();
  await page.getByRole('article').filter({ hasText: seed!.name }).getByRole('button', { name: 'Review current research', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Current automatic research proof', exact: true })).toBeVisible();
  expect((await compositionControl(page)).admissions).toEqual(baseline.admissions);
  await exactAdmission(admission);
  await confirmCampaignReply(app, policy.mailboxId, `info@${new URL(seed!.website).hostname}`, admission, 'not_interested');
  await completed.recover();
  expect((await compositionControl(page)).admissions.filter(row => row.firmId === admission.firmId)).toHaveLength(1);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  await compositionOff(app);
});

test('representative current authority and proof refusal table keeps valid publication but creates no recipient work', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const prepared = await seedEmailCampaign(app);
  const cases = ['automaticApproval', 'owner', 'researchHold', 'enrollmentHold', 'mailbox', 'stop', 'source', 'emailExpiry', 'nativeExpiry', 'campaignExpiry'] as const;
  for (const name of cases) await test.step(name, async () => {
    const [seed] = await ingestAutomaticSupply(app, [`Refuse${name}`]);
    await completeAutomaticSupply(app);
    const policy = { ...prepared.policy };
    policy.authorizationRevision = (await f.db.query<{ revision: number }>('SELECT revision FROM gmail_prospecting_authorizations WHERE mailbox_id=$1', [policy.mailboxId])).rows[0]!.revision;
    let restore = async () => {};
    if (name === 'automaticApproval') {
      await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
      restore = async () => { await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true,qualification_evaluation=$2::jsonb WHERE workspace_id=$1', [f.alpha.workspaceId, JSON.stringify(supplyEvaluation)]); };
    }
    if (name === 'owner') {
      await f.db.query('UPDATE sourcing_discovery_settings SET owner_user_id=$2 WHERE workspace_id=$1', [f.alpha.workspaceId, f.alpha.salesperson.userId]);
      restore = async () => { await f.db.query('UPDATE sourcing_discovery_settings SET owner_user_id=$2 WHERE workspace_id=$1', [f.alpha.workspaceId, f.alpha.admin.userId]); };
    }
    if (name === 'researchHold' || name === 'enrollmentHold') {
      const action = name === 'researchHold' ? 'research' : 'enrollment_advance';
      const hold = await withTransaction(f.db, () => openHold(supplyContext(app), { scopeKind: 'workspace', scopeKey: f.alpha.workspaceId, reasonCode: 'scoped_pause', blockedActionKinds: [action], sourceEventKind: 'composition_acceptance' }));
      restore = async () => { await withTransaction(f.db, () => releaseHold(supplyContext(app), hold)); };
    }
    if (name === 'mailbox') await f.db.query('UPDATE gmail_prospecting_authorizations SET revision=revision+1 WHERE mailbox_id=$1', [policy.mailboxId]);
    if (name === 'stop') await suppressCampaignAddress(app, `info@${new URL(seed!.website).hostname}`);
    if (name === 'source') await f.db.query('DELETE FROM sourcing_discovery_hits WHERE candidate_id=$1', [seed!.candidateId]);
    if (name === 'emailExpiry' || name === 'nativeExpiry') await f.db.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,ARRAY[$2::text,'retrievedAt'],to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE candidate_id=$1", [seed!.candidateId, name === 'nativeExpiry' ? 0 : 1]);
    if (name === 'campaignExpiry') policy.expiresAt = new Date(Date.now() - 1000).toISOString();
    try {
      if (name === 'campaignExpiry' || name === 'mailbox') {
        const response = await browserRequest(page, `${campaignCompositionBase}/approve`, { body: { ...policy, commandId: randomUUID() } });
        expect(JSON.stringify(response.body)).not.toContain('"status":"approved"');
      } else await approveComposition(page, policy);
      expect((await compositionControl(page)).admissions.some(row => row.candidateId === seed!.candidateId), name).toBe(false);
      expect((await f.db.query('SELECT 1 FROM outreach_email_sources WHERE candidate_id=$1', [seed!.candidateId])).rows, name).toEqual([]);
    } finally {
      await f.db.query('DELETE FROM sourcing_discovery_hits WHERE candidate_id=$1', [seed!.candidateId]);
      await restore();
      for (const row of (await compositionControl(page)).campaigns.filter(row => row.revokedAt === null)) await browserRequest(page, `${campaignCompositionBase}/revoke`, { body: { id: row.id, expectedRevision: row.revision, commandId: randomUUID() } });
    }
  });
});

test('campaign expiry, revocation and mailbox revision during extraction conserve publication without admitting recipients', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const prepared = await seedEmailCampaign(app);
  for (const name of ['expiry', 'revocation', 'mailboxRevision'] as const) await test.step(name, async () => {
    const policy = { ...prepared.policy, ...(name === 'expiry' ? { expiresAt: new Date(Date.now() + 2500).toISOString() } : {}) };
    const approved = await approveComposition(page, policy);
    const [seed] = await ingestAutomaticSupply(app, [`During${name}`]);
    await completeAutomaticSupply(app, { afterExtraction: async () => {
      if (name === 'expiry') await f.db.query('SELECT pg_sleep(2.6)');
      if (name === 'revocation') expect((await browserRequest(page, `${campaignCompositionBase}/revoke`, { body: { id: approved.campaignId, expectedRevision: approved.revision, commandId: randomUUID() } })).status).toBe(200);
      if (name === 'mailboxRevision') await f.db.query('UPDATE gmail_prospecting_authorizations SET revision=revision+1 WHERE mailbox_id=$1', [policy.mailboxId]);
    } });
    expect((await f.db.query('SELECT 1 FROM sourcing_automatic_research_firms WHERE candidate_id=$1', [seed!.candidateId])).rows).toHaveLength(1);
    expect((await compositionControl(page)).admissions.some(row => row.candidateId === seed!.candidateId)).toBe(false);
    await f.db.query('DELETE FROM sourcing_discovery_hits WHERE candidate_id=$1', [seed!.candidateId]);
    for (const row of (await compositionControl(page)).campaigns.filter(row => row.revokedAt === null)) await browserRequest(page, `${campaignCompositionBase}/revoke`, { body: { id: row.id, expectedRevision: row.revision, commandId: randomUUID() } });
  });
});
