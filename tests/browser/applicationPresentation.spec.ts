import { test, expect, type Locator, type Page } from 'playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { openImportScript } from '../../src/main/applicationMenu';
import type { ApplicationPresentationBrowser } from '../fixtures/applicationPresentationBrowser';
import { appRoutes, assertActualDestination, assertSharedPresentation, assertTransitionPresentation, navigateActualRoute, nativePalette, presentationSample, routeLinkName, routeProofs, type PresentationContext } from '../support/presentationOracle';

let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/applicationPresentationBrowser.tsx')], outdir: 'application-presentation-fixture', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page, context: PresentationContext, initialRoute: typeof appRoutes[number] = 'today') {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:41838/application-presentation?mode=${context.mode}`;
  await page.addInitScript(context => {
    if (localStorage.getItem('callie.theme') === null) localStorage.setItem('callie.theme', context.theme);
    if (localStorage.getItem('callie.density') === null) localStorage.setItem('callie.density', context.density);
  }, context);
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Actual application routes</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>` });
    requests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: context.width, height: context.width === 1440 ? 900 : 700 });
  await page.emulateMedia({ colorScheme: context.theme });
  await page.goto(`${url}#/${initialRoute}`);
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  return { errors, requests };
}
const calls = (page: Page) => page.evaluate((): ApplicationPresentationBrowser['calls'] => window.applicationPresentation.calls);
const kevinRow = (page: Page) => page.getByRole('grid').locator('[role="row"][data-person-id="person-kevin"]');
async function openKevin(page: Page) {
  const row = kevinRow(page);
  await expect(row).toBeVisible();
  await row.focus();
  await row.press('Enter');
}

