import { randomUUID, createHash } from 'node:crypto';
import { test, expect, type Page } from 'playwright/test';
import { startLocalBrowserApp, type LocalBrowserApp } from '../support/appServer.ts';
import { reserveLocalBrowserDatabase } from '../support/database.ts';
import { assertNoBrowserCredentials, browserRequest, browserSession } from '../support/browser.ts';
import { leaveUncertainNotes, revokeCurrentDevice } from '../support/notes.ts';

let app: LocalBrowserApp;
let release: (() => Promise<void>) | undefined;
test.beforeAll(async () => {
  release = await reserveLocalBrowserDatabase();
  try { app = await startLocalBrowserApp(); }
  catch (error) { await release(); release = undefined; throw error; }
});
test.afterAll(async () => { try { await app?.stop(); } finally { await release?.(); } });
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === app.origin) await route.continue();
    else await route.abort('blockedbyclient');
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) console.log('LOCAL_BROWSER_UI_STATUS:', await page.getByRole('status').allTextContents());
});

async function login(page: Page, workspace = app.fixture.alpha, member = workspace.salesperson): Promise<void> {
  app.chooseIdentity(member);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(workspace.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: workspace === app.fixture.alpha ? 'Alpha Synthetic Browser Firm' : 'Beta Synthetic Browser Firm', exact: true })).toBeVisible();
}
async function openAlpha(page: Page): Promise<void> {
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Alpha Synthetic Browser Firm', exact: true }) }).getByRole('button', { name: 'Open firm' }).click();
  await expect(page.getByRole('region', { name: 'Firm', exact: true })).toBeVisible();
}
async function readNotes(page: Page): Promise<void> {
  await page.getByLabel('Meeting ID', { exact: true }).fill(app.meetingId);
  await page.getByRole('button', { name: 'Read meeting notes', exact: true }).click();
  await expect(page.getByLabel('Your notes', { exact: true })).toBeVisible();
}

