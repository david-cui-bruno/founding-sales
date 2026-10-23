import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from 'playwright/test';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { recordMessage, storeMessageBody } from '@fss/domain/mail/messages.ts';
import { directSendTargetOf, recordMatches } from '@fss/domain/mail/matching.ts';
import { promoteReply } from '@fss/domain/today/promotions.ts';
import { replyAttemptSchema, REPLY_PENDING_KEY, type PendingReplyAttempt } from '../../src/client/ReplyAttempt.ts';
import type { ReplyBriefApp } from './replyBriefApp.ts';

export async function loginCustody(page: Page, app: ReplyBriefApp): Promise<void> {
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) return await route.abort('blockedbyclient');
    if (url.pathname !== '/browser/sign-in') return await route.continue();
    const response = await route.fetch();
    const body = await response.json() as { authorizationUrl?: string };
    expect(response.status()).toBe(200);
    if (!body.authorizationUrl) throw new Error('Signed OIDC required');
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.origin).toBe(app.fixture.google.issuer);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    await route.fulfill({ response, json: { authorizationUrl: `${app.origin}/__local/provider?${authorization.searchParams.toString()}` } });
  });
  await page.goto(app.origin);
  const browsers = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes('--remote-debugging-pipe') && line.includes('--user-data-dir=') && line.includes('playwright_chromiumdev_profile-') && !line.includes('--type='));
  expect(browsers).toHaveLength(1);
  const browser = browsers[0]!;
  const profilePath = /--user-data-dir=([^ ]+)/u.exec(browser)?.[1];
  if (!profilePath) throw new Error('Owned browser profile not found');
  console.log('REPLY_CUSTODY_BROWSER_RESERVED', JSON.stringify({ pid: Number(browser.trim().split(/\s+/u)[0]), profilePath }));
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
}

/** Second ordinary incoming reply uses the same canonical mailbox, target and approval.
 * No duplicated prepared-brief rows or fake principal/context are introduced. */
export async function seedCustodyReply(app: ReplyBriefApp, subject: string) {
  const { fixture: f, seed } = app;
  const target = await directSendTargetOf(seed.ctx, seed.messageId);
  if (!target) throw new Error('Canonical reply target required');
  const original = (await f.db.query<{ header_to: string[] }>('SELECT header_to FROM mail_messages WHERE id=$1', [seed.messageId])).rows[0]!;
  const id = randomUUID();
  const message = await withTransaction(f.db, () => recordMessage(seed.ctx, { mailboxId: seed.mailboxId, metadata: {
    providerMessageId: id, providerThreadId: id, rfcMessageId: `${id}@example.test`, direction: 'incoming',
    internalDate: new Date().toISOString(), headerFrom: seed.recipient, headerTo: original.header_to,
    headerCc: [], subject, referenceMessageIds: [], inReplyTo: null, autoSubmitted: null, listId: null, labelIds: [], attachments: [],
  } }));
  await withTransaction(f.db, () => recordMatches(seed.ctx, { messageId: message.message.id, candidates: [{
    firmId: app.firmId, contactId: seed.contactId, opportunityId: target.opportunityId, rule: 'participant', viaClosedOpportunity: false,
  }] }));
  await withTransaction(f.db, () => storeMessageBody(seed.ctx, { messageId: message.message.id, text: `Original ${subject}`, truncated: false }));
  await withTransaction(f.db, () => promoteReply(seed.ctx, { firmId: app.firmId, contactId: seed.contactId, messageId: message.message.id, receivedAt: new Date().toISOString() }));
  return { id: message.message.id, subject, text: `Original ${subject}` };
}
export async function selectCustodyReply(page: Page, subject: string, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await page.getByRole('button', { name: `Reply Brief Synthetic Firm: ${subject}`, exact: true }).click();
  await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}
export async function custodyRecords(page: Page): Promise<PendingReplyAttempt[]> {
  const raw = await page.evaluate(key => sessionStorage.getItem(key), REPLY_PENDING_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  const legacy = replyAttemptSchema.safeParse(parsed);
  if (legacy.success) return [legacy.data];
  const collection = parsed as { version: number; records: unknown[] };
  expect(collection.version).toBe(2);
  return collection.records.map(record => replyAttemptSchema.parse(record));
}
export async function assertPrivateStorage(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(JSON.stringify(state)).not.toMatch(/Original Custody|maintenance plan|Thank you|prospect-|owner-|accessToken|deviceSecret|handoffSecret|code_verifier/u);
  expect(state.cookies).toBe('');
}
export async function noCustodyOutbound(app: ReplyBriefApp): Promise<void> {
  for (const table of ['outbound_messages', 'human_reply_send_intents', 'outbound_message_events']) {
    expect((await app.fixture.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]?.count, table).toBe('0');
  }
  expect((await app.fixture.db.query("SELECT 1 FROM jobs WHERE kind='reply.human_send'")).rows).toHaveLength(0);
  expect((await app.fixture.db.query("SELECT 1 FROM mail_messages WHERE direction='outgoing'")).rows).toHaveLength(0);
}
