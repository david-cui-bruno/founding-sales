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

test('Today is read-only while a snooze is on the wire, so a second press sends nothing', async ({ page }) => {
  server = await startAppServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url());

  const submit = page.getByTestId('snooze-submit').nth(1);
  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');
  await page.getByTestId('snooze-return').nth(1).fill('2026-09-24T09:00');
  const release = server.hold('today.snooze');
  await submit.click();
  await expect.poll(() => called('today.snooze').length).toBe(1);
  await expect(page.getByTestId('column')).toHaveAttribute('aria-busy', 'true');
  await pressAgain(page, submit);

  release();
  await expect(page.getByTestId('column')).not.toHaveAttribute('aria-busy', 'true');
  expect(called('today.snooze')).toHaveLength(1);
  expect(await page.getByTestId('column').evaluate(node => (node as HTMLElement).inert)).toBe(false);
});

test('Administration is read-only while a Save is on the wire, and a Save without a note still goes', async ({ page }) => {
  server = await startAppServer({ admin: adminState() });
  await page.goto(server.url('#admin'));

  const save = page.getByTestId('save-business_time_zone');
  await page.getByTestId('field-business_time_zone-timeZone').selectOption('America/Denver');
  const release = server.hold('admin.saveSetting');
  await save.click();
  await expect.poll(() => called('admin.saveSetting').length).toBe(1);
  await expect(page.getByTestId('column')).toHaveAttribute('aria-busy', 'true');
  await pressAgain(page, save);

  release();
  await expect(page.getByTestId('column')).not.toHaveAttribute('aria-busy', 'true');
  expect(called('admin.saveSetting')).toEqual([{ settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: '' }]);
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
