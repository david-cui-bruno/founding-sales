import { test, expect, type Locator, type Page } from 'playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { nativePalette } from '../support/presentationOracle';
import type { ModalMethod } from '../fixtures/applicationModalScenario';

test.use({ timezoneId: 'America/New_York' });
let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/applicationPresentationBrowser.tsx')], outdir: 'application-modal-fixture', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});

type Context = { theme: 'light' | 'dark' | 'system'; density: 'comfortable' | 'compact'; width: 1050 | 1440; mode?: 'legacy' | 'meeting_first'; fridayScenario?: boolean };
async function mount(page: Page, context: Context, route: string) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (context.mode === 'legacy') {
    // Legacy Today polls discovery every 5s. Pause before App mounts so a slow
    // pointer/focus test cannot silently introduce an uncounted read.
    await page.clock.install({ time: new Date('2026-09-10T11:59:59.000Z') });
    await page.clock.pauseAt(new Date('2026-09-10T12:00:00.000Z'));
  } else await page.clock.setFixedTime(new Date('2026-09-10T12:00:00.000Z'));
  await page.addInitScript(context => {
    localStorage.setItem('callie.theme', context.theme);
    localStorage.setItem('callie.density', context.density);
  }, context);
  const url = `http://127.0.0.1:41838/application-modal?mode=${context.mode ?? 'meeting_first'}&modalScenario=1${context.fridayScenario ? '&fridayScenario=1' : ''}`;
  await page.route('**/*', request => {
    if (request.request().url() === url && request.request().isNavigationRequest()) return request.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Actual application modals</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>` });
    requests.push(request.request().url());
    return request.abort();
  });
  await page.setViewportSize({ width: context.width, height: context.width === 1440 ? 900 : 700 });
  await page.emulateMedia({ colorScheme: context.theme === 'system' ? 'light' : context.theme });
  await page.goto(`${url}#/${route}`);
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  return { errors, requests };
}

async function nativeIsolation(page: Page, dialog: Locator, pointer = true) {
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
  const stops = await dialog.locator('button:visible:not(:disabled),input:visible:not(:disabled),textarea:visible:not(:disabled),select:visible:not(:disabled),[tabindex="0"]:visible').count();
  for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < Math.max(4, stops * 2 + 1); index++) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate(element => element.contains(document.activeElement)), `${key} ${index}`).toBe(true);
  }
  // This is a real pointer action at a background navigation control, not a
  // synthetic click dispatched directly into an inert subtree.
  const target = await page.locator('.nav-rail a[href="#/accounts"]').boundingBox();
  expect(target).not.toBeNull();
  const before = page.url();
  if (pointer) await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
  expect(page.url()).toBe(before);
  await expect(dialog).toBeVisible();
  await page.locator('.nav-rail a[href="#/accounts"]').evaluate(element => (element as HTMLElement).focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true });
});

type Consumer = 'palette' | 'import' | 'learning' | 'transcript' | 'manual-today' | 'manual-contact' | 'discovery';
const consumers: Consumer[] = ['palette', 'import', 'learning', 'transcript', 'manual-today', 'manual-contact', 'discovery'];
const routeFor = (consumer: Consumer) => consumer === 'learning' ? 'learnings' : consumer === 'transcript' ? 'conversations' : consumer === 'manual-today' ? 'today' : 'leads';
const recorded = (page: Page) => page.evaluate(() => window.applicationPresentation.calls);
const operations = (page: Page) => page.evaluate(() => window.applicationPresentation.modal!.operations);
const arm = (page: Page, method: ModalMethod) => page.evaluate(method => window.applicationPresentation.modal!.arm(method), method);
const settle = (page: Page, token: string, outcome: 'resolve' | 'reject') => page.evaluate(({ token, outcome }) => window.applicationPresentation.modal!.settle(token, outcome), { token, outcome });
function counts(calls: Awaited<ReturnType<typeof recorded>>) {
  const result: Record<string, number> = {};
  for (const call of calls) result[call.method] = (result[call.method] ?? 0) + 1;
  return result;
}

async function openConsumer(page: Page, consumer: Consumer) {
  let opener: Locator;
  if (consumer === 'learning') opener = page.getByRole('button', { name: 'Capture learning', exact: true });
  else if (consumer === 'transcript') {
    const row = page.locator('.conversation-list button').filter({ hasText: 'Kevin Shin' });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    opener = page.getByRole('button', { name: 'Attach transcript', exact: true });
  } else if (consumer === 'manual-today') {
    await page.getByRole('button', { name: 'More actions for Kevin Shin', exact: true }).click();
    opener = page.getByRole('menuitem', { name: 'Log past activity', exact: true });
  } else if (consumer === 'manual-contact' || consumer === 'discovery') {
    const row = page.getByRole('grid').locator('[data-person-id="person-kevin"]');
    await row.focus(); await row.press('Enter');
    const contact = page.getByRole('complementary', { name: 'Kevin Shin details', exact: true });
    await expect(contact).toBeVisible();
    if (consumer === 'manual-contact') {
      await contact.getByRole('tab', { name: 'Activity', exact: true }).click();
      opener = contact.getByRole('button', { name: 'Log dated past activity', exact: true });
    } else {
      await contact.locator('summary').filter({ hasText: /^Details$/ }).click();
      opener = contact.getByRole('button', { name: 'Adjust discovery', exact: true });
    }
  } else opener = page.locator('#leads-import-trigger');
  await expect(opener).toBeVisible();
  if (consumer === 'palette') { await opener.focus(); await page.keyboard.press('ControlOrMeta+k'); }
  else await opener.click();
  const name = consumer === 'palette' ? 'Command palette' : consumer === 'import' ? 'Import leads' : consumer === 'learning' ? 'Capture learning' : consumer === 'transcript' ? 'Attach transcript' : consumer === 'discovery' ? 'Discovery decision for Kevin Shin' : 'Log past activity · Kevin Shin';
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, opener };
}

