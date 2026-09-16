import { test, expect, type Locator, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/phoneRouteReviewBrowser';

// Real renderer components on the Accounts detail with the explicit no-IO Lenox fixture.
// Every browser request is blocked; nothing here can admit, call, open, research, import or send.
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/phoneRouteReviewBrowser.tsx')], outdir: 'phone-route-review-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:41837/phone-route-review-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Phone route review isolated renderer acceptance</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByText('Local account library', { exact: true })).toBeVisible();
  return { errors, requests };
}
const calls = (page: Page) => page.evaluate(() => window.phoneRouteReviewBrowser.fixture.calls.map(call => ({ method: call.method, input: call.input })));
const axeClean = async (page: Page) => {
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
};
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';

test('the phone route step sits beside the inbox step, prefilled from the saved Lenox source, reachable by keyboard, and admits exactly the displayed values only after the confirmation click', async ({ page }, testInfo) => {
  const state = await mount(page);
  await page.getByRole('button', { name: 'Open route review · Lenox Management', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lenox Management', exact: true })).toBeVisible();
  const inbox = page.getByRole('region', { name: 'Company draft', exact: true });
  const region = page.getByRole('region', { name: 'Phone route review', exact: true });
  await expect(inbox).toBeVisible(); await expect(region).toBeVisible();
  expect(await page.evaluate(() => {
    const draft = document.querySelector('section[aria-label="Company draft"]')!, phone = document.querySelector('section[aria-label="Phone route review"]')!;
    return (draft.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })).toBe(true);
  await expect(region.getByRole('heading', { name: 'Review phone route', exact: true })).toBeVisible();
  const select = region.getByRole('combobox', { name: 'Saved source for the phone route' }), number = region.getByRole('textbox', { name: 'Business phone number' });
  const passage = region.getByRole('textbox', { name: 'Exact source passage' }), confirm = region.getByRole('checkbox');
  const admit = region.getByRole('button', { name: 'Admit phone route', exact: true });
  const prefilled = async () => {
    await expect(select).toHaveValue('source-lenox'); await expect(number).toHaveValue('401-572-3322'); await expect(passage).toHaveValue(lenoxQuote);
    await expect(region.getByText('Filled from saved source https://lenoxmanagement.com/ by matching its text, not verified. Saved as +14015723322.', { exact: true })).toBeVisible();
    await expect(region.getByRole('list', { name: 'Excluded numbers' })).toContainText('401-555-0199');
    await expect(region.getByRole('list', { name: 'Excluded numbers' })).toContainText('“Tenant”');
    await expect(region.getByRole('radio')).toHaveCount(0);
  };
  await prefilled();
  await expect(confirm).not.toBeChecked(); await expect(admit).toBeDisabled();
  // No control implies calling, dialling, verifying or sending; the step's copy says so in the negative.
  await expect(region.getByRole('button', { name: /call|dial|verif|send/i })).toHaveCount(0);
  await expect(region.getByText('Saving a route is not a call, not a check that the number answers and not a route on a worker.', { exact: false })).toBeVisible();
  for (const width of [1440, 1050]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => { window.phoneRouteReviewBrowser.preferences(theme, 'comfortable'); window.phoneRouteReviewBrowser.rerender(); }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await prefilled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await admit.scrollIntoViewIfNeeded();
      await expect(confirm).toBeInViewport(); await expect(admit).toBeInViewport();
      for (const control of [select, number, passage, admit] as Locator[]) {
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await axeClean(page);
      await page.screenshot({ path: testInfo.outputPath(`phone-route-review-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  // Keyboard reach: from the passage, Tab lands on the confirmation, Space ticks it, Tab lands on Admit, now enabled. Nothing was sent yet.
  await passage.focus();
  await page.keyboard.press('Tab'); await expect(confirm).toBeFocused();
  await page.keyboard.press('Space'); await expect(confirm).toBeChecked();
  await page.keyboard.press('Tab'); await expect(admit).toBeFocused(); await expect(admit).toBeEnabled();
  expect((await calls(page)).filter(call => call.method === 'localWorkspace.admitCompanyPhoneRoute')).toEqual([]);
  // The explicit click sends exactly the displayed values: the E.164 value and the verbatim passage. The fixture refuses, so the exact command is retained.
  await page.keyboard.press('Enter');
  await expect(region.getByRole('alert')).toBeVisible();
  await expect(region.getByRole('button', { name: 'Retry phone route admission', exact: true })).toBeVisible();
  const admissions = (await calls(page)).filter(call => call.method === 'localWorkspace.admitCompanyPhoneRoute');
  expect(admissions).toEqual([{ method: 'localWorkspace.admitCompanyPhoneRoute', input: { commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), accountId: 'lenox', expectedAccountVersion: 1,
    phone: '+14015723322', sourceId: 'source-lenox', quote: lenoxQuote, selection: 'published_company_business_phone' } }]);
  await axeClean(page);
  const inventory = (await calls(page)).map(call => call.method);
  expect(inventory.filter(method => method === 'localWorkspace.admitCompanyDraftEmail')).toEqual([]);
  expect(inventory).not.toContain('forbidden');
  expect(await page.evaluate(() => window.phoneRouteReviewBrowser.opened)).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
});
