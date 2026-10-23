import type { Page } from 'playwright/test';
import { todayActionsV4ResponseSchema, todayActionOpenV4ResponseSchema, type TodayActionV4 } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { openHold, releaseHold, type OpenHoldInput } from '@fss/domain/policy/holds.ts';
import { lockSendGateForStopFact } from '@fss/domain/policy/sendGate.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { browserRequest } from '../support/browser.ts';
import { test, expect, startAutomaticSupplyApp, routeAutomaticSupplyProvider, loginAutomaticSupply } from '../support/automaticSupplyApp.ts';
import { ingestAutomaticSupply, completeAutomaticSupply, supplyContext, type SupplySeed } from '../support/automaticSupplySeed.ts';

let owned: Awaited<ReturnType<typeof startAutomaticSupplyApp>>;
test.beforeAll(async () => { owned = await startAutomaticSupplyApp(); });
test.afterAll(async () => {
  if (!owned) return;
  try { expect((await owned.app.fixture.db.query('SELECT 1 FROM outbound_messages')).rows).toEqual([]); }
  finally { await owned.stop(); }
});
test.beforeEach(async ({ supplyPage }) => { await routeAutomaticSupplyProvider(supplyPage, owned.app); });
const publicationRows = async (seed: SupplySeed) => (await owned.app.fixture.db.query('SELECT id,firm_id,revision,evidence_fingerprint FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2', [owned.app.fixture.alpha.workspaceId, seed.candidateId])).rows;
async function actions(page: Page) {
  const response = await browserRequest(page, '/today/actions/v4');
  expect(response.status).toBe(200);
  return todayActionsV4ResponseSchema.parse(response.body).actions;
}
async function actionFor(page: Page, seed: SupplySeed) {
  const action = (await actions(page)).find(row => row.target.kind === 'automatic_research' && row.target.candidateId === seed.candidateId);
  expect(action, seed.name).toBeDefined();
  return action!;
}
async function open(page: Page, action: TodayActionV4) {
  const response = await browserRequest(page, '/today/actions/open/v4', { body: { actionId: action.actionId, target: action.target } });
  expect(response.status).toBe(200);
  return todayActionOpenV4ResponseSchema.parse(response.body);
}
async function refused(page: Page, action: TodayActionV4) {
  expect(await open(page, action)).toEqual({ version: 4, target: null, research: null, automaticResearch: null });
  expect((await actions(page)).some(row => row.actionId === action.actionId)).toBe(false);
}
const researchHold = (scopeKind: 'owner' | 'firm', scopeKey: string): OpenHoldInput => ({ scopeKind, scopeKey, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'automatic_supply_p1_test' });
async function hold(input: OpenHoldInput) { return await withTransaction(owned.app.fixture.db, () => openHold(supplyContext(owned.app), input)); }
async function release(id: string) { await withTransaction(owned.app.fixture.db, () => releaseHold(supplyContext(owned.app), id)); }
async function remainsOpen(ids: string[]) {
  expect((await owned.app.fixture.db.query('SELECT id FROM active_holds WHERE id=ANY($1::uuid[]) AND released_at IS NULL', [ids])).rows.map(row => row['id']).sort()).toEqual([...ids].sort());
}
async function canonicalFixture(suffix: string) {
  const app = owned.app, f = app.fixture;
  // A preexisting CRM identity is the linkage prerequisite, never a replacement
  // for actual approved-source ingestion, qualification or automatic publication.
  await f.db.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,100) ON CONFLICT(workspace_id) DO UPDATE SET enabled=false', [f.alpha.workspaceId]);
  return await seedFirm(f, { name: `Controlled Supply ${suffix}`, website: `https://supply-${suffix.toLowerCase()}.example.test/`, locality: 'Arlington', regionCode: 'TX', assignedUserId: f.alpha.admin.userId });
}
async function unrelatedHolds(firmId: string) {
  const f = owned.app.fixture;
  return [
    await hold(researchHold('owner', f.alpha.salesperson.userId)),
    await hold(researchHold('firm', owned.app.alphaFirmId)),
    await hold({ ...researchHold('owner', f.alpha.admin.userId), blockedActionKinds: ['email_send'] }),
    await hold({ ...researchHold('firm', firmId), blockedActionKinds: ['email_send'] }),
  ];
}
async function refreshEvidence(seed: SupplySeed) {
  // Retained qualification evidence is refreshed locally, not redispatched. This
  // changes its fingerprint so an illicit publication refresh is observable.
  await owned.app.fixture.db.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,retrievedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))),admission_checked_at=NULL WHERE candidate_id=$1", [seed.candidateId]);
}

