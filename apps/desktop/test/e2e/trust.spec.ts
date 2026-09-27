import { expect, test, type Locator, type Page } from 'playwright/test';
import { adminState, startAppServer, type AppServer } from './support/appServer.ts';
import { FIRM_ID, desktopState, expandedFirm, todayState } from './support/homeFixtures.ts';
import { EXAMPLE_WORKSPACE, signedOutState } from './support/sessionFixtures.ts';

/**
 * Wave 1's trust fixes, as the owner meets them: a card opens while the Mac is offline,
 * a second press while a command is on the wire sends nothing, and a Mac that has
 * signed in before is not asked for its workspace again.
 *
 * The bridges are the harness's fakes, so what these prove is the page's half. The main
 * process's half — the expansion cache, `online` following every call, the remembered
 * workspace on disk — is in `today.test.ts` and `desktop.test.ts`.
 */

let server: AppServer;

test.afterEach(async () => {
  await server.stop();
});

const called = (method: string): unknown[] =>
  server.calls.filter(call => call.method === method).map(call => call.argument);

/** A real click at the control's centre: what `inert` refuses, unlike `element.click()`. */
async function pressAgain(page: Page, control: Locator): Promise<void> {
  const box = await control.boundingBox();
  if (box === null) throw new Error('the control is not on screen');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('a card opens while the Mac is offline and the list is stale, under the offline line', async ({ page }) => {
  server = await startAppServer({
    desktop: desktopState({ online: false, stale: true }),
    today: todayState({ online: false, stale: true }),
  });
  await page.goto(server.url());
  await expect(page.getByTestId('banner-warning').first()).toContainText('cannot reach the server');

  const card = page.getByTestId('today-card').nth(1);
  await expect(card.getByTestId('card-expand')).toBeEnabled();
  await card.getByTestId('card-expand').click();
  await expect.poll(() => called('today.expand')).toEqual([{ firmId: FIRM_ID }]);
  await expect(page.getByTestId('today-task').first()).toBeVisible();
  await expect(page.getByTestId('banner-warning').first()).toContainText('cannot reach the server');
});

test('a snooze on the wire holds its own form and nothing else, and a second press sends nothing', async ({ page }) => {
  /*
   * P1-4. Until the review a command made the whole column `inert`: snoozing one task
   * froze every other card, Refresh and the sidebar, for as long as the server took. A
   * person waits for the thing they pressed. What is still true is the part that
   * mattered — a second press of the same button sends nothing.
   */
  server = await startAppServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url());

  const submit = page.getByTestId('snooze-submit').nth(1);
  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');
  await page.getByTestId('snooze-return').nth(1).fill('2026-09-24T09:00');
  const release = server.hold('today.snooze');
  await submit.click();
  await expect.poll(() => called('today.snooze').length).toBe(1);

  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(submit).toBeDisabled();
  // Everything that is not this form is still the person's to use.
  await expect(page.getByTestId('refresh')).toBeEnabled();
  await expect(page.getByTestId('card-expand').first()).toBeEnabled();
  await expect(page.getByTestId('nav-firms')).toBeEnabled();
  expect(await page.getByTestId('column').evaluate(node => (node as HTMLElement).inert)).toBe(false);
  await pressAgain(page, submit);

  release();
  await expect(submit).not.toHaveAttribute('aria-busy', 'true');
  expect(called('today.snooze')).toHaveLength(1);
});

test('a Save on the wire holds its own row, the other rows stay editable, and a Save without a note still goes', async ({ page }) => {
  // The same rule on Administration (P1-4): the row being saved waits, the rest of the
  // page does not, and a second press of that row's Save sends nothing.
  server = await startAppServer({ admin: adminState() });
  await page.goto(server.url('#admin'));

  const save = page.getByTestId('save-business_time_zone');
  await page.getByTestId('field-business_time_zone-timeZone').selectOption('America/Denver');
  const release = server.hold('settings.saveSetting');
  await save.click();
  await expect.poll(() => called('settings.saveSetting').length).toBe(1);

  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('save-postal_address')).toBeEnabled();
  await expect(page.getByTestId('field-postal_address-address')).toBeEditable();
  await expect(page.getByTestId('nav-today')).toBeEnabled();
  expect(await page.getByTestId('column').evaluate(node => (node as HTMLElement).inert)).toBe(false);
  await pressAgain(page, save);

  release();
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  expect(called('settings.saveSetting')).toEqual([{ settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: '' }]);
});