async function assertModalIsolation(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press(key);
      const focus = await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 600), focusedDocument: document.hasFocus(), modal: element.matches(':modal') }));
      expect(focus.inside, JSON.stringify({ key, index, ...focus })).toBe(true);
    }
  }
  // Native modal isolation must also prevent background controls taking focus.
  await page.locator('.nav-rail [aria-current="page"]').evaluate(element => (element as HTMLElement).focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true });
});

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1050] as const) {
  test(`actual navigation keyboard focus preserves selection and More hover ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'comfortable', width });
    const rail = page.getByRole('navigation', { name: 'Primary', exact: true });
    const samples = [];
    for (const route of ['today', 'leads'] as const) {
      await navigateActualRoute(page, route);
      // A real key event establishes keyboard modality before explicitly focusing each link.
      await page.keyboard.press('Tab');
      for (const selected of [true, false]) {
        const link = selected ? rail.locator('[aria-current="page"]') : rail.getByRole('link', { name: 'Accounts', exact: true });
        await link.focus();
        const sample = await link.evaluate(element => {
          const style = getComputedStyle(element);
          return { focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'), radius: style.borderRadius, shadow: style.boxShadow };
        });
        samples.push({ route, selected, ...sample });
        expect.soft(sample.focused).toBe(true);
        expect.soft(sample.focusVisible).toBe(true);
        expect.soft(sample.radius).toBe('6px');
        expect.soft(sample.shadow).toContain('0px 0px 0px 2px');
        if (selected) expect.soft(sample.shadow).toContain('inset');
      }
    }
    const more = rail.getByRole('button', { name: 'More workspaces', exact: true });
    await more.hover();
    const moreBackground = await more.evaluate(element => getComputedStyle(element).backgroundColor);
    expect.soft(moreBackground).toBe('rgba(0, 0, 0, 0)');
    expect(observed.errors).toEqual([]);
    expect(observed.requests).toEqual([]);
    expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    writeFileSync(info.outputPath('navigation-states.json'), JSON.stringify({ theme, width, samples, moreBackground }, null, 2));
  });
}

for (const mode of ['meeting_first', 'legacy'] as const) for (const theme of ['light', 'dark'] as const) for (const density of ['comfortable', 'compact'] as const) for (const width of [1440, 1050] as const) {
  test(`actual ten-route shared presentation ${mode} ${theme} ${density} ${width}`, async ({ page }, info) => {
    const context = { mode, theme, density, width };
    const observed = await mount(page, context, 'settings');
    await assertActualDestination(page, 'settings', mode);
    const samples: { route: string; sample: Awaited<ReturnType<typeof presentationSample>>; transition: ReturnType<ApplicationPresentationBrowser['stopPresentationFrames']> }[] = [];
    let recordedCalls: ApplicationPresentationBrowser['calls'] = [];
    const persist = () => writeFileSync(info.outputPath('route-observations.json'), JSON.stringify({ context, samples, calls: recordedCalls, ...observed }, null, 2));
    try {
      for (const route of appRoutes) {
        await test.step(`actual ${route} route`, async () => {
        const before = (await calls(page)).length;
        await page.evaluate(() => window.applicationPresentation.startPresentationFrames());
        await navigateActualRoute(page, route);
        await assertActualDestination(page, route, mode);
        if (route === 'inbox') {
          // A global limit-one summary cannot stand in for this route's selected queue.
          await expect.poll(async () => (await calls(page)).slice(before)
            .filter(call => call.method === 'review.list').map(call => call.args))
            .toContainEqual([{ kinds: ['unmatched_communication'], cursor: null, limit: 200 }]);
        } else {
          await expect.poll(async () => (await calls(page)).slice(before).some(call => call.method === routeProofs[route].read)).toBe(true);
        }
        await page.evaluate(() => window.applicationPresentation.frame());
        const sample = await presentationSample(page);
        const transition = await page.evaluate(() => window.applicationPresentation.stopPresentationFrames());
        samples.push({ route, sample, transition });
        recordedCalls = await calls(page);
        persist();
        assertSharedPresentation(sample, context);
        assertTransitionPresentation(transition, context);
        if (mode === 'meeting_first' && density === 'compact' && width === 1440) await page.screenshot({ path: info.outputPath(`${route}-${theme}.png`), fullPage: true });
        });
      }
      expect(samples.map(sample => sample.route)).toEqual([...appRoutes]);
      expect(observed.errors).toEqual([]);
      expect(observed.requests).toEqual([]);
      expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    } finally {
      persist();
    }
  });
}

for (const mode of ['meeting_first', 'legacy'] as const) for (const width of [1440, 1050] as const) {
  test(`actual deep-linked routes survive document reload ${mode} ${width}`, async ({ page }) => {
    const context: PresentationContext = { mode, width, theme: width === 1440 ? 'dark' : 'light', density: 'compact' };
    const observed = await mount(page, context, 'leads');
    const base = page.url().split('#')[0];
    for (const route of appRoutes) {
      await page.goto(`${base}#/${route}`);
      await page.reload();
      const active = page.locator('.nav-rail').getByRole('link', { name: routeLinkName(route), exact: true, includeHidden: true });
      await expect(active).toHaveAttribute('aria-current', 'page');
      // A deep-linked secondary destination may correctly start under collapsed More.
      if (!await active.isVisible()) await page.getByRole('button', { name: 'More workspaces', exact: true }).click();
      await expect(active).toBeVisible();
      await expect(page.locator('main').getByRole('heading', { level: 1, name: routeProofs[route].heading, exact: true })).toBeVisible();
      await assertActualDestination(page, route, mode);
      assertSharedPresentation(await presentationSample(page), context);
      expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    }
    expect(observed.errors).toEqual([]);
    expect(observed.requests).toEqual([]);
  });
}

