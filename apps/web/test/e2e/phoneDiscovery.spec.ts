import { randomUUID } from 'node:crypto';
import { expect, test as base } from 'playwright/test';
import { manualProspectListSchema, prospectPhoneDiscoveryCommandSchema, prospectPhoneDiscoveryQueuedSchema, prospectPhoneDiscoveryReceiptSchema, prospectPhoneDiscoveryViewSchema } from '@fss/contracts';
import { browserRequest } from '../support/browser.ts';
import { assertGlassNoExternalActions, containGlass, signInGlass } from '../support/glassWorkspaceApp.ts';
import { launchGlassContext } from '../support/glassWorkspaceBrowser.ts';
import { assertPhoneDiscoveryNoEffects, assertPhoneDiscoveryStorage, drivePhoneDiscoveryJob, openPhoneDiscoveryCandidate, phoneDiscoveryCase, phoneDiscoveryEffectsSnapshot, phoneDiscoveryPaths, requirePhoneDiscoveryRuntimeGrant, seedPhoneDiscoveryCandidate, setPhoneDiscoveryResearch, startPhoneDiscoveryApp, withdrawPhoneDiscoverySource } from '../support/phoneDiscoveryApp.ts';

const test = base.extend({ context: async ({ browserName }, use) => {
  // beforeAll already checked the clean environment before allocating this app.
  // Its own registered PG variables must not be mistaken for inherited PG here.
  expect(process.env['FSS_PHONE_DISCOVERY_RUNTIME_GRANT']).toBe('797');
  expect(owned).toBeDefined();
  expect(browserName).toBe('chromium');
  const browser = await launchGlassContext();
  try { await use(browser.context); }
  finally { await browser.stop(); }
} });

test.use({ ignoreHTTPSErrors: true, actionTimeout: 15_000, screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ timeout: 180_000 });
let owned: Awaited<ReturnType<typeof startPhoneDiscoveryApp>> | undefined;
let candidate: Awaited<ReturnType<typeof seedPhoneDiscoveryCandidate>>;
const app = () => { if (!owned) throw Error('Phone797 runtime has not been granted/initialized'); return owned.app; };
test.beforeAll(async () => {
  requirePhoneDiscoveryRuntimeGrant();
  owned = await startPhoneDiscoveryApp();
  candidate = await seedPhoneDiscoveryCandidate(owned.app);
});
test.afterAll(async () => {
  if (!owned) return;
  try { await assertGlassNoExternalActions(owned.app); }
  finally { await owned.stop(); owned = undefined; }
});