test('two rows can be saving at once, and each waits only for its own Save', async ({ page }) => {
  /*
   * P1-4's rule stated as the thing somebody can do. Before the review this was not
   * possible at all: the first Save made the column read-only, so the second row could
   * not even be typed into until the server answered the first.
   */
  server = await startAppServer({ admin: adminState() });
  await page.goto(server.url('#admin'));

  const zone = page.getByTestId('save-business_time_zone');
  const address = page.getByTestId('save-postal_address');

  const releaseZone = server.hold('settings.saveSetting');
  await page.getByTestId('field-business_time_zone-timeZone').selectOption('America/Denver');
  await zone.click();
  await expect(zone).toHaveAttribute('aria-busy', 'true');

  // The second row, while the first is still on the wire.
  const releaseAddress = server.hold('settings.saveSetting');
  await page.getByTestId('field-postal_address-address').fill('1 Example Street, Providence RI 02903');
  await address.click();
  await expect(address).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => called('settings.saveSetting').length).toBe(2);

  releaseZone();
  await expect(zone).not.toHaveAttribute('aria-busy', 'true');
  // The address row is still waiting for its own answer, and only for that.
  await expect(address).toHaveAttribute('aria-busy', 'true');

  releaseAddress();
  await expect(address).not.toHaveAttribute('aria-busy', 'true');
  expect(called('settings.saveSetting')).toEqual([
    { settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: '' },
    { settingKey: 'postal_address', value: { address: '1 Example Street, Providence RI 02903' }, changeNote: '' },
  ]);
});

test('a command outside the setting rows holds its own button too: the holiday calendar', async ({ page }) => {
  /*
   * The setting rows were the two controls the first fix reached. Every other command
   * on Administration took a form key that no control read, so its button stayed
   * pressable while its own command was on the wire — "Replace calendar" among them,
   * and pressing it twice would have sent the calendar twice.
   */
  server = await startAppServer({ admin: adminState() });
  await page.goto(server.url('#admin'));

  const save = page.getByTestId('holidays-save');
  await page.getByTestId('holiday-version').fill('2027-federal');
  const release = server.hold('settings.recordHolidayCalendar');
  await save.click();
  await expect.poll(() => called('settings.recordHolidayCalendar').length).toBe(1);

  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('holiday-version')).toBeDisabled();
  // Its own form only: a setting row on the same page is still there to be used.
  await expect(page.getByTestId('save-business_time_zone')).toBeEnabled();
  await pressAgain(page, save);

  release();
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  expect(called('settings.recordHolidayCalendar')).toHaveLength(1);
});

test('an answer that lands late does not put an older view back on the screen', async ({ page }) => {
  /*
   * P2. Every one of these bridges answers with the whole view, so the last answer
   * written *is* the view. Now that two commands may be in flight at once (P1-4),
   * answers land in whatever order the server produces them — and a *read* issued while
   * a Save is on the wire carries a state read before that Save committed. Landing
   * last, it takes the saved value off the screen a moment after the row accepted it.
   */
  server = await startAppServer({ admin: adminState() });
  await page.goto(server.url('#admin'));
  await expect(page.getByTestId('summary-business_time_zone')).toHaveText('Central (Chicago)');

  // The Save is accepted first, but its answer is held on the wire.
  const release = server.hold('settings.saveSetting');
  await page.getByTestId('field-business_time_zone-timeZone').selectOption('America/Denver');
  await page.getByTestId('save-business_time_zone').click();
  await expect.poll(() => called('settings.saveSetting').length).toBe(1);

  // A read issued after it and answered before it: the state it carries is the one the
  // server held *before* the Save was applied.
  await page.getByTestId('history-business_time_zone').click();
  await expect.poll(() => called('settings.openHistory').length).toBe(1);

  release();
  await expect(page.getByTestId('save-business_time_zone')).not.toHaveAttribute('aria-busy', 'true');

  // The value the person saved is what is on screen, not the one the read carried.
  await expect(page.getByTestId('summary-business_time_zone')).toHaveText('Mountain (Denver)');
});