for (const mode of ['meeting_first', 'legacy'] as const) for (const theme of ['light', 'dark'] as const) for (const density of ['comfortable', 'compact'] as const) for (const width of [1440, 1050] as const) for (const view of ['docked', 'full'] as const) {
  test(`actual contact ${view} shares presentation and survives topmost Escape ${mode} ${theme} ${density} ${width}`, async ({ page }, info) => {
    const context: PresentationContext = { mode, theme, density, width };
    const observed = await mount(page, context);
    await navigateActualRoute(page, 'leads');
    await openKevin(page);
    await expect(page.getByRole('complementary', { name: 'Kevin Shin details', exact: true })).toBeVisible();
    if (view === 'full') await page.getByRole('button', { name: 'Open full page', exact: true }).click();
    const contact = page.locator(view === 'full' ? '.lead-full-page' : '.lead-inspector');
    await expect(contact.getByRole('heading', { name: 'Kevin Shin', exact: true })).toBeVisible();
    const original = await contact.elementHandle();
    expect(original).not.toBeNull();
    const samples = [];
    for (const route of appRoutes) {
      await navigateActualRoute(page, route);
      await assertActualDestination(page, route, context.mode);
      await expect(contact.getByRole('heading', { name: 'Kevin Shin', exact: true })).toBeVisible();
      const sample = await contact.evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor, font: style.fontFamily, left: element.getBoundingClientRect().left, railRight: document.querySelector('.nav-rail')!.getBoundingClientRect().right };
      });
      samples.push({ route, ...sample });
      expect.soft(sample.color).toBe(nativePalette[theme].text);
      expect.soft(sample.background).toBe(view === 'full' ? nativePalette[theme].canvas : nativePalette[theme].surface);
      expect.soft(sample.font).toContain('-apple-system');
      if (view === 'full') expect.soft(Math.abs(sample.left - sample.railRight)).toBeLessThanOrEqual(1);
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    }
    const opener = contact.getByRole('tab', { name: 'Overview', exact: true });
    await opener.click();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await assertModalIsolation(page, palette);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(contact).toBeVisible();
    await expect(opener).toBeFocused();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(contact).toHaveCount(0);
    expect(observed.errors).toEqual([]);
    expect(observed.requests).toEqual([]);
    expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    const detailReads = (await calls(page)).filter(call => call.method === 'leadDetail.get');
    expect(detailReads.length).toBeGreaterThan(0);
    expect(detailReads.every(call => JSON.stringify(call.args) === JSON.stringify([{ personId: 'person-kevin' }]))).toBe(true);
    writeFileSync(info.outputPath('contact-observations.json'), JSON.stringify({ samples, calls: await calls(page) }, null, 2));
  });
}

for (const state of ['pending', 'failed'] as const) {
  test(`actual pending or failed contact has a usable Close control ${state}`, async ({ page }) => {
    const observed = await mount(page, { mode: 'meeting_first', theme: 'light', density: 'comfortable', width: 1050 });
    await navigateActualRoute(page, 'leads');
    await page.evaluate(state => window.applicationPresentation.setDetailMode(state), state);
    await openKevin(page);
    const contact = page.getByRole('complementary', { name: 'Lead details', exact: true });
    await expect(contact).toBeVisible();
    await expect(contact.getByText(state === 'pending' ? 'Loading lead details' : "Couldn't load this lead", { exact: true })).toBeVisible();
    const close = contact.getByRole('button', { name: 'Close inspector', exact: true });
    await expect(close).toBeVisible();
    await close.click();
    await expect(contact).toHaveCount(0);
    await expect(kevinRow(page)).toBeFocused();
    await page.evaluate(() => window.applicationPresentation.resolvePendingDetails());
    await page.evaluate(() => window.applicationPresentation.frame());
    await expect(page.locator('.lead-inspector, .lead-full-page')).toHaveCount(0);
    expect(observed.errors).toEqual([]);
    expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  });
}

test('actual palette-to-Import replacement retains modal focus without closing the contact', async ({ page }) => {
  const observed = await mount(page, { mode: 'meeting_first', theme: 'light', density: 'comfortable', width: 1440 });
  await navigateActualRoute(page, 'leads');
  await openKevin(page);
  const contact = page.getByRole('complementary', { name: 'Kevin Shin details', exact: true });
  await expect(contact).toBeVisible();
  const origin = contact.getByRole('tab', { name: 'Overview', exact: true });
  await origin.click();
  await expect(origin).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await palette.getByRole('combobox', { name: 'Command palette', exact: true }).fill('Import leads');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
  await expect(palette).toHaveCount(0);
  await assertModalIsolation(page, dialog);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(contact).toBeVisible();
  await page.evaluate(() => window.applicationPresentation.frame());
  const returnFocus = await origin.evaluate(element => ({ exactOrigin: document.activeElement === element, active: document.activeElement?.outerHTML.slice(0, 600), originConnected: element.isConnected }));
  await expect(origin, JSON.stringify(returnFocus)).toBeFocused();
  expect(observed.errors).toEqual([]);
  expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
});

