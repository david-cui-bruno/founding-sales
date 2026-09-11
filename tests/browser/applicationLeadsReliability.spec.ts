import { test, expect, type Page, type Locator } from 'playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type { LeadsCommand, LeadsRead } from '../fixtures/applicationLeadsScenario';
import type { Call } from '../fixtures/applicationPresentationBrowser';
import type { LeadsListRequest } from '../../src/shared/contracts/leadsContract';

test.use({ timezoneId: 'America/New_York' });
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/applicationPresentationBrowser.tsx')], outdir: 'application-leads-fixture', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true });
});
const request: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 };
const person = (n: number) => `person-leads-${String(n).padStart(3, '0')}`;
const name = (n: number) => `Test Lead ${String(n).padStart(3, '0')}`;
const read = (method: string, ...args: unknown[]): Call => ({ method, kind: 'read', args });
const command = (method: string, input: unknown): Call => ({ method, kind: 'command', args: [input] });
const recorded = (page: Page) => page.evaluate(() => window.applicationPresentation.calls);
const arm = (page: Page, method: LeadsCommand) => page.evaluate(method => window.applicationPresentation.leads!.arm(method), method);
const defer = (page: Page, method: LeadsRead) => page.evaluate(method => window.applicationPresentation.leads!.deferNextRead(method), method);
const settle = (page: Page, token: string, outcome: 'resolve' | 'reject') => page.evaluate(({ token, outcome }) => window.applicationPresentation.leads!.settle(token, outcome), { token, outcome });
const operations = (page: Page) => page.evaluate(() => window.applicationPresentation.leads!.operations);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const sorted = (calls: Call[]) => calls.map(call => JSON.stringify(canonical(call))).sort();
type Context = { theme: 'light' | 'dark'; density: 'compact' | 'comfortable'; width: 1050 | 1440 };
const standard: Context = { theme: 'light', density: 'compact', width: 1440 };
async function mount(page: Page, context: Context = standard) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-10T12:00:00.000Z'));
  await page.addInitScript(context => {
    localStorage.setItem('callie.theme', context.theme); localStorage.setItem('callie.density', context.density);
  }, context);
  const url = 'http://127.0.0.1:41839/application-leads?leadsScenario=1&mode=legacy';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Actual Leads reliability</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>` });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: context.width, height: context.width === 1440 ? 900 : 700 });
  await page.emulateMedia({ colorScheme: context.theme });
  await page.goto(`${url}#/leads`);
  await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
  const expected = [read('health.get'), read('health.get'), read('leadDetail.getOutboundCapabilities'), read('leadDetail.getOutboundCapabilities'),
    read('review.list', { kinds: [], cursor: null, limit: 1 }), read('review.list', { kinds: [], cursor: null, limit: 1 }), read('leads.list', request), read('leads.list', request)];
  async function checkpoint(...additional: Call[]) {
    expected.push(...additional);
    await expect.poll(async () => sorted(await recorded(page))).toEqual(sorted(expected));
    expect(errors).toEqual([]); expect(requests).toEqual([]);
    expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  }
  await checkpoint();
  const root = await page.locator('.presentation-root').elementHandle();
  async function presentation() {
    expect(await root!.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
    await expect(page.locator('.presentation-root')).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-theme', context.theme);
    await expect(page.locator('html')).toHaveAttribute('data-density', context.density);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  return { checkpoint, presentation };
}
async function reveal(page: Page, n: number) {
  const scroll = page.locator('.leads-grid__scroll');
  await scroll.evaluate((element, n) => { element.scrollTop = (n - 1) * 46; }, n);
  const row = page.getByRole('grid', { name: 'Leads', exact: true }).locator(`[data-person-id="${person(n)}"]`);
  await expect(row).toBeVisible(); return row;
}
async function loadMore(page: Page, retry = false) {
  await page.getByRole('button', { name: retry ? 'Retry more' : 'Load more', exact: true }).click();
  await expect(page.getByText('Showing 208 of 208', { exact: true })).toBeVisible();
  const calls = await recorded(page); const input = calls.filter(call => call.method === 'leads.list').at(-1)!.args![0] as LeadsListRequest;
  expect(input.cursor).toEqual(expect.any(String)); expect(input.cursor).not.toBe('200');
  return read('leads.list', { ...request, cursor: input.cursor });
}
async function openPerson(page: Page, n: number, full = false) {
  const row = await reveal(page, n); await row.focus(); await row.press('Enter');
  const dock = page.getByRole('complementary', { name: `${name(n)} details`, exact: true });
  await expect(dock).toBeVisible();
  if (full) { await dock.getByRole('button', { name: 'Open full page', exact: true }).click(); }
  const surface = full ? page.getByRole('article', { name: `${name(n)} full page`, exact: true }) : dock;
  await openReviewControls(surface); return surface;
}
const openedReads = (n: number) => [read('leadDetail.get', { personId: person(n) }), read('discovery.getBrief', { personId: person(n) })];
async function openReviewControls(surface: Locator) {
  await surface.locator('.lead-inspector__diagnostics > summary').click();
  const evidence = surface.getByRole('region', { name: 'Prepared conversation evidence', exact: true });
  await expect(evidence.getByText('Not assessed', { exact: true })).toBeVisible();
  await expect(evidence.getByRole('alert')).toHaveCount(0);
  await surface.getByRole('button', { name: 'Founder manual controls', exact: true }).click();
  await expect(surface.getByRole('button', { name: 'Mark ready', exact: true })).toBeVisible();
}
async function startInline(page: Page, field: 'name' | 'organization' = 'name') {
  const row = await reveal(page, 1);
  await row.locator(field === 'name' ? '.leads-grid__name' : '.leads-grid__organization').dblclick();
  const input = page.getByRole('textbox', { name: `Edit ${field} for ${name(1)}`, exact: true });
  await expect(input).toBeFocused(); return input;
}
async function selectHiddenPair(page: Page, checkpoint: (...calls: Call[]) => Promise<void>) {
  await (await reveal(page, 1)).getByRole('checkbox', { name: `Select ${name(1)}`, exact: true }).check();
  await checkpoint(await loadMore(page));
  await (await reveal(page, 208)).getByRole('checkbox', { name: `Select ${name(208)}`, exact: true }).check();
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill(name(1));
  await expect(page.getByText('Showing 1 of 1', { exact: true })).toBeVisible();
  await expect(page.getByText('2 selected · 1 outside view', { exact: true })).toBeVisible();
  await checkpoint(read('leads.list', { ...request, query: name(1) }));
}
async function nativeIsolation(page: Page, dialog: Locator, pointer = true) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
  const stops = await dialog.locator('button:visible:not(:disabled),input:visible:not(:disabled),textarea:visible:not(:disabled),select:visible:not(:disabled),[tabindex="0"]:visible').count();
  for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < Math.max(4, stops * 2 + 1); i++) {
    await page.keyboard.press(key); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  const target = page.locator('.nav-rail a[href="#/accounts"]'), box = await target.boundingBox();
  expect(box).not.toBeNull(); const before = page.url();
  // Palette intentionally dismisses on a backdrop click. Import does not.
  if (pointer) await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  expect(page.url()).toBe(before); await expect(dialog).toBeVisible();
  await target.evaluate(element => (element as HTMLElement).focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
}
async function paletteThenImport(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await nativeIsolation(page, palette, false);
  await palette.getByRole('combobox', { name: 'Command palette', exact: true }).fill('Import leads');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
  await nativeIsolation(page, dialog); await expect(palette).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
const readyInput = (n: number) => ({ transition: 'review_to_ready', salesCycleId: `cycle-leads-${String(n).padStart(3, '0')}`, expectedRevision: 1 });

async function readableBox(locator: Locator, minimumWidth: number) {
  const geometry = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      // These grid ancestors are unscaled. Borders and scrollbar gutters are not visible client space.
      const clientLeft = bounds.left + parent.clientLeft, clientTop = bounds.top + parent.clientTop;
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, clientLeft); right = Math.min(right, clientLeft + parent.clientWidth); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, clientTop); bottom = Math.min(bottom, clientTop + parent.clientHeight); }
    }
    // Single-line inputs intentionally scroll their value. Buttons/count/feedback must fit their text.
    let textFits = true;
    if (!(element instanceof HTMLInputElement)) {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        textFits = element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1;
      } else {
        const range = document.createRange(); range.selectNodeContents(element);
        const fragments = [...range.getClientRects()].filter(fragment => fragment.width > 0 && fragment.height > 0);
        textFits = fragments.length > 0 && fragments.every(fragment => fragment.left >= rect.left - 1 && fragment.right <= rect.right + 1 && fragment.top >= rect.top - 1 && fragment.bottom <= rect.bottom + 1);
      }
    }
    return { width: rect.width, height: rect.height, visibleWidth: right - left, visibleHeight: bottom - top, textFits };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(minimumWidth);
  expect(geometry.visibleWidth).toBeGreaterThanOrEqual(geometry.width - 1);
  expect(geometry.visibleHeight).toBeGreaterThanOrEqual(geometry.height - 1);
  expect(geometry.height).toBeGreaterThanOrEqual(16);
  expect(geometry.textFits).toBe(true);
}

