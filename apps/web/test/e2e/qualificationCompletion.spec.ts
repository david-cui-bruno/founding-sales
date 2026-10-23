import type { Page } from 'playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { candidateListSchema, qualificationViewSchema, todayListResponseSchema, pluralFirmPageResponseSchema, type CandidateInput, type QualificationFact } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { saveCandidate } from '@fss/domain/sourcing/candidates.ts';
import { finishQualification } from '@fss/domain/sourcing/qualificationStore.ts';
import { evaluateQualification } from '@fss/domain/sourcing/qualificationDecision.ts';
import { recordStatePosture } from '@fss/domain/policy/postures.ts';
import { POSTURE_STATEMENTS } from '@fss/domain/src/rules/statePosture.ts';
import { test, expect, startQualifiedResearchApp, routeQualifiedResearchProvider, loginQualifiedResearch } from '../support/qualifiedResearchApp.ts';
import { browserRequest } from '../support/browser.ts';
import { QUALIFICATION_PENDING_KEY } from '../../src/client/QualificationPending.ts';

let owned: Awaited<ReturnType<typeof startQualifiedResearchApp>>;
const inventory = (page: Page) => page.getByRole('region', { name: 'Ordinary sourcing inventory', exact: true });
const context = () => repositoryContext(workspaceScope(owned.app.fixture.alpha.workspaceId,
  { kind: 'user', userId: owned.app.fixture.alpha.admin.userId, role: 'admin' }), owned.app.fixture.db);
let candidateId: string, blockedId: string;
const input: CandidateInput = { firmName: 'Controlled Qualification Completion PM', website: 'https://qualification-completion.example.test/', locality: 'Dallas', region: 'TX', signal: 'fit_only', evidence: 'Synthetic retained residential management observation.', sourceUrl: 'https://qualification-completion.example.test/', observedOn: '2026-10-23', preparedBy: 'Controlled local qualification acceptance' };
async function finish(runId: string, candidate: CandidateInput, phone: boolean) {
  const id = randomUUID();
  const blocks = [{ id: 'firm', text: `${candidate.firmName} is a residential property management company in ${candidate.locality}, ${candidate.region}.` },
    ...(phone ? [{ id: 'phone', text: `Contact ${candidate.firmName} at (214) 555-0196.` }] : [])];
  const facts: QualificationFact[] = (['firm_identity', 'residential_management', 'service_area'] as const).map(kind => ({ kind, blockId: 'firm', observationId: id, value: blocks[0]!.text }));
  if (phone) facts.push({ kind: 'business_phone', blockId: 'phone', observationId: id, value: blocks[1]!.text });
  const result = await withTransaction(owned.app.fixture.db, () => finishQualification(context(), { runId, reason: null,
    observations: [{ id, url: candidate.website, contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), retrievedAt: new Date().toISOString(), publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks }], facts }));
  assert(result.ok, result.ok ? '' : result.reason);
  const evaluated = await withTransaction(owned.app.fixture.db, () => evaluateQualification(context(), { runId }));
  assert(evaluated.ok, evaluated.ok ? '' : evaluated.reason);
}
async function load(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/candidates/list'));
  await inventory(page).getByRole('button', { name: 'Load ordinary inventory', exact: true }).click();
  const answer = await response; expect(answer.status()).toBe(200); return candidateListSchema.parse(await answer.json());
}
async function held(page: Page) {
  return await page.evaluate(key => sessionStorage.getItem(key), QUALIFICATION_PENDING_KEY);
}
async function zeroOutbound() {
  for (const table of ['contacts', 'sequence_enrollments', 'outbound_messages']) {
    const rows = await owned.app.fixture.db.query(`SELECT count(*)::int AS count FROM ${table}`);
    expect(rows.rows[0]?.['count']).toBe(0);
  }
}

