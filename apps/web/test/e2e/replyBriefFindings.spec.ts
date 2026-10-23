import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { test, expect, type Page } from 'playwright/test';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordMessage, storeMessageBody } from '@fss/domain/mail/messages.ts';
import { directSendTargetOf, recordMatches } from '@fss/domain/mail/matching.ts';
import { replyAttemptSchema, REPLY_PENDING_KEY } from '../../src/client/ReplyAttempt.ts';
import { startReplyBriefApp, type ReplyBriefApp } from '../support/replyBriefApp.ts';
import { reserveLocalBrowserDatabase } from '../support/database.ts';
import { browserRequest, browserSession } from '../support/browser.ts';

// Finding-only composed proof. The original 13-case suite remains closed.
let app: ReplyBriefApp;
let release: (() => Promise<void>) | undefined;
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
      await access(app.storagePath).then(() => { throw new Error('Owned cluster remains'); }, error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      expect(() => process.kill(app.postgresPid, 0)).toThrow();
      expect(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]).toBeUndefined();
      console.log('REPLY_BRIEF_CLUSTER_PID_DIRECTORY_TEMPLATE_ABSENT');
    }
  }
});
test.afterEach(async ({ context }) => {
  app?.duringGeneration();
  await context.close();
  console.log('REPLY_BRIEF_BROWSER_CONTEXT_RELEASED');
});

