import { expect, test, type Page } from 'playwright/test';
import { expandedFirm, startHomeTestServer, todayState, type HomeTestServer } from './support/homeTestServer.ts';

/**
 * Today keeps itself current (lane g84, audit item G05), end to end against Home's
 * generated test server with the page's clock under the spec's control.
 *
 * The renderer is the shipped file and only the bridges are scripted. These prove what a
 * person sees: how old the list is, a focus that reads it again, the business day's
 * rollover that reads it without anybody there, a failed read beside Retry — and that
 * none of it redraws the lanes when the list did not change, or reads over somebody's
 * typing when it might have.
 *
 * **The vacuous-pass trap.** "The lanes were not redrawn" is proved by a mark set on a
 * card before the read and found on it after; a spec that only looked at the text would
 * pass with every read redrawing the lanes.
 */

let server: HomeTestServer;

test.afterEach(async () => {
  await server.stop();
});

const called = (method: string): unknown[] =>
  server.calls.filter(call => call.method === method).map(call => call.argument);

async function settled(page: Page): Promise<void> {
  await expect.poll(() => called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('today')).toHaveAttribute('aria-busy', 'false');
}

async function markFirstCard(page: Page): Promise<void> {
  await page.getByTestId('today-card').first().evaluate(card => {
    (card as HTMLElement).dataset['mark'] = 'kept';
  });
}

async function focusWindow(page: Page): Promise<void> {
  const reads = called('admin.state').length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The focus handler reads the sidebar every time; once that has been asked for, the
  // handler has run and any read of the list it was going to make has been asked for too.
  await expect.poll(() => called('admin.state').length).toBeGreaterThan(reads);
}

test('the list says how old it is, and the minutes move without redrawing anything', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-21T13:00:20.000Z') });
  server = await startHomeTestServer();
  await page.goto(server.url);
  await settled(page);

  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated just now');
  await markFirstCard(page);
  await page.clock.runFor(5 * 60_000);
  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated 5 min ago');
  await expect(page.getByTestId('today-card').first()).toHaveAttribute('data-mark', 'kept');
  // Five minutes of ticks at 09:05 in New York is no reason to read the list again.
  expect(called('today.refresh')).toHaveLength(1);
});

test('a focus a minute after the last read reads the list again, quietly, and keeps the lanes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-21T13:00:20.000Z') });
  server = await startHomeTestServer({
    onRefresh: (today, count) => ({ ...today, asOf: count === 1 ? '2026-09-21T13:00:00.000Z' : '2026-09-21T13:05:00.000Z' }),
  });
  await page.goto(server.url);
  await settled(page);
  await markFirstCard(page);

  // Within the minute: nothing.
  await page.clock.runFor(30_000);
  await focusWindow(page);
  expect(called('today.refresh')).toHaveLength(1);

  await page.clock.runFor(5 * 60_000);
  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated 5 min ago');
  await focusWindow(page);
  await expect.poll(() => called('today.refresh')).toEqual([null, { quiet: true }]);
  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated just now');
  // Only the read time changed, so the lanes on screen are the ones drawn before.
  await expect(page.getByTestId('today-card').first()).toHaveAttribute('data-mark', 'kept');

  // And not again straight away.
  await focusWindow(page);
  expect(called('today.refresh')).toHaveLength(2);
});

test('a read Home would make by itself waits while somebody is typing in the lanes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-21T13:00:20.000Z') });
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');
  await page.getByTestId('heading').click();
  await page.clock.runFor(5 * 60_000);
  await focusWindow(page);
  expect(called('today.refresh')).toHaveLength(1);
  await expect(page.getByTestId('snooze-reason').nth(1)).toHaveValue('Waiting on their board');
});

test('the business day’s rollover reads the list with nobody there, and looks again ten minutes on', async ({ page }) => {
  // 04:59 in New York on Tuesday; the list on screen is Monday's.
  await page.clock.install({ time: new Date('2026-09-22T08:59:00.000Z') });
  server = await startHomeTestServer({
    today: todayState({ asOf: '2026-09-22T08:59:00.000Z' }),
    onRefresh: (today, count) =>
      count === 1 ? today : { ...today, snapshotDate: '2026-09-22', asOf: count === 2 ? '2026-09-22T09:00:30.000Z' : '2026-09-22T09:10:30.000Z' },
  });
  await page.goto(server.url);
  await settled(page);
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');

  await page.clock.runFor(90_000);
  await expect.poll(() => called('today.refresh')).toEqual([null, { quiet: true }]);
  await expect(page.getByTestId('heading')).toHaveText('Tuesday, 22 September');

  await page.clock.runFor(10 * 60_000);
  await expect.poll(() => called('today.refresh')).toHaveLength(3);
  await page.clock.runFor(30 * 60_000);
  expect(called('today.refresh')).toHaveLength(3);
});

test('a failed read says so beside Retry, over the list it kept, and Retry reads again', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-21T13:00:20.000Z') });
  server = await startHomeTestServer({
    onRefresh: (today, count) =>
      count === 2
        ? { ...today, online: false, stale: true }
        : { ...today, online: true, stale: false, asOf: count === 1 ? '2026-09-21T13:00:00.000Z' : '2026-09-21T13:02:30.000Z' },
  });
  await page.goto(server.url);
  await settled(page);
  await expect(page.getByTestId('today-refresh-failed')).toHaveCount(0);

  await page.clock.runFor(2 * 60_000);
  await focusWindow(page);
  await expect(page.getByTestId('today-refresh-failed')).toHaveText(' · Could not refresh.');
  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated 2 min ago');
  // The existing lines say why, and the list stays readable.
  await expect(page.getByTestId('banner-warning').first()).toContainText('cannot reach the server');
  await expect(page.getByTestId('today-card')).toHaveCount(4);

  await page.getByTestId('today-retry').click();
  await expect.poll(() => called('today.refresh')).toHaveLength(3);
  await expect(page.getByTestId('today-refresh-failed')).toHaveCount(0);
  await expect(page.getByTestId('today-updated-text')).toHaveText('Updated just now');
});