test.beforeAll(async () => {
  assert.equal(process.env['FSS_QUALIFICATION_COMPLETION_EXCLUSIVE_LANE'], 'local-qualification-completion', 'Root sole disposable PG lane grant required');
  owned = await startQualifiedResearchApp();
  const f = owned.app.fixture;
  await f.db.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,10) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,daily_firm_ceiling=10', [f.alpha.workspaceId]);
  const posture = await withTransaction(f.db, () => recordStatePosture(context(), { state: 'TX', effectiveFrom: new Date(Date.now() - 60_000).toISOString(), confirmedStatements: Object.keys(POSTURE_STATEMENTS) }));
  assert(posture.ok);
  const saved = await withTransaction(f.db, () => saveCandidate(context(), input)); assert(saved.ok); candidateId = saved.value.id;
  const blocked = await withTransaction(f.db, () => saveCandidate(context(), { ...input, firmName: 'Controlled Nonreviewable PM', website: 'https://nonreviewable.example.test/', sourceUrl: 'https://nonreviewable.example.test/', locality: 'Worcester', region: 'MA' })); assert(blocked.ok); blockedId = blocked.value.id;
});
test.afterAll(async () => { try { if (owned) await zeroOutbound(); } finally { await owned?.stop(); } });

test('real browser request and reviewed admission retain exact custody through response loss/reload, while phone/geography unknowns remain blocked', async ({ researchPage: page }) => {
  await routeQualifiedResearchProvider(page, owned.app);
  let requestCommands = 0, admissionCommands = 0, qualificationReads = 0;
  page.on('request', request => {
    if (request.url().endsWith('/browser/api/sourcing/qualification/request')) requestCommands += 1;
    if (request.url().endsWith('/browser/api/sourcing/qualification/admit')) admissionCommands += 1;
    if (request.url().endsWith('/browser/api/sourcing/qualification/read')) qualificationReads += 1;
  });
  await loginQualifiedResearch(page, owned.app);
  expect(qualificationReads).toBe(0); expect(requestCommands).toBe(0);
  expect(owned.app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  await load(page);
  let card = inventory(page).getByRole('article', { name: `Candidate ${candidateId}`, exact: true });
  // Lose only the browser response after the actual HTTPS/API/domain command commits.
  await page.route('**/browser/api/sourcing/qualification/request', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  }, { times: 1 });
  await card.getByRole('button', { name: 'Request qualification', exact: true }).click();
  await expect(card).toContainText('Qualification unavailable or refused.');
  await expect(page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true })).toBeVisible();
  const beforeRequestReload = await held(page); expect(beforeRequestReload).not.toBeNull();
  expect(beforeRequestReload).not.toMatch(/Controlled|residential|https|csrf|evidence/u);
  const retainedRequest = JSON.parse(beforeRequestReload!) as { command: { payload: { commandId: string } } };
  await page.reload(); await expect(page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true })).toBeVisible();
  expect(requestCommands).toBe(1); expect(await held(page)).toBe(beforeRequestReload);
  const replay = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/qualification/request'));
  await page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true }).click();
  const replayResponse = await replay; const queued = await replayResponse.json() as { status: string; replayed: boolean; result: { runId: string } };
  expect(queued.status).toBe('accepted'); expect(queued.replayed).toBe(true);
  expect(replayResponse.request().postDataJSON()).toMatchObject({ commandId: retainedRequest.command.payload.commandId });
  await finish(queued.result.runId, input, true);
  // Completing evidence through existing domain ports is a controlled fixture, never provider/model evidence.
  await load(page); card = inventory(page).getByRole('article', { name: `Candidate ${candidateId}`, exact: true });
  await card.getByRole('button', { name: 'Read qualification', exact: true }).click();
  await expect(card).toContainText('Unknown maintenance_need_unconfirmed');
  const link = card.getByRole('region', { name: 'Candidate qualification', exact: true }).getByRole('link');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer'); await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  await page.route('**/browser/api/sourcing/qualification/admit', async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  }, { times: 1 });
  await card.getByRole('button', { name: 'Admit reviewed qualification', exact: true }).click();
  await expect(card).toContainText('Qualification unavailable or refused.');
  await expect(page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true })).toBeVisible();
  const beforeAdmitReload = await held(page); expect(beforeAdmitReload).not.toMatch(/Controlled|residential|https|csrf|evidence/u);
  await page.reload(); await expect(page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true })).toBeVisible();
  expect(admissionCommands).toBe(1); expect(await held(page)).toBe(beforeAdmitReload);
  const admissionReplay = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/qualification/admit'));
  await page.getByRole('button', { name: 'Reconcile exact qualification command', exact: true }).click();
  const admittedResponse = await admissionReplay; const admitted = await admittedResponse.json() as { replayed: boolean; result: { firmId: string; routeId: string } };
  expect(admitted.replayed).toBe(true);
  const association = (await owned.app.fixture.db.query('SELECT firm_id,route_id FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2', [owned.app.fixture.alpha.workspaceId, candidateId])).rows;
  expect(association).toEqual([{ firm_id: admitted.result.firmId, route_id: admitted.result.routeId }]);
  await expect(inventory(page)).toContainText(`Admitted exact Firm ${admitted.result.firmId}`);
  const todayRead = page.waitForResponse(response => new URL(response.url()).pathname === '/browser/api/today');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  const today = todayListResponseSchema.parse(await (await todayRead).json());
  expect(today.cards.find(card => card.firmId === admitted.result.firmId)?.firmName).toBe(input.firmName);
  const todayCard = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Open firm', exact: true }) }).filter({ hasText: input.firmName });
  const firmRead = page.waitForResponse(response => response.url().endsWith('/browser/api/crm/firm-page-v3'));
  await todayCard.getByRole('button', { name: 'Open firm', exact: true }).click();
  expect(pluralFirmPageResponseSchema.parse(await (await firmRead).json()).read.firm.id).toBe(admitted.result.firmId);
  await expect(page.getByRole('region', { name: 'Firm', exact: true })).toContainText(input.firmName);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await load(page); card = inventory(page).getByRole('article', { name: `Candidate ${candidateId}`, exact: true });
  await card.getByRole('button', { name: 'Read qualification', exact: true }).click();
  await expect(card).toContainText(`Admitted exact Firm ${admitted.result.firmId}`);
  const blocked = inventory(page).getByRole('article', { name: `Candidate ${blockedId}`, exact: true });
  const blockedRequest = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/qualification/request'));
  await blocked.getByRole('button', { name: 'Request qualification', exact: true }).click();
  const blockedQueued = await (await blockedRequest).json() as { result: { runId: string } };
  await finish(blockedQueued.result.runId, { ...input, firmName: 'Controlled Nonreviewable PM', website: 'https://nonreviewable.example.test/', locality: 'Worcester', region: 'MA' }, false);
  await blocked.getByRole('button', { name: 'Read qualification', exact: true }).click();
  await expect(blocked).toContainText('Unknown target_geography_unsupported'); await expect(blocked).toContainText('Unknown business_phone_unresolved');
  await expect(blocked.getByRole('button', { name: 'Admit reviewed qualification', exact: true })).toHaveCount(0);
  const wrongCsrf = await browserRequest(page, '/sourcing/qualification/read', { body: { candidateId }, csrf: 'x'.repeat(40) }); expect(wrongCsrf.status).toBe(403);
  await zeroOutbound(); expect(admissionCommands).toBe(2);
  const current = await browserRequest(page, '/sourcing/qualification/read', { body: { candidateId } }); expect(qualificationViewSchema.parse(current.body).admission?.firmId).toBe(admitted.result.firmId);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); expect(await held(page)).toBeNull();
  expect((await browserRequest(page, '/sourcing/qualification/read', { body: { candidateId } })).status).toBe(401);
  await loginQualifiedResearch(page, owned.app, true);
  expect((await browserRequest(page, '/sourcing/qualification/read', { body: { candidateId } })).status).toBe(200);
  expect((await browserRequest(page, '/sourcing/qualification/read', { body: { candidateId } })).body).toBeNull();
  await zeroOutbound();
});