const expectedReadArgs: Record<string, unknown[] | undefined> = {
  'health.get': [], 'leadDetail.getOutboundCapabilities': [],
  'review.list': [{ kinds: [], cursor: null, limit: 1 }],
  'daily.get': [], 'delegation.status': undefined,
  'localWorkspace.get': [], 'localWorkspace.getCommitments': [],
  'today.get': [], 'discovery.get': [],
  'leads.list': [{ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 }],
  'learnings.list': [{ categories: [], statuses: [], query: '', limit: 200 }],
  'conversations.list': [{ query: '', filter: 'all', limit: 200, cursor: null }],
  'conversations.get': [{ activityId: 'activity-call-kevin' }],
  'leadDetail.get': [{ personId: 'person-kevin' }],
  'discovery.getBrief': [{ personId: 'person-kevin' }],
};
function assertReadArguments(calls: Awaited<ReturnType<typeof recorded>>) {
  for (const call of calls.filter(call => call.kind === 'read')) {
    expect(Object.hasOwn(expectedReadArgs, call.method), `unexpected read ${call.method}`).toBe(true);
    expect(call.args, `${call.method} exact arguments`).toEqual(expectedReadArgs[call.method]);
  }
}
function initialControl(dialog: Locator, consumer: Consumer) {
  if (consumer === 'palette') return dialog.getByRole('combobox', { name: 'Command palette', exact: true });
  if (consumer === 'import') return dialog.getByRole('button', { name: 'Close', exact: true });
  if (consumer === 'learning') return dialog.getByRole('combobox', { name: 'Category', exact: true });
  return dialog.getByLabel(consumer === 'transcript' ? 'Transcript text' : consumer === 'discovery' ? 'Reason' : 'What happened', { exact: true });
}
async function assertReads(page: Page, consumer: Consumer) {
  const baseline: Record<string, number> = { 'health.get': 2, 'leadDetail.getOutboundCapabilities': 2, 'review.list': 2 };
  if (consumer === 'manual-today') Object.assign(baseline, { 'daily.get': 2, 'delegation.status': 2, 'localWorkspace.get': 2, 'localWorkspace.getCommitments': 2, 'today.get': 2, 'discovery.get': 1 });
  else baseline[consumer === 'learning' ? 'learnings.list' : consumer === 'transcript' ? 'conversations.list' : 'leads.list'] = 2;
  if (consumer === 'transcript') baseline['conversations.get'] = 1;
  if (consumer === 'manual-contact' || consumer === 'discovery') baseline['leadDetail.get'] = 1;
  if (consumer === 'discovery') baseline['discovery.getBrief'] = 1;
  await expect.poll(async () => counts(await recorded(page))).toEqual(baseline);
  expect((await recorded(page)).every(call => call.kind === 'read')).toBe(true);
  assertReadArguments(await recorded(page));
}