// ONE new changed-product path, no replay of accepted Glass workflows. Root must
// separately grant FSS_PHONE_DISCOVERY_RUNTIME_GRANT=797 and existing Glass guards.
// All companies, originals and URLs below are explicitly fictional. No live fetch.
test('exact retained prospect -> Calling -> phone-only capture, receipt recovery, explicit read and durable current evidence', async ({ context, page }) => {
  await containGlass(context, app());
  await signInGlass(page, app());
  const baseline = await phoneDiscoveryEffectsSnapshot(app());
  await openPhoneDiscoveryCandidate(page, candidate.candidateId);
  const discovery = page.getByRole('region', { name: 'Business phone discovery', exact: true });
  const find = discovery.getByRole('button', { name: 'Find business phone', exact: true });
  const read = discovery.getByRole('button', { name: 'Read phone result', exact: true });
  await expect(find).toBeEnabled();
  // Mount, list, sign-in and explicit missing-result read cannot enqueue acquisition.
  await read.click();
  await expect(discovery).toContainText('No phone discovery result is recorded for this exact observation. Phone remains unknown.');
  expect((await app().fixture.db.query('SELECT 1 FROM sourcing_prospect_phone_discoveries')).rowCount).toBe(0);
  expect((await app().fixture.db.query('SELECT 1 FROM jobs')).rowCount).toBe(baseline['jobs']!.length);

  // Real registered request/refusal boundaries, no frontend or domain fake. These
  // direct API commands do not replace the user's later actual Find click.
  const stale = await browserRequest(page, phoneDiscoveryPaths.request, { body: { ...candidate, expectedRevision: 2, commandId: randomUUID() } });
  expect(stale.status).toBe(200);
  expect(stale.body).toMatchObject({ status: 'refused', reason: 'candidate_changed' });
  const disabled = await browserRequest(page, phoneDiscoveryPaths.request, { body: { ...candidate, commandId: randomUUID() } });
  expect(disabled.status).toBe(200);
  expect(disabled.body).toMatchObject({ status: 'refused', reason: 'research_disabled' });
  expect((await app().fixture.db.query('SELECT 1 FROM sourcing_prospect_phone_discoveries')).rowCount).toBe(0);
  expect((await app().fixture.db.query('SELECT 1 FROM jobs')).rowCount).toBe(baseline['jobs']!.length);
  await setPhoneDiscoveryResearch(app(), true);

  // Lose only the response AFTER the unchanged signed API committed. A response
  // fixture never manufactures acceptance. The browser must recover by receipt,
  // never redispatch the captured command or manufacture a second UUID/run.
  const requestPattern = `**/browser/api${phoneDiscoveryPaths.request}`;
  let requests = 0;
  let acceptedRunId: string | undefined;
  let commandId: string | undefined;
  await context.route(requestPattern, async route => {
    requests += 1;
    const payload = prospectPhoneDiscoveryCommandSchema.omit({ clientVersion: true }).parse(route.request().postDataJSON());
    expect(payload).toEqual({ ...candidate, commandId: payload.commandId });
    commandId = payload.commandId;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const body = await response.json() as { status: string; result: unknown };
    expect(body.status).toBe('accepted');
    acceptedRunId = prospectPhoneDiscoveryQueuedSchema.parse(body.result).runId;
    await route.abort('failed');
  });
  try {
    await find.click();
    await expect(discovery).toContainText('Phone discovery UNKNOWN. Receipt-only recovery, no redispatch.');
    await expect(find).toBeDisabled();
    await expect(read).toBeDisabled();
    // UNKNOWN appears as soon as custody is prepared, before network dispatch.
    // Wait for this route's real committed acceptance, not that initial render.
    await expect.poll(() => requests).toBe(1);
    await expect.poll(() => acceptedRunId).toBeDefined();
    await assertPhoneDiscoveryStorage(page, candidate.candidateId);
    const receiptReady = page.waitForResponse(response => new URL(response.url()).pathname === `/browser/api${phoneDiscoveryPaths.receipt}`);
    await discovery.getByRole('button', { name: 'Check phone discovery receipt', exact: true }).click();
    const receiptResponse = await receiptReady;
    expect(receiptResponse.status()).toBe(200);
    expect(prospectPhoneDiscoveryReceiptSchema.parse(await receiptResponse.json())).toEqual({ state: 'accepted', result: { runId: acceptedRunId } });
    await expect(discovery).toContainText('Phone discovery receipt accepted. Read current phone evidence separately.');
    await expect(find).toBeDisabled();
    await expect(read).toBeEnabled();
    expect(requests).toBe(1);
  } finally { await context.unroute(requestPattern); }
  if (!acceptedRunId || !commandId) throw Error('Real committed phone discovery acceptance required');
  const runId = acceptedRunId;
  const receiptRows = (await app().fixture.db.query<{ result_status: string; result: unknown }>('SELECT result_status,result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2', [app().fixture.alpha.workspaceId, commandId])).rows;
  expect(receiptRows).toEqual([{ result_status: 'accepted', result: { runId } }]);
  const worker = await drivePhoneDiscoveryJob(app(), runId);
  // No push/mount success: the user explicitly reads the actual registered result.
  const readReady = page.waitForResponse(response => new URL(response.url()).pathname === `/browser/api${phoneDiscoveryPaths.read}`);
  await read.click();
  const resultResponse = await readReady;
  expect(resultResponse.status()).toBe(200);
  const result = prospectPhoneDiscoveryViewSchema.parse(await resultResponse.json());
  expect(result).toMatchObject({ candidateId: candidate.candidateId, candidateRevision: 1, runId, state: 'complete', channelAuthority: 'not_granted', phoneEvidence: { state: 'observed', value: phoneDiscoveryCase.phone } });
  const resultPanel = discovery.getByLabel('Current phone discovery result', { exact: true });
  await expect(resultPanel).toContainText(`Phone ${phoneDiscoveryCase.phone} · observed, not call-ready`);
  await resultPanel.getByText('Phone-specific sources and coverage', { exact: true }).click();
  await expect(resultPanel).toContainText('Source label: Office phone');
  await expect(resultPanel).toContainText(worker.retrievedAt);
  await expect(resultPanel.getByRole('link', { name: phoneDiscoveryCase.phoneUrl, exact: true })).toHaveAttribute('href', phoneDiscoveryCase.phoneUrl);
  await expect(resultPanel).toContainText('Phone type unknown. Ownership and reachability are not verified.');
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await assertPhoneDiscoveryStorage(page, candidate.candidateId, runId);

  // Readback comes from the current API/list and DB, not previous frontend state.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const listed = await browserRequest(page, '/sourcing/candidates/prospects/list', { body: { state: 'all', offset: 0 } });
  expect(listed.status).toBe(200);
  const current = manualProspectListSchema.parse(listed.body).prospects.find(row => row.candidateId === candidate.candidateId);
  expect(current).toMatchObject({ candidateId: candidate.candidateId, revision: 1, observedPhone: phoneDiscoveryCase.phone, qualification: 'unverified', contactAuthority: 'not_granted' });
  expect(current?.phoneEvidence).toMatchObject({ state: 'observed', value: phoneDiscoveryCase.phone, sources: [{ url: phoneDiscoveryCase.phoneUrl, retrievedAt: worker.retrievedAt, authority: { kind: 'phone_discovery', runId } }] });
  await openPhoneDiscoveryCandidate(page, candidate.candidateId);
  await expect(discovery.getByLabel('Current phone discovery result', { exact: true })).toHaveCount(0);
  await expect(find).toBeDisabled();
  await read.click();
  await expect(resultPanel).toContainText(phoneDiscoveryCase.phone);
  await assertPhoneDiscoveryStorage(page, candidate.candidateId, runId);
  expect(worker.fetches()).toBe(1);
  expect((await app().fixture.db.query('SELECT 1 FROM sourcing_prospect_phone_discoveries')).rowCount).toBe(1);
  await assertPhoneDiscoveryNoEffects(app(), baseline);

  // One natural terminal fence on this same run. Existing source-loss owner erases
  // content. Explicit read may report unavailable/null, but never retain the phone.
  await withdrawPhoneDiscoverySource(app());
  await read.click();
  await expect(discovery).not.toContainText(phoneDiscoveryCase.phone);
  const unavailable = await browserRequest(page, phoneDiscoveryPaths.read, { body: candidate });
  expect(unavailable.status).toBe(200);
  const lost = prospectPhoneDiscoveryViewSchema.nullable().parse(unavailable.body);
  expect(lost === null || lost.state === 'unavailable').toBe(true);
  const erased = (await app().fixture.db.query<{ content: unknown }>('SELECT content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2', [app().fixture.alpha.workspaceId, runId])).rows[0];
  expect(erased?.content ?? null).toBeNull();
  expect(worker.fetches()).toBe(1);
  await assertPhoneDiscoveryNoEffects(app(), baseline);
});