test('P1 owner research stop blocks new automatic publication and exact current TodayV4 open/list while unrelated holds remain nonblocking', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const [seed] = await ingestAutomaticSupply(app, ['P1Owner']);
  const controls = await unrelatedHolds(app.alphaFirmId);
  const matching = await hold(researchHold('owner', f.alpha.admin.userId));
  let completed: Awaited<ReturnType<typeof completeAutomaticSupply>>;
  try {
    completed = await completeAutomaticSupply(app);
    expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
    expect(await publicationRows(seed!)).toEqual([]);
    expect((await f.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND website=$2', [f.alpha.workspaceId, seed!.website])).rows).toEqual([]);
    await loginAutomaticSupply(page, app);
    expect((await actions(page)).some(row => row.target.kind === 'automatic_research' && row.target.candidateId === seed!.candidateId)).toBe(false);
    await completed.recover();
    expect(await publicationRows(seed!)).toEqual([]);
    await remainsOpen([matching, ...controls]);
  } finally { await release(matching); }
  await completed!.recover();
  const action = await actionFor(page, seed!);
  const proof = (await open(page, action)).automaticResearch!;
  expect(proof.ownerUserId).toBe(f.alpha.admin.userId);
  expect(proof.target.candidateId).toBe(seed!.candidateId);
  const baseline = await publicationRows(seed!);
  const currentStop = await hold(researchHold('owner', proof.ownerUserId));
  try {
    await refused(page, action);
    await completed!.recover();
    expect(await publicationRows(seed!)).toEqual(baseline);
    await remainsOpen([currentStop, ...controls]);
  } finally { await release(currentStop); }
  expect((await open(page, action)).automaticResearch?.target).toEqual(proof.target);
  expect(completed!.calls()).toEqual({ fetches: 1, extractions: 1 });
  for (const id of controls) await release(id);
});

test('P1 canonical Firm research stop blocks exact existing linkage and refresh/current proof without blocking unrelated scopes or action kinds', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const firmId = await canonicalFixture('P1Firm');
  const [seed] = await ingestAutomaticSupply(app, ['P1Firm']);
  const controls = await unrelatedHolds(firmId);
  const matching = await hold(researchHold('firm', firmId));
  const completed = await completeAutomaticSupply(app);
  await loginAutomaticSupply(page, app);
  try {
    expect(await publicationRows(seed!)).toEqual([]);
    await completed.recover();
    expect(await publicationRows(seed!)).toEqual([]);
    expect((await f.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND website=$2', [f.alpha.workspaceId, seed!.website])).rows).toEqual([{ id: firmId }]);
    expect((await actions(page)).some(row => row.target.kind === 'automatic_research' && row.target.candidateId === seed!.candidateId)).toBe(false);
    await remainsOpen([matching, ...controls]);
  } finally { await release(matching); }
  await completed.recover();
  const action = await actionFor(page, seed!);
  const proof = (await open(page, action)).automaticResearch!;
  expect(proof.target.firmId).toBe(firmId);
  const baseline = await publicationRows(seed!);
  const currentStop = await hold(researchHold('firm', firmId));
  try {
    await refused(page, action);
    await refreshEvidence(seed!);
    await completed.recover();
    expect(await publicationRows(seed!)).toEqual(baseline);
    await remainsOpen([currentStop, ...controls]);
  } finally { await release(currentStop); }
  await completed.recover();
  const refreshed = (await open(page, await actionFor(page, seed!))).automaticResearch!;
  expect(refreshed.target.firmId).toBe(firmId);
  expect(refreshed.target.publicationId).toBe(proof.target.publicationId);
  expect(refreshed.target.publicationRevision).toBe(proof.target.publicationRevision + 1);
  expect(refreshed.target.evidenceFingerprint).not.toBe(proof.target.evidenceFingerprint);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  for (const id of controls) await release(id);
});

for (const scope of ['owner', 'firm'] as const) {
  test(`P1 ${scope} research stop committed after actual publication/read waits refuses fresh authority without provider redispatch`, async ({ supplyPage: page }) => {
    const app = owned.app, f = app.fixture;
    const [seed] = await ingestAutomaticSupply(app, [`P1Wait${scope}`]);
    const completed = await completeAutomaticSupply(app);
    await loginAutomaticSupply(page, app);
    const initialAction = await actionFor(page, seed!);
    const initial = (await open(page, initialAction)).automaticResearch!;
    const scopeKey = scope === 'owner' ? initial.ownerUserId : initial.target.firmId;
    const baseline = await publicationRows(seed!);
    await refreshEvidence(seed!);
    const blocker = await f.database.appRuntimeSession();
    const blockerContext = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'system', component: 'worker' }), blocker);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let pendingRecovery: ReturnType<typeof completed.recover> | undefined;
    let publicationStop: string | undefined;
    await blocker.query('BEGIN');
    try {
      await lockSendGateForStopFact(blockerContext);
      pendingRecovery = completed.recover();
      await expect.poll(async () => (await blocker.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows.length).toBeGreaterThan(0);
      publicationStop = await openHold(blockerContext, researchHold(scope, scopeKey));
      await blocker.query('COMMIT');
    } catch (error) { await blocker.query('ROLLBACK'); throw error; }
    await pendingRecovery;
    expect(await publicationRows(seed!)).toEqual(baseline);
    await refused(page, initialAction);
    await remainsOpen([publicationStop!]);
    await release(publicationStop!);
    await completed.recover();
    const freshAction = await actionFor(page, seed!);
    const fresh = (await open(page, freshAction)).automaticResearch!;
    expect(fresh.target.firmId).toBe(initial.target.firmId);
    expect(fresh.target.publicationRevision).toBe(initial.target.publicationRevision + 1);
    const refreshedBaseline = await publicationRows(seed!);
    let pendingRead: ReturnType<typeof open> | undefined;
    let readStop: string | undefined;
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [f.alpha.workspaceId, initial.ownerUserId]);
      pendingRead = open(page, freshAction);
      await expect.poll(async () => (await f.db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows.length).toBeGreaterThan(0);
      readStop = await hold(researchHold(scope, scopeKey));
    } finally { await blocker.query('ROLLBACK'); }
    expect(await pendingRead).toEqual({ version: 4, target: null, research: null, automaticResearch: null });
    await refused(page, freshAction);
    await remainsOpen([readStop!]);
    expect(await publicationRows(seed!)).toEqual(refreshedBaseline);
    await release(readStop!);
    expect((await open(page, freshAction)).automaticResearch?.target).toEqual(fresh.target);
    expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  });
}
