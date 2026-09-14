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
async function mount(page: Page, context: PresentationContext, initialRoute: typeof appRoutes[number] = 'today', healthScenario = false, researchScenario = false) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:41838/application-presentation?mode=${context.mode}${healthScenario ? '&healthScenario=1' : ''}${researchScenario ? '&researchScenario=1' : ''}`;
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
  test(`actual Settings research setup is readable and explicit ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'comfortable', width }, 'settings', false, true);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sourcing', exact: true }).click();
    const section = page.getByRole('region', { name: 'Cloud research', exact: true });
    await expect(section.getByRole('heading', { name: 'Operator-reviewed settings' })).toBeAttached();
    const fields = [
      ['Residential regions, one per line', 'Fictional region\nAdjacent fictional region'], ['Targeting terms, one per line', 'property management\nresidential'],
      ['Official website URLs, one per line', 'https://fictional.example/\nhttps://other-fictional.example/'], ['Maximum companies (1–50)', '1'],
      ['Maximum pages (1–10)', '1'], ['Maximum bytes (1–1,000,000)', '10000'],
      ['Discovery cumulative ceiling (USD)', '0.01'], ['Research cumulative ceiling (USD)', '0.02'],
    ];
    for (const [label, value] of fields) await section.getByLabel(label, { exact: true }).fill(value);
    const ack = section.getByLabel('I have reviewed the targeting, cumulative ceilings, operator assertions and limitations above', { exact: true });
    await ack.check(); await ack.focus(); await page.keyboard.press('Tab');
    const approve = section.getByRole('button', { name: 'Approve research', exact: true });
    await expect(approve).toBeEnabled(); await expect(approve).toBeFocused(); await expect(approve).toBeInViewport();
    expect(await section.locator('input:not([type="checkbox"]), textarea').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height >= 30))).toBe(true);
    expect(await section.locator('dd').evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1);
    }))).toBe(true);
    expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await section.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(section.getByLabel('Official website URLs, one per line', { exact: true })).toHaveValue(fields[2][1]);
    await expect(approve).toBeDisabled();
    expect((await calls(page)).filter(call => call.kind !== 'read')).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('research-setup-controls.png'), fullPage: true });
  });

  test(`actual Settings separates remote grant controls without automatic consent ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'comfortable', width }, 'settings');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connections', exact: true }).click();
    const work = page.getByRole('region', { name: 'Work email', exact: true });
    const personal = page.getByRole('region', { name: 'Personal calendar availability', exact: true });
    await expect(work.getByText('No cloud grant configured', { exact: true })).toBeVisible();
    await expect(personal.getByText('No cloud grant configured', { exact: true })).toBeAttached();
    const email = work.getByLabel('Named work email (@usecali.com)', { exact: true });
    await email.fill('founder@usecali.com');
    await work.getByLabel('I confirm this named work mailbox', { exact: true }).check();
    await work.getByLabel('I have reviewed and acknowledge this disclosure', { exact: true }).check();
    await expect(work.getByRole('button', { name: 'Continue to Google', exact: true })).toBeEnabled();
    const fields = page.locator('[aria-label="Remote Google connections"] input:not([type="checkbox"]), [aria-label="Remote Google connections"] textarea');
    expect(await fields.evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height >= 30))).toBe(true);
    const pane = page.locator('.foundation-workspace');
    const scrollBefore = await pane.evaluate(element => element.scrollTop);
    await pane.hover(); await page.mouse.wheel(0, 1800);
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBefore);
    const calendars = personal.getByLabel('Calendar IDs, one per line', { exact: true });
    await calendars.fill('founder@gmail.com');
    await personal.getByLabel('I confirm these exact calendar IDs', { exact: true }).check();
    const ack = personal.getByLabel('I have reviewed and acknowledge this disclosure', { exact: true });
    await ack.check(); await ack.focus(); await page.keyboard.press('Tab');
    const next = personal.getByRole('button', { name: 'Continue to Google', exact: true });
    await expect(next).toBeFocused(); await expect(next).toBeInViewport();
    await page.evaluate(() => window.applicationPresentation.setGoogleConnectionReady(true));
    await personal.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(personal.getByText('Cloud grant ready (last verified status)', { exact: true })).toBeVisible();
    expect(await personal.locator('dd').evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1);
    }))).toBe(true);
    expect(await personal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect((await calls(page)).filter(call => call.kind !== 'read')).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('remote-google-controls.png'), fullPage: true });
  });

  test(`actual Settings workspace access remains explicit and keyboard reachable ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'comfortable', width }, 'settings');
    const sections = page.getByRole('navigation', { name: 'Settings sections' });
    await sections.getByRole('button', { name: 'Worker connection', exact: true }).click();
    const access = page.getByRole('region', { name: 'Workspace access', exact: true });
    await expect(access).toBeVisible();
    const refresh = access.getByRole('button', { name: 'Refresh setup status', exact: true });
    await expect(refresh).toBeEnabled();
    await expect(access.getByText('Sync saved cloud work is not read-only.', { exact: false })).toBeVisible();
    await refresh.scrollIntoViewIfNeeded(); await refresh.focus();
    const before = (await calls(page)).filter(call => call.method === 'delegation.status').length;
    await refresh.press('Enter');
    await expect.poll(async () => (await calls(page)).filter(call => call.method === 'delegation.status').length).toBe(before + 1);
    await expect(refresh).toBeEnabled();
    const sync = access.getByRole('button', { name: 'Sync saved cloud work', exact: true });
    await sync.scrollIntoViewIfNeeded(); await expect(sync).toBeInViewport();
    expect(await access.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await access.locator('dd').evaluateAll(elements => elements.every(element => {
      const cell = element.parentElement!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every(rect => rect.right <= cell.right + 1 && rect.left >= cell.left - 1);
    }))).toBe(true);
    expect((await calls(page)).filter(call => call.kind !== 'read')).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('workspace-access.png'), fullPage: true });
  });

  test(`actual Settings recovers Connections in place without commands ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'comfortable', width }, 'settings');
    await page.evaluate(() => window.applicationPresentation.setConnectionStatusUnavailable(true));
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Connections', exact: true }).click();
    const section = page.getByRole('region', { name: 'Connections', exact: true });
    await expect(section.getByRole('alert')).toContainText('Connection status unavailable');
    await expect(section.getByText('Synthetic private connection failure')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Save connections' })).toBeDisabled();
    await section.getByLabel('Sender name', { exact: true }).fill('Edited Founder');
    await section.getByLabel('OpenAI API key', { exact: true }).fill('fictional-unsubmitted-secret');
    const before = (await calls(page)).filter(call => call.method === 'outreach.status').length;
    await page.evaluate(() => window.applicationPresentation.setConnectionStatusUnavailable(false));
    const retry = section.getByRole('button', { name: 'Refresh connection status' });
    await retry.focus(); await retry.press('Enter');
    await expect(section.getByRole('button', { name: 'Save connections' })).toBeEnabled();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.getByLabel('Sender name', { exact: true })).toHaveValue('Edited Founder');
    await expect(section.getByLabel('OpenAI API key', { exact: true })).toHaveValue('fictional-unsubmitted-secret');
    expect((await calls(page)).filter(call => call.method === 'outreach.status')).toHaveLength(before + 1);
    expect((await calls(page)).filter(call => call.kind !== 'read')).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('connections-recovered.png'), fullPage: true });
  });

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

// Additive actual-App diagnostic observation acceptance.
// Breaks caught: refresh unmounting a real editor, stale focus stealing,
// blocked routes remaining admitted, or blocked/ready discarding the shared draft.
const healthFocusMethods = ['daily.get', 'delegation.status', 'health.get', 'localWorkspace.get', 'localWorkspace.getCommitments', 'review.list'];
async function settledHealthFrames(page: Page) {
  await page.evaluate(async () => { await window.applicationPresentation.frame(); await window.applicationPresentation.frame(); });
}
async function healthReadDelta(page: Page, start: number, methods: string[]) {
  await settledHealthFrames(page);
  const delta = (await calls(page)).slice(start);
  expect(delta.every(call => call.kind === 'read')).toBe(true);
  expect(delta.map(call => call.method).sort()).toEqual([...methods].sort());
  for (const call of delta.filter(call => call.method === 'review.list')) {
    expect(call.args).toEqual([{ kinds: [], cursor: null, limit: 1 }]);
  }
  return delta;
}
async function holdFocusedHealth(page: Page) {
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  const start = (await calls(page)).length;
  const trace = await page.evaluate(async () => {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement)) throw new Error('Expected the deliberate input focus before observation');
    const events: { event: string; disabled: boolean; active: string; oldValue?: string | null }[] = [];
    const sample = (event: string, oldValue?: string | null) => events.push({ event, disabled: input.disabled, active: document.activeElement?.tagName ?? '', oldValue });
    const blur = () => sample('blur');
    const observer = new MutationObserver(records => { for (const record of records) sample(record.attributeName!, record.oldValue); });
    observer.observe(input, { attributes: true, attributeOldValue: true, attributeFilter: ['disabled', 'readonly'] });
    input.addEventListener('blur', blur);
    try {
      sample('before-focus');
      window.applicationPresentation.health!.arm(); window.dispatchEvent(new Event('focus'));
      await window.applicationPresentation.frame(); await window.applicationPresentation.frame();
      const region = document.querySelector('[aria-label="Diagnostic observation"]')!.getBoundingClientRect();
      sample('after-frames');
      return { events, connected: input.isConnected, focused: document.activeElement === input, region: { top: region.top, bottom: region.bottom, left: region.left, right: region.right }, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY } };
    } finally { observer.disconnect(); input.removeEventListener('blur', blur); }
  });
  console.log('DIAGNOSTIC_FOCUS_TRACE ' + JSON.stringify(trace));
  await expect.poll(() => page.evaluate(() => window.applicationPresentation.health!.phase())).toBe('pending');
  await healthReadDelta(page, start, healthFocusMethods);
  return start;
}
async function visibleHealthObservation(page: Page) {
  const observation = page.getByRole('region', { name: 'Diagnostic observation', exact: true });
  await expect(observation).toBeVisible();
  const rect = await observation.boundingBox();
  expect(rect).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 0, y: 0 });
  const geometry = await observation.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const rail = document.querySelector('.nav-rail')!.getBoundingClientRect();
    const button = element.querySelector('button')!;
    const buttonRect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
    return {
      rightOfRail: bounds.left >= rail.right - 1,
      pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      contentFits: [element, ...element.querySelectorAll('p,button')].every(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1),
      buttonInside: buttonRect.left >= bounds.left && buttonRect.right <= bounds.right + 1 && buttonRect.top >= bounds.top && buttonRect.bottom <= bounds.bottom + 1,
      buttonUncovered: hit === button || button.contains(hit),
    };
  });
  expect(geometry).toEqual({ rightOfRail: true, pageFits: true, contentFits: true, buttonInside: true, buttonUncovered: true });
}
async function reachableCompanyClose(page: Page) {
  const close = page.getByRole('button', { name: 'Close company form', exact: true });
  // Explicitly scroll the real queue only after all editor/caret/modal assertions.
  // This does not click Close, force focus, or change any form or command state.
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeEnabled();
  expect(await close.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const status = document.querySelector('[aria-label="Diagnostic observation"]')!.getBoundingClientRect();
    let top = 0, left = 0, bottom = innerHeight, right = innerWidth;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent); const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth); }
    }
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { fullyVisible: rect.top >= top - 1 && rect.bottom <= bottom + 1 && rect.left >= left - 1 && rect.right <= right + 1,
      aboveStatus: rect.bottom <= status.top + 1, uncovered: hit === element || element.contains(hit) };
  })).toEqual({ fullyVisible: true, aboveStatus: true, uncovered: true });
  await visibleHealthObservation(page);
}
async function finishHealth(page: Page, outcome: 'ready' | 'blocked' | 'rejected') {
  await page.evaluate(value => window.applicationPresentation.health!.settle(value), outcome);
  await expect.poll(() => page.evaluate(() => window.applicationPresentation.health!.phase())).toBe('idle');
  await settledHealthFrames(page);
}
async function healthDraft(page: Page) {
  await assertActualDestination(page, 'accounts', 'meeting_first');
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Company name', exact: true });
  const domain = page.getByRole('textbox', { name: 'Company domain (optional)', exact: true });
  await name.fill('  Diagnostic Harbor Management  ');
  await domain.fill(' HARBOR.EXAMPLE ');
  await name.focus();
  await name.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 14));
  await expect(name).toBeFocused();
  const input = await name.elementHandle();
  const root = await page.locator('.presentation-root').elementHandle();
  const shell = await page.locator('.app-shell').elementHandle();
  expect(input).not.toBeNull(); expect(root).not.toBeNull(); expect(shell).not.toBeNull();
  await settledHealthFrames(page);
  return { name, domain, input: input!, root: root!, shell: shell! };
}
async function sameHealthDraft(draft: Awaited<ReturnType<typeof healthDraft>>, focused: boolean) {
  expect(await draft.input.evaluate(element => {
    const input = element as HTMLInputElement;
    return { connected: input.isConnected, focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd };
  })).toEqual({ connected: true, focused, value: '  Diagnostic Harbor Management  ', start: 3, end: 14 });
  expect(await draft.root.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
  expect(await draft.shell.evaluate(element => element.isConnected && document.querySelector('.app-shell') === element)).toBe(true);
  await expect(draft.domain).toHaveValue(' HARBOR.EXAMPLE ');
}
async function onlyReadHealthScenario(page: Page, observed: { errors: string[]; requests: string[] }) {
  expect((await calls(page)).filter(call => call.kind !== 'read')).toEqual([]);
  expect((await calls(page)).filter(call => ['localWorkspace.reviewCompany', 'localWorkspace.createCompany', 'localWorkspace.getCompanyCreateStatus'].includes(call.method))).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
}
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1050] as const) {
  test(`actual diagnostic refresh keeps the same company editor and newer palette focus ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'compact', width }, 'accounts', true);
    const draft = await healthDraft(page);
    await sameHealthDraft(draft, true);
    await holdFocusedHealth(page);
    await sameHealthDraft(draft, true);
    await visibleHealthObservation(page);
    await finishHealth(page, 'rejected');
    await expect(page.getByRole('alert').filter({ hasText: /diagnostic/i })).toBeVisible();
    await visibleHealthObservation(page);
    await sameHealthDraft(draft, true);

    const manualStart = (await calls(page)).length;
    await page.evaluate(() => window.applicationPresentation.health!.arm());
    await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.applicationPresentation.health!.phase())).toBe('pending');
    await healthReadDelta(page, manualStart, ['health.get']);
    // A user click intentionally moved focus. The editor itself must not be replaced.
    await sameHealthDraft(draft, false);
    await expect(page.getByRole('alert').filter({ hasText: /diagnostic/i })).toBeVisible();
    await visibleHealthObservation(page);
    await finishHealth(page, 'ready');
    await expect(page.getByRole('alert').filter({ hasText: /diagnostic/i })).toHaveCount(0);
    await healthReadDelta(page, manualStart, ['health.get']);
    await sameHealthDraft(draft, false);

    await draft.name.focus();
    await draft.name.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 14));
    await sameHealthDraft(draft, true);
    const paletteOrigin = await draft.name.elementHandle();
    expect(paletteOrigin).not.toBeNull();
    await holdFocusedHealth(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    const paletteNode = await palette.elementHandle();
    expect(paletteNode).not.toBeNull();
    expect(await paletteNode!.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal') && element.contains(document.activeElement))).toBe(true);
    // Delivery happens while this exact newer native-modal owner is still open.
    await finishHealth(page, 'ready');
    expect(await paletteNode!.evaluate(element => element.isConnected && element instanceof HTMLDialogElement && element.matches(':modal') && element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    expect(await paletteOrigin!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
    await sameHealthDraft(draft, true);
    await reachableCompanyClose(page);
    await onlyReadHealthScenario(page, observed);
    await page.screenshot({ path: info.outputPath(`diagnostic-editor-${theme}-${width}.png`) });
    writeFileSync(info.outputPath('diagnostic-calls.json'), JSON.stringify(await calls(page), null, 2));
  });

  test(`actual blocked diagnostic observation removes routes but retains the company draft on ready return ${theme} ${width}`, async ({ page }, info) => {
    const observed = await mount(page, { mode: 'meeting_first', theme, density: 'compact', width }, 'accounts', true);
    const draft = await healthDraft(page);
    await holdFocusedHealth(page);
    const blockedStart = (await calls(page)).length;
    await finishHealth(page, 'blocked');
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toHaveCount(0);
    await expect(draft.name).toHaveCount(0);
    expect(await draft.input.evaluate(element => element.isConnected)).toBe(false);
    expect(await draft.root.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
    await expect(page.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeVisible();
    // This frozen blocked App does not mount the optional RecoverySection.
    await healthReadDelta(page, blockedStart, []);

    const readyStart = (await calls(page)).length;
    await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await assertActualDestination(page, 'accounts', 'meeting_first');
    await expect(draft.name).toHaveValue('  Diagnostic Harbor Management  ');
    await expect(draft.domain).toHaveValue(' HARBOR.EXAMPLE ');
    const restored = await draft.name.elementHandle();
    expect(restored).not.toBeNull();
    expect(await draft.input.evaluate(element => element.isConnected)).toBe(false);
    expect(await restored!.evaluate(element => element.isConnected)).toBe(true);
    expect(await draft.root.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
    await healthReadDelta(page, readyStart, ['health.get', 'daily.get', 'daily.get', 'delegation.status', 'delegation.status', 'localWorkspace.get', 'localWorkspace.get', 'localWorkspace.getCommitments', 'localWorkspace.getCommitments', 'review.list', 'review.list', 'leadDetail.getOutboundCapabilities', 'leadDetail.getOutboundCapabilities']);
    await expect(page.getByRole('button', { name: 'Review company', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeDisabled();

    await draft.name.focus();
    await draft.name.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 14));
    await holdFocusedHealth(page);
    await finishHealth(page, 'rejected');
    await expect(page.getByRole('alert').filter({ hasText: /diagnostic/i })).toBeVisible();
    await visibleHealthObservation(page);
    expect(await restored!.evaluate(element => {
      const input = element as HTMLInputElement;
      return { connected: input.isConnected, focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd };
    })).toEqual({ connected: true, focused: true, value: '  Diagnostic Harbor Management  ', start: 3, end: 14 });
    await reachableCompanyClose(page);
    await onlyReadHealthScenario(page, observed);
    await page.screenshot({ path: info.outputPath(`diagnostic-return-${theme}-${width}.png`) });
    writeFileSync(info.outputPath('diagnostic-return-calls.json'), JSON.stringify(await calls(page), null, 2));
  });
}