async function editorGeometry(page: Page, input: Locator, kind: 'inline' | 'bulk') {
  await readableBox(input, 120);
  await readableBox(page.getByRole('alert'), 240);
  for (const label of kind === 'inline' ? ['Save edit', 'Cancel edit'] : ['Save organization', 'Cancel organization', 'Clear']) {
    await readableBox(page.getByRole('button', { name: label, exact: true }), 24);
  }
  if (kind === 'bulk') await readableBox(page.getByText('2 selected · 1 outside view', { exact: true }), 120);
  const context = page.locator('.leads-grid__row .leads-grid__col--context').first();
  const header = page.locator('.leads-grid__head .leads-grid__col--context');
  const box = await context.boundingBox(), head = await header.boundingBox();
  expect(box).not.toBeNull(); expect(head).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(160);
  expect(Math.abs(box!.x - head!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - head!.width)).toBeLessThanOrEqual(1);
}

test('actual Leads exposes all 208 with unique sampled rows and keyboard crosses the loaded page boundary', async ({ page }) => {
  const h = await mount(page);
  await expect(page.getByRole('grid', { name: 'Leads', exact: true })).toHaveAttribute('aria-rowcount', '201');
  await h.checkpoint(await loadMore(page));
  await expect(page.getByRole('grid', { name: 'Leads', exact: true })).toHaveAttribute('aria-rowcount', '209');
  const seen = new Set<string>();
  for (let n = 1; n <= 208; n += 8) {
    await reveal(page, n);
    const sampled = await page.locator('.leads-grid [data-person-id]').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-person-id')!, index: element.getAttribute('aria-rowindex')! })));
    expect(new Set(sampled.map(row => row.id)).size).toBe(sampled.length);
    expect(new Set(sampled.map(row => row.index)).size).toBe(sampled.length);
    for (const row of sampled) { expect(Number(row.index)).toBe(Number(row.id.slice(-3)) + 1); seen.add(row.id); }
  }
  expect([...seen].sort()).toEqual(Array.from({ length: 208 }, (_, i) => person(i + 1)).sort());
  const row = await reveal(page, 200); await row.focus();
  for (let n = 201; n <= 208; n++) { await page.keyboard.press('ArrowDown'); await expect(page.locator(`[data-person-id="${person(n)}"]`)).toBeFocused(); }
  await page.keyboard.press('Enter'); await expect(page.getByRole('complementary', { name: `${name(208)} details`, exact: true })).toBeVisible();
  await h.checkpoint(read('leadDetail.get', { personId: person(208) })); await h.presentation();
});

