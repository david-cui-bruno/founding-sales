import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from 'playwright/test';

import { launchFounderWorkspace, launchSeededFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

const routes = ['Today', 'Leads', 'Pipeline', 'Conversations', 'Learnings', 'Inbox', 'Friday', 'Settings'] as const;

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('region', { name: 'Appearance', exact: true })
    .getByRole('button', { name: theme === 'light' ? 'Light appearance' : 'Dark appearance', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function accessible(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).setLegacyMode(true)
    .options({ rules: { 'label-content-name-mismatch': { enabled: true } } }).analyze();
  expect([...result.passes, ...result.inapplicable, ...result.incomplete, ...result.violations]
    .some(rule => rule.id === 'label-content-name-mismatch'), `${label}: Label in Name rule ran`).toBe(true);
  expect.soft(result.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? '') || v.id === 'label-content-name-mismatch')
    .map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), label).toEqual([]);
}

async function fitAndCapture(page: Page, info: TestInfo, name: string) {
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no window-level horizontal overflow`).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
}

test('Bauhaus identity reaches the real shell, heading and navigation without replacing theme preferences', async () => {
  const workspace = await launchFounderWorkspace();
  try {
    const { page } = workspace;
    await setTheme(page, 'light');
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page.locator('.nav-rail__brand-native')).toHaveText('Callie');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contacts due', exact: true })).toBeVisible();
    const styles = await page.evaluate(() => {
      const heading = document.querySelector('main h1')!;
      const main = document.querySelector('.app-shell__workspace')!;
      const nav = document.querySelector('[aria-current="page"]')!;
      const root = document.querySelector('.presentation-root') ?? document.documentElement;
      return { canvas: getComputedStyle(main).backgroundColor,
        display: getComputedStyle(heading).fontFamily,
        root: getComputedStyle(root).fontFamily,
        text: getComputedStyle(root).color,
        navRadius: getComputedStyle(nav).borderTopLeftRadius };
    });
    expect(styles.canvas).toBe('rgb(233, 237, 242)');
    expect(styles.display).toContain('-apple-system');
    expect(styles.root).toContain('-apple-system');
    expect(styles.text).toBe('rgb(34, 42, 53)');
    expect(parseFloat(styles.navRadius)).toBe(6);
    await fitAndCapture(page, test.info(), 'light-today-quiet');
    await accessible(page, 'light quiet Today');
    const nativeBox = await page.locator('.nav-rail__native-controls').boundingBox();
    const brandBox = await page.locator('.nav-rail__brand-native').boundingBox();
    expect(brandBox!.y).toBeGreaterThanOrEqual(nativeBox!.y + nativeBox!.height);
    await setTheme(page, 'dark');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.nav-rail__brand-native')).toHaveText('Callie');
  } finally { await workspace.close(); }
});

test('command-palette import restores logical route focus when its original control is replaced', async () => {
  const workspace = await launchSeededFounderWorkspace();
  try {
    const { page } = workspace;
    const opener = page.getByRole('button', { name: 'All 3', exact: true });
    await opener.focus();
    expect(await opener.evaluate(el => el.id)).toBe('');
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Command palette', exact: true }).fill('Import');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await dialog.getByLabel('CSV file').setInputFiles({
      name: 'palette-focus.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Name,Phone,Email,Source,Doors,Organization\nPalette Focus Owner,+14015550999,palette-focus@example.test,frbo,4,Palette Fixture\n'),
    });
    await dialog.getByRole('button', { name: 'Preview rows', exact: true }).click();
    await dialog.getByRole('button', { name: 'Import 1 row', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'All 4', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Leads', exact: true })).toBeFocused();
  } finally { await workspace.close(); }
});

test('all workspaces and shared overlays remain usable with Bauhaus light and dark styling', async () => {
  const info = test.info();
  test.setTimeout(180_000);
  const workspace = await launchSeededFounderWorkspace();
  try {
    const { page } = workspace;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Successful import remounts the Leads route. Done must focus its new trigger.
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();

    // Fixture-only manual reports through the real public commands. No dispatch.
    const names = await page.evaluate(async () => {
      const leads = await window.callie.leads.list({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 10 });
      for (const row of leads.rows) {
        const detail = await window.callie.leadDetail.get({ personId: row.personId });
        await window.callie.leadDetail.confirmTransition({ transition: 'review_to_ready', salesCycleId: detail.salesCycleId, expectedRevision: detail.revision });
        await window.callie.today.logCallOutcome({ personId: row.personId, salesCycleId: detail.salesCycleId,
          outcome: 'spoke', callbackAt: new Date(Date.now() + 1000).toISOString(), occurredAt: new Date().toISOString() });
      }
      return leads.rows.map(row => row.personName);
    });
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).lanes.flatMap(lane => lane.items).length).toBe(3);
    expect(names).toHaveLength(3);

    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setTheme(page, theme);
      for (const route of routes) {
        await navigateFounderRoute(page, route);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
        if (route === 'Today') {
          const queue = page.getByRole('list', { name: 'Work queue', exact: true });
          await expect(queue).toBeVisible();
          await expect(queue.locator('.today-row')).toHaveCount(3);
          for (const name of names) await expect(queue.getByRole('button', { name, exact: true })).toBeVisible();
          await expect(page.getByText('Prepared conversations', { exact: true })).toHaveCount(0);

        }
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}`);
        await accessible(page, `${theme} ${route}`);
        // The app's actual minimum supported window is 1050x700.
        await page.setViewportSize({ width: 1050, height: 700 });
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}-narrow`);
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      await page.getByRole('link', { name: 'Today', exact: true }).click();
      const row = page.getByRole('list', { name: 'Work queue', exact: true }).locator('.today-row').first();
      await expect(row).toBeVisible();
      const comfortableHeight = (await row.boundingBox())!.height;
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Compact density', exact: true }).click();
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect(row).toBeVisible();
      expect((await row.boundingBox())!.height).toBeLessThan(comfortableHeight);
      await fitAndCapture(page, info, `${theme}-today-compact-density`);
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Comfortable density', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');

      await navigateFounderRoute(page, 'Leads');
      await page.getByRole('row', { name: /Kevin Shin/ }).click();
      const inspector = page.getByRole('complementary', { name: 'Kevin Shin details', exact: true });
      await expect(inspector).toBeVisible();
      await fitAndCapture(page, info, `${theme}-inspector`);
      await accessible(page, `${theme} inspector`);
      await page.setViewportSize({ width: 1050, height: 700 });
      await fitAndCapture(page, info, `${theme}-inspector-narrow`);
      await inspector.getByRole('button', { name: 'Open full page', exact: true }).click();
      await expect(page.locator('.lead-full-page')).toBeVisible();
      await fitAndCapture(page, info, `${theme}-lead-full-page`);
      await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });

      await page.getByRole('button', { name: 'Import', exact: true }).click();
      const importDialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
      await expect(importDialog).toBeVisible();
      await expect(importDialog).toBeInViewport({ ratio: 1 });
      await expect.poll(() => importDialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await fitAndCapture(page, info, `${theme}-import`);
      await accessible(page, `${theme} import`);
      for (let tab = 0; tab < 12; tab++) {
        await page.keyboard.press('Tab');
        expect(await importDialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(importDialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(importDialog).toBeInViewport({ ratio: 1 });
      await importDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();

      await page.keyboard.press('Meta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toBeVisible();
      await fitAndCapture(page, info, `${theme}-command-palette`);
      await accessible(page, `${theme} command palette`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally { await workspace.close(); }
});
