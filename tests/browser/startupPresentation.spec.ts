import { test, expect, type Page, type TestInfo } from 'playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { AppearanceSample } from '../fixtures/startupPresentationBrowser';

// Parent runs explicitly. No server, Electron, preload, provider or app build.
let javascript: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.resolve('tests/fixtures/startupPresentationBrowser.tsx')],
    outdir: 'startup-browser-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
// Preserve first-commit evidence even when an early assertion is the intended RED.
test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => window.startupPresentation ? ({ calls: window.startupPresentation.calls, samples: window.startupPresentation.samples }) : null);
  const evidencePath = info.outputPath('final-observer-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  await info.attach('final-observer-evidence', { path: evidencePath, contentType: 'application/json' });
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure-whole-screen.png'), fullPage: true });
});
type Theme = 'light' | 'dark';
type Density = 'comfortable' | 'compact';
type Preferences = { theme: string | null; density: string | null; storage?: 'throwing' | 'missing' };
const palette = {
  light: { canvas: 'rgb(233, 237, 242)', rail: 'rgb(233, 237, 242)', text: 'rgb(34, 42, 53)', surface: 'rgb(255, 255, 255)', muted: 'rgb(92, 102, 116)', border: 'rgb(137, 148, 164)', accent: 'rgb(49, 87, 186)', brand: 'rgb(184, 61, 44)', legacy: 'rgb(246, 240, 223)' },
  dark: { canvas: 'rgb(24, 29, 37)', rail: 'rgb(25, 31, 40)', text: 'rgb(237, 241, 246)', surface: 'rgb(38, 46, 57)', muted: 'rgb(178, 189, 204)', border: 'rgb(130, 144, 163)', accent: 'rgb(173, 194, 255)', brand: 'rgb(240, 147, 126)', legacy: 'rgb(25, 28, 30)' },
};
async function mount(page: Page, width: number, preferences: Preferences, system: Theme = 'light') {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:41837/startup-presentation-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Isolated startup presentation</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
  await page.emulateMedia({ colorScheme: system });
  await page.goto(url);
  await page.evaluate(preferences => {
    localStorage.clear();
    if (preferences.theme !== null) localStorage.setItem('callie.theme', preferences.theme);
    if (preferences.density !== null) localStorage.setItem('callie.density', preferences.density);
    if (preferences.storage === 'throwing') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw Error('Synthetic storage unavailable'); } });
    if (preferences.storage === 'missing') Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    // No seeded html datasets or fixture CSS. App owns the first render.
  }, preferences);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByRole('status').filter({ hasText: /^Checking local foundation…$/ })).toHaveText('Checking local foundation…');
  await expect.poll(() => page.evaluate(() => window.startupPresentation.pending().health)).toBe(2);
  await page.evaluate(() => window.startupPresentation.frame());
  return { errors, requests };
}
const methods = (page: Page) => page.evaluate(() => window.startupPresentation.calls.map(call => call.method));
async function noWorkflowBeforeHealth(page: Page, count: number) {
  expect(await methods(page)).toEqual(Array.from({ length: count }, () => 'health.get'));
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
}
function assertASample(sample: AppearanceSample, theme: Theme, density: Density, width: number) {
  const colors = palette[theme];
  expect(sample.presentation, JSON.stringify(sample)).toBe('native-a');
  expect(sample.theme).toBe(theme);
  expect(sample.density).toBe(density);
  expect(sample.background).toBe(colors.canvas);
  expect(sample.color).toBe(colors.text);
  expect(sample.font).toContain('-apple-system');
  expect(sample.font).not.toContain('InterVariable');
  expect(sample.width).toBe(width);
  expect(sample.height).toBeGreaterThanOrEqual(width === 1440 ? 900 : 700);
  expect(sample.overflow).toBe(false);
  expect(sample.corners).toHaveLength(4);
  for (const corner of sample.corners.slice(0, 3)) expect([colors.canvas, colors.rail]).toContain(corner);
  if (['health-pending', 'health-error'].includes(sample.phase)) {
    expect(sample.diagnosticStrip).toBeNull();
    expect([colors.canvas, colors.rail]).toContain(sample.corners[3]);
  } else {
    // Only the actual admitted diagnostic strip may paint the bottom-right corner.
    // First-frame/bootstrap and the other three corner contracts remain unchanged.
    expect(sample.diagnosticStrip).not.toBeNull();
    const strip = sample.diagnosticStrip!;
    expect(strip.ownsCorners).toEqual([false, false, false, true]);
    expect(strip.left).toBe(width === 1440 ? 142 : 124);
    expect(strip.right).toBe(width);
    expect(strip.bottom).toBe(sample.viewportHeight);
    expect(strip.top).toBeGreaterThan(0);
    expect(strip.top).toBeLessThan(sample.viewportHeight - 2);
    expect(sample.corners[3]).toBe(colors.surface);
  }
  if (['health-pending', 'health-error', 'daily-pending', 'daily-error', 'informational'].includes(sample.phase)) expect(sample.workflow).toBeNull();
  if (['daily-pending', 'daily-error', 'informational'].includes(sample.phase)) assertPendingGeometry(sample, width);
}
function assertPendingGeometry(sample: AppearanceSample, width: number) {
  // Only the empty pending/error/informational surface. Ready and legacy
  // intentionally retain their existing content/scroll geometry contracts.
  expect(sample.deskBounds).not.toBeNull();
  expect(sample.deskBounds!.left).toBeGreaterThanOrEqual(0);
  expect(sample.deskBounds!.top).toBeGreaterThanOrEqual(0);
  expect(sample.deskBounds!.right).toBeLessThanOrEqual(width);
  expect(sample.deskBounds!.bottom, `pending outer bounds: ${JSON.stringify(sample.deskBounds)}`).toBeLessThanOrEqual(sample.viewportHeight);
  expect(sample.scrollHeight, 'empty pending surface must not add document scrolling').toBe(sample.viewportHeight);
}
async function checkpoint(page: Page, info: TestInfo, label: string) {
  await page.evaluate(() => window.startupPresentation.frame());
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true });
}
async function assertRail(page: Page, width: number, theme: Theme) {
  const colors = palette[theme];
  await expect(page.locator('.nav-rail')).toHaveCSS('background-color', colors.rail);
  await expect(page.locator('.nav-rail')).toHaveCSS('width', width === 1440 ? '142px' : '124px');
  await expect(page.locator('.nav-rail__brand')).toBeHidden();
  await expect(page.locator('.nav-rail__brand-native')).toBeVisible();
  await expect(page.locator('.nav-rail__brand-native')).toHaveCSS('color', colors.brand);
  const today = page.getByRole('link', { name: 'Today', exact: true });
  await expect(today).toHaveAttribute('aria-current', 'page');
  await expect(today).toHaveCSS('height', '44px');
  await expect(today).toHaveCSS('color', colors.accent);
  await expect(page.locator('.app-shell__main')).toHaveCSS('padding', '12px 16px');
}
async function pendingReads(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.startupPresentation.pending())).toEqual({ health: 0, daily: count, delegation: count });
}
async function refresh(page: Page) {
  await page.evaluate(() => window.startupPresentation.refresh());
  await expect.poll(() => page.evaluate(() => window.startupPresentation.pending())).toEqual({ health: 1, daily: 1, delegation: 1 });
  await page.evaluate(() => window.startupPresentation.resolveHealth());
  await pendingReads(page, 1);
}
async function settle(page: Page, mode: 'meeting_first' | 'unknown' | 'legacy') {
  await page.evaluate(async mode => {
    window.startupPresentation.resolveDaily(mode);
    await window.startupPresentation.resolveDelegation();
  }, mode);
}
async function clean(page: Page, state: { errors: string[]; requests: string[] }, info: TestInfo) {
  const evidence = await page.evaluate(() => ({ calls: window.startupPresentation.calls, samples: window.startupPresentation.samples }));
  await info.attach('startup-observer-and-call-inventory', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(evidence.calls.filter(call => call.kind === 'forbidden')).toEqual([]);
}

for (const width of [1440, 1050]) for (const theme of ['light', 'dark'] as const) for (const density of ['comfortable', 'compact'] as const) {
  test(`first React frame and honest startup transitions ${width}/${theme}/${density}`, async ({ page }, info) => {
    const state = await mount(page, width, { theme, density });
    const initial = await page.evaluate(() => window.startupPresentation.samples);
    expect(initial[0].source).toBe('mutation');
    expect(initial[0].phase).toBe('health-pending');
    expect(initial.some(sample => sample.source === 'frame')).toBe(true);
    for (const sample of initial) assertASample(sample, theme, density, width);
    await noWorkflowBeforeHealth(page, 2);
    await checkpoint(page, info, '01-health-pending');
    await page.evaluate(() => window.startupPresentation.rejectHealth());
    await expect(page.getByRole('alert')).toContainText('The diagnostic read could not be completed');
    await expect(page.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    await expect(page.locator('body')).not.toContainText('Synthetic private failure');
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveCSS('background-color', palette[theme].surface);
    await expect(retry).toHaveCSS('color', palette[theme].text);
    await expect(retry).toHaveCSS('height', density === 'compact' ? '26px' : '28px');
    await expect(retry).toHaveCSS('border-top-color', palette[theme].border);
    expect(await retry.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await expect(page.locator('.diagnostics__eyebrow')).toHaveCSS('color', palette[theme].muted);
    await noWorkflowBeforeHealth(page, 2);
    await checkpoint(page, info, '02-health-error-retry-focus');
    await retry.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: /^Checking local foundation…$/ })).toHaveText('Checking local foundation…');
    await expect.poll(() => page.evaluate(() => window.startupPresentation.pending().health)).toBe(1);
    await noWorkflowBeforeHealth(page, 3);
    await checkpoint(page, info, '03-health-retry-pending');
    await page.evaluate(() => window.startupPresentation.resolveHealth());
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await pendingReads(page, 2);
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await assertRail(page, width, theme);
    await checkpoint(page, info, '04-daily-pending');
    // Config settles independently. Configuration is NOT workflow authority.
    await page.evaluate(() => window.startupPresentation.resolveDelegation());
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await checkpoint(page, info, '05-daily-pending-config-ready');
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.startupPresentation.rejectDaily());
    await expect(page.getByRole('status').filter({ hasText: 'Daily workspace unavailable.' })).toBeVisible();
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await checkpoint(page, info, '06-daily-first-failure');
    await page.evaluate(() => window.startupPresentation.setLocalMode('legacy'));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await pendingReads(page, 1);
    await settle(page, 'unknown');
    await expect(page.getByText('Workflow mode unavailable or inconsistent. Refresh to check local status. Worker actions are held.')).toBeVisible();
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await checkpoint(page, info, '07-unknown-held');
    await refresh(page);
    await settle(page, 'meeting_first');
    await expect(page.getByTestId('native-desk')).toBeVisible();
    await expect(page.getByText('Local workflow unavailable or inconsistent. Worker actions are held. Refresh to check status.')).toBeVisible();
    await checkpoint(page, info, '09-local-daily-disagreement-held');
    await page.evaluate(() => window.startupPresentation.setLocalMode('meeting_first'));
    await refresh(page);
    await settle(page, 'meeting_first');
    await expect(page.getByText('Local workflow unavailable or inconsistent. Worker actions are held. Refresh to check status.')).toHaveCount(0);
    await expect(page.getByTestId('native-desk')).toHaveAttribute('data-workflow-mode', 'meeting_first');
    await assertRail(page, width, theme);
    const headings = await page.locator('.native-desk__lane h2').evaluateAll(elements => elements.map(element => ({ text: element.textContent, bottom: element.getBoundingClientRect().bottom })));
    expect(headings).toHaveLength(4);
    await expect(page.locator('.native-desk__lane h2 .native-desk__lane-label')).toHaveText(['Local commitments', 'Calls', 'Saved draft continuations', 'Upcoming meetings']);
    for (const heading of headings) expect(heading.bottom, heading.text ?? '').toBeLessThan(width === 1440 ? 900 : 700);
    await checkpoint(page, info, '10-ready-native-a');
    await page.evaluate(() => window.startupPresentation.setLocalMode('legacy'));
    await refresh(page);
    await settle(page, 'legacy');
    // Actual legacy content keeps the same application-wide presentation.
    await expect(page.getByTestId('today-route')).toBeVisible();
    await expect(page.getByText('No suggested contacts right now.')).toBeVisible();
    await expect(page.locator('.presentation-root[data-presentation="native-a"]')).toHaveCount(1);
    await assertRail(page, width, theme);
    await expect(page.locator('.nav-rail__brand-native')).toBeVisible();
    await checkpoint(page, info, '08-confirmed-legacy-common-presentation');
    const samples = await page.evaluate(() => window.startupPresentation.samples);
    for (const sample of samples) assertASample(sample, theme, density, width);
    for (const phase of ['health-pending', 'health-error', 'daily-pending', 'daily-error', 'informational', 'legacy', 'desk']) expect(samples.some(sample => sample.phase === phase && sample.source === 'frame'), phase).toBe(true);
    const inventory = await methods(page);
    expect(inventory.filter(method => method === 'health.get')).toHaveLength(6);
    // StrictMode mounts read twice. Only four explicit refreshes add reads.
    for (const method of ['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments']) expect(inventory.filter(value => value === method), method).toHaveLength(6);
    // FounderApp's real inspector provider reads capabilities on mount, not on
    // user action (LeadInspectorProvider.tsx useEffect). It never starts outreach.
    // Require exactly the StrictMode pair, even across every desk refresh.
    // useDiscovery shares its in-flight read across StrictMode effects, so
    // the diagnostic inventory has one discovery.get, not two.
    const expectedReads = {
      'health.get': 6, 'daily.get': 6, 'delegation.status': 6,
      'localWorkspace.get': 6, 'localWorkspace.getCommitments': 6,
      'leadDetail.getOutboundCapabilities': 2, 'today.get': 2, 'discovery.get': 1,
      // Healthy StrictMode mount twice, then three explicit window-focus events.
      // The first route-local Refresh button does not refresh the global summary.
      'review.list': 5,
    };
    expect(inventory.filter(method => !(method in expectedReads)), 'unexpected API calls').toEqual([]);
    expect(inventory.slice().sort()).toEqual(Object.entries(expectedReads).flatMap(([method, count]) => Array<string>(count).fill(method)).sort());
    await clean(page, state, info);
  });
}
for (const storage of ['system', 'invalid', 'throwing', 'missing', 'unset'] as const) {
  test(`first-frame preference fallback and live system updates: ${storage}`, async ({ page }, info) => {
    const preferences: Preferences = storage === 'system' ? { theme: 'system', density: 'compact' }
      : storage === 'invalid' ? { theme: 'ultraviolet', density: 'tiny' }
      : { theme: null, density: null, ...(storage === 'throwing' || storage === 'missing' ? { storage } : {}) };
    const density = storage === 'system' ? 'compact' : 'comfortable';
    const state = await mount(page, 1050, preferences, 'dark');
    const first = await page.evaluate(() => window.startupPresentation.samples);
    for (const sample of first) assertASample(sample, 'dark', density, 1050);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await checkpoint(page, info, `${storage}-health-${theme}`);
      const latest = await page.evaluate(() => window.startupPresentation.samples.at(-1)!);
      assertASample(latest, theme, density, 1050);
      await noWorkflowBeforeHealth(page, 2);
    }
    await page.evaluate(() => window.startupPresentation.resolveHealth());
    await pendingReads(page, 2);
    await page.evaluate(() => window.startupPresentation.resolveDaily('meeting_first'));
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await checkpoint(page, info, `${storage}-daily-ready-config-pending`);
    await expect(page.locator('[data-workflow-mode]')).toHaveCount(0);
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.startupPresentation.resolveDelegation());
    await expect(page.getByTestId('native-desk')).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await checkpoint(page, info, `${storage}-ready-light`);
    assertASample(await page.evaluate(() => window.startupPresentation.samples.at(-1)!), 'light', density, 1050);
    for (const sample of await page.evaluate(() => window.startupPresentation.samples)) {
      expect(['light', 'dark']).toContain(sample.theme);
      assertASample(sample, sample.theme as Theme, density, 1050);
    }
    const inventory = await methods(page);
    for (const method of ['health.get', 'daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments', 'leadDetail.getOutboundCapabilities', 'review.list']) expect(inventory.filter(value => value === method), method).toHaveLength(2);
    expect(inventory).toHaveLength(14);
    await clean(page, state, info);
  });
}

