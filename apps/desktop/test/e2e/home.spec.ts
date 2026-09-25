import { expect, test, type Page } from 'playwright/test';
import {
  AUTOMATED_ITEM_ID,
  FIRM_ID,
  MANUAL_ITEM_ID,
  ROUTE_ID,
  connectedMailbox,
  desktopState,
  diagnostics,
  expandedFirm,
  notConnectedMailbox,
  readyAdmin,
  sendingPosture,
  startHomeTestServer,
  todayState,
  type HomeTestServer,
} from './support/homeTestServer.ts';

/**
 * Home: the main window once a person is signed in (lane g65).
 *
 * The renderer is the shipped file; only the four bridges are substituted, so what these
 * specs prove is what a person sees and can press: the business date and a line of
 * counts, the lanes in the order the server sent, the sidebar's windows and status, the
 * last seven days, and a Needs-you list that holds only what the bridges say is missing.
 *
 * G6's Today window specs are folded in here unchanged in what they assert, because the
 * lanes they drove are Home's lanes now: one card per firm, the expansion into contact
 * tasks, the two delay controls, the dial and its limitation notice, the outcome form,
 * and the outage in which everything is readable and nothing is pressable.
 */

let server: HomeTestServer;

test.afterEach(async () => {
  await server.stop();
});

const called = (method: string): unknown[] =>
  server.calls.filter(call => call.method === method).map(call => call.argument);

/**
 * Wait for Home's first reads: the cached list, then today's. The lanes are `aria-busy`
 * while a Today call is in flight, so a spec that presses something in them presses it
 * on the list the page will keep.
 */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('today')).toHaveAttribute('aria-busy', 'false');
}

/** Record any dialog, so a spec can prove none was opened. */
function dialogsOf(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

test('Home opens on the business date, a line of counts, and the four lanes in the server’s order', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  // Sending is off on this workspace, so the list's emails are counted as held.
  await expect(page.getByTestId('summary')).toHaveText('4 firms · 1 reply · 1 callback · 4 emails held');

  await expect(page.getByTestId('lane-label')).toHaveText(['Replies', 'Callbacks', 'Due today', 'New firms']);
  await expect(page.getByTestId('lane-count')).toHaveText(['1', '1', '1', '1']);
  // The new firm's instant is three weeks earlier and it is still last: the lane
  // decides, and the page never re-sorts what the snapshot ordered.
  await expect(page.getByTestId('card-firm')).toHaveText([
    'Ashgrove Test Partners',
    'Northwind Test Holdings',
    'Copperline Test Holdings',
    'Larkspur Test Foundry',
  ]);
  // Five people are due at Northwind; there is one card, and it carries the counts.
  await expect(page.getByTestId('card-counts').nth(1)).toHaveText('3 emails, 1 call, 1 LinkedIn task');
  await expect(page.getByTestId('card-counts').nth(3)).toHaveText('Nothing outstanding');

  // The cached list first, then today's: the morning list is there without a press.
  await settled(page);
  expect(server.calls.map(call => call.method).filter(method => method.startsWith('today.'))).toEqual([
    'today.state',
    'today.refresh',
  ]);
});

test('the sidebar names every window with its key and opens the one pressed', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);

  const nav = page.getByTestId('nav');
  await expect(nav.getByRole('button')).toHaveText([
    'Today⌘1',
    'Replies⌘2',
    'Firms⌘3',
    'Sequences⌘4',
    'Dashboard⌘6',
    'Administration⌘5',
  ]);
  await expect(page.getByTestId('nav-today')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('nav-replies').click();
  await expect.poll(() => called('callie.openWindow')).toEqual([{ window: 'dashboard' }, { window: 'replies' }]);
});

test('the sidebar says what state the system is in, in dots and words', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);

  await expect(page.getByTestId('status-mailbox')).toHaveText('Mailbox connected · sales@example.test');
  await expect(page.getByTestId('status-calling')).toHaveText('Calling from +1 617 ··· 0100');
  await expect(page.getByTestId('status-sending')).toHaveText('Sending off');
  await expect(page.getByTestId('status-domain')).toHaveText('Domain passes · sending.example.test');
  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.0.3 · online');
  await expect(page.getByTestId('status-sending')).toHaveAttribute('data-tone', 'warn');
  await expect(page.getByTestId('status-calling')).toHaveAttribute('data-tone', 'ok');
  // Status lives here, not in a banner above the list.
  await expect(page.getByTestId('banners').locator('p')).toHaveCount(0);
});