test('real signed OIDC login, Today, existing Firm, reload, logout and second identity isolation', async ({ page }) => {
  await login(page);
  const exchange = app.fixture.google.tokenExchanges().at(-1);
  expect(exchange?.codeVerifier.length).toBeGreaterThanOrEqual(43);
  expect(exchange?.clientSecretPresented).toBe(true);
  expect(exchange?.redirectUri).toBe(`${app.origin}/browser/callback`);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  await assertNoBrowserCredentials(page, app);
  await openAlpha(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Alpha Synthetic Browser Firm', exact: true })).toBeVisible();
  await openAlpha(page);
  const today = await browserRequest(page, '/today');
  expect(today.status).toBe(200);
  expect(today.cache).toContain('no-store');
  const alphaSession = await browserSession(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  expect((await browserRequest(page, '/today')).status).toBe(401);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
  await login(page, app.fixture.beta);
  expect((await browserRequest(page, '/today/firm', { body: { firmId: app.betaFirmId }, revision: alphaSession.status === 'signed_in' ? alphaSession.revision : '' })).status).toBe(409);
  await expect(page.getByRole('heading', { name: 'Alpha Synthetic Browser Firm', exact: true })).toHaveCount(0);
  expect((await browserRequest(page, `/firms/${app.alphaFirmId}`)).status).toBe(404);
  expect((await browserRequest(page, `/meetings/outcomes?meetingId=${app.meetingId}`)).status).toBe(404);
  await assertNoBrowserCredentials(page, app);
});

test('browser refuses CSRF, cross-origin, stale revision and unsupported routes', async ({ page }) => {
  await login(page);
  expect((await browserRequest(page, '/today/firm', { body: { firmId: app.alphaFirmId }, csrf: 'not-the-session-csrf' })).status).toBe(403);
  expect((await browserRequest(page, '/today/firm', { body: { firmId: app.alphaFirmId }, revision: 'stale-tab-revision' })).status).toBe(409);
  expect((await browserRequest(page, '/admin/settings')).status).toBe(404);
  const session = await browserSession(page);
  const refused = await page.context().request.post(`${app.origin}/browser/api/today/firm`, { headers: { origin: 'https://other.example.test', 'x-callie-csrf': session.csrfToken, 'x-callie-session': session.status === 'signed_in' ? session.revision : '' }, data: { firmId: app.alphaFirmId } });
  expect(refused.status()).toBe(403);
});

for (const refusal of ['membership', 'device', 'session', 'expiry'] as const) {
  test(`real authentication refuses ${refusal} revocation or expiry`, async ({ page }) => {
    await login(page);
    const session = await browserSession(page);
    if (session.status !== 'signed_in') throw new Error('Expected real signed-in session');
    const baseline = app.fixture.deps.now();
    try {
      if (refusal === 'membership') await app.fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
      if (refusal === 'device') await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
      if (refusal === 'session') await app.fixture.db.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2 AND status='active'", [session.workspaceId, session.deviceId]);
      if (refusal === 'expiry') app.fixture.advance(3600_001);
      expect((await browserRequest(page, '/today')).status).toBe(401);
      expect((await browserRequest(page, '/meetings/notes', { body: { meetingId: app.meetingId, expectedRevision: 0, debrief: 'Must not persist', speakerMappings: [], itemOverrides: [], sufficient: false, commandId: randomUUID() } })).status).toBeGreaterThanOrEqual(400);
      await page.reload();
      await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Alpha Synthetic Browser Firm', exact: true })).toHaveCount(0);
    } finally {
      app.fixture.setNow(baseline);
      if (refusal === 'membership') await app.fixture.db.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
    }
  });
}

test('meeting notes save/readback/reload, duplicate receipt and lost response reuse real command', async ({ page }) => {
  await login(page);
  await openAlpha(page);
  await readNotes(page);
  const note = 'Synthetic browser meeting: send the agreed fictional guide.';
  await page.getByLabel('Your notes', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByText('Saved notes revision 1.', { exact: true })).toBeVisible();
  await page.reload();
  await openAlpha(page);
  await readNotes(page);
  await expect(page.getByLabel('Your notes', { exact: true })).toHaveValue(note);
  app.dropNextNotesResponse();
  const uncertainNote = 'Synthetic browser meeting: response deliberately lost after commit.';
  await page.getByLabel('Your notes', { exact: true }).fill(uncertainNote);
  const sent = page.waitForRequest(request => request.url().endsWith('/browser/api/meetings/notes') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  const original = (await sent).postDataJSON() as { commandId: string };
  await expect(page.getByText('Save outcome is unresolved.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
  await page.reload();
  await openAlpha(page);
  await readNotes(page);
  await expect(page.getByLabel('Your notes', { exact: true })).toHaveValue(uncertainNote);
  const replay = page.waitForRequest(request => request.url().endsWith('/browser/api/meetings/notes') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  expect((await replay).postDataJSON()).toEqual((await sent).postDataJSON());
  await expect(page.getByText('Saved notes revision 2 (existing receipt).', { exact: true })).toBeVisible();
  const readback = await browserRequest(page, `/meetings/outcomes?meetingId=${app.meetingId}`);
  expect(readback.body).toMatchObject({ notes: { revision: 2, debrief: uncertainNote } });
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
  await assertNoBrowserCredentials(page, app);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual({});
});

test('late real Today response cannot repopulate after logout', async ({ page }) => {
  await login(page);
  const releaseResponse = app.holdNext('/browser/api/today');
  const received = page.waitForRequest(request => request.url().includes('/browser/api/today?'));
  const lateResponse = page.waitForResponse(response => response.url().includes('/browser/api/today?'));
  try {
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await received;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  } finally { releaseResponse(); }
  // The client deliberately rejects a stale fetch before consuming its JSON body.
  // Observe browser response delivery, then let its generation check and React flush.
  expect((await lateResponse).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(page.getByRole('heading', { name: 'Alpha Synthetic Browser Firm', exact: true })).toHaveCount(0);
  expect((await browserRequest(page, '/today')).status).toBe(401);
});

test('revocation clears a retained uncertain notes command and refuses replay', async ({ page }) => {
  await login(page);
  await openAlpha(page);
  await readNotes(page);
  const pending = await leaveUncertainNotes(page, app, 'Synthetic retained save before device revocation.');
  await revokeCurrentDevice(page, app);
  let dispatched = 0;
  page.on('request', request => { if (request.url().endsWith('/browser/api/meetings/notes')) dispatched += 1; });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  expect(dispatched).toBe(0);
  expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  expect((await app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [pending.commandId])).rows).toHaveLength(1);
  expect((await browserRequest(page, `/meetings/outcomes?meetingId=${app.meetingId}`)).status).toBe(401);
});

test('logout removes unresolved notes draft and a new sign-in does not replay it', async ({ page }) => {
  await login(page);
  await openAlpha(page);
  await readNotes(page);
  const pending = await leaveUncertainNotes(page, app, 'Synthetic retained save before logout.');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  let dispatched = 0;
  page.on('request', request => { if (request.url().endsWith('/browser/api/meetings/notes')) dispatched += 1; });
  await login(page);
  await openAlpha(page);
  await readNotes(page);
  await expect(page.getByRole('button', { name: 'Save notes', exact: true })).toBeVisible();
  expect(dispatched).toBe(0);
  const readback = await browserRequest(page, `/meetings/outcomes?meetingId=${app.meetingId}`);
  expect(readback.body).toMatchObject({ notes: { revision: pending.revision } });
});
