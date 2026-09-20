import { expect, test } from 'playwright/test';
import {
  AUTOMATED_ITEM_ID,
  FIRM_ID,
  MANUAL_ITEM_ID,
  ROUTE_ID,
  expandedFirm,
  startTodayTestServer,
  todayState,
  type TodayTestServer,
} from './support/todayTestServer.ts';

/**
 * The Today window, driven end to end against the generated test server.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees and can press: the aggregate cards in
 * the order the server sent them, one card per firm however many people are at it,
 * the expansion into contact tasks, the two different delay controls, the dial and
 * its limitation notice, and the outage in which everything is readable and nothing
 * is pressable.
 */

let server: TodayTestServer;

test.afterEach(async () => {
  await server.stop();
});

test('shows one aggregate card per firm, in the order the server sent', async ({ page }) => {
  server = await startTodayTestServer(todayState());
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Today');
  await expect(page.getByTestId('snapshot-date')).toHaveText('2026-09-21');
  await expect(page.getByTestId('today-card')).toHaveCount(2);

  // Five people are due at Northwind; there is one card, and it carries the counts.
  await expect(page.getByTestId('card-firm').nth(0)).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('card-lane').nth(0)).toHaveText('Callback');
  await expect(page.getByTestId('card-counts').nth(0)).toHaveText('3 emails, 1 call, 1 LinkedIn task');

  // The new firm's instant is three weeks earlier and it is still second: the lane
  // decides, and the window never re-sorts what the snapshot ordered.
  await expect(page.getByTestId('card-lane').nth(1)).toHaveText('New firm');
});

