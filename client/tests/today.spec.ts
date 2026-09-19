import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startStubWorker, todayFixture, type StubWorker } from './stubWorker';
import { clientFile, launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The Today page on the real seam (slice S1): the built renderer, preload and main process against the stub
 * worker. Four lane sections in the fixed order with their cards, the posture warning from the header's
 * states without posture, and the stale banner when the stub is stopped and the main process serves the
 * last good file it kept. Nothing here dials: the dial verdict on a card is the worker's word.
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
  await stub.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true });
});

const openToday = async (page: Page) => {
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true, level: 1 })).toBeVisible();
};
const lanes = (page: Page) => page.locator('section.today-lane');
const todayReads = () => stub.requests.filter(request => request.method === 'GET' && request.path === '/v1/today');

test('renders the four lanes in order from the stub, with the cards, the counts row, the as-of stamp and no stale banner', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(lanes(page)).toHaveCount(4);
  expect(await lanes(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-lane')))).toEqual(['replies', 'callbacks', 'due', 'new']);
  await expect(page.getByRole('heading', { name: 'Replies (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Callbacks due (0)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sequence calls due (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New firms (2)', exact: true })).toBeVisible();
  const list = stub.today.list!;
  for (const card of [...list.lanes.replies, ...list.lanes.due, ...list.lanes.new]) {
    await expect(page.locator(`.today-card[data-firm-id="${card.firmId}"]`).getByRole('heading', { name: card.name, exact: true })).toBeVisible();
  }
  // The dial verdict is the worker's, shown as sent: the Texas card is held outside hours at 06:00 local.
  const tx = page.locator('.today-card[data-firm-id="account-tx-1"]');
  await expect(tx).toHaveAttribute('data-dial-allowed', 'false');
  await expect(tx.getByText('Held: outside_hours at 06:00 local', { exact: true })).toBeVisible();
  await expect(tx.getByText('Call 2 of 5', { exact: false })).toBeVisible();
  await expect(page.locator('.today-card[data-firm-id="account-ri-1"]')).toHaveAttribute('data-dial-allowed', 'true');
  await expect(page.getByRole('button', { name: 'Copy number for Rhode Island Firm 1', exact: true })).toBeVisible();
  await expect(page.getByText('1 replies · 0 callbacks · 1 due · 2 new · pool 2', { exact: true })).toBeVisible();
  await expect(page.locator('.today-as-of time')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  // The read went to the worker with the device's token, and the last good file now holds exactly what the stub served.
  expect(todayReads().length).toBeGreaterThan(0);
  expect(todayReads().every(request => request.authenticated)).toBe(true);
  expect(JSON.parse(readFileSync(clientFile(userData, 'today-last-good.json'), 'utf8')).view).toEqual(stub.today);
});

test('shows the posture warning when the header reports states without posture, and none when every state has one', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(page.getByRole('alert')).toHaveText('No calling posture is recorded for MA and TX. Firms in these states are held until you record one.');
  const fixture = todayFixture();
  stub.setToday({ ...fixture, list: { ...fixture.list!, header: { ...fixture.list!.header, statesWithoutPosture: [] } } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // An empty answer still warns: no posture anywhere names the state the firms derive to.
  stub.setToday({ asOf: fixture.asOf, list: null, reason: 'no_posture', postures: [], statesWithoutPosture: ['RI'] });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('No calling posture is recorded for RI. Firms in this state are held until you record one.');
  await expect(page.locator('[data-empty-reason="no_posture"]')).toBeVisible();
  await expect(lanes(page)).toHaveCount(0);
});

test('shows the stale banner and keeps the lanes when the stub is stopped and the last good file is served', async () => {
  const { page } = client!;
  await openToday(page);
  await expect(lanes(page)).toHaveCount(4);
  const lastGood = clientFile(userData, 'today-last-good.json');
  expect(existsSync(lastGood)).toBe(true);
  const savedAt = JSON.parse(readFileSync(lastGood, 'utf8')).fetchedAt as string;

  await stub.close();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const banner = page.getByRole('status');
  await expect(banner).toHaveAttribute('data-stale-reason', 'last_good');
  await expect(banner).toContainText('Showing the last good list saved on this Mac');
  // The lanes are still the saved ones: a morning survives an outage. The as-of stamp is the saved fetch, not now.
  await expect(lanes(page)).toHaveCount(4);
  await expect(page.locator('.today-as-of time')).toHaveAttribute('datetime', savedAt);
  expect(JSON.parse(readFileSync(lastGood, 'utf8')).fetchedAt).toBe(savedAt);

  // A restart with the worker still down serves the same saved list, stale, on mount.
  await client!.close();
  client = await launchClient({ endpoint: stub.url, userData });
  await openToday(client.page);
  await expect(client.page.getByRole('status')).toHaveAttribute('data-stale-reason', 'last_good');
  await expect(lanes(client.page)).toHaveCount(4);
});
