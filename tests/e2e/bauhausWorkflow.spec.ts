import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from 'playwright/test';

import { launchFounderWorkspace, launchSeededFounderWorkspace } from '../support/founderWorkspace';

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
    await expect(page.locator('.nav-rail__brand')).toHaveText('FSS');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    const styles = await page.evaluate(() => {
      const heading = document.querySelector('main h1')!;
      const main = document.querySelector('.app-shell__workspace')!;
      const nav = document.querySelector('[aria-current="page"]')!;
      return { canvas: getComputedStyle(main).backgroundColor,
        display: getComputedStyle(heading).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
        navRadius: getComputedStyle(nav).borderTopLeftRadius };
    });
    expect(styles.canvas).toBe('rgb(246, 240, 223)');
    expect(styles.display).not.toBe(styles.body);
    expect(parseFloat(styles.navRadius)).toBeLessThanOrEqual(2);
    await fitAndCapture(page, test.info(), 'light-today-quiet');
    await accessible(page, 'light quiet Today');
    const nativeBox = await page.locator('.nav-rail__native-controls').boundingBox();
    const brandBox = await page.locator('.nav-rail__brand').boundingBox();
    expect(brandBox!.y).toBeGreaterThanOrEqual(nativeBox!.y + nativeBox!.height);
    await setTheme(page, 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.nav-rail__brand')).toHaveText('FSS');
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
    const done = page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible()) await done.click();

    // Create genuine commitments using the retained manual-review UI and the
    // same public completion command used by the callback workflow fixture.
    // No mocked Today snapshot, outbound request, or real person is involved.
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await page.getByRole('button', { name: 'Manual review (optional)', exact: true }).click();
    await page.getByRole('region', { name: 'Unreviewed backlog', exact: true })
      .getByRole('button', { name: 'Review', exact: true }).click();
    for (let index = 1; index <= 3; index++) {
      await expect(page.getByText(`Reviewing ${index} of 3`, { exact: true })).toBeVisible();
      await page.keyboard.press('1');
    }
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(0);
    await page.keyboard.press('Escape');
    const names = await page.evaluate(async () => {
      const ready = await window.callie.leads.list({ query: '', stages: ['ready'], priorities: [], sort: 'person_name', cursor: null, limit: 10 });
      for (const row of ready.rows) {
        const detail = await window.callie.leadDetail.get({ personId: row.personId });
        await window.callie.today.complete({ salesCycleId: detail.salesCycleId, actionId: detail.nextAction!.id, outcome: 'replied', activityId: null });
      }
      return ready.rows.map(row => row.personName);
    });
    expect(names).toHaveLength(3);

    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setTheme(page, theme);
      for (const route of routes) {
        await page.getByRole('link', { name: route, exact: true }).click();
        await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: route, exact: true })).toHaveAttribute('aria-current', 'page');
        if (route === 'Today') {
          const hero = page.getByRole('group', { name: /^Next up:/ });
          const also = page.getByRole('region', { name: 'Also today', exact: true });
          await expect(hero).toBeVisible();
          await expect(also.locator('.today-row')).toHaveCount(2);
          for (const name of names) await expect(page.locator('.today__bento').getByRole('button', { name, exact: true })).toBeVisible();
          const heroBox = await hero.boundingBox();
          const alsoBox = await also.boundingBox();
          expect(alsoBox!.x).toBeGreaterThan(heroBox!.x + heroBox!.width);
          expect(Math.abs(alsoBox!.y - heroBox!.y)).toBeLessThan(2);
        }
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}`);
        await accessible(page, `${theme} ${route}`);
        // The app's actual minimum supported window is 1050x700.
        await page.setViewportSize({ width: 1050, height: 700 });
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}-narrow`);
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      await page.getByRole('link', { name: 'Today', exact: true }).click();
      const row = page.getByRole('region', { name: 'Also today', exact: true }).locator('.today-row').first();
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

      await page.getByRole('link', { name: 'Leads', exact: true }).click();
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