for (const mode of ['meeting_first', 'legacy'] as const) for (const theme of ['light', 'dark'] as const) for (const density of ['comfortable', 'compact'] as const) for (const width of [1440, 1050] as const) {
  test(`actual native Import payload and shared dialogs ${mode} ${theme} ${density} ${width}`, async ({ page }, info) => {
    const context: PresentationContext = { mode, theme, density, width };
    const observed = await mount(page, context);
    for (const route of appRoutes) {
      await navigateActualRoute(page, route);
      await assertActualDestination(page, route, context.mode);
      await page.keyboard.press('ControlOrMeta+k');
      const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
      await expect(palette).toBeVisible();
      expect(await palette.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
      expect.soft(await palette.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, font: getComputedStyle(element).fontFamily }))).toMatchObject({ color: nativePalette[theme].text, background: nativePalette[theme].surface });
      expect.soft(await palette.evaluate(element => getComputedStyle(element).fontFamily)).toContain('-apple-system');
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
      // Execute the exact native menu payload, not a browser-only key binding.
      await page.evaluate(script => window.eval(script), openImportScript);
      const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
      // Native modal content makes the background inert, and More may be collapsed.
      await expect(page.locator('.nav-rail').getByRole('link', { name: 'Leads', exact: true, includeHidden: true })).toHaveAttribute('aria-current', 'page');
      expect.soft(await dialog.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, font: getComputedStyle(element).fontFamily }))).toMatchObject({ color: nativePalette[theme].text, background: nativePalette[theme].surface });
      expect.soft(await dialog.evaluate(element => getComputedStyle(element).fontFamily)).toContain('-apple-system');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await assertActualDestination(page, 'leads', mode);
    }
    expect(observed.errors).toEqual([]);
    expect(observed.requests).toEqual([]);
    expect((await calls(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    writeFileSync(info.outputPath('dialog-calls.json'), JSON.stringify(await calls(page), null, 2));
  });
}

// Additive actual-App browser coverage for local draft continuity.
// Uses existing real App fixture/helpers with no extra allowed API operation.
// Tests navigation and native Import-open draft retention, NOT committed create or persistence.
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1050] as const) {
  test(`actual company draft survives routes and native Import opening without command replay ${theme} ${width}`, async ({ page }, info) => {
    const context: PresentationContext = { mode: 'meeting_first', theme, density: 'compact', width };
    const observed = await mount(page, context, 'accounts');
    await assertActualDestination(page, 'accounts', 'meeting_first');
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Company name', exact: true });
    const domain = page.getByRole('textbox', { name: 'Company domain (optional)', exact: true });
    const rawName = '  Browser Harbor Management  ';
    const rawDomain = ' HARBOR.EXAMPLE ';
    await name.fill(rawName);
    await domain.fill(rawDomain);
    const oldInput = await name.elementHandle();
    expect(oldInput).not.toBeNull();
    for (const route of ['campaigns', 'leads', 'today'] as const) {
      await navigateActualRoute(page, route);
      await assertActualDestination(page, route, 'meeting_first');
      await expect(page.getByRole('form', { name: 'Local company intake', exact: true })).toHaveCount(0);
    }
    expect(await oldInput!.evaluate(element => element.isConnected)).toBe(false);
    await navigateActualRoute(page, 'accounts');
    await assertActualDestination(page, 'accounts', 'meeting_first');
    await expect(name).toHaveValue(rawName);
    await expect(domain).toHaveValue(rawDomain);
    const paletteOrigin = await name.elementHandle();
    expect(paletteOrigin).not.toBeNull();
    await name.focus();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await assertModalIsolation(page, palette);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(name).toBeFocused();
    expect(await paletteOrigin!.evaluate(element => ({ connected: element.isConnected, focused: document.activeElement === element }))).toEqual({ connected: true, focused: true });
    await expect(name).toHaveValue(rawName);
    await page.evaluate(script => window.eval(script), openImportScript);
    const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
    await assertModalIsolation(page, dialog);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await assertActualDestination(page, 'leads', 'meeting_first');
    await navigateActualRoute(page, 'accounts');
    await assertActualDestination(page, 'accounts', 'meeting_first');
    await expect(name).toHaveValue(rawName);
    await expect(domain).toHaveValue(rawDomain);
    await expect(page.getByRole('button', { name: 'Review company', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeDisabled();
    const observedCalls = await calls(page);
    expect(observedCalls.filter(call => ['localWorkspace.reviewCompany', 'localWorkspace.createCompany', 'localWorkspace.getCompanyCreateStatus', 'imports.preview', 'imports.commit', 'imports.status'].includes(call.method))).toEqual([]);
    expect(observedCalls.filter(call => call.kind !== 'read')).toEqual([]);
    expect(observed.errors).toEqual([]);
    expect(observed.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath(`company-draft-${theme}-${width}.png`) });
    writeFileSync(info.outputPath('company-draft-calls.json'), JSON.stringify(observedCalls, null, 2));
  });
}
