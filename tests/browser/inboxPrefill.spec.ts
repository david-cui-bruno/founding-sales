import { test, expect, type Locator, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/inboxPrefillBrowser';

// Real renderer components on the Accounts detail with the explicit no-IO Lenox fixture.
// Every browser request is blocked; nothing here can admit, open, research, import or send.
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/inboxPrefillBrowser.tsx')], outdir: 'inbox-prefill-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:41837/inbox-prefill-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Inbox prefill isolated renderer acceptance</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByText('Local account library', { exact: true })).toBeVisible();
  return { errors, requests };
}
const methods = (page: Page) => page.evaluate(() => window.inboxPrefillBrowser.fixture.calls.map(call => call.method));
const axeClean = async (page: Page) => {
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
};
const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';

test('the inbox review opens prefilled from the saved source, keeps the source text collapsed below the fields, and admits nothing without the confirmation click', async ({ page }, testInfo) => {
  const state = await mount(page);
  await page.getByRole('button', { name: 'Open route review · Lenox Management', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lenox Management', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.inboxPrefillBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{ method: 'localWorkspace.getCompany', input: { accountId: 'lenox' } }]);
  const form = page.getByRole('region', { name: 'Company draft' });
  const select = form.getByRole('combobox', { name: 'Saved source' }), email = form.getByRole('textbox', { name: 'Business inbox email' });
  const quote = form.getByRole('textbox', { name: 'Exact publication quote' }), confirm = form.getByRole('checkbox');
  const admit = form.getByRole('button', { name: 'Admit reviewed company inbox', exact: true });
  const details = form.locator('details').filter({ hasText: 'Show saved source text' });
  const prefilled = async () => {
    await expect(select).toHaveValue('source-lenox'); await expect(email).toHaveValue('info@lenoxmanagement.com'); await expect(quote).toHaveValue(lenoxQuote);
    await expect(form.getByText('Filled from saved source https://lenoxmanagement.com/ by matching its text, not verified. Read the quoted passage before confirming.', { exact: true })).toBeVisible();
    await expect(form.getByRole('list', { name: 'Excluded addresses' })).toContainText('tenants@lenoxmanagement.com');
    await expect(form.getByRole('list', { name: 'Excluded addresses' })).toContainText('“tenants”');
    await expect(form.getByRole('radio')).toHaveCount(0);
  };
  await prefilled();
  await expect(confirm).not.toBeChecked(); await expect(admit).toBeDisabled();
  // The complete source text sits below the fields and the Admit control, collapsed; expanding it moves no field.
  // Edges relative to the Company draft region, because clicking scrolls an inner container and boundingBox() is viewport-relative.
  const edges = (locator: Locator) => locator.evaluate(element => {
    const region = element.closest('section[aria-label="Company draft"]')!.getBoundingClientRect(), box = element.getBoundingClientRect();
    return { top: box.top - region.top, bottom: box.bottom - region.top };
  });
  await expect(details).toHaveJSProperty('open', false);
  const quoteEdges = await edges(quote), admitEdges = await edges(admit), detailsEdges = await edges(details);
  expect(admitEdges.top).toBeGreaterThanOrEqual(quoteEdges.bottom);
  expect(detailsEdges.top).toBeGreaterThanOrEqual(admitEdges.bottom);
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(details.locator('blockquote')).toContainText('380 Broadway Providence, Rhode Island 02909');
  await expect(details.locator('pre')).toContainText('Our in-house maintenance team coordinates repairs');
  expect(await edges(quote)).toEqual(quoteEdges);
  expect(await edges(admit)).toEqual(admitEdges);
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', false);
  for (const width of [1440, 1050]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => { window.inboxPrefillBrowser.preferences(theme, 'comfortable'); window.inboxPrefillBrowser.rerender(); }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await prefilled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await admit.scrollIntoViewIfNeeded();
      await expect(confirm).toBeInViewport(); await expect(admit).toBeInViewport();
      for (const control of [select, email, quote, admit]) {
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await axeClean(page);
      await page.screenshot({ path: testInfo.outputPath(`inbox-prefill-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  // Keyboard reach: from the quote, Tab lands on the confirmation, Space ticks it, Tab lands on Admit, now enabled. Nothing was sent to the API.
  await quote.focus();
  await page.keyboard.press('Tab'); await expect(confirm).toBeFocused();
  await page.keyboard.press('Space'); await expect(confirm).toBeChecked();
  await page.keyboard.press('Tab'); await expect(admit).toBeFocused(); await expect(admit).toBeEnabled();
  await expect(admit).toBeInViewport();
  // Editing the address by hand releases the confirmation again; nothing stays confirmed silently.
  await email.fill('typed@lenoxmanagement.com');
  await expect(confirm).not.toBeChecked(); await expect(admit).toBeDisabled();
  const inventory = await methods(page);
  expect(inventory.filter(method => method === 'localWorkspace.admitCompanyDraftEmail')).toEqual([]);
  expect(inventory).not.toContain('forbidden');
  expect(await page.evaluate(() => window.inboxPrefillBrowser.opened)).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
});