test('a firm name that looks like markup is shown as text', async ({ page }) => {
  const base = todayState();
  const first = base.cards[0];
  if (first === undefined) throw new Error('fixture');
  server = await startTodayTestServer({
    ...base,
    cards: [{ ...first, firmName: '<img src=x onerror=alert(1)>' }],
  });
  await page.goto(server.url);
  await expect(page.getByTestId('card-firm').nth(0)).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

test('expanding a card reveals one task per contact, in lane order', async ({ page }) => {
  server = await startTodayTestServer(todayState());
  await page.goto(server.url);

  await page.getByTestId('card-expand').nth(0).click();
  await expect(page.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('today-task')).toHaveCount(5);
  await expect(page.getByTestId('task-kind').nth(0)).toHaveText('Callback');
  await expect(page.getByTestId('task-contact').nth(0)).toHaveText('Dana Example');
  // A firm-level task has no person, and says so rather than showing an empty cell.
  await expect(page.getByTestId('task-contact').nth(4)).toHaveText('—');
  await expect(page.getByTestId('task-snoozed')).toHaveCount(1);

  expect(server.calls.find(call => call.method === 'expand')?.argument).toEqual({ firmId: FIRM_ID });
});

test('a manual task is snoozed and an automated send is held, and the server decides which', async ({ page }) => {
  server = await startTodayTestServer(todayState({ expanded: expandedFirm() }));
  await page.goto(server.url);

  // The labels differ, so nobody presses "snooze" and gets a hold they did not want.
  await expect(page.getByTestId('snooze-submit').nth(1)).toHaveText('Snooze');
  await expect(page.getByTestId('snooze-submit').nth(2)).toHaveText('Hold this send');

  // A reason and a return instant are both required before either can be pressed.
  await expect(page.getByTestId('snooze-submit').nth(1)).toBeDisabled();
  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');
  await expect(page.getByTestId('snooze-submit').nth(1)).toBeDisabled();
  await page.getByTestId('snooze-return').nth(1).fill('2026-09-24T09:00');
  await expect(page.getByTestId('snooze-submit').nth(1)).toBeEnabled();
  await page.getByTestId('snooze-submit').nth(1).click();

  await expect(page.getByTestId('banner-info')).toContainText('Snoozed.');
  expect(server.calls.find(call => call.method === 'snooze')?.argument).toEqual({
    itemId: MANUAL_ITEM_ID,
    reason: 'Waiting on their board',
    returnAt: '2026-09-24T09:00',
  });
});

test('the same request on an automated send comes back as a hold', async ({ page }) => {
  server = await startTodayTestServer(todayState({ expanded: expandedFirm() }));
  await page.goto(server.url);

  await page.getByTestId('snooze-reason').nth(2).fill('Their office is closed this week');
  await page.getByTestId('snooze-return').nth(2).fill('2026-09-24T09:00');
  await page.getByTestId('snooze-submit').nth(2).click();

  await expect(page.getByTestId('banner-info')).toContainText('recorded a hold instead of a snooze');
  const sent = server.calls.find(call => call.method === 'snooze')?.argument as { itemId: string };
  expect(sent.itemId).toBe(AUTOMATED_ITEM_ID);
});

test('only a usable number is offered, with the limitation notice beside it', async ({ page }) => {
  server = await startTodayTestServer(todayState({ expanded: expandedFirm() }));
  await page.goto(server.url);

  // Two routes on the card, one of them a candidate. One Call button.
  await expect(page.getByTestId('dial')).toHaveCount(1);
  await expect(page.getByTestId('dial')).toHaveText('Call +14015550187');
  await expect(page.getByTestId('dial-limitation')).toContainText('cannot recall it');

  await page.getByTestId('dial').click();
  await expect(page.getByTestId('banner-info')).toContainText('Handed to the phone app.');
  expect(server.calls.find(call => call.method === 'dial')?.argument).toEqual({
    firmId: FIRM_ID,
    contactId: null,
    routeId: ROUTE_ID,
    // 9.2: the version the card displays is the version the server checks.
    routeVersion: 3,
  });
});

test('a firm with no verified number of the caller’s offers no Call button', async ({ page }) => {
  server = await startTodayTestServer(
    todayState({ expanded: expandedFirm({ callingIdentityId: null }) }),
  );
  await page.goto(server.url);
  await expect(page.getByTestId('dial')).toHaveCount(0);
});

test('an outcome will not record until it has everything it needs', async ({ page }) => {
  server = await startTodayTestServer(todayState({ expanded: expandedFirm() }));
  await page.goto(server.url);

  await expect(page.getByTestId('outcome-submit')).toBeDisabled();
  await page.getByTestId('outcome-select').selectOption('callback_requested');
  // 9.1: the callback is created "after salesperson confirmation of the instant", so
  // the form asks for the day and refuses without it.
  await expect(page.getByTestId('outcome-callback')).toBeVisible();
  await expect(page.getByTestId('outcome-submit')).toBeDisabled();
  await expect(page.getByTestId('outcome-problem')).toContainText('the day you promised');

  await page.getByTestId('callback-date').fill('2026-09-24');
  await page.getByTestId('callback-time').fill('14:00');
  await expect(page.getByTestId('outcome-submit')).toBeEnabled();
  await page.getByTestId('outcome-submit').click();
  await expect(page.getByTestId('banner-info')).toContainText('Call recorded.');
});

test('“do not call” says how wide the suppression is before it is recorded', async ({ page }) => {
  server = await startTodayTestServer(todayState({ expanded: expandedFirm() }));
  await page.goto(server.url);
  await page.getByTestId('outcome-select').selectOption('do_not_call');
  await expect(page.getByTestId('outcome-warning')).toContainText('stops Callie calling this number');
});

test('an outage leaves the list readable and nothing pressable', async ({ page }) => {
  server = await startTodayTestServer(
    todayState({ online: false, stale: true, expanded: expandedFirm() }),
  );
  await page.goto(server.url);

  await expect(page.getByTestId('banner-warning').nth(0)).toContainText('cannot reach the server');
  await expect(page.getByTestId('banner-warning').nth(1)).toContainText('from an earlier read');
  await expect(page.getByTestId('today-card')).toHaveCount(2);
  await expect(page.getByTestId('card-counts').nth(0)).toHaveText('3 emails, 1 call, 1 LinkedIn task');

  await expect(page.getByTestId('card-expand').nth(0)).toBeDisabled();
  await expect(page.getByTestId('snooze-submit').nth(0)).toBeDisabled();
  await expect(page.getByTestId('dial')).toHaveCount(0);
  await expect(page.getByTestId('outcome-submit')).toBeDisabled();
});

test('an empty list says so rather than showing nothing', async ({ page }) => {
  server = await startTodayTestServer(todayState({ cards: [] }));
  await page.goto(server.url);
  await expect(page.getByTestId('today-empty')).toHaveText('Nothing is due today.');
});
