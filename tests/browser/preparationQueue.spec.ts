import { test, expect, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/preparationQueueBrowser';

// Real renderer components on the Accounts surface with the explicit no-IO fixture.
// Every browser request is blocked; nothing here can research, draft, import or send.
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/preparationQueueBrowser.tsx')], outdir: 'preparation-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:41837/preparation-queue-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Preparation queue isolated renderer acceptance</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByText('Local account library', { exact: true })).toBeVisible();
  return { errors, requests };
}
const reads = ['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'];
const methods = (page: Page) => page.evaluate(() => window.preparationQueueBrowser.fixture.calls.map(call => call.method));
// The Accounts surface also lists daily account rows; only the local library section is under test here.
const library = (page: Page) => page.locator('section[aria-labelledby="local-account-library"]');
const rowKeys = (page: Page) => library(page).locator('.native-desk__row[data-row-key]').evaluateAll(rows => rows.map(row => JSON.parse(row.getAttribute('data-row-key')!)[1]));
const stepKeys = (page: Page) => library(page).locator('[data-step-key]').evaluateAll(rows => rows.map(row => JSON.parse(row.getAttribute('data-step-key')!)[1]));
async function assertClean(page: Page, state: { errors: string[]; requests: string[] }) {
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(await methods(page)).not.toContain('forbidden');
}
const axeClean = async (page: Page) => {
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
};

test('ranked local companies show one reason and next step each, traverse by keyboard, and only select on activation', async ({ page }, testInfo) => {
  const state = await mount(page);
  expect((await methods(page)).every(method => reads.includes(method))).toBe(true);
  expect(await rowKeys(page)).toEqual(['d', 'c', 'b', 'a', 'f', 'e']);
  expect(await stepKeys(page)).toEqual(['d', 'c', 'b', 'a', 'f']);
  // Reasons come from the fixture's saved snapshot, read back through the same no-IO local API the library uses.
  const reasons = await page.evaluate(async () => {
    const local = await window.preparationQueueBrowser.fixture.api.localWorkspace.get();
    return local.accounts.state === 'available' ? local.accounts.snapshots.flatMap(snapshot => snapshot.preparation ? [snapshot.preparation.reason] : []) : [];
  });
  expect(reasons).toHaveLength(5);
  for (const reason of reasons) await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await expect(page.getByText('Ordered by what is ready to prepare next, from saved local evidence. Each step opens the company; nothing starts on its own.', { exact: true })).toBeVisible();
  // Row identities and labels are unchanged; the step control is a separate sibling with its own name.
  const delta = page.getByRole('button', { name: 'Local account · Delta Draft PM', exact: true });
  await expect(delta).toContainText('Read-only local evidence');
  await expect(page.getByRole('button', { name: /Echo Unassessed PM/ })).toHaveCount(1);
  await delta.focus();
  const traversal = ['Reopen draft · Delta Draft PM', 'Local account · Charlie Ready PM', 'Open draft · Charlie Ready PM', 'Local account · Bravo Routeless PM', 'Open route review · Bravo Routeless PM',
    'Local account · Alpha New PM', 'Open research · Alpha New PM', 'Local account · Foxtrot Unknown PM', 'Open company · Foxtrot Unknown PM', 'Local account · Echo Unassessed PM'];
  for (const name of traversal) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }
  // Traversal alone selects nothing and reads nothing beyond the initial snapshot.
  expect((await methods(page)).every(method => reads.includes(method))).toBe(true);
  await expect(library(page).locator('.native-desk__row[aria-current="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open draft · Charlie Ready PM', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Charlie Ready PM', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local account · Charlie Ready PM', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.preparationQueueBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{ method: 'localWorkspace.getCompany', input: { accountId: 'c' } }]);
  expect((await methods(page)).filter(method => ![...reads, 'localWorkspace.getCompany'].includes(method))).toEqual([]);
  expect(await page.evaluate(() => window.preparationQueueBrowser.opened)).toEqual([]);
  for (const width of [1440, 1050]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => { window.preparationQueueBrowser.preferences(theme, 'comfortable'); window.preparationQueueBrowser.rerender(); window.preparationQueueBrowser.refresh(); }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await rowKeys(page)).toEqual(['d', 'c', 'b', 'a', 'f', 'e']);
      await expect(page.getByRole('button', { name: 'Local account · Charlie Ready PM', exact: true })).toHaveAttribute('aria-current', 'true');
      const first = await page.getByRole('button', { name: 'Reopen draft · Delta Draft PM', exact: true }).boundingBox();
      const queue = await page.locator('.native-desk__queue').boundingBox();
      expect(first!.x + first!.width).toBeLessThanOrEqual(queue!.x + queue!.width + 1);
      await expect(page.getByRole('button', { name: 'Reopen draft · Delta Draft PM', exact: true })).toBeInViewport();
      await axeClean(page);
      await page.screenshot({ path: testInfo.outputPath(`preparation-queue-${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Charlie Ready PM', exact: true })).toHaveCount(0);
  await expect(library(page).locator('.native-desk__row[aria-current="true"]')).toHaveCount(0);
  expect((await methods(page)).filter(method => ![...reads, 'localWorkspace.getCompany'].includes(method))).toEqual([]);
  await assertClean(page, state);
});

test('an unavailable local read stays unavailable with no ranked rows, controls or readiness claims', async ({ page }) => {
  const state = await mount(page);
  await page.evaluate(() => {
    const f = window.preparationQueueBrowser.fixture;
    f.setLocalSnapshot({ scope: 'local_database', generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'unavailable', snapshots: [] } });
    window.preparationQueueBrowser.refresh();
  });
  await expect(page.getByText('Local account library is unavailable. Refresh the local read.', { exact: true })).toBeVisible();
  await expect(library(page).locator('.native-desk__row[data-row-key]')).toHaveCount(0);
  await expect(library(page).locator('[data-step-key]')).toHaveCount(0);
  await expect(page.getByText(/Ordered by what is ready/)).toHaveCount(0);
  await axeClean(page);
  await assertClean(page, state);
});
