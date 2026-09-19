import { rm } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { startStubWorker, type StubWorker } from './stubWorker';
import { launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The Week page on the real seam (slice S5): the built client as an Electron app against the stub worker. The page
 * reads `/v1/week` and shows it; there is no control on it, because there is no decision to make about a week that
 * already happened. Two honest statements are checked below as well as the numbers: the days with no spend counter
 * are named rather than counted as zero, and the hold counts are said to come from a log that expires.
 */
let stub: StubWorker;
let userData: string;
let client: LaunchedClient | undefined;

test.beforeEach(async () => {
  stub = await startStubWorker();
  userData = await newUserData();
  client = await launchClient({ endpoint: stub.url, userData });
  await pairThroughUi(client.page, stub);
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close();
  await rm(userData, { recursive: true, force: true });
});

test('shows the seven Eastern days, the totals, the calls by outcome and the holds, and reads nothing else', async () => {
  const { page } = client!;
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Week', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('.week__range')).toHaveText('2026-09-12 to 2026-09-18, Eastern days.');

  const totals = page.getByRole('list', { name: 'Totals', exact: true });
  await expect(totals.locator('[data-total="calls"]')).toHaveText('Calls: 28');
  await expect(totals.locator('[data-total="emails"]')).toHaveText('Emails sent: 14');
  await expect(totals.locator('[data-total="replies"]')).toHaveText('Replies: 4');
  await expect(totals.locator('[data-total="callbacks"]')).toHaveText('Callbacks: 3 promised, 2 kept');
  await expect(totals.locator('[data-total="researched"]')).toHaveText('Firms researched: 34');
  // A day with no counter is named, never read as zero.
  await expect(totals.locator('[data-total="spend"]')).toContainText('Research spend: 0.18 USD');
  await expect(totals.locator('[data-total="spend"]')).toContainText('2 of 7 days have no counter');

  const outcomes = page.getByRole('list', { name: 'Calls by outcome', exact: true });
  await expect(outcomes.locator('li')).toHaveCount(4);
  await expect(outcomes.locator('[data-outcome="answered_interested"]')).toHaveText('answered interested: 3');
  await expect(outcomes.locator('[data-outcome="voicemail"]')).toHaveText('voicemail: 10');

  const holds = page.getByRole('list', { name: 'Holds', exact: true });
  await expect(holds.locator('[data-hold="cap_reached"]')).toHaveText('cap reached (cap_reached): 4');
  await expect(holds.locator('[data-hold="no_posture"]')).toHaveText('state not cleared (no_posture): 2');
  await expect(page.getByText('Holds come from the attempt log, which keeps thirty days.', { exact: false })).toBeVisible();

  // Seven rows, oldest first, and the days add up to the totals shown above.
  const rows = page.locator('.week__days tbody tr');
  await expect(rows).toHaveCount(7);
  expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-day'))))
    .toEqual(['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
  const calls = await rows.evaluateAll((nodes) => nodes.map((node) => Number(node.querySelectorAll('td')[0]?.textContent)));
  expect(calls.reduce((total, value) => total + value, 0)).toBe(28);

  // The page read the week and issued no command: there is nothing to decide here.
  expect(stub.requests.some((request) => request.method === 'GET' && request.path === '/v1/week')).toBe(true);
  expect(stub.commands).toEqual([]);
});

test('says plainly when the worker refuses the week, and never shows a week it did not read', async () => {
  const { page } = client!;
  const device = stub.pairedDevices()[0]!;
  stub.revokeDevice(device.deviceId);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Week', exact: true, level: 1 })).toBeVisible();
  // The refusal is shown in the worker's own words, and no week at all is drawn: not an empty one, not an old one.
  await expect(page.locator('.page--week').getByRole('alert')).toContainText('revoked');
  await expect(page.locator('.week__days')).toHaveCount(0);
  await expect(page.locator('.week__totals')).toHaveCount(0);
  await expect(page.locator('.page--week .page__stamp')).toHaveText('Not read yet.');
});