test('Needs you lists only what the bridges say is missing, and each row does its one thing', async ({ page }) => {
  server = await startHomeTestServer({
    mailbox: notConnectedMailbox(),
    admin: readyAdmin({
      callingNumbers: [],
      sendingAdmin: sendingPosture(),
      diagnostics: diagnostics(),
    }),
  });
  await page.goto(server.url);

  const rows = page.getByTestId('needs-row');
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId('needs-label')).toHaveText([
    'Connect Gmail',
    'Add your calling number',
    'Record the domain checklist',
    '1 alert to acknowledge',
  ]);
  await expect(page.getByTestId('status-calling')).toHaveText('No calling number');
  await expect(page.getByTestId('status-domain')).toHaveText('Domain checklist not passing · sending.example.test');

  await rows.filter({ hasText: 'Add your calling number' }).getByTestId('needs-open').click();
  await expect.poll(() => called('callie.openWindow')).toEqual([{ window: 'administration' }]);

  await page.getByTestId('needs-connect').click();
  await expect.poll(() => called('mailbox.connect')).toHaveLength(1);
  await expect(page.getByTestId('needs-label')).toHaveText([
    'Add your calling number',
    'Record the domain checklist',
    '1 alert to acknowledge',
  ]);
  await expect(page.getByTestId('status-mailbox')).toHaveText('Mailbox connected · sales@example.test');
});

test('with everything in order, Needs you says so in one grey line', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);
  await expect(page.getByTestId('needs-empty')).toHaveText('Nothing needs you.');
  await expect(page.getByTestId('needs-row')).toHaveCount(0);
});

test('a salesperson is never shown the domain, in the sidebar or in Needs you', async ({ page }) => {
  const device = desktopState().device;
  if (device === null) throw new Error('fixture');
  server = await startHomeTestServer({
    desktop: desktopState({ device: { ...device, role: 'salesperson' } }),
    today: todayState({ role: 'salesperson' }),
    // A checklist that does not pass, which an admin would be asked to record.
    admin: readyAdmin({ role: 'salesperson', sendingAdmin: sendingPosture() }),
  });
  await page.goto(server.url);

  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.0.3 · online');
  await expect(page.getByTestId('status-domain')).toHaveCount(0);
  await expect(page.getByTestId('needs-empty')).toHaveText('Nothing needs you.');
});

test('the last 7 days are read over the last seven days, and a figure not in this build is a dash', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);

  await expect(page.getByTestId('figures-label')).toHaveText('Last 7 days');
  await expect(page.getByTestId('figure-replies')).toHaveText('Replies21 uncertain');
  await expect(page.getByTestId('figure-calls')).toHaveText('Calls3');
  await expect(page.getByTestId('figure-holds')).toHaveText('Holds open1');
  // `sending: { available: false }`: not a zero, which would be a measurement.
  await expect(page.getByTestId('figure-emails')).toHaveText('Emails sent—not in this build');
  await expect(page.getByTestId('figures-line')).toHaveCount(0);

  const [window] = called('admin.loadDashboard') as { from: string; to: string }[];
  if (window === undefined) throw new Error('no dashboard read');
  expect(Date.parse(window.to) - Date.parse(window.from)).toBe(7 * 24 * 60 * 60 * 1000);
});

test('figures that could not be read are dashes and one grey line, never a dialog', async ({ page }) => {
  server = await startHomeTestServer({ figuresFail: true });
  const dialogs = dialogsOf(page);
  await page.goto(server.url);

  await expect(page.getByTestId('figures-line')).toHaveText('Callie could not read the last 7 days.');
  await expect(page.getByTestId('figure-value')).toHaveText(['—', '—', '—', '—']);
  expect(dialogs).toEqual([]);
});

test('a firm name that looks like markup is shown as text', async ({ page }) => {
  const base = todayState();
  server = await startHomeTestServer({
    today: { ...base, cards: base.cards.map((card, index) => (index === 0 ? { ...card, firmName: '<img src=x onerror=alert(1)>' } : card)) },
  });
  await page.goto(server.url);
  await expect(page.getByTestId('card-firm').nth(0)).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

test('expanding a card reveals one task per contact, under its own row', async ({ page }) => {
  server = await startHomeTestServer();
  await page.goto(server.url);
  await settled(page);

  await page.getByTestId('card-expand').nth(1).click();
  const card = page.getByTestId('today-card').nth(1);
  await expect(card.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(card.getByTestId('today-task')).toHaveCount(5);
  await expect(page.getByTestId('task-kind').nth(0)).toHaveText('Callback');
  await expect(page.getByTestId('task-contact').nth(0)).toHaveText('Dana Example');
  // A firm-level task has no person, and says so rather than showing an empty cell.
  await expect(page.getByTestId('task-contact').nth(4)).toHaveText('—');
  await expect(page.getByTestId('task-snoozed')).toHaveCount(1);
  // The business zone's clock: 18:00Z is 14:00 in New York in September.
  await expect(page.getByTestId('task-due').nth(0)).toHaveText('14:00');
  await expect(page.getByTestId('card-expand').nth(1)).toHaveText('Close');

  expect(called('today.expand')).toEqual([{ firmId: FIRM_ID }]);
});

test('a manual task is snoozed and an automated send is held, and the server decides which', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

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
  expect(called('today.snooze')).toEqual([
    { itemId: MANUAL_ITEM_ID, reason: 'Waiting on their board', returnAt: '2026-09-24T09:00' },
  ]);
});

test('the same request on an automated send comes back as a hold', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

  await page.getByTestId('snooze-reason').nth(2).fill('Their office is closed this week');
  await page.getByTestId('snooze-return').nth(2).fill('2026-09-24T09:00');
  await page.getByTestId('snooze-submit').nth(2).click();

  await expect(page.getByTestId('banner-info')).toContainText('recorded a hold instead of a snooze');
  const [sent] = called('today.snooze') as { itemId: string }[];
  expect(sent?.itemId).toBe(AUTOMATED_ITEM_ID);
});

test('what a person is typing survives the window regaining focus', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');
  const reads = called('admin.state').length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The sidebar is read again on focus; the lanes, which hold the text, are not redrawn.
  await expect.poll(() => called('admin.state').length).toBeGreaterThan(reads);
  await expect(page.getByTestId('snooze-reason').nth(1)).toHaveValue('Waiting on their board');
});