for (const width of [1440, 1050]) {
  test(`pending surface outer bounds and document height ${width}`, async ({ page }, info) => {
    const state = await mount(page, width, { theme: 'light', density: 'comfortable' });
    await page.evaluate(() => window.startupPresentation.resolveHealth());
    await pendingReads(page, 2);
    await expect(page.getByText('Loading daily workspace…', { exact: true })).toBeVisible();
    await checkpoint(page, info, 'geometry-pending');
    assertPendingGeometry(await page.evaluate(() => window.startupPresentation.samples.at(-1)!), width);
    await page.evaluate(() => window.startupPresentation.rejectDaily());
    await expect(page.getByText('Daily workspace unavailable. Retry the local read.', { exact: true })).toBeVisible();
    await checkpoint(page, info, 'geometry-failed');
    assertPendingGeometry(await page.evaluate(() => window.startupPresentation.samples.at(-1)!), width);
    await page.evaluate(async () => {
      await window.startupPresentation.resolveDelegation();
      window.startupPresentation.setLocalMode('legacy');
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await pendingReads(page, 1);
    await settle(page, 'unknown');
    await expect(page.getByText('Workflow mode unavailable or inconsistent. Refresh to check local status. Worker actions are held.')).toBeVisible();
    await checkpoint(page, info, 'geometry-unknown');
    assertPendingGeometry(await page.evaluate(() => window.startupPresentation.samples.at(-1)!), width);
    await clean(page, state, info);
  });
}