for (const theme of ['light', 'dark'] as const) for (const density of ['comfortable', 'compact'] as const) for (const width of [1050, 1440] as const) for (const consumer of consumers) {
  test(`actual ${consumer} modal boundaries ${theme} ${density} ${width}`, async ({ page }, info) => {
    const context: Context = { theme, density, width, mode: consumer === 'manual-today' ? 'legacy' : 'meeting_first' };
    const observed = await mount(page, context, routeFor(consumer));
    const root = await page.locator('.presentation-root').elementHandle();
    expect(root).not.toBeNull();
    const { dialog, opener } = await openConsumer(page, consumer);
    await assertReads(page, consumer);
    const before = (await recorded(page)).length;
    await expect(initialControl(dialog, consumer)).toBeFocused();
    await nativeIsolation(page, dialog, consumer !== 'palette');
    // Explicit event-contract probes. These are not claims of hardware IME use.
    await dialog.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, repeat: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }));
    });
    await expect(dialog).toBeVisible();
    if (consumer !== 'palette') {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toHaveCount(0);
    }
    const sample = await dialog.evaluate(element => {
      const css = getComputedStyle(element), rect = element.getBoundingClientRect();
      return { font: css.fontFamily, text: css.color, background: css.backgroundColor, line: css.getPropertyValue('--line').trim(), borderWidth: parseFloat(css.borderTopWidth), borderColor: css.borderTopColor, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('data-density', density);
    await expect(page.locator('.presentation-root[data-presentation="native-a"]')).toHaveCount(1);
    expect(await root!.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
    expect(sample.font).toContain('-apple-system'); expect(sample.text).toBe(nativePalette[theme].text);
    expect(sample.background).toBe(nativePalette[theme].surface);
    expect(sample.line).toBe(theme === 'light' ? '#d6dce5' : '#434f60');
    // The shared line token is required. Consumer-owned decorative borders
    // (for example the palette's yellow top accent) retain their local design.
    expect(sample.left).toBeGreaterThanOrEqual(0); expect(sample.right).toBeLessThanOrEqual(width);
    expect(sample.top).toBeGreaterThanOrEqual(0); expect(sample.bottom).toBeLessThanOrEqual(sample.viewportHeight + 1);
    if ((theme === 'light' && density === 'comfortable' && width === 1050)
      || (theme === 'dark' && density === 'compact' && width === 1440)) {
      await page.screenshot({ path: info.outputPath(`${consumer}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    if (await opener.count()) await expect(opener).toBeFocused();
    else {
      // The Today menu item was removed. The registry's named active-route
      // fallback, not an arbitrary non-body node, must receive focus.
      expect(consumer).toBe('manual-today');
      const fallback = page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Today', exact: true });
      await expect(fallback).toBeVisible(); await expect(fallback).toBeFocused();
    }
    expect(await root!.evaluate(element => element.isConnected && document.querySelector('.presentation-root') === element)).toBe(true);
    expect((await recorded(page)).slice(before)).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    writeFileSync(info.outputPath('modal-observation.json'), JSON.stringify({ context, consumer, sample, calls: await recorded(page), ...observed }, null, 2));
  });
}

const learningText = 'Owners lose weekends to showings.';
const quote1 = 'I lose Saturday to showings.';
const quote2 = 'Sunday is occupied as well.';
const transcriptText = 'me: Thanks for the call.\nKevin: Happy to discuss maintenance.';
const summary = 'Discussed maintenance and stated the current price.';
const reason = 'Retain for a later maintenance conversation.';
const pasted = 'Name,Email\nAlex Example,alex@example.test';
async function fillForm(dialog: Locator, consumer: Consumer) {
  if (consumer === 'learning') {
    await dialog.getByLabel('Statement', { exact: true }).fill(learningText);
    await dialog.getByLabel('Evidence quote 1', { exact: true }).fill(quote1);
    await dialog.getByRole('button', { name: 'Add another evidence row', exact: true }).click();
    await dialog.getByLabel('Evidence quote 2', { exact: true }).fill(quote2);
  } else if (consumer === 'transcript') await dialog.getByLabel('Transcript text', { exact: true }).fill(transcriptText);
  else if (consumer === 'discovery') await dialog.getByLabel('Reason', { exact: true }).fill(reason);
  else {
    await dialog.getByLabel('What happened', { exact: true }).fill(summary);
    await dialog.getByLabel('Date', { exact: true }).fill('2026-09-09');
    await dialog.getByLabel('I stated the price', { exact: true }).check();
  }
}
async function retainedInputs(dialog: Locator, consumer: Consumer) {
  if (consumer === 'learning') {
    await expect(dialog.getByRole('textbox', { name: 'Statement', exact: true })).toHaveValue(learningText);
    await expect(dialog.getByRole('textbox', { name: 'Evidence quote 1', exact: true })).toHaveValue(quote1);
    await expect(dialog.getByRole('textbox', { name: 'Evidence quote 2', exact: true })).toHaveValue(quote2);
  } else if (consumer === 'transcript') await expect(dialog.getByRole('textbox', { name: 'Transcript text', exact: true })).toHaveValue(transcriptText);
  else if (consumer === 'discovery') await expect(dialog.getByRole('textbox', { name: 'Reason', exact: true })).toHaveValue(reason);
  else {
    await expect(dialog.getByRole('textbox', { name: 'What happened', exact: true })).toHaveValue(summary);
    await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue('2026-09-09');
    await expect(dialog.getByLabel('I stated the price', { exact: true })).toBeChecked();
  }
}
async function blockedWhilePending(page: Page, dialog: Locator, submit: Locator, close: Locator) {
  await expect(submit).toBeDisabled(); await expect(close).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await dialog.evaluate(element => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toHaveCount(0);
  await nativeIsolation(page, dialog);
}

for (const consumer of ['learning', 'transcript', 'manual-today', 'manual-contact', 'discovery'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  test(`actual ${consumer} retains pending input and handles ${outcome} without invented success`, async ({ page }, info) => {
    const observed = await mount(page, { theme: 'dark', density: 'compact', width: 1050, mode: consumer === 'manual-today' ? 'legacy' : 'meeting_first' }, routeFor(consumer));
    const { dialog } = await openConsumer(page, consumer);
    await assertReads(page, consumer);
    await fillForm(dialog, consumer);
    const method: ModalMethod = consumer === 'learning' ? 'learnings.capture' : consumer === 'transcript' ? 'conversations.attachTranscript' : consumer === 'discovery' ? 'discovery.override' : 'today.logPastActivity';
    const submit = dialog.getByRole('button', { name: consumer === 'learning' ? 'Save learning' : consumer === 'transcript' ? 'Attach' : consumer === 'discovery' ? 'Save discovery decision' : 'Log activity', exact: true });
    const close = dialog.getByRole('button', { name: consumer === 'transcript' ? 'Close' : consumer === 'discovery' ? 'Close decision' : 'Cancel', exact: true });
    const before = (await recorded(page)).length;
    const token = await arm(page, method);
    // Same-turn UI-event probe, deliberately separate from physical keyboard
    // Enter while pending below. No API callback or inert background is invoked.
    await submit.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await expect.poll(async () => (await operations(page)).find(operation => operation.token === token)?.state).toBe('pending');
    await blockedWhilePending(page, dialog, submit, close);
    await retainedInputs(dialog, consumer);
    expect(counts((await recorded(page)).slice(before))).toEqual({ [method]: 1 });
    const request = (await operations(page)).find(operation => operation.token === token)!.input;
    if (consumer === 'learning') expect(request).toEqual({ category: 'pain', statement: learningText, confidence: 'medium', contradictionOf: null, evidence: [quote1, quote2].map((quote): { personId: null; activityId: null; quote: string; notedAt: string } => ({ personId: null, activityId: null, quote, notedAt: '2026-09-10T12:00:00.000Z' })) });
    else if (consumer === 'transcript') expect(request).toEqual({ activityId: 'activity-call-kevin', personId: 'person-kevin', rawText: transcriptText });
    else if (consumer === 'discovery') expect(request).toEqual({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), personId: 'person-kevin', assessmentId: '10000000-0000-4000-8000-000000000001', expectedFingerprint: 'a'.repeat(64), decision: 'watch', reason });
    else expect(request).toEqual({ personId: 'person-kevin', salesCycleId: 'cycle-kevin', kind: 'call', direction: 'outbound', occurredAt: '2026-09-09T16:00:00.000Z', summary, outcome: 'price_said' });
    await settle(page, token, outcome);
    if (outcome === 'reject') {
      await expect(dialog).toBeVisible();
      await retainedInputs(dialog, consumer);
      await expect(close).toBeEnabled();
      if (consumer === 'discovery') await expect(page.getByText('Decision response unavailable. Retry preserves the same decision and reason.', { exact: true })).toBeVisible();
      else await expect(dialog.getByRole('alert')).toContainText('not confirmed');
      expect(counts((await recorded(page)).slice(before))).toEqual({ [method]: 1 });
      await close.click(); await expect(dialog).toHaveCount(0);
    } else {
      await expect(dialog).toHaveCount(0);
      const refresh = consumer === 'learning' ? { 'learnings.list': 1 } : consumer === 'transcript' ? { 'conversations.get': 1, 'conversations.list': 1 } : consumer === 'discovery' ? { 'discovery.getBrief': 1 } : consumer === 'manual-contact' ? { 'leadDetail.get': 1 } : { 'today.get': 1 };
      await expect.poll(async () => counts((await recorded(page)).slice(before))).toEqual({ [method]: 1, ...refresh });
      if (consumer === 'learning') await expect(page.getByText(learningText, { exact: true })).toBeVisible();
      if (consumer === 'transcript') await expect(page.getByText('Happy to discuss maintenance.', { exact: true })).toBeVisible();
      if (consumer === 'discovery') {
        const evidence = page.getByRole('region', { name: 'Discovery evidence for Kevin Shin', exact: true });
        await expect(evidence).toContainText(`Prior decision: watch. ${reason}`);
        await expect(evidence).toContainText('Synthetic address');
        await expect(page.getByRole('region', { name: 'Prepared conversation evidence', exact: true }).getByRole('alert')).toHaveCount(0);
      }
      if (consumer === 'manual-contact') {
        const contact = page.getByRole('complementary', { name: 'Kevin Shin details', exact: true });
        await contact.getByRole('tab', { name: 'Activity', exact: true }).click();
        await expect(contact.getByText(summary, { exact: true })).toBeVisible();
      }
    }
    assertReadArguments(await recorded(page));
    expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    writeFileSync(info.outputPath('operation.json'), JSON.stringify({ consumer, outcome, request, operations: await operations(page), calls: await recorded(page), ...observed }, null, 2));
  });
}

test('actual Capture learning uses a native modal and isolates the background', async ({ page }, info) => {
  const context: Context = { theme: 'light', density: 'comfortable', width: 1050 };
  const observed = await mount(page, context, 'learnings');
  const opener = page.getByRole('button', { name: 'Capture learning', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Capture learning', exact: true });
  await nativeIsolation(page, dialog);
  const sample = await dialog.evaluate(element => ({ font: getComputedStyle(element).fontFamily, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  expect(sample.font).toContain('-apple-system');
  expect(sample.color).toBe(nativePalette.light.text);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  expect(await page.evaluate(() => window.applicationPresentation.calls.filter(call => call.kind === 'forbidden'))).toEqual([]);
  writeFileSync(info.outputPath('learning-modal.json'), JSON.stringify({ sample, ...observed }, null, 2));
});

for (const outcome of ['resolve', 'reject'] as const) test(`actual Import pending commit and ${outcome} preserve source and explicit completion`, async ({ page }, info) => {
  const observed = await mount(page, { theme: 'dark', density: 'comfortable', width: 1050 }, 'leads');
  const { dialog } = await openConsumer(page, 'import');
  await assertReads(page, 'import');
  await dialog.getByLabel('Paste spreadsheet rows', { exact: true }).fill(pasted);
  const preview = await arm(page, 'imports.preview');
  await dialog.getByRole('button', { name: 'Preview rows', exact: true }).click();
  await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
  expect((await operations(page))[0].input).toEqual({ kind: 'spreadsheet_paste', sourceName: 'Pasted rows', content: pasted });
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await settle(page, preview, 'resolve');
  const submit = dialog.getByRole('button', { name: 'Import 1 row', exact: true });
  await expect(submit).toBeEnabled();
  const before = (await recorded(page)).length;
  const token = await arm(page, 'imports.commit');
  await submit.click();
  await expect.poll(async () => (await operations(page)).find(operation => operation.token === token)?.state).toBe('pending');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await dialog.evaluate(element => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await nativeIsolation(page, dialog);
  expect(counts((await recorded(page)).slice(before))).toEqual({ 'imports.commit': 1 });
  expect((await operations(page)).find(operation => operation.token === token)?.input).toEqual({ previewId: 'preview-case-1', contentHash: 'b'.repeat(64), mapping: { Name: 'person_name', Email: 'email' }, source: { channel: 'custom', referredByPersonId: null }, duplicateDecisions: [] });
  await settle(page, token, outcome);
  await expect(dialog).toBeVisible();
  if (outcome === 'resolve') {
    await expect(dialog.getByRole('status').filter({ hasText: /^Imported 1 row\.$/ })).toHaveText('Imported 1 row.');
    await expect.poll(async () => counts((await recorded(page)).slice(before))).toEqual({ 'imports.commit': 1, 'leads.list': 2, 'review.list': 1 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('grid').locator('[data-person-id="person-imported-case-1"]')).toBeVisible();
  } else {
    await expect(dialog.getByRole('alert')).toContainText('Import failed');
    await dialog.getByRole('button', { name: 'Start over', exact: true }).click();
    await expect(dialog.getByLabel('Paste spreadsheet rows', { exact: true })).toHaveValue(pasted);
    expect(counts((await recorded(page)).slice(before))).toEqual({ 'imports.commit': 1 });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  assertReadArguments(await recorded(page));
    expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
  writeFileSync(info.outputPath('import-operation.json'), JSON.stringify({ outcome, operations: await operations(page), calls: await recorded(page), ...observed }, null, 2));
});

test('actual Discovery listbox owns first Escape and unknown retry keeps the exact command', async ({ page }, info) => {
  const observed = await mount(page, { theme: 'light', density: 'comfortable', width: 1440 }, 'leads');
  const { dialog, opener } = await openConsumer(page, 'discovery');
  await assertReads(page, 'discovery');
  await dialog.getByRole('combobox', { name: 'Discovery decision', exact: true }).click();
  await expect(dialog.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await fillForm(dialog, 'discovery');
  const first = await arm(page, 'discovery.override');
  await dialog.getByRole('button', { name: 'Save discovery decision', exact: true }).click();
  await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
  const input = (await operations(page))[0].input;
  await settle(page, first, 'reject');
  await expect(dialog.getByRole('button', { name: 'Close decision', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close decision', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click();
  await retainedInputs(dialog, 'discovery');
  const retry = await arm(page, 'discovery.override');
  await dialog.getByRole('button', { name: 'Save discovery decision', exact: true }).click();
  await expect.poll(async () => (await operations(page))[1]?.state).toBe('pending');
  expect((await operations(page))[1].input).toEqual(input);
  await settle(page, retry, 'resolve');
  await expect(dialog).toHaveCount(0);
  expect((await recorded(page)).filter(call => call.kind === 'command').map(call => call.method)).toEqual(['discovery.override', 'discovery.override']);
  assertReadArguments(await recorded(page));
    expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
  writeFileSync(info.outputPath('discovery-retry.json'), JSON.stringify({ operations: await operations(page), calls: await recorded(page), ...observed }, null, 2));
});

test('actual palette Escape does not clear the underlying Leads bulk selection', async ({ page }) => {
  const observed = await mount(page, { theme: 'light', density: 'compact', width: 1050 }, 'leads');
  const row = page.getByRole('grid').locator('[data-person-id="person-kevin"]');
  const checkbox = row.getByRole('checkbox');
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(checkbox).toBeChecked();
  expect((await recorded(page)).filter(call => call.kind !== 'read')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
});

test('legacy polling advances only with the explicitly advanced browser clock', async ({ page }) => {
  const observed = await mount(page, { theme: 'light', density: 'comfortable', width: 1050, mode: 'legacy' }, 'today');
  const { dialog } = await openConsumer(page, 'manual-today');
  await assertReads(page, 'manual-today');
  const before = (await recorded(page)).length;
  await page.clock.runFor(5001);
  await expect.poll(async () => counts((await recorded(page)).slice(before))).toEqual({ 'discovery.get': 1 });
  await expect(dialog).toBeVisible();
  assertReadArguments(await recorded(page));
  expect((await recorded(page)).filter(call => call.kind !== 'read')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
});

for (const outcome of ['resolve', 'reject'] as const) test(`actual pending Today save survives a failed window-focus refresh then ${outcome}`, async ({ page }, info) => {
  const observed = await mount(page, { theme: 'light', density: 'compact', width: 1050, mode: 'legacy' }, 'today');
  const { dialog } = await openConsumer(page, 'manual-today');
  await assertReads(page, 'manual-today'); await fillForm(dialog, 'manual-today');
  const field = dialog.getByRole('textbox', { name: 'What happened', exact: true });
  const node = await field.elementHandle();
  const token = await arm(page, 'today.logPastActivity');
  await dialog.getByRole('button', { name: 'Log activity', exact: true }).click();
  await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
  const input = (await operations(page))[0].input;
  const before = (await recorded(page)).length;
  await page.evaluate(() => { window.applicationPresentation.modal!.rejectNextRead('today.get'); window.dispatchEvent(new Event('focus')); });
  await expect.poll(async () => counts((await recorded(page)).slice(before))).toEqual({ 'health.get': 1, 'daily.get': 1, 'delegation.status': 1, 'localWorkspace.get': 1, 'localWorkspace.getCommitments': 1, 'today.get': 1, 'discovery.get': 1, 'review.list': 1 });
  await expect(dialog).toBeVisible(); await retainedInputs(dialog, 'manual-today');
  expect(await node!.evaluate(element => element.isConnected && element === document.querySelector('dialog textarea'))).toBe(true);
  await expect(page.getByRole('alert', { includeHidden: true }).filter({ hasText: /refresh/i })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  expect((await operations(page))[0].input).toEqual(input);
  expect((await recorded(page)).filter(call => call.kind === 'command').map(call => call.method)).toEqual(['today.logPastActivity']);
  await settle(page, token, outcome);
  if (outcome === 'resolve') await expect(dialog).toHaveCount(0);
  else { await expect(dialog.getByRole('alert')).toContainText('not confirmed'); await retainedInputs(dialog, 'manual-today'); }
  assertReadArguments(await recorded(page));
  expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
  writeFileSync(info.outputPath('pending-refresh.json'), JSON.stringify({ outcome, input, calls: await recorded(page), operations: await operations(page) }, null, 2));
});

for (const density of ['comfortable', 'compact'] as const) for (const width of [1050, 1440] as const) test(`actual Native editor preserves node, caret and pending identity across palette and system theme ${density} ${width}`, async ({ page }, info) => {
  const observed = await mount(page, { theme: 'system', density, width }, 'today');
  await page.getByRole('button', { name: 'Email · Account A', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Email body', exact: true });
  const node = await body.elementHandle();
  const text = 'A retained exact Native email draft.';
  const token = await arm(page, 'delegation.editRequestedFollowup');
  await body.fill(text);
  await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
  const input = (await operations(page))[0].input;
  expect(input).toEqual({ accountId: 'a', draftId: 'draft-a', expectedRevision: 1, subject: 'Information for a', body: text });
  await body.evaluate(element => { element.focus(); (element as HTMLTextAreaElement).setSelectionRange(6, 12); });
  const before = (await recorded(page)).length;
  for (const theme of ['dark', 'light'] as const) {
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await nativeIsolation(page, palette, false);
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveAttribute('data-density', density);
    await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0);
    await expect(body).toBeFocused(); await expect(body).toHaveValue(text);
    expect(await node!.evaluate(element => element.isConnected && element === document.querySelector('textarea[aria-label="Email body"]'))).toBe(true);
    expect(await body.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([6, 12]);
    expect((await operations(page))[0].input).toEqual(input);
  }
  expect((await recorded(page)).slice(before)).toEqual([]);
  await expect(page.getByText('Saving edits…', { exact: true })).toBeVisible();
  await settle(page, token, 'resolve');
  await expect(page.getByText('Saving edits…', { exact: true })).toHaveCount(0);
  await expect(body).not.toHaveAttribute('readonly');
  await expect(body).toHaveValue(text);
  assertReadArguments(await recorded(page));
  expect((await recorded(page)).filter(call => call.kind === 'command')).toHaveLength(1);
  expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
  writeFileSync(info.outputPath('editor-identity.json'), JSON.stringify({ density, width, input, operations: await operations(page), calls: await recorded(page) }, null, 2));
});

test('actual contact outcome note keeps its node, caret and Person through palette', async ({ page }) => {
  const observed = await mount(page, { theme: 'system', density: 'compact', width: 1050 }, 'leads');
  const row = page.getByRole('grid').locator('[data-person-id="person-kevin"]');
  await row.focus(); await row.press('Enter');
  const contact = page.getByRole('complementary', { name: 'Kevin Shin details', exact: true });
  await contact.getByRole('button', { name: 'Open full page', exact: true }).click();
  const full = page.getByRole('article', { name: 'Kevin Shin full page', exact: true });
  await full.getByRole('tab', { name: 'Activity', exact: true }).click();
  const note = full.getByRole('region', { name: 'Call outcome', exact: true }).getByRole('textbox', { name: 'Note', exact: true });
  await note.fill('Retained note for Kevin only.');
  const node = await note.elementHandle();
  await note.evaluate(element => { element.focus(); (element as HTMLTextAreaElement).setSelectionRange(3, 9); });
  const before = (await recorded(page)).length;
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await nativeIsolation(page, palette, false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0);
  await expect(full).toBeVisible(); await expect(note).toBeFocused(); await expect(note).toHaveValue('Retained note for Kevin only.');
  expect(await node!.evaluate(element => element.isConnected && element === document.querySelector('.call-outcome__note'))).toBe(true);
  expect(await note.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([3, 9]);
  expect((await recorded(page)).slice(before)).toEqual([]); assertReadArguments(await recorded(page));
  expect((await recorded(page)).filter(call => call.kind !== 'read')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
});

for (const phase of ['preview-reject', 'preview-late', 'remap'] as const) test(`actual Import ${phase} preserves source and bounded command identity`, async ({ page }) => {
  const observed = await mount(page, { theme: 'light', density: 'comfortable', width: 1050 }, 'leads');
  const { dialog, opener } = await openConsumer(page, 'import');
  await assertReads(page, 'import');
  await dialog.getByLabel('Paste spreadsheet rows', { exact: true }).fill(pasted);
  const preview = await arm(page, 'imports.preview');
  await dialog.getByRole('button', { name: 'Preview rows', exact: true }).click();
  await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
  if (phase === 'preview-late') {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    await settle(page, preview, 'resolve');
    await expect(dialog).toHaveCount(0);
  } else if (phase === 'preview-reject') {
    await settle(page, preview, 'reject');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Start over', exact: true }).click();
    await expect(dialog.getByLabel('Paste spreadsheet rows', { exact: true })).toHaveValue(pasted);
  } else {
    await settle(page, preview, 'resolve');
    const remap = await arm(page, 'imports.remap');
    await dialog.getByRole('combobox', { name: 'Email', exact: true }).selectOption('notes');
    await expect.poll(async () => (await operations(page))[1]?.state).toBe('pending');
    expect((await operations(page))[1].input).toEqual({ previewId: 'preview-case-1', contentHash: 'b'.repeat(64), mapping: { Name: 'person_name', Email: 'notes' } });
    await expect(dialog.getByRole('button', { name: 'Import 1 row', exact: true })).toBeDisabled();
    await settle(page, remap, 'resolve');
    await expect(dialog.getByRole('combobox', { name: 'Email', exact: true })).toHaveValue('notes');
    await expect(dialog.getByRole('button', { name: 'Import 1 row', exact: true })).toBeEnabled();
  }
  expect((await recorded(page)).filter(call => call.kind === 'command').map(call => call.method)).toEqual(phase === 'remap' ? ['imports.preview', 'imports.remap'] : ['imports.preview']);
  assertReadArguments(await recorded(page));
  expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
  expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
});

// Task3 additive cases. Synthetic finite responses, actual App/Friday/modals.
// No schema/provider/domain factory is imported into this browser test.
const fridayLayouts = [{ width: 1050, density: 'comfortable' }, { width: 1440, density: 'compact' }] as const;
const fridayUnconfirmed = 'The change could not be confirmed. Your input is kept. Review the job before retrying.';
const fridayRow = (page: Page, id: string) => page.locator('.friday-jobs__row').filter({ has: page.getByText(id, { exact: true }) });
async function fridayReads(page: Page, expectedCurrent: number) {
  const all = await recorded(page);
  expect(counts(all.filter(call => call.kind === 'read'))).toEqual({
    'health.get': 2, 'leadDetail.getOutboundCapabilities': 2, 'review.list': 2, 'friday.getCurrent': expectedCurrent,
  });
  assertReadArguments(all.filter(call => call.method !== 'friday.getCurrent'));
  // Playwright preserves undefined, JSON artifacts may serialize it to null.
  // Assert inside the browser so argc1/undefined cannot become {} or offset0.
  expect(await page.evaluate(() => window.applicationPresentation.calls.filter(call => call.method === 'friday.getCurrent').map(call => ({
    argc: call.args?.length, undefinedInput: call.args?.[0] === undefined,
  })))).toEqual(Array.from({ length: expectedCurrent }, () => ({ argc: 1, undefinedInput: true })));
}
async function fridayFrames(page: Page) {
  await page.evaluate(() => window.applicationPresentation.frame());
  await page.evaluate(() => window.applicationPresentation.frame());
}

for (const action of ['create', 'fill', 'cancel'] as const) for (const theme of ['light', 'dark'] as const) for (const layout of fridayLayouts) {
  test(`actual Friday ${action} retains intent through native modals and uncertain acknowledgement ${theme} ${layout.density} ${layout.width}`, async ({ page }, info) => {
    const context: Context = { ...layout, theme, fridayScenario: true };
    // One member of the12 proves the default-deny boundary before a fresh opt-in mount.
    if (action === 'create' && theme === 'light' && layout.width === 1050) {
      const defaultObserved = await mount(page, { ...layout, theme }, 'friday');
      const denied = await page.evaluate(async () => {
        const controller = window.applicationPresentation.modal!;
        let armDenied = false, readControlDenied = false, commandDenied = false;
        try { Reflect.apply(controller.arm, controller, ['friday.createJob']); } catch { armDenied = true; }
        try { Reflect.apply(controller.rejectNextRead, controller, ['friday.getCurrent']); } catch { readControlDenied = true; }
        try { await window.callie.friday.createJob({ jobId: 'denied-default', salesCycleId: null, requestedAt: '2026-09-08T14:15:00.000Z' }); } catch { commandDenied = true; }
        return { armDenied, readControlDenied, commandDenied, operations: controller.operations,
          forbidden: window.applicationPresentation.calls.filter(call => call.kind === 'forbidden').map(call => call.method) };
      });
      expect(denied).toEqual({ armDenied: true, readControlDenied: true, commandDenied: true, operations: [], forbidden: ['friday.createJob'] });
      expect(defaultObserved.errors).toEqual([]); expect(defaultObserved.requests).toEqual([]);
    }
    const observed = await mount(page, context, 'friday');
    await expect(page.getByLabel('Requested date', { exact: true })).toBeVisible();
    await expect(fridayRow(page, 'job-friday-kevin').getByText('Requested', { exact: true })).toBeVisible();
    await expect(fridayRow(page, 'job-friday-maya').getByText('Requested', { exact: true })).toBeVisible();
    await fridayFrames(page); await fridayReads(page, 2);
    expect(await page.evaluate(() => {
      const c = window.applicationPresentation.modal!;
      let unknown = false, drilldown = false;
      try { Reflect.apply(c.arm, c, ['friday.unknown']); } catch { unknown = true; }
      try { Reflect.apply(c.arm, c, ['friday.getDrilldown']); } catch { drilldown = true; }
      return { unknown, drilldown, operations: c.operations.length };
    })).toEqual({ unknown: true, drilldown: true, operations: 0 });

    const requestedDate = page.getByLabel('Requested date', { exact: true });
    const requestedTime = page.getByLabel('Requested time', { exact: true });
    const cycle = page.getByRole('textbox', { name: 'Won sales cycle (optional)', exact: true });
    const rawCycle = action === 'create' ? '  friday-cycle-new  ' : '  unrelated-won-cycle-draft  ';
    await requestedDate.fill('2026-09-08'); await requestedTime.fill('10:15'); await cycle.fill(rawCycle);
    const fields = [
      { locator: requestedDate, value: '2026-09-08' }, { locator: requestedTime, value: '10:15' }, { locator: cycle, value: rawCycle },
    ];
    let fill: Locator | undefined;
    if (action === 'fill') {
      await page.getByRole('button', { name: 'Fill job-friday-kevin', exact: true }).click();
      fill = page.getByRole('group', { name: 'Fill job-friday-kevin', exact: true });
      await expect(fill).toBeVisible();
      expect(await fill.evaluate(element => !(element instanceof HTMLDialogElement) && !element.closest('dialog'))).toBe(true);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
      await fill.getByLabel('Accepted date', { exact: true }).fill('2026-09-09');
      await fill.getByLabel('Accepted time', { exact: true }).fill('11:30');
      fields.push({ locator: fill.getByLabel('Accepted date', { exact: true }), value: '2026-09-09' }, { locator: fill.getByLabel('Accepted time', { exact: true }), value: '11:30' });
    }
    const held = await Promise.all(fields.map(async field => ({ ...field, node: (await field.locator.elementHandle())! })));
    const sameFields = async (includeFill = true) => {
      for (const field of includeFill ? held : held.slice(0, 3)) {
        await expect(field.locator).toHaveValue(field.value);
        expect(await field.locator.evaluate((element, original) => element === original && element.isConnected, field.node)).toBe(true);
      }
    };
    const setupCycleSelection = async () => {
      await cycle.focus();
      await cycle.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 9));
    };
    const expectCycleSelection = async () => {
      await expect(cycle).toBeFocused();
      expect(await cycle.evaluate((element, original) => element === original && element.isConnected, held[2].node)).toBe(true);
      expect(await cycle.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([3, 9]);
    };
    const expectReadonlyFields = async () => {
      for (const field of held) {
        await expect(field.locator).toBeEnabled();
        expect(await field.locator.evaluate(element => (element as HTMLInputElement).readOnly)).toBe(true);
      }
    };
    await setupCycleSelection();
    if (fill) {
      // Inline editing is not a modal owner. Escape must not dismiss or trap it.
      await page.keyboard.press('Escape'); await expect(fill).toBeVisible();
      await expect(cycle).toBeFocused(); await sameFields();
      expect(await cycle.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([3, 9]);
    }
    const beforeModals = (await recorded(page)).length;
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await nativeIsolation(page, palette, false);
    await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0);
    await expect(cycle).toBeFocused(); await sameFields();
    expect(await cycle.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([3, 9]);
    // The native Import event navigates to Leads. Use the actual palette action,
    // whose openImport callback does not navigate or unmount Friday instead.
    await page.keyboard.press('ControlOrMeta+k');
    await palette.getByRole('combobox', { name: 'Command palette', exact: true }).fill('Import leads');
    await palette.getByRole('option', { name: 'Import leads…', exact: true }).click();
    const importDialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
    await expect(palette).toHaveCount(0);
    await nativeIsolation(page, importDialog);
    expect(new URL(page.url()).hash).toBe('#/friday');
    await importDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(importDialog).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/friday'); await sameFields();
    // Focus restoration through two modal owners is not assumed here.
    expect((await recorded(page)).slice(beforeModals)).toEqual([]);
    if (fill) await expect(fill).toBeVisible();

    const method = action === 'create' ? 'friday.createJob' : action === 'fill' ? 'friday.fillJob' : 'friday.cancelJob';
    const firstToken = await arm(page, method);
    // Friday permissions are one total armed/pending token, even across methods.
    expect(await page.evaluate(() => {
      const c = window.applicationPresentation.modal!;
      try { c.arm('friday.cancelJob'); return false; } catch { return true; }
    })).toBe(true);
    const commandStart = (await recorded(page)).length;
    if (action === 'create') { await cycle.focus(); await cycle.press('Enter'); }
    else if (action === 'fill') { await fill!.getByRole('button', { name: 'Confirm fill', exact: true }).focus(); await page.keyboard.press('Enter'); }
    else await page.getByRole('button', { name: 'Cancel job-friday-maya', exact: true }).click();
    await expect.poll(async () => (await operations(page))[0]?.state).toBe('pending');
    await page.keyboard.press('Enter');
    await sameFields();
    for (const name of ['Request job', 'Fill job-friday-maya', 'Cancel job-friday-maya', 'Previous week', 'Next week']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    if (fill) await expect(fill.getByRole('button', { name: 'Keep requested', exact: true })).toBeDisabled();
    const firstInput = (await operations(page))[0].input;
    let expectedInput: unknown;
    if (action === 'create') {
      expect(firstInput).toEqual({ jobId: expect.stringMatching(/^job-/), salesCycleId: 'friday-cycle-new', requestedAt: '2026-09-08T14:15:00.000Z' });
      // Generated identity is captured once, all other expectations are fixture constants.
      expectedInput = firstInput;
    } else expectedInput = action === 'fill'
      ? { jobId: 'job-friday-kevin', contractorAcceptedAt: '2026-09-09T15:30:00.000Z' }
      : { jobId: 'job-friday-maya' };
    expect(firstInput).toEqual(expectedInput);
    expect((await recorded(page)).slice(commandStart)).toEqual([{ method, kind: 'command', args: [expectedInput] }]);

    // Command activation may move focus. Establish this pending phase's own
    // textbox selection before observing a real modal open/close transition.
    await expectReadonlyFields(); await setupCycleSelection();
    const pendingModalStart = (await recorded(page)).length;
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible();
    expect(await palette.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
    await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0);
    await expectCycleSelection(); await sameFields(); await expectReadonlyFields();
    await page.keyboard.press('ControlOrMeta+k');
    await palette.getByRole('combobox', { name: 'Command palette', exact: true }).fill('Import leads');
    await palette.getByRole('option', { name: 'Import leads…', exact: true }).click();
    await expect(palette).toHaveCount(0); await expect(importDialog).toBeVisible();
    expect(await importDialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
    expect(new URL(page.url()).hash).toBe('#/friday');
    await importDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(importDialog).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/friday');
    await sameFields(); await expectReadonlyFields();
    expect((await recorded(page)).slice(pendingModalStart)).toEqual([]);
    expect((await operations(page)).map(operation => operation.state)).toEqual(['pending']);
    // Import's close does not promise textbox focus. Explicitly establish a new
    // selection before rejection, then never restore it after that transition.
    await setupCycleSelection(); await expectCycleSelection();
    await settle(page, firstToken, 'reject');
    await expect(page.getByText(fridayUnconfirmed, { exact: true })).toBeVisible();
    await sameFields(); await expectCycleSelection(); await expectReadonlyFields(); await fridayReads(page, 2);
    expect((await recorded(page)).slice(commandStart)).toEqual([{ method, kind: 'command', args: [expectedInput] }]);
    expect(await operations(page)).toEqual([{ token: firstToken, method, input: expectedInput, state: 'rejected' }]);
    await expect(page.getByRole('button', { name: 'Request job', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Previous week', exact: true })).toBeDisabled();
    if (fill) await expect(fill.getByRole('button', { name: 'Keep requested', exact: true })).toBeDisabled();

    const retryToken = await arm(page, method);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(async () => (await operations(page))[1]?.state).toBe('pending');
    expect((await operations(page))[1].input).toEqual(expectedInput);
    // Retry activation owns its button focus. Observe readonly field/caret
    // stability only after explicit setup in this new pending phase.
    await setupCycleSelection(); await fridayFrames(page);
    await sameFields(); await expectCycleSelection(); await expectReadonlyFields();
    await page.evaluate(() => window.applicationPresentation.modal!.rejectNextRead('friday.getCurrent'));
    await settle(page, retryToken, 'resolve');
    await expect(page.getByText('Saved; scoreboard refresh failed', { exact: true })).toBeVisible();
    await fridayReads(page, 3);
    const commands = (await recorded(page)).filter(call => call.kind === 'command');
    expect(commands).toEqual([{ method, kind: 'command', args: [expectedInput] }, { method, kind: 'command', args: [expectedInput] }]);
    if (action === 'create') {
      await expect(requestedDate).toHaveValue(''); await expect(requestedTime).toHaveValue(''); await expect(cycle).toHaveValue('');
      for (const field of held) expect(await field.locator.evaluate((element, original) => element === original, field.node)).toBe(true);
    } else {
      await sameFields(false);
      if (fill) await expect(fill).toHaveCount(0);
    }
    const refreshStart = (await recorded(page)).length;
    await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
    await fridayFrames(page); await fridayReads(page, 4);
    expect((await recorded(page)).slice(refreshStart).map(call => ({ method: call.method, kind: call.kind }))).toEqual([{ method: 'friday.getCurrent', kind: 'read' }]);
    expect((await recorded(page)).filter(call => call.kind === 'command')).toEqual(commands);
    if (action === 'create') {
      const id = await page.evaluate(() => {
        const input = window.applicationPresentation.modal!.operations[0].input;
        if (typeof input !== 'object' || input === null || !('jobId' in input) || typeof input.jobId !== 'string') throw Error('Missing captured job ID');
        return input.jobId;
      });
      await expect(fridayRow(page, id).getByText('Requested', { exact: true })).toBeVisible();
    } else {
      await sameFields(false);
      await expect(fridayRow(page, action === 'fill' ? 'job-friday-kevin' : 'job-friday-maya').getByText(action === 'fill' ? 'Filled' : 'Cancelled', { exact: true })).toBeVisible();
    }
    expect((await recorded(page)).filter(call => call.method.startsWith('imports.'))).toEqual([]);
    expect((await recorded(page)).filter(call => call.kind === 'forbidden')).toEqual([]);
    expect((await operations(page)).map(operation => operation.state)).toEqual(['rejected', 'resolved']);
    expect(observed.errors).toEqual([]); expect(observed.requests).toEqual([]);
    writeFileSync(info.outputPath('friday-retention.json'), JSON.stringify({ action, theme, ...layout, expectedInput, calls: await recorded(page), operations: await operations(page) }, null, 2));
  });
}