test('a Mac that has signed in before is one button: no workspace, no name', async ({ page }) => {
  server = await startAppServer({
    desktop: signedOutState({ rememberedWorkspace: { workspaceId: EXAMPLE_WORKSPACE, deviceLabel: "David's MacBook" } }),
  });
  await page.goto(server.url());

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('workspace-id')).toBeHidden();
  await expect(page.getByTestId('device-label')).toBeHidden();
  await page.getByTestId('sign-in').click();
  await expect.poll(() => called('callie.signIn')).toEqual([{}]);
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
});

test('"Use another workspace" shows the two fields, and the sign-in sends them', async ({ page }) => {
  server = await startAppServer({
    desktop: signedOutState({ rememberedWorkspace: { workspaceId: EXAMPLE_WORKSPACE, deviceLabel: "David's MacBook" } }),
  });
  await page.goto(server.url());

  await page.getByTestId('use-another-workspace').click();
  await expect(page.getByTestId('use-another-workspace')).toHaveCount(0);
  await expect(page.getByTestId('device-label')).toHaveValue("David's MacBook");
  await page.getByTestId('workspace-id').fill('44444444-4444-4444-8444-444444444444');
  await page.getByTestId('sign-in').click();
  await expect
    .poll(() => called('callie.signIn'))
    .toEqual([{ workspaceId: '44444444-4444-4444-8444-444444444444', deviceLabel: "David's MacBook" }]);
});

test('a first sign-in shows the fields, and says so when the workspace was left out', async ({ page }) => {
  server = await startAppServer({ desktop: signedOutState({ notice: 'workspace_required' }) });
  await page.goto(server.url());

  await expect(page.getByTestId('workspace-id')).toBeVisible();
  await expect(page.getByTestId('use-another-workspace')).toHaveCount(0);
  await expect(page.getByTestId('banner-info')).toHaveText('Enter the workspace ID to sign in on this Mac the first time.');
});

test('a sign-in that could not reach the server says so once and keeps what was typed', async ({ page }) => {
  server = await startAppServer({
    desktop: signedOutState(),
    signInAnswer: signedOutState({ online: false, notice: 'offline' }),
  });
  await page.goto(server.url());
  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('device-label').fill('Studio Mac');
  await page.getByTestId('sign-in').click();

  await expect.poll(() => called('callie.signIn')).toEqual([{ workspaceId: EXAMPLE_WORKSPACE, deviceLabel: 'Studio Mac' }]);
  await expect(page.getByTestId('banner-warning')).toHaveText('Callie cannot reach the server.');
  await expect(page.getByTestId('banner-info')).toHaveCount(0);
  await expect(page.getByTestId('sign-in')).toBeEnabled();
  await expect(page.getByTestId('workspace-id')).toHaveValue(EXAMPLE_WORKSPACE);
  await expect(page.getByTestId('device-label')).toHaveValue('Studio Mac');
});

test('signing out empties the request cache: the next person’s Today is read again', async ({ page }) => {
  // The Query cache is memory-only and is cleared on sign-out, on another workspace, on
  // a changed role and on revocation (`App.tsx`). Every read has `staleTime: Infinity`,
  // so if the cache survived a sign-out the same Mac signing back in would draw the list
  // it already had — the one thing 12.4 will not have.
  server = await startAppServer({ today: todayState() });
  await page.goto(server.url());
  await expect(page.getByTestId('today-card').first()).toBeVisible();
  await expect.poll(() => called('today.refresh').length).toBe(1);

  await page.getByTestId('this-mac-summary').click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');

  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('device-label').fill("David's MacBook");
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('today-card').first()).toBeVisible();
  await expect.poll(() => called('today.refresh').length).toBe(2);
});