async function login(page: Page): Promise<void> {
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    expect(response.status()).toBe(200);
    if (!body.authorizationUrl) throw new Error('Signed OIDC authorization required');
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.origin).toBe(app.fixture.google.issuer);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
  await page.goto(app.origin);
  const processes = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes('--remote-debugging-pipe') && line.includes('--user-data-dir=') && line.includes('playwright_chromiumdev_profile-') && !line.includes('--type='));
  expect(processes).toHaveLength(1);
  const process = processes[0]!;
  const profilePath = /--user-data-dir=([^ ]+)/u.exec(process)?.[1];
  if (!profilePath) throw new Error('Owned browser profile not found');
  console.log('REPLY_BRIEF_BROWSER_RESERVED', JSON.stringify({ pid: Number(process.trim().split(/\s+/u)[0]), profilePath }));
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
}
async function selectReply(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await page.getByRole('button', { name: 'Reply Brief Synthetic Firm: Synthetic preparation question', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
  await expect(page.getByText('Could we discuss the synthetic maintenance plan?', { exact: true })).toBeVisible();
}
async function rawCustody(page: Page): Promise<string | null> {
  return await page.evaluate(key => sessionStorage.getItem(key), REPLY_PENDING_KEY);
}
async function assertIdsOnly(page: Page): Promise<void> {
  const raw = await rawCustody(page);
  expect(raw).not.toBeNull();
  replyAttemptSchema.parse(JSON.parse(raw!));
  const state = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(JSON.stringify(state)).not.toMatch(/maintenance plan|Earlier synthetic|Thank you|prospect-|owner-|accessToken|deviceSecret|handoffSecret|code_verifier/u);
  expect(state.cookies).toBe('');
}
async function noOutbound(): Promise<void> {
  for (const table of ['outbound_messages', 'human_reply_send_intents', 'outbound_message_events']) {
    expect((await app.fixture.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]?.count, table).toBe('0');
  }
  expect((await app.fixture.db.query("SELECT 1 FROM jobs WHERE kind='reply.human_send'")).rows).toHaveLength(0);
  expect((await app.fixture.db.query("SELECT 1 FROM mail_messages WHERE direction='outgoing'")).rows).toHaveLength(0);
}

test('S743-1 paid generation with incomplete prior source retains exact custody until real auth loss', async ({ page }) => {
  await login(page);
  const original = (await app.fixture.db.query<{ provider_thread_id: string; internal_date: Date; header_to: string[] }>('SELECT provider_thread_id,internal_date,header_to FROM mail_messages WHERE id=$1', [app.seed.messageId])).rows[0]!;
  const id = randomUUID();
  const prior = await withTransaction(app.fixture.db, () => recordMessage(app.seed.ctx, {
    mailboxId: app.seed.mailboxId,
    metadata: { providerMessageId: id, providerThreadId: original.provider_thread_id, rfcMessageId: `${id}@example.test`,
      direction: 'incoming', internalDate: new Date(original.internal_date.getTime() - 60_000).toISOString(),
      headerFrom: app.seed.recipient, headerTo: original.header_to, headerCc: [], subject: 'Earlier synthetic context',
      referenceMessageIds: [], inReplyTo: null, autoSubmitted: null, listId: null, labelIds: [], attachments: [] },
  }));
  const target = await directSendTargetOf(app.seed.ctx, app.seed.messageId);
  if (!target) throw new Error('Existing canonical reply target required');
  await withTransaction(app.fixture.db, () => recordMatches(app.seed.ctx, { messageId: prior.message.id,
    candidates: [{ firmId: app.firmId, contactId: app.seed.contactId, opportunityId: target.opportunityId,
      rule: 'participant', viaClosedOpportunity: false }] }));
  await withTransaction(app.fixture.db, () => storeMessageBody(app.seed.ctx, { messageId: prior.message.id, text: 'Earlier synthetic discussion context.', truncated: false }));
  await selectReply(page);
  await expect(page.getByText('Earlier synthetic discussion context.', { exact: true })).toBeVisible();
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Real signed session required');
  const baseline = app.calls();
  const requests: unknown[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/replies/composer/generate')) requests.push(request.postDataJSON());
  });
  let reached = () => {};
  const entered = new Promise<void>(resolve => { reached = resolve; });
  let resume = () => {};
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  app.duringGeneration(async () => { reached(); await barrier; });
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/replies/composer/generate'));
  let retained: string | null = null;
  try {
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await entered;
    expect(app.calls()).toBe(baseline + 1);
    retained = await rawCustody(page);
    expect(retained).not.toBeNull();
    const pending = replyAttemptSchema.parse(JSON.parse(retained!));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ commandId: pending.commandId, messageId: app.seed.messageId, sourceRevision: pending.sourceRevision });
    await assertIdsOnly(page);
    // A real port await is held, then a separate committed DB write loses only prior content.
    await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=true WHERE mail_message_id=$1', [prior.message.id]);
    expect(await browserSession(page)).toEqual(session);
  } finally { resume(); }
  try {
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(await response.json()).toEqual({ status: 'refused', replayed: false, reason: 'context_incomplete' });
    await expect(page.getByText('Current source or selected facts are unavailable.', { exact: false })).toBeVisible();
    expect(await rawCustody(page)).toBe(retained);
    expect(await browserSession(page)).toEqual(session);
    await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Reply draft', { exact: true })).toHaveCount(0);
    const pending = replyAttemptSchema.parse(JSON.parse(retained!));
    const reservation = async () => (await app.fixture.db.query('SELECT attempt,state FROM provider_reservations WHERE workspace_id=$1 AND subject_kind=\'outreach_reply\' AND subject_id=$2', [session.workspaceId, pending.commandId])).rows;
    expect(await reservation()).toEqual([{ attempt: 1, state: 'settled' }]);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(await rawCustody(page)).toBe(retained);
    expect(await browserSession(page)).toEqual(session);
    expect(requests).toHaveLength(1);
    expect(app.calls()).toBe(baseline + 1);
    // Restoration reconstitutes the same exact revision, not a fresh paid attempt.
    await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=false WHERE mail_message_id=$1', [prior.message.id]);
    await selectReply(page);
    await expect(page.getByText('Earlier synthetic discussion context.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate suggestion', exact: true })).toBeDisabled();
    expect(await rawCustody(page)).toBe(retained);
    expect(requests).toHaveLength(1);
    const reconciledPromise = page.waitForResponse(response => response.url().endsWith('/replies/composer/generate'));
    await page.getByRole('button', { name: 'Check same reply attempt', exact: true }).click();
    const reconciled = await reconciledPromise;
    expect(reconciled.status()).toBe(200);
    expect(await reconciled.json()).toEqual({ status: 'refused', replayed: true, reason: 'generation_already_attempted' });
    await expect(page.getByText('Same attempt checked.', { exact: false })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(await rawCustody(page)).toBe(retained);
    expect(await browserSession(page)).toEqual(session);
    expect(app.calls()).toBe(baseline + 1);
    expect(await reservation()).toEqual([{ attempt: 1, state: 'settled' }]);
    await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Reply draft', { exact: true })).toHaveValue('');
    await assertIdsOnly(page);
    // Real API authority loss, not a content envelope, must still clear exact custody.
    await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
    const refusedPromise = page.waitForResponse(response => response.url().endsWith('/browser/session'));
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    const signedOut = await refusedPromise;
    expect(signedOut.status()).toBe(200);
    expect(await signedOut.json()).toMatchObject({ status: 'signed_out' });
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    expect(await rawCustody(page)).toBeNull();
    await expect(page.getByRole('region', { name: 'Reply composer', exact: true })).toHaveCount(0);
    expect((await browserRequest(page, '/replies', { body: {} })).status).toBe(401);
    expect(requests).toHaveLength(2);
    expect(app.calls()).toBe(baseline + 1);
    await noOutbound();
    console.log('TARGETED_S743_1_COMPOSED_PASS: paid prior-source loss, safe200, byte-identical IDs-only custody/session, no replacement, reload, exact same-attempt, real401 clears');
  } finally {
    app.duringGeneration();
    await app.fixture.db.query('UPDATE mail_message_bodies SET truncated=false WHERE mail_message_id=$1', [prior.message.id]);
  }
});
