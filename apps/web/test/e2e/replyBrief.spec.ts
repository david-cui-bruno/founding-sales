import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { test, expect, type Page } from 'playwright/test';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { updateResearchSettings, readResearchSettings } from '@fss/domain/research/settings.ts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import { startReplyBriefApp, type ReplyBriefApp } from '../support/replyBriefApp.ts';
import { reserveLocalBrowserDatabase } from '../support/database.ts';
import { browserRequest, browserSession } from '../support/browser.ts';

let app: ReplyBriefApp;
let release: (() => Promise<void>) | undefined;
const pendingKey = 'callie.browser.pending-reply.v1';
let browserResourceRecorded = false;
test.beforeAll(async () => {
  release = await reserveLocalBrowserDatabase();
  const cluster = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  console.log('REPLY_BRIEF_CLUSTER_TEMPLATE_RESERVED', JSON.stringify({ host: cluster.hostname, port: cluster.port, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] }));
  try { app = await startReplyBriefApp(); }
  catch (error) { await release(); release = undefined; throw error; }
});
test.afterAll(async () => {
  try { await app?.stop(); }
  finally {
    await release?.();
    if (app) {
      await access(app.storagePath).then(() => { throw new Error('Owned cluster remains'); }, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      let processExists = true;
      try { process.kill(app.postgresPid, 0); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); processExists = false; }
      expect(processExists).toBe(false);
      expect(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]).toBeUndefined();
      console.log('REPLY_BRIEF_CLUSTER_PID_DIRECTORY_TEMPLATE_ABSENT');
    }
  }
});
test.afterEach(async ({ context }) => {
  app?.duringGeneration(); app?.setAnswer('Thank you for your question.');
  await context.close();
  console.log('REPLY_BRIEF_BROWSER_CONTEXT_RELEASED');
});
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    if (response.status() !== 200 || !body.authorizationUrl) return await route.fulfill({ response });
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.origin).toBe(app.fixture.google.issuer);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
});
async function login(page: Page): Promise<void> {
  app.chooseIdentity(app.fixture.alpha.salesperson);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reply Brief Synthetic Firm', exact: true })).toBeVisible();
  if (!browserResourceRecorded) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes('--remote-debugging-pipe') && line.includes('--user-data-dir=') && line.includes('playwright_chromiumdev_profile-'));
    expect(processes).toHaveLength(1);
    const process = processes[0]!;
    const profilePath = /--user-data-dir=([^ ]+)/u.exec(process)?.[1];
    if (!profilePath) throw new Error('Owned browser profile not found');
    console.log('REPLY_BRIEF_BROWSER_RESERVED', JSON.stringify({ pid: Number(process.trim().split(/\s+/u)[0]), profilePath }));
    browserResourceRecorded = true;
  }
}
async function selectReply(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await page.getByRole('button', { name: 'Reply Brief Synthetic Firm: Synthetic preparation question', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
  await expect(page.getByText('Could we discuss the synthetic maintenance plan?', { exact: true })).toBeVisible();
}
async function prepare(page: Page): Promise<void> {
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Reply Brief Synthetic Firm', exact: true }) }).getByRole('button', { name: 'Open firm', exact: true }).click();
  await page.getByRole('button', { name: 'Load existing meetings', exact: true }).click();
  await page.getByRole('button', { name: 'Open preparation', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Current meeting brief', exact: true })).toBeVisible();
}
async function noOutbound(): Promise<void> {
  for (const table of ['outbound_messages', 'human_reply_send_intents', 'outbound_message_events']) {
    expect((await app.fixture.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]?.count, table).toBe('0');
  }
  expect((await app.fixture.db.query("SELECT 1 FROM jobs WHERE kind='reply.human_send'")).rows).toHaveLength(0);
  expect((await app.fixture.db.query("SELECT 1 FROM mail_messages WHERE direction='outgoing'")).rows).toHaveLength(0);
}
async function custody(page: Page) {
  return await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null') as { commandId: string } | null, pendingKey);
}
async function privateStorageIsIdsOnly(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  const serialized = JSON.stringify(state);
  expect(serialized).not.toMatch(/maintenance plan|Thank you|Human edited|prospect-|owner-|accessToken|deviceSecret|handoffSecret|code_verifier/u);
  expect(state.cookies).toBe('');
}

test('actual reply cards and context require explicit generation, adoption, human edits and exact preview with no send', async ({ page }) => {
  const baseline = app.calls();
  await login(page);
  await selectReply(page);
  expect(app.calls()).toBe(baseline);
  const exchange = app.fixture.google.tokenExchanges().at(-1);
  expect(exchange?.clientSecretPresented).toBe(true);
  expect(exchange?.redirectUri).toBe(`${app.origin}/browser/callback`);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  expect((await browserRequest(page, '/replies/card', { body: { messageId: app.seed.messageId } })).status).toBe(200);
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toContainText('Thank you for your question.');
  expect(app.calls()).toBe(baseline + 1);
  await expect(page.getByLabel('Reply draft', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Use suggestion in draft', exact: true }).click();
  await page.getByLabel('Reply draft', { exact: true }).fill('Human edited exact synthetic reply.');
  const previewRequest = page.waitForRequest(request => request.url().endsWith('/replies/composer/preview'));
  await page.getByRole('button', { name: 'Preview exact reply', exact: true }).click();
  expect((await previewRequest).postDataJSON()).toEqual({ messageId: app.seed.messageId, text: 'Human edited exact synthetic reply.', factRefs: [app.seed.factRef], envelope: { to: [app.seed.recipient], cc: [] } });
  const preview = page.getByRole('article', { name: 'Final reply preview', exact: true });
  await expect(preview).toContainText('Human edited exact synthetic reply.');
  await expect(preview).toContainText(app.seed.recipient);
  await page.getByLabel('Reply draft', { exact: true }).fill('Human edited replacement invalidates preview.');
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Send|Confirm reply|Book)/u })).toHaveCount(0);
  for (const path of ['/replies/composer/send', '/replies/composer/send-status', '/replies/confirm']) {
    expect((await browserRequest(page, path, { body: {} })).status).toBe(404);
  }
  await privateStorageIsIdsOnly(page);
  await noOutbound();
});

test('actual existing meeting list opens bounded v2 brief with current sources, dates, unverified labels and inferred questions', async ({ page }) => {
  const baseline = app.calls();
  await login(page);
  await prepare(page);
  const brief = page.getByRole('article', { name: 'Current meeting brief', exact: true });
  await expect(brief).toContainText(app.meetingId);
  await expect(brief).toContainText('Robin Fixture');
  await expect(brief.getByRole('region', { name: 'Company and person facts', exact: true })).toContainText('Residents submit requests through the portal.');
  await expect(brief).toContainText('2026-10-01');
  await expect(brief.getByRole('region', { name: 'Prior interactions', exact: true })).toContainText('Synthetic preparation question');
  await expect(brief.getByRole('region', { name: 'Inferred or unverified hypotheses', exact: true })).toContainText('unverified');
  await expect(brief).toContainText('2026-09-20');
  const questions = brief.getByRole('region', { name: 'Preparation questions', exact: true });
  expect(await questions.getByRole('listitem').count()).toBeGreaterThan(0);
  expect(await questions.getByRole('listitem').count()).toBeLessThanOrEqual(3);
  await expect(questions).toContainText('inferred');
  await expect(questions).toContainText('preparation_prompt');
  await expect(brief.getByRole('region', { name: 'Next-step objective', exact: true })).toContainText('confirm whether a next step is useful');
  await privateStorageIsIdsOnly(page);
  expect(app.calls()).toBe(baseline);
  await noOutbound();
});

test('committed generation response loss retains exact UUID across reload without automatic or replacement paid attempts', async ({ page }) => {
  await login(page); await selectReply(page);
  const baseline = app.calls();
  let original: unknown;
  await page.route('**/browser/api/replies/composer/generate', async route => {
    original = route.request().postDataJSON();
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByText('Current source or operation unavailable.', { exact: false })).toBeVisible();
  const held = await custody(page);
  expect(held?.commandId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(original).toMatchObject({ commandId: held?.commandId });
  expect((await app.fixture.db.query('SELECT attempt,state FROM provider_reservations WHERE workspace_id=$1 AND subject_kind=\'outreach_reply\' AND subject_id=$2', [app.fixture.alpha.workspaceId, held?.commandId])).rows).toEqual([{ attempt: 1, state: 'settled' }]);
  expect(app.calls()).toBe(baseline + 1);
  await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=true WHERE mail_message_id=$1', [app.seed.messageId]);
  try {
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    await expect(page.getByText('Current source or operation unavailable.', { exact: false })).toBeVisible();
    expect(await custody(page)).toEqual(held);
    expect(app.calls()).toBe(baseline + 1);
  } finally { await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=false WHERE mail_message_id=$1', [app.seed.messageId]); }
  await page.reload();
  await selectReply(page);
  expect(await custody(page)).toEqual(held);
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Reply draft', { exact: true })).toHaveValue('');
  expect(app.calls()).toBe(baseline + 1);
  const check = page.waitForRequest(request => request.url().endsWith('/replies/composer/generate'));
  await page.getByRole('button', { name: 'Check same reply attempt', exact: true }).click();
  expect((await check).postDataJSON()).toEqual(original);
  await expect(page.getByText('Same attempt checked.', { exact: false })).toBeVisible();
  expect(await custody(page)).toEqual(held);
  expect(app.calls()).toBe(baseline + 1);
  await expect(page.getByRole('button', { name: 'Generate suggestion', exact: true })).toBeDisabled();
  expect((await app.fixture.db.query('SELECT attempt,state FROM provider_reservations WHERE workspace_id=$1 AND subject_kind=\'outreach_reply\' AND subject_id=$2', [app.fixture.alpha.workspaceId, held?.commandId])).rows).toEqual([{ attempt: 1, state: 'settled' }]);
  await privateStorageIsIdsOnly(page); await noOutbound();
});

test('brief re-open shows changed current facts and refuses a meeting no longer linked to the Firm', async ({ page }) => {
  await login(page); await prepare(page);
  const brief = page.getByRole('article', { name: 'Current meeting brief', exact: true });
  await app.fixture.db.query("UPDATE firm_facts SET quote='Synthetic workflow changed to telephone intake.' WHERE workspace_id=$1 AND firm_id=$2 AND key='maintenance_workflow'", [app.fixture.alpha.workspaceId, app.firmId]);
  try {
    await page.getByRole('button', { name: 'Open preparation', exact: true }).click();
    await expect(brief).toContainText('Synthetic workflow changed to telephone intake.');
    await expect(brief).not.toContainText('Residents submit requests through the portal.');
    await app.fixture.db.query('UPDATE meetings SET firm_id=NULL WHERE workspace_id=$1 AND id=$2', [app.fixture.alpha.workspaceId, app.meetingId]);
    await page.getByRole('button', { name: 'Open preparation', exact: true }).click();
    await expect(page.getByText('Meeting preparation unavailable.', { exact: false })).toBeVisible();
    await expect(brief).toHaveCount(0);
  } finally {
    await app.fixture.db.query('UPDATE meetings SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [app.fixture.alpha.workspaceId, app.meetingId, app.firmId]);
    await app.fixture.db.query("UPDATE firm_facts SET quote='Residents submit requests through the portal.' WHERE workspace_id=$1 AND firm_id=$2 AND key='maintenance_workflow'", [app.fixture.alpha.workspaceId, app.firmId]);
  }
  await noOutbound();
});

test('changed or missing original refuses exact preview without inventing context or generating', async ({ page }) => {
  await login(page); await selectReply(page);
  const baseline = app.calls();
  await page.getByLabel('Reply draft', { exact: true }).fill('Human edited stale source draft.');
  await app.fixture.db.query('UPDATE mail_message_bodies SET body_text=$2 WHERE mail_message_id=$1', [app.seed.messageId, 'Synthetic source changed after context load.']);
  try {
    await page.getByRole('button', { name: 'Preview exact reply', exact: true }).click();
    await expect(page.getByText('Conversation or approved facts changed.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Reply draft', { exact: true })).toHaveCount(0);
    await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=true WHERE mail_message_id=$1', [app.seed.messageId]);
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    await expect(page.getByText('Current source or operation unavailable.', { exact: false })).toBeVisible();
    expect(app.calls()).toBe(baseline);
  } finally {
    await app.fixture.db.query('UPDATE mail_message_bodies SET body_text=$2,truncated=false WHERE mail_message_id=$1', [app.seed.messageId, 'Could we discuss the synthetic maintenance plan?']);
  }
  await noOutbound();
});

test('unsupported controlled suggestion is rejected with current session intact and zero outbound writes', async ({ page }) => {
  await login(page); await selectReply(page);
  app.setAnswer('It costs $99 per month and we will launch tomorrow.');
  const baseline = app.calls();
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByText('Suggestion unavailable under current controls.', { exact: false })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
  expect((await browserSession(page)).status).toBe('signed_in');
  expect(app.calls()).toBe(baseline + 1);
  await noOutbound();
});

test('logout from another actual tab clears private reply draft, brief and retained attempt custody', async ({ page, context }) => {
  await login(page); await selectReply(page);
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(app.origin);
  await expect(other.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await prepare(other);
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reply composer', exact: true })).toHaveCount(0);
  await expect(other.getByRole('article', { name: 'Current meeting brief', exact: true })).toHaveCount(0);
  expect(await custody(page)).toBeNull();
  expect((await browserRequest(page, '/replies', { body: {} })).status).toBe(401);
  await noOutbound();
});

test('late generated response after logout cannot repopulate suggestion or pending state', async ({ page }) => {
  await login(page); await selectReply(page);
  let releaseResponse = () => {};
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  let observed = () => {};
  const received = new Promise<void>(resolve => { observed = resolve; });
  await page.route('**/browser/api/replies/composer/generate', async route => {
    const response = await route.fetch(); observed(); await held; await route.fulfill({ response });
  }, { times: 1 });
  const delivered = page.waitForResponse(response => response.url().endsWith('/replies/composer/generate'));
  try {
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await received;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  } finally { releaseResponse(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
  expect(await custody(page)).toBeNull(); await noOutbound();
});

test('device revocation during controlled generation withholds private response and clears custody', async ({ page }) => {
  await login(page); await selectReply(page);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Real signed session required');
  app.duringGeneration(async () => {
    await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  });
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reply composer', exact: true })).toHaveCount(0);
  expect(await custody(page)).toBeNull();
  expect((await browserRequest(page, '/replies/composer/context', { body: { messageId: app.seed.messageId } })).status).toBe(401);
  await noOutbound();
});

test('actual membership refusal clears previously mounted sourced brief', async ({ page }) => {
  await login(page); await prepare(page);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Real signed session required');
  await app.fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
  try {
    await page.getByRole('button', { name: 'Load existing meetings', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Current meeting brief', exact: true })).toHaveCount(0);
  } finally { await app.fixture.db.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]); }
  expect((await browserRequest(page, '/replies/composer/context', { body: { messageId: randomUUID() } })).status).toBe(401);
  await noOutbound();
});

test('existing current budget blocks explicit generation before controlled port call', async ({ page }) => {
  await login(page); await selectReply(page);
  const baseline = app.calls(), settings = await readResearchSettings(app.seed.admin);
  await withTransaction(app.fixture.db, () => updateResearchSettings(app.seed.admin, { dailyCostCeilingCents: 0 }));
  try {
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await expect(page.getByText('Suggestion unavailable under current controls.', { exact: false })).toBeVisible();
    expect(app.calls()).toBe(baseline);
    expect((await browserSession(page)).status).toBe('signed_in');
  } finally { await withTransaction(app.fixture.db, () => updateResearchSettings(app.seed.admin, { dailyCostCeilingCents: settings.dailyCostCeilingCents })); }
  await noOutbound();
});

test('existing current research hold blocks generation without bypassing owner controls', async ({ page }) => {
  await login(page); await selectReply(page);
  const baseline = app.calls();
  const hold = await withTransaction(app.fixture.db, () => openHold(app.seed.admin, { scopeKind: 'firm', scopeKey: app.firmId, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'reply_brief_fixture' }));
  try {
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await expect(page.getByText('Suggestion unavailable under current controls.', { exact: false })).toBeVisible();
    expect(app.calls()).toBe(baseline);
  } finally { await withTransaction(app.fixture.db, () => releaseHold(app.seed.admin, hold)); }
  await noOutbound();
});

test('expired actual access session refuses reply context and clears private draft', async ({ page }) => {
  await login(page); await selectReply(page);
  await page.getByLabel('Reply draft', { exact: true }).fill('Human edited private expiring draft.');
  app.fixture.advance(61 * 60 * 1000);
  try {
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Reply composer', exact: true })).toHaveCount(0);
    expect(await custody(page)).toBeNull();
  } finally { app.fixture.advance(-61 * 60 * 1000); }
  await noOutbound();
});
