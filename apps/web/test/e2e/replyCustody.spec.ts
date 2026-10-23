import { access } from 'node:fs/promises';
import { test, expect } from 'playwright/test';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { setProspectingAuthorization } from '@fss/domain/outreach/authorization.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { startReplyBriefApp, type ReplyBriefApp } from '../support/replyBriefApp.ts';
import { reserveLocalBrowserDatabase } from '../support/database.ts';
import { browserSession } from '../support/browser.ts';
import { loginCustody, seedCustodyReply, selectCustodyReply, custodyRecords, assertPrivateStorage, noCustodyOutbound } from '../support/replyCustody.ts';

// Run only this file after both implementation freezes and root's sole-lane grant.
let app: ReplyBriefApp;
let release: (() => Promise<void>) | undefined;
test.beforeAll(async () => {
  release = await reserveLocalBrowserDatabase();
  const cluster = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  console.log('REPLY_CUSTODY_CLUSTER_TEMPLATE_RESERVED', JSON.stringify({ host: cluster.hostname, port: cluster.port, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] }));
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
      console.log('REPLY_CUSTODY_CLUSTER_PID_DIRECTORY_TEMPLATE_ABSENT');
    }
  }
});
test.afterEach(async ({ context }) => {
  app?.duringGeneration();
  await context.close();
  await noCustodyOutbound(app);
});

for (const lost of [false, true]) {
  test(`747 ordinary A→B→A retains ${lost ? 'lost-response' : 'settled'} A across reload`, async ({ page }) => {
    const a = await seedCustodyReply(app, `Custody A ${lost ? 'lost' : 'settled'}`);
    const b = await seedCustodyReply(app, `Custody B ${lost ? 'lost' : 'settled'}`);
    await loginCustody(page, app);
    await selectCustodyReply(page, a.subject, a.text);
    const baseline = app.calls();
    const requests: unknown[] = [];
    page.on('request', request => { if (request.url().endsWith('/replies/composer/generate')) requests.push(request.postDataJSON()); });
    if (lost) await page.route('**/replies/composer/generate', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    if (lost) await expect(page.getByText('Current source or operation unavailable.', { exact: false })).toBeVisible();
    else await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toBeVisible();
    const heldA = (await custodyRecords(page)).find(record => record.messageId === a.id);
    expect(heldA).toBeDefined();
    expect(app.calls()).toBe(baseline + 1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(app.calls()).toBe(baseline + 1);
    expect((await custodyRecords(page)).find(record => record.messageId === a.id)).toEqual(heldA);
    await selectCustodyReply(page, b.subject, b.text);
    await expect(page.getByRole('button', { name: 'Generate suggestion', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toBeVisible();
    const records = await custodyRecords(page);
    expect(records).toHaveLength(2);
    expect(records.find(record => record.messageId === a.id)).toEqual(heldA);
    expect(records.find(record => record.messageId === b.id)?.commandId).not.toBe(heldA?.commandId);
    expect(app.calls()).toBe(baseline + 2);
    await selectCustodyReply(page, a.subject, a.text);
    await expect(page.getByRole('button', { name: 'Generate suggestion', exact: true })).toBeDisabled();
    const reconciled = page.waitForResponse(response => response.url().endsWith('/replies/composer/generate'));
    await page.getByRole('button', { name: 'Check same reply attempt', exact: true }).click();
    expect(await (await reconciled).json()).toEqual({ status: 'refused', replayed: true, reason: 'generation_already_attempted' });
    await expect(page.getByText('Same attempt checked.', { exact: false })).toBeVisible();
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[0]);
    expect(app.calls()).toBe(baseline + 2);
    expect(await custodyRecords(page)).toEqual(records);
    await assertPrivateStorage(page);
  });
}

test('747 paid readiness loss preserves authority and UUID, true mailbox revocation clears every record', async ({ page }) => {
  const a = await seedCustodyReply(app, 'Custody readiness A');
  const b = await seedCustodyReply(app, 'Custody readiness B');
  await loginCustody(page, app);
  await selectCustodyReply(page, a.subject, a.text);
  const session = await browserSession(page);
  expect(session.status).toBe('signed_in');
  const baseline = app.calls();
  const requests: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/replies/composer/generate')) requests.push(request.postDataJSON()); });
  // Controlled generation await, actual committed mailbox readiness loss after paid entry.
  app.duringGeneration(async () => {
    await app.fixture.db.query("UPDATE mailboxes SET sync_state='recovering' WHERE id=$1", [app.seed.mailboxId]);
  });
  const result = page.waitForResponse(response => response.url().endsWith('/replies/composer/generate'));
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'refused', replayed: false, reason: 'mailbox_not_ready' });
  await expect(page.getByText('Current source or selected facts are unavailable.', { exact: false })).toBeVisible();
  const heldA = (await custodyRecords(page))[0]!;
  expect(heldA.messageId).toBe(a.id);
  expect(await browserSession(page)).toEqual(session);
  expect(app.calls()).toBe(baseline + 1);
  await expect(page.getByLabel('Reply draft', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(await custodyRecords(page)).toEqual([heldA]);
  expect(app.calls()).toBe(baseline + 1);
  app.duringGeneration();
  await app.fixture.db.query("UPDATE mailboxes SET sync_state='ready' WHERE id=$1", [app.seed.mailboxId]);
  await selectCustodyReply(page, b.subject, b.text);
  await page.getByRole('button', { name: 'Generate suggestion', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toBeVisible();
  await selectCustodyReply(page, a.subject, a.text);
  await expect(page.getByRole('button', { name: 'Generate suggestion', exact: true })).toBeDisabled();
  const reconciled = page.waitForResponse(value => value.url().endsWith('/replies/composer/generate'));
  await page.getByRole('button', { name: 'Check same reply attempt', exact: true }).click();
  expect(await (await reconciled).json()).toEqual({ status: 'refused', replayed: true, reason: 'generation_already_attempted' });
  await expect(page.getByText('Same attempt checked.', { exact: false })).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual(requests[0]);
  expect((await custodyRecords(page)).find(record => record.messageId === a.id)).toEqual(heldA);
  expect(await browserSession(page)).toEqual(session);
  expect(app.calls()).toBe(baseline + 2);
  await assertPrivateStorage(page);
  const authorization = (await app.fixture.db.query<{ revision: number }>('SELECT revision FROM gmail_prospecting_authorizations WHERE mailbox_id=$1', [app.seed.mailboxId])).rows[0]!;
  const revoked = await withTransaction(app.fixture.db, () => setProspectingAuthorization(app.seed.admin, { mailboxId: app.seed.mailboxId, expectedRevision: authorization.revision, enabled: false, basis: 'owner_reported_google_permission' }));
  expect(revoked.ok).toBe(true);
  await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
  await expect.poll(async () => await custodyRecords(page)).toEqual([]);
  await expect(page.getByRole('region', { name: 'Reply composer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Reply suggestion', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Reply draft', { exact: true })).toHaveCount(0);
  expect(app.calls()).toBe(baseline + 2);
});
