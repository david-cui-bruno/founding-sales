import { test, expect, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/nativeDeskCompositionBrowser';

let javascript: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/fixtures/nativeDeskCompositionBrowser.tsx')], outdir: 'composition-fixture', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
  javascript = bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(f => f.path.endsWith('.css'))!.text;
});
async function mount(page: Page, scenario = 'populated') {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:41837/native-composition?scenario=${scenario}`;
  await page.route('**/*', route => {
    if (route.request().url() === url && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Fictional A composition acceptance</title></head><body><div id="root"></div></body></html>' });
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: javascript });
  await expect(page.getByTestId('native-desk')).toBeVisible();
  return { errors, requests };
}
const commands = (page: Page) => page.evaluate(() => window.nativeDeskCompositionBrowser.fixture.calls.filter(c => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'].includes(c.method)));
const emailRow = (page: Page) => page.locator('[data-row-key="requested_followup:nora:draft-nora"]');
async function clean(page: Page, state: { errors: string[]; requests: string[] }) {
  expect(state.errors).toEqual([]); expect(state.requests).toEqual([]);
  expect((await commands(page)).some(c => c.method === 'forbidden')).toBe(false);
}

test('actual saved email follows A identity, call context, editor and action composition', async ({ page }, info) => {
  const state = await mount(page);
  await emailRow(page).click();
  const detail = page.locator('.native-desk__detail');
  await page.screenshot({ path: info.outputPath('initial-composition.png') });
  await expect(emailRow(page)).toContainText('Nora Ellis');
  await expect(emailRow(page)).toContainText('Riverton Residential');
  await expect(detail.getByRole('heading', { name: 'Nora Ellis', exact: true })).toBeVisible();
  await expect(detail.getByText('Operations director', { exact: true })).toBeVisible();
  await expect(detail.getByText('Human-reported call note', { exact: true })).toBeVisible();
  const note = detail.getByText('Email me a short outline of what you mean by a one-building pilot. Then we can decide if a conversation makes sense.', { exact: true });
  await expect(note).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Riverton Residential', exact: true })).toHaveCount(0);
  const body = page.getByRole('textbox', { name: 'Email body' });
  await body.evaluate(e => { e.setAttribute('data-composition-node', 'original'); (e as HTMLTextAreaElement).setSelectionRange(4, 8); });
  for (const width of [1440, 1050]) for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    await page.evaluate(theme => { window.nativeDeskCompositionBrowser.preferences(theme, 'compact'); window.nativeDeskCompositionBrowser.refresh(); }, theme);
    await expect(body).toHaveAttribute('data-composition-node', 'original');
    const geometry = { title: await detail.getByRole('heading', { name: 'Nora Ellis', exact: true }).boundingBox(), note: await note.boundingBox(), subject: await page.getByRole('textbox', { name: 'Email subject' }).boundingBox(), body: await body.boundingBox(), approve: await page.getByRole('button', { name: 'Approve email', exact: true }).boundingBox() };
    expect(geometry.title!.y).toBeLessThan(geometry.note!.y);
    expect(geometry.note!.y).toBeLessThan(geometry.subject!.y);
    expect(geometry.subject!.y).toBeLessThan(geometry.body!.y);
    expect(geometry.body!.height).toBeGreaterThanOrEqual(width === 1440 ? 190 : 90);
    expect(geometry.approve!.y + geometry.approve!.height).toBeLessThanOrEqual((await detail.boundingBox())!.y + (await detail.boundingBox())!.height - 4);
    await expect(page.getByRole('button', { name: 'Approve email', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`composed-A-${width}-${theme}.png`) });
    // At short window heights the message owns a real internal scroll area.
    // Bounding-box height alone does not prove any part of the editor is visible.
    if (width === 1050) {
      const subject = page.getByRole('textbox', { name: 'Email subject' });
      await subject.focus(); await subject.press('Tab');
      await expect(body).toBeFocused();
    }
    const visibleEditorHeight = await body.evaluate(e => {
      const body = e.getBoundingClientRect();
      const area = e.closest('.native-desk__message-area')!.getBoundingClientRect();
      return Math.max(0, Math.min(body.bottom, area.bottom, innerHeight) - Math.max(body.top, area.top, 0));
    });
    expect(visibleEditorHeight, `${width}/${theme} usable visible editor`).toBeGreaterThanOrEqual(width === 1440 ? 190 : 90);
    await expect(page.getByRole('button', { name: 'Approve email', exact: true })).toBeInViewport();
    if (width === 1050) await page.screenshot({ path: info.outputPath(`composed-A-${width}-${theme}-editor-focused.png`) });
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter(i => i.impact === 'serious' || i.impact === 'critical')).toEqual([]);
    await page.locator('.native-desk__message-area').evaluate(e => { e.scrollTop = 0; });
  }
  expect(await commands(page)).toEqual([]);
  await clean(page, state);
});

test('unpaired A uses one coherent inset state and does not mislabel unavailable lanes as zero', async ({ page }, info) => {
  const state = await mount(page, 'unpaired');
  for (const width of [1440, 1050]) for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
    await page.evaluate(theme => window.nativeDeskCompositionBrowser.preferences(theme, 'compact'), theme);
    const detail = page.locator('.native-desk__detail');
    await expect(detail.getByRole('link', { name: /settings/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Local commitments/ }).locator('.native-desk__count')).toHaveText('0');
    for (const label of ['Calls', 'Saved draft continuations', 'Upcoming meetings']) {
      await expect(page.getByRole('heading', { name: new RegExp(`^${label}`) }).locator('.native-desk__count')).toHaveText('Unavailable');
    }
    await expect(page.locator('.native-desk__lane .native-desk__count')).toHaveCount(4);
    await expect(page.getByText('Account approvals are unavailable.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Account meetings are unavailable.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No retained work due in this local snapshot.', { exact: true })).toHaveCount(0);
    expect((await detail.boundingBox())!.height).toBeGreaterThan(300);
    await expect(page.getByRole('heading', { name: 'Nora Ellis', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`empty-A-${width}-${theme}.png`) });
    expect((await new AxeBuilder({ page }).analyze()).violations.filter(i => i.impact === 'serious' || i.impact === 'critical')).toEqual([]);
  }
  expect(await commands(page)).toEqual([]); await clean(page, state);
});

test('unavailable metadata falls back to the actual recipient rather than an invented contact or quote', async ({ page }) => {
  const state = await mount(page, 'missing'); await emailRow(page).click();
  const detail = page.locator('.native-desk__detail');
  await expect(detail.getByRole('heading', { name: 'nora@riverton.example', exact: true })).toBeVisible();
  await expect(detail.getByText('Nora Ellis', { exact: true })).toHaveCount(0);
  await expect(detail.getByText(/Email me a short outline/)).toHaveCount(0);
  await expect(detail.getByText(/original call context unavailable/i)).toBeVisible();
  expect(await commands(page)).toEqual([]); await clean(page, state);
});

test('metadata removal and arrival retain the actual editor node, local text and caret without commands', async ({ page }) => {
  const state = await mount(page); await emailRow(page).click();
  const body = page.getByRole('textbox', { name: 'Email body' });
  await body.fill('My unsaved local wording stays here.');
  await body.evaluate(e => { e.setAttribute('data-continuity', 'same'); (e as HTMLTextAreaElement).setSelectionRange(3, 9); });
  const presentation = await page.evaluate(() => {
    const fixture = window.nativeDeskCompositionBrowser.fixture;
    const snapshot = fixture.snapshot();
    const answer = snapshot.answers.find(a => a.kind === 'requested_followup');
    if (!answer || answer.kind !== 'requested_followup') throw Error('Missing requested fixture');
    const presentation = answer.presentation!;
    delete answer.presentation;
    fixture.setSnapshot(snapshot); window.nativeDeskCompositionBrowser.refresh();
    return presentation;
  });
  const detail = page.locator('.native-desk__detail');
  await expect(detail.getByRole('heading', { name: 'nora@riverton.example', exact: true })).toBeVisible();
  await expect(body).toHaveAttribute('data-continuity', 'same');
  await expect(body).toHaveValue('My unsaved local wording stays here.');
  expect(await body.evaluate(e => [(e as HTMLTextAreaElement).selectionStart, (e as HTMLTextAreaElement).selectionEnd])).toEqual([3, 9]);
  await page.evaluate(presentation => {
    const fixture = window.nativeDeskCompositionBrowser.fixture;
    const snapshot = fixture.snapshot();
    const answer = snapshot.answers.find(a => a.kind === 'requested_followup');
    if (!answer || answer.kind !== 'requested_followup') throw Error('Missing requested fixture');
    answer.presentation = presentation;
    fixture.setSnapshot(snapshot); window.nativeDeskCompositionBrowser.refresh();
  }, presentation);
  await expect(detail.getByRole('heading', { name: 'Nora Ellis', exact: true })).toBeVisible();
  await expect(body).toHaveAttribute('data-continuity', 'same');
  await expect(body).toHaveValue('My unsaved local wording stays here.');
  expect(await body.evaluate(e => [(e as HTMLTextAreaElement).selectionStart, (e as HTMLTextAreaElement).selectionEnd])).toEqual([3, 9]);
  expect(await commands(page)).toEqual([]); await clean(page, state);
});

test('secondary approval checks do not execute and required permission remains directly available', async ({ page }) => {
  const state = await mount(page); await emailRow(page).click();
  const body = page.getByRole('textbox', { name: 'Email body' });
  await body.evaluate(e => e.setAttribute('data-disclosure-node', 'same'));
  const checks = page.locator('.native-desk__approval-checks');
  await expect(checks).not.toHaveAttribute('open', '');
  await expect(page.getByRole('checkbox')).toBeVisible();
  await expect(page.getByLabel('Approval expiry')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve email', exact: true })).toBeDisabled();
  await checks.locator(':scope > summary').click();
  await expect(page.getByRole('button', { name: 'Owner preflight', exact: true })).toBeVisible();
  await expect(body).toHaveAttribute('data-disclosure-node', 'same');
  await checks.locator(':scope > summary').click();
  await expect(page.getByRole('checkbox')).toBeVisible();
  await expect(page.getByLabel('Approval expiry')).toBeVisible();
  await expect(body).toHaveAttribute('data-disclosure-node', 'same');
  expect(await commands(page)).toEqual([]); await clean(page, state);
});