test('actual failed append retains rows and checks and retries the exact cursor', async ({ page }) => {
  const h = await mount(page); await (await reveal(page, 1)).getByRole('checkbox').check();
  const token = await defer(page, 'leads.list'); await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeDisabled();
  const input = (await operations(page)).find(op => op.token === token)!.input as LeadsListRequest;
  expect(input.cursor).toEqual(expect.any(String)); await h.checkpoint(read('leads.list', { ...request, cursor: input.cursor }));
  await settle(page, token, 'reject'); await expect(page.getByText('More leads could not be loaded. Your loaded rows are kept.', { exact: true })).toBeVisible();
  await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible(); await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
  const retry = await loadMore(page, true); expect(retry).toEqual(read('leads.list', input)); await h.checkpoint(retry);
});

for (const sort of ['person_name', 'last_contact'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  test(`actual repeated active ${sort} sort preserves pending append ${outcome}`, async ({ page }) => {
    const h = await mount(page);
    const header = page.getByRole('columnheader').getByRole('button', { name: sort === 'person_name' ? 'Person' : 'Last activity', exact: true });
    await header.click(); await h.checkpoint(read('leads.list', { ...request, sort }));
    await (await reveal(page, 1)).getByRole('checkbox').check();
    const token = await defer(page, 'leads.list'); await page.getByRole('button', { name: 'Load more', exact: true }).click();
    const input = (await operations(page)).find(op => op.token === token)!.input as LeadsListRequest;
    expect(input).toEqual({ ...request, sort, cursor: expect.any(String) });
    await h.checkpoint(read('leads.list', input));
    await header.click(); await h.checkpoint();
    await settle(page, token, outcome);
    if (outcome === 'reject') {
      const retry = page.getByRole('button', { name: 'Retry more', exact: true });
      await expect(retry).toBeEnabled();
      await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
      await retry.click(); await h.checkpoint(read('leads.list', input));
    }
    await expect(page.getByText('Showing 208 of 208', { exact: true })).toBeVisible();
    await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
    await h.checkpoint();
  });
}

test('actual sort and stage controls restart only their exact query window', async ({ page }) => {
  const h = await mount(page);
  for (const sort of ['person_name', 'last_contact', 'priority'] as const) {
    await page.getByRole('combobox', { name: 'Sort leads', exact: true }).click();
    await page.getByRole('option', { name: { person_name: 'Name', last_contact: 'Last contact', priority: 'Priority' }[sort], exact: true }).click();
    await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
    await h.checkpoint(read('leads.list', { ...request, sort }));
  }
  const filters = page.getByRole('group', { name: 'Filter by stage', exact: true });
  await filters.getByRole('button', { name: 'Unreviewed', exact: true }).click();
  await h.checkpoint(read('leads.list', { ...request, stages: ['unreviewed'] }));
  await filters.getByRole('button', { name: 'Ready', exact: true }).click();
  await h.checkpoint(read('leads.list', { ...request, stages: ['unreviewed', 'ready'] }));
  await filters.getByRole('button', { name: 'Unreviewed', exact: true }).click();
  await expect(page.getByText('Showing 0 of 0', { exact: true })).toBeVisible();
  await h.checkpoint(read('leads.list', { ...request, stages: ['ready'] }));
  await filters.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible(); await h.checkpoint(read('leads.list', request));
});

for (const first of [true, false]) test(`actual late ${first ? 'first' : 'append'} read cannot overwrite newer search`, async ({ page }) => {
  const h = await mount(page), token = await defer(page, 'leads.list');
  await page.getByRole('button', { name: first ? 'Refresh list' : 'Load more', exact: true }).click();
  const old = (await operations(page)).find(op => op.token === token)!.input as LeadsListRequest;
  expect(old.cursor === null).toBe(first); await h.checkpoint(read('leads.list', { ...request, cursor: old.cursor }));
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill(name(1));
  await expect(page.getByText('Showing 1 of 1', { exact: true })).toBeVisible(); await h.checkpoint(read('leads.list', { ...request, query: name(1) }));
  await settle(page, token, 'resolve'); await page.evaluate(() => window.applicationPresentation.frame());
  await expect(page.getByText('Showing 1 of 1', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0); await h.checkpoint();
});

for (const theme of ['light', 'dark'] as const) for (const density of ['compact', 'comfortable'] as const) for (const width of [1050, 1440] as const) {
  const context = { theme, density, width };
  for (const kind of ['inline', 'bulk'] as const) test(`actual ${kind} pending rejection and modal ownership ${theme} ${density} ${width}`, async ({ page }) => {
    const h = await mount(page, context);
    if (kind === 'bulk') { await selectHiddenPair(page, h.checkpoint); await page.getByRole('button', { name: 'Set organization', exact: true }).click(); }
    const input = kind === 'inline' ? await startInline(page) : page.getByRole('textbox', { name: 'Organization for 2 selected', exact: true });
    const value = kind === 'inline' ? 'Renamed Lead' : 'Shared Test Company';
    await input.fill(value); const node = await input.elementHandle();
    await input.evaluate(element => (element as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
    await h.checkpoint();
    await paletteThenImport(page); await expect(input).toBeFocused(); await expect(input).toHaveValue(value); await h.checkpoint();
    const method = kind === 'inline' ? 'leads.updateField' : 'leads.bulkUpdate';
    const payload = kind === 'inline' ? { personId: person(1), field: 'person_name', value } : { personIds: [person(1), person(208)], field: 'organization_label', value };
    const token = await arm(page, method); await input.press('Enter'); await input.press('Enter'); await input.press('Escape');
    await expect(input).toHaveAttribute('readonly', '');
    if (kind === 'bulk') {
      await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
      await expect(page.getByRole('checkbox', { name: `Select ${name(1)}`, exact: true })).toBeDisabled();
    }
    await h.checkpoint(command(method, payload));
    await paletteThenImport(page);
    expect(await node!.evaluate(element => element.isConnected)).toBe(true); await expect(input).toHaveValue(value);
    expect(await input.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd, (element as HTMLInputElement).selectionDirection])).toEqual([2, 6, 'backward']);
    await h.checkpoint();
    await settle(page, token, 'reject'); await expect(input).not.toHaveAttribute('readonly');
    await expect(page.getByRole('alert')).toContainText('Your input is kept');
    expect(await node!.evaluate(element => element.isConnected)).toBe(true); await expect(input).toHaveValue(value);
    if (kind === 'bulk') await expect(page.getByText('2 selected · 1 outside view', { exact: true })).toBeVisible();
    await input.focus(); await paletteThenImport(page); await expect(input).toBeFocused(); await h.checkpoint(); await h.presentation();
    await editorGeometry(page, input, kind);
    await page.screenshot({ path: test.info().outputPath(`${kind}-${theme}-${density}-${width}.png`), animations: 'disabled' });
    const retry = await arm(page, method); await input.press('Enter'); await h.checkpoint(command(method, payload));
    await settle(page, retry, 'resolve'); await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await h.checkpoint(read('leads.list', kind === 'bulk' ? { ...request, query: name(1) } : request));
    await expect(input).toHaveCount(0);
    if (kind === 'bulk') await expect(page.getByRole('toolbar', { name: 'Bulk actions', exact: true })).toHaveCount(0);
  });
}

test('actual inline edit stays usable beside a nonmodal inspector and respects Escape ownership', async ({ page }) => {
  const h = await mount(page), inspector = await openPerson(page, 2);
  await h.checkpoint(...openedReads(2));
  const input = await startInline(page); await input.fill('Retained beside inspector');
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).focus();
  await page.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(input).toBeFocused(); await expect(inspector).toBeVisible();
  await paletteThenImport(page); await expect(input).toBeFocused(); await expect(inspector).toBeVisible(); await h.checkpoint();
  const token = await arm(page, 'leads.updateField');
  await input.press('Enter'); await input.press('Enter');
  await expect(input).toHaveAttribute('readonly', '');
  await h.checkpoint(command('leads.updateField', { personId: person(1), field: 'person_name', value: 'Retained beside inspector' }));
  await settle(page, token, 'reject'); await expect(input).not.toHaveAttribute('readonly');
  await expect(page.getByRole('region', { name: 'Unfinished edit', exact: true }).getByRole('alert')).toContainText('Your input is kept');
  await expect(input).toHaveValue('Retained beside inspector');
  await expect(inspector).toBeVisible();
  await input.press('Escape'); await expect(inspector).toHaveCount(0);
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Retained beside inspector');
  await input.press('Escape'); await expect(input).toHaveCount(0);
  await h.checkpoint(); await h.presentation();
});

test('actual acknowledged inline save followed by failed refresh cannot be resubmitted', async ({ page }) => {
  const h = await mount(page), input = await startInline(page, 'organization'); await input.fill('');
  const write = await arm(page, 'leads.updateField'); await input.press('Enter');
  const refresh = await defer(page, 'leads.list'); await settle(page, write, 'resolve');
  await expect.poll(async () => (await operations(page)).find(op => op.token === refresh)?.state).toBe('pending');
  await settle(page, refresh, 'reject'); await expect(page.getByText('Saved; list refresh failed', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  await h.checkpoint(command('leads.updateField', { personId: person(1), field: 'organization_label', value: null }), read('leads.list', request));
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click(); await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
  await h.checkpoint(read('leads.list', request));
});

test('actual virtual cell removal keeps one unfinished draft and exact original owner', async ({ page }) => {
  const h = await mount(page), input = await startInline(page); await input.fill('Retained Person');
  const old = await input.elementHandle(); await reveal(page, 190);
  const recovery = page.getByRole('region', { name: 'Unfinished edit', exact: true });
  await expect(recovery).toBeVisible(); expect(await old!.evaluate(element => element.isConnected)).toBe(false);
  await expect(page.getByRole('textbox', { name: `Edit name for ${name(1)}`, exact: true })).toHaveCount(1);
  await expect(recovery.getByRole('textbox')).toHaveValue('Retained Person');
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill('No matching fictional name');
  await expect(page.getByText('No matching leads', { exact: true })).toBeVisible();
  await expect(recovery.getByRole('textbox')).toHaveValue('Retained Person');
  const token = await arm(page, 'leads.updateField'); await recovery.getByRole('button', { name: 'Save edit', exact: true }).click();
  await settle(page, token, 'reject'); await expect(recovery.getByRole('textbox')).toHaveValue('Retained Person');
  await expect(recovery.getByRole('alert')).toContainText('Your input is kept');
  await h.checkpoint(read('leads.list', { ...request, query: 'No matching fictional name' }), command('leads.updateField', { personId: person(1), field: 'person_name', value: 'Retained Person' }));
});

test('actual search typing keeps focus across passive draft recovery and row remounts', async ({ page }) => {
  const h = await mount(page), input = await startInline(page); await input.fill('Retained Person');
  const search = page.getByRole('searchbox', { name: 'Search leads', exact: true });
  await search.focus(); const token = await defer(page, 'leads.list'); await page.keyboard.type('T');
  await expect.poll(async () => (await operations(page)).find(op => op.token === token)?.state).toBe('pending');
  await expect(search).toBeFocused(); await expect(search).toHaveValue('T');
  await expect(page.getByRole('region', { name: 'Unfinished edit', exact: true }).getByRole('textbox')).toHaveValue('Retained Person');
  await h.checkpoint(read('leads.list', { ...request, query: 'T' }));
  await settle(page, token, 'resolve'); await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.type('e'); await expect(search).toHaveValue('Te'); await expect(search).toBeFocused();
  await expect(input).toHaveValue('Retained Person');
  await h.checkpoint(read('leads.list', { ...request, query: 'Te' }));
});

test('actual passive virtual draft recovery waits for explicit resume before moving focus', async ({ page }) => {
  const h = await mount(page), input = await startInline(page); await input.fill('Retained Person');
  const search = page.getByRole('searchbox', { name: 'Search leads', exact: true }); await search.focus();
  await reveal(page, 190);
  const recovery = page.getByRole('region', { name: 'Unfinished edit', exact: true });
  await expect(recovery.getByRole('textbox')).toHaveValue('Retained Person'); await expect(search).toBeFocused();
  await recovery.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(recovery.getByRole('textbox')).toBeFocused();
  await paletteThenImport(page); await expect(recovery.getByRole('textbox')).toBeFocused();
  await expect(recovery.getByRole('textbox')).toHaveValue('Retained Person'); await h.checkpoint();
});

for (const full of [false, true]) for (const last of [200, 208]) test(`actual review boundary ${last} ${full ? 'full' : 'docked'} returns to explicit refresh`, async ({ page }) => {
  const h = await mount(page, full ? { theme: 'dark', density: 'comfortable', width: 1050 } : standard);
  if (last === 208) await h.checkpoint(await loadMore(page));
  await (await reveal(page, 1)).getByRole('checkbox').check();
  const surface = await openPerson(page, last, full); await h.checkpoint(...openedReads(last));
  const token = await arm(page, 'leadDetail.confirmTransition'); await surface.getByRole('button', { name: 'Mark ready', exact: true }).click();
  await h.checkpoint(command('leadDetail.confirmTransition', readyInput(last))); await expect(surface).toBeVisible();
  await settle(page, token, 'resolve'); await expect(surface).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh list', exact: true })).toBeFocused();
  await expect(page.getByText('Decision saved. No next person is loaded in this order. Refresh the list to continue.', { exact: true })).toBeVisible();
  await expect(page.getByText(`Last loaded: ${last} of 208`, { exact: true })).toBeVisible();
  await expect(page.getByText('1 selected', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0); await h.checkpoint();
  const refresh = await defer(page, 'leads.list'); await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await settle(page, refresh, 'reject'); await expect(page.getByText('Decision saved. No next person is loaded in this order. Refresh the list to continue.', { exact: true })).toBeVisible();
  await h.checkpoint(read('leads.list', request));
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click(); await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
  await h.checkpoint(read('leads.list', request)); await h.presentation();
});

for (const full of [false, true]) test(`actual loaded 199 through 202 advances without page-one reload ${full ? 'full' : 'docked'}`, async ({ page }) => {
  const h = await mount(page); await h.checkpoint(await loadMore(page)); await openPerson(page, 199, full);
  await h.checkpoint(...openedReads(199));
  for (let n = 199; n <= 201; n++) {
    const surface = page.getByRole(full ? 'article' : 'complementary', { name: `${name(n)} ${full ? 'full page' : 'details'}`, exact: true });
    const token = await arm(page, 'leadDetail.confirmTransition'); await surface.getByRole('button', { name: 'Mark ready', exact: true }).click();
    await settle(page, token, 'resolve');
    const next = page.getByRole(full ? 'article' : 'complementary', { name: `${name(n + 1)} ${full ? 'full page' : 'details'}`, exact: true });
    await expect(next).toBeVisible(); await openReviewControls(next);
    await h.checkpoint(command('leadDetail.confirmTransition', readyInput(n)), ...openedReads(n + 1));
  }
  await expect(page.getByText('Last loaded: 208 of 208', { exact: true })).toBeVisible();
});

test('actual accepted review quarantines an already pending old append', async ({ page }) => {
  const h = await mount(page), old = await defer(page, 'leads.list'); await page.getByRole('button', { name: 'Load more', exact: true }).click();
  const input = (await operations(page)).find(op => op.token === old)!.input as LeadsListRequest;
  await h.checkpoint(read('leads.list', { ...request, cursor: input.cursor }));
  const surface = await openPerson(page, 199); await h.checkpoint(...openedReads(199));
  const token = await arm(page, 'leadDetail.confirmTransition'); await surface.getByRole('button', { name: 'Mark ready', exact: true }).click();
  await settle(page, token, 'resolve'); await expect(page.getByRole('complementary', { name: `${name(200)} details`, exact: true })).toBeVisible();
  await h.checkpoint(command('leadDetail.confirmTransition', readyInput(199)), read('leadDetail.get', { personId: person(200) }));
  await settle(page, old, 'resolve'); await page.evaluate(() => window.applicationPresentation.frame());
  await expect(page.getByText('Last loaded: 200 of 208', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0); await h.checkpoint();
});

for (const full of [false, true]) test(`actual rejected ready decision retains its person and retries explicitly ${full ? 'full' : 'docked'}`, async ({ page }) => {
  const h = await mount(page), surface = await openPerson(page, 199, full);
  await h.checkpoint(...openedReads(199));
  const ready = surface.getByRole('button', { name: 'Mark ready', exact: true });
  const token = await arm(page, 'leadDetail.confirmTransition'); await ready.click();
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(ready).toBeDisabled(); await expect(surface.getByRole('button', { name: 'Dismiss', exact: true })).toBeDisabled();
  await h.checkpoint(command('leadDetail.confirmTransition', readyInput(199)));
  await settle(page, token, 'reject');
  await expect(surface.getByRole('region', { name: 'Review this lead', exact: true }).getByRole('alert')).toHaveText('Decision not confirmed. Your selection is unchanged.');
  await expect(ready).toBeEnabled(); await h.checkpoint();
  const retry = await arm(page, 'leadDetail.confirmTransition'); await ready.click(); await settle(page, retry, 'resolve');
  await expect(page.getByRole(full ? 'article' : 'complementary', { name: `${name(200)} ${full ? 'full page' : 'details'}`, exact: true })).toBeVisible();
  await h.checkpoint(command('leadDetail.confirmTransition', readyInput(199)), read('leadDetail.get', { personId: person(200) }));
  await expect(page.getByText('Last loaded: 200 of 208', { exact: true })).toBeVisible();
});

for (const full of [false, true]) test(`actual rejected dismissal retains its person and explicit retry advances only after acceptance ${full ? 'full' : 'docked'}`, async ({ page }) => {
  const h = await mount(page), surface = await openPerson(page, 199, full);
  await h.checkpoint(...openedReads(199));
  await surface.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await surface.getByRole('combobox', { name: 'Dismissal reason', exact: true }).click();
  await surface.getByRole('option', { name: 'Out of area', exact: true }).click();
  const payload = { personId: person(199), salesCycleId: 'cycle-leads-199', qualificationGateReason: 'out_of_area', expectedRevision: 1 };
  const token = await arm(page, 'leadDetail.dismissLead');
  await surface.getByRole('button', { name: 'Confirm dismiss', exact: true }).click();
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  for (const label of ['Mark ready', 'Confirm dismiss', 'Cancel']) await expect(surface.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await expect(surface.getByRole('combobox', { name: 'Dismissal reason', exact: true })).toBeDisabled();
  await h.checkpoint(command('leadDetail.dismissLead', payload)); await expect(surface).toBeVisible();
  await settle(page, token, 'reject');
  await expect(surface).toBeVisible();
  await expect(surface.getByRole('region', { name: 'Review this lead', exact: true }).getByRole('alert')).toHaveText('Decision not confirmed. Your selection is unchanged.');
  await expect(surface.getByRole('combobox', { name: 'Dismissal reason', exact: true })).toHaveText('Out of area');
  await h.checkpoint();
  const retry = await arm(page, 'leadDetail.dismissLead');
  await surface.getByRole('button', { name: 'Confirm dismiss', exact: true }).click();
  await settle(page, retry, 'resolve');
  await expect(page.getByRole(full ? 'article' : 'complementary', { name: `${name(200)} ${full ? 'full page' : 'details'}`, exact: true })).toBeVisible();
  await h.checkpoint(command('leadDetail.dismissLead', payload), read('leadDetail.get', { personId: person(200) }));
  await expect(page.getByText('Last loaded: 200 of 208', { exact: true })).toBeVisible();
});

for (const full of [false, true]) for (const destination of ['underlay', 'palette'] as const) test(`actual boundary does not steal ${destination} focus ${full ? 'full' : 'docked'}`, async ({ page }) => {
  const h = await mount(page), surface = await openPerson(page, 200, full); await h.checkpoint(...openedReads(200));
  const token = await arm(page, 'leadDetail.confirmTransition'); await surface.getByRole('button', { name: 'Mark ready', exact: true }).click();
  const target = destination === 'underlay' ? page.getByRole('button', { name: 'More workspaces', exact: true }) : page.getByRole('combobox', { name: 'Command palette', exact: true });
  if (destination === 'palette') await page.keyboard.press('ControlOrMeta+k'); else await target.click();
  await expect(target).toBeFocused(); await settle(page, token, 'resolve'); await expect(surface).toHaveCount(0); await expect(target).toBeFocused();
  await h.checkpoint(command('leadDetail.confirmTransition', readyInput(200)));
  if (destination === 'palette') await nativeIsolation(page, page.getByRole('dialog', { name: 'Command palette', exact: true }), false);
});

test('actual 201 checked people refuse a bulk command without dropping checks or chunking', async ({ page }) => {
  test.setTimeout(90000);
  const h = await mount(page); await h.checkpoint(await loadMore(page));
  for (let n = 1; n <= 201; n++) await (await reveal(page, n)).getByRole('checkbox', { name: `Select ${name(n)}`, exact: true }).check();
  await expect(page.getByText('201 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Set organization', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Organization for 201 selected', exact: true }); await input.fill('No partial update'); await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Select 200 or fewer people for one update. No records submitted.');
  await expect(input).toHaveValue('No partial update'); await expect(page.getByText('201 selected', { exact: true })).toBeVisible(); await h.checkpoint();
  expect(await operations(page)).toEqual([]);
});
