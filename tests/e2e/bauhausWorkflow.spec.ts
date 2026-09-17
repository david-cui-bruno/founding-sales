import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from 'playwright/test';

import { launchFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

const routes = ['Today', 'Accounts', 'Campaigns', 'Settings'] as const;
/** A fresh packaged profile starts in the legacy workflow; its desk routes show this exact hold, never the removed queue. */
const legacyHoldCopy = 'Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.';

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
    await expect(page.getByText(legacyHoldCopy, { exact: true })).toBeVisible();
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

test('all workspaces and shared overlays remain usable with Bauhaus light and dark styling', async () => {
  const info = test.info();
  test.setTimeout(180_000);
  const workspace = await launchFounderWorkspace();
  try {
    const { page } = workspace;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));

    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setTheme(page, theme);
      for (const route of routes) {
        await navigateFounderRoute(page, route);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
        if (route !== 'Settings') await expect(page.getByText(legacyHoldCopy, { exact: true })).toBeVisible();
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}`);
        await accessible(page, `${theme} ${route}`);
        // The app's actual minimum supported window is 1050x700.
        await page.setViewportSize({ width: 1050, height: 700 });
        await fitAndCapture(page, info, `${theme}-${route.toLowerCase()}-narrow`);
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Compact density', exact: true }).click();
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect(page.getByText(legacyHoldCopy, { exact: true })).toBeVisible();
      await fitAndCapture(page, info, `${theme}-today-compact-density`);
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Comfortable density', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');

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
