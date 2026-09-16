import { test, expect, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/accountIntakeConfigureBrowser';

// Real renderer components on the Campaigns surface with the explicit no-IO fixture. Every browser
// request is blocked; the intake write is forbidden, so nothing here can configure, read mail or send.
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/accountIntakeConfigureBrowser.tsx')], outdir: 'intake-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:41837/account-intake-configure-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Account intake configuration isolated renderer acceptance</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  // Review the saved campaign version so the detail pane shows real saved work (the route's empty
  // welcome pane is not this lane's markup); the intake controls live in the composer above the layout.
  await page.locator('[data-row-key="campaign:version"]').click();
  await expect(page.locator('.native-desk__detail')).not.toContainText(/Select an item/i);
  return { errors, requests };
}
const methods = (page: Page) => page.evaluate(() => window.accountIntakeConfigureBrowser.fixture.calls.map(call => call.method));
const grantReads = (page: Page) => page.evaluate(() => window.accountIntakeConfigureBrowser.grantReads);
// StrictMode in this development bundle mounts effects twice; every read must still be the one stored-record status read.
async function expectOnlyGrantStatusReads(page: Page) {
  const reads = await grantReads(page);
  expect(reads.length).toBeGreaterThanOrEqual(1);
  for (const read of reads) expect(read).toEqual({ purpose: 'permitted_correspondence' });
}
const panel = (page: Page) => page.getByRole('region', { name: 'Intake configuration', exact: true });
async function review(page: Page) {
  await page.getByRole('button', { name: 'New call campaign', exact: true }).click();
  await page.getByLabel('Company').selectOption('a');
  await page.getByRole('button', { name: 'Review worker preparation', exact: true }).click();
  return page.getByRole('button', { name: 'Read intake configuration', exact: true });
}
async function assertClean(page: Page, state: { errors: string[]; requests: string[] }) {
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(await methods(page)).not.toContain('forbidden');
  expect(await grantReads(page)).not.toContain('forbidden');
}
const axeClean = async (page: Page) => {
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
};

test('the three intake controls appear only after the explicit read, reach by keyboard in order, and queue nothing at 1440/1050 in light and dark', async ({ page }, testInfo) => {
  const state = await mount(page);
  const read = await review(page);
  await expect(panel(page)).toHaveCount(0);
  expect(await methods(page)).not.toContain('getAccountPreparation');
  expect(await grantReads(page)).toEqual([]);
  await read.click();
  await expect(panel(page).getByText('Mailbox: founder@fixture.invalid.', { exact: false })).toBeVisible();
  // Only the grant status read from the owner's stored record, nothing else, and no readiness claim.
  await expectOnlyGrantStatusReads(page);
  expect((await methods(page)).filter(method => method === 'getAccountPreparation')).toHaveLength(1);
  const activate = panel(page).getByRole('button', { name: 'Set intake active', exact: true });
  const since = panel(page).getByLabel('Read relevant mail since');
  const mail = panel(page).getByRole('button', { name: 'Switch on relevant mail', exact: true });
  const calendar = panel(page).getByRole('button', { name: 'Use calendar founder@fixture.invalid', exact: true });
  await expect(activate).toBeEnabled(); await expect(mail).toBeDisabled(); await expect(calendar).toBeDisabled();
  await expect(panel(page).getByText('A configured mailbox is required before a calendar can be used.', { exact: true })).toBeVisible();
  await expect(panel(page).getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeVisible();
  // Keyboard reach: from the read control, Tab lands on each offered intake control in order. A disabled
  // control is not in the tab order; its reason is visible instead.
  await read.focus();
  await page.keyboard.press('Tab'); await expect(activate).toBeFocused();
  await page.keyboard.press('Tab'); await expect(since).toBeFocused();
  await since.fill('2026-09-01');
  await expect(mail).toBeEnabled();
  // Chromium's date field tabs through its month, day and year segments before leaving the input.
  for (let presses = 0; presses < 4 && !(await mail.evaluate(element => element === document.activeElement)); presses++) await page.keyboard.press('Tab');
  await expect(mail).toBeFocused();
  await page.keyboard.press('Tab'); await expect(calendar).not.toBeFocused();
  for (const width of [1440, 1050]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => { window.accountIntakeConfigureBrowser.preferences(theme, 'comfortable'); window.accountIntakeConfigureBrowser.rerender(); }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(activate).toBeEnabled(); await expect(mail).toBeEnabled(); await expect(calendar).toBeDisabled();
      await activate.scrollIntoViewIfNeeded();
      await expect(activate).toBeInViewport();
      const composer = await page.locator('.native-desk__campaign-draft').boundingBox();
      const box = await mail.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(composer!.x + composer!.width + 1);
      await axeClean(page);
      await page.screenshot({ path: testInfo.outputPath(`account-intake-configure-${width}-${theme}.png`), fullPage: true });
    }
  }
  // Nothing was queued: the fixture's write is forbidden and was never called.
  expect((await methods(page)).filter(method => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments', 'getAccountPreparation'].includes(method))).toEqual([]);
  await assertClean(page, state);
});

test('with a configured mailbox the mail control is withdrawn and the grant calendar is offered and reachable', async ({ page }) => {
  const state = await mount(page);
  await page.evaluate(() => window.accountIntakeConfigureBrowser.fixture.setPreparation(window.accountIntakeConfigureBrowser.preparations.activeMail));
  const read = await review(page);
  await read.click();
  const pause = panel(page).getByRole('button', { name: 'Pause intake', exact: true });
  const calendar = panel(page).getByRole('button', { name: 'Use calendar founder@fixture.invalid', exact: true });
  await expect(pause).toBeEnabled();
  await expect(calendar).toBeEnabled();
  await expect(panel(page).getByRole('button', { name: 'Switch on relevant mail' })).toHaveCount(0);
  await expect(panel(page).getByText(/Relevant mail is already on for this company/)).toBeVisible();
  await expect(panel(page).getByText('Uses the grant’s owned calendar for this company. This books nothing.', { exact: true })).toBeVisible();
  await pause.focus();
  await page.keyboard.press('Tab'); await expect(calendar).toBeFocused();
  await axeClean(page);
  await expectOnlyGrantStatusReads(page);
  await assertClean(page, state);
});