test('only a usable number is offered, with the limitation notice beside it', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

  // Two routes on the card, one of them a candidate. One Call button.
  await expect(page.getByTestId('dial')).toHaveCount(1);
  await expect(page.getByTestId('dial')).toHaveText('Call +14015550187');
  await expect(page.getByTestId('dial-limitation')).toContainText('cannot recall it');

  await page.getByTestId('dial').click();
  await expect(page.getByTestId('banner-info')).toContainText('Handed to the phone app.');
  expect(called('today.dial')).toEqual([
    // 9.2: the version the card displays is the version the server checks.
    { firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID, routeVersion: 3 },
  ]);
});

test('a firm with no verified number of the caller’s offers no Call button, and says where to add one', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm({ callingIdentityId: null }) }) });
  await page.goto(server.url);
  await expect(page.getByTestId('dial')).toHaveCount(0);
  await expect(page.getByTestId('banner-info')).toContainText('Add it in Window › Administration');
});

test('an outcome will not record until it has everything it needs', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);

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
  server = await startHomeTestServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url);
  await settled(page);
  await page.getByTestId('outcome-select').selectOption('do_not_call');
  await expect(page.getByTestId('outcome-warning')).toContainText('stops Callie calling this number');
});

test('an outage leaves Home readable and nothing on it pressable', async ({ page }) => {
  server = await startHomeTestServer({
    desktop: desktopState({ online: false, stale: true, mayMutate: false }),
    today: todayState({ online: false, stale: true, mayMutate: false, expanded: expandedFirm() }),
    mailbox: notConnectedMailbox({ mayConnect: false, notice: 'offline' }),
  });
  await page.goto(server.url);

  // The existing sentences, as quiet lines at the top of the column.
  await expect(page.getByTestId('banner-warning').nth(0)).toContainText('cannot reach the server');
  await expect(page.getByTestId('banner-warning').nth(1)).toContainText('from an earlier read');
  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.0.3 · offline');

  await expect(page.getByTestId('today-card')).toHaveCount(4);
  await expect(page.getByTestId('card-counts').nth(1)).toHaveText('3 emails, 1 call, 1 LinkedIn task');
  await expect(page.getByTestId('today-task')).toHaveCount(5);

  for (const index of [0, 1, 2, 3]) await expect(page.getByTestId('card-expand').nth(index)).toBeDisabled();
  for (const index of [0, 1, 2, 3, 4]) await expect(page.getByTestId('snooze-submit').nth(index)).toBeDisabled();
  await expect(page.getByTestId('snooze-reason').nth(0)).toBeDisabled();
  await expect(page.getByTestId('dial')).toHaveCount(0);
  await expect(page.getByTestId('outcome-select')).toBeDisabled();
  await expect(page.getByTestId('outcome-submit')).toBeDisabled();
  await expect(page.getByTestId('needs-connect')).toBeDisabled();
});

test('an empty list says what to do next in one grey line', async ({ page }) => {
  server = await startHomeTestServer({ today: todayState({ cards: [] }) });
  await page.goto(server.url);
  await expect(page.getByTestId('today-empty')).toHaveText(
    'Nothing today. Add firms and a sequence, and tomorrow’s list builds at 05:00.',
  );
  await expect(page.getByTestId('lane')).toHaveCount(0);
  await expect(page.getByTestId('summary')).toHaveText('');
});

test('a page built without the Today and administration bridges says so where they would be', async ({ page }) => {
  server = await startHomeTestServer({ without: ['callieToday', 'callieAdmin'], mailbox: connectedMailbox() });
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await expect(page.getByTestId('today-unavailable')).toHaveText('Unavailable in this build');
  await expect(page.getByTestId('today-card')).toHaveCount(0);
  await expect(page.getByTestId('figures-line')).toHaveText('Unavailable in this build');
  await expect(page.getByTestId('status-calling')).toHaveText('Calling number: unavailable in this build');
  await expect(page.getByTestId('status-mailbox')).toHaveText('Mailbox connected · sales@example.test');
  await expect(page.getByTestId('needs-empty')).toHaveText('Unavailable in this build');
});
