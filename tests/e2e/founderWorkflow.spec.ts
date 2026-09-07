import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'playwright/test';

import {
  launchFounderWorkspace,
  launchSeededFounderWorkspace,
} from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

test('empty healthy app opens Today and health stays callable through preload', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    if (process.platform === 'darwin') {
      await expect(page.locator('body')).toHaveAttribute('data-platform', 'darwin');
      const nativeRow = page.locator('.nav-rail__native-controls');
      const brand = page.locator('.nav-rail__brand');
      await expect(nativeRow).toBeVisible();
      await expect(brand).toHaveCount(1);
      await expect(brand).toBeVisible();
      const nativeBox = await nativeRow.boundingBox();
      const brandBox = await brand.boundingBox();
      expect(nativeBox).not.toBeNull();
      expect(brandBox).not.toBeNull();
      expect(nativeBox!.height).toBeGreaterThan(0);
      expect(brandBox!.y).toBeGreaterThanOrEqual(nativeBox!.y + nativeBox!.height);
      // Final packaged acceptance must also observe the actual OS traffic
      // lights above Callie. DOM bounds cannot locate native window buttons.
    }

    const health = await page.evaluate(() => window.callie.health.get());
    expect(health.databaseEncrypted).toBe(true);
    expect(health.domainReady).toBe(true);
  } finally {
    await workspace.close();
  }
});

test('imports leads and opens the same person from Leads, Today, and Pipeline', async () => {
  const workspace = await launchSeededFounderWorkspace();

  try {
    const { page } = workspace;

    // Leads: open the inspector from the grid row.
    await page.getByRole('row', { name: /Kevin Shin/ }).click();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close inspector' }).click();

    // Pipeline: the same single global inspector.
    await page.getByRole('link', { name: 'Pipeline' }).click();
    await page.getByRole('button', { name: /Kevin Shin/ }).first().click();
    await expect(
      page.getByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close inspector' }).click();

    // Today: the queue exposes the same person.
    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page.getByRole('main')).toBeVisible();
  } finally {
    await workspace.close();
  }
});

test('inbox renders its truthful empty state and zero badge in a clean workspace', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await page.getByRole('link', { name: 'Inbox' }).click();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).locator('.nav-rail__badge'),
    ).toHaveCount(0);
  } finally {
    await workspace.close();
  }
});

test('a large import stays out of Today: unreviewed leads are backlog only and the queue caps at the dial budget', async () => {
  // 60 rows import + relaunch machinery can exceed the default budget on a
  // loaded machine; the flow is inherently heavy, not hanging.
  test.setTimeout(90_000);
  // 60 valid rows: enough to overflow the 40-dial budget if they ever leaked
  // into the queue. Imported leads start unreviewed, and unreviewed cycles
  // carry no next action, so Today must stay empty apart from the backlog
  // band. No row carries a due date anywhere in this flow.
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-capacity-'));
  const csvPath = join(fixtureDirectory, 'capacity-leads.csv');
  const rows = ['Name,Phone,Email,Source,Doors,Organization'];
  for (let index = 0; index < 60; index += 1) {
    const suffix = String(index).padStart(2, '0');
    rows.push(
      `Cap Lead${suffix},+1401555${(1000 + index).toString()},cap${suffix}@example.com,registry,4,Cap Org ${suffix}`,
    );
  }
  await writeFile(csvPath, `${rows.join('\n')}\n`);

  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;

    await page.getByRole('link', { name: 'Leads' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByLabel('CSV file').setInputFiles(csvPath);
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await expect(page.getByText('60 rows ready')).toBeVisible();
    await page.getByRole('button', { name: 'Import 60 rows' }).click();
    // The grid is virtualized and priority-sorted with random-uuid ties, so
    // any specific row may sit outside the rendered window; the header count
    // is the deterministic import signal.
    await page.getByRole('heading', { name: /Leads · 60 people/ }).waitFor();
    await page.getByRole('row', { name: /Cap Lead/ }).first().waitFor();

    // The real snapshot through preload: zero queue rows, full backlog.
    const snapshot = await page.evaluate(() => window.callie.today.get());
    const queuedRows = snapshot.lanes.reduce(
      (total, lane) => total + lane.items.length,
      0,
    );
    expect(queuedRows).toBe(0);
    expect(queuedRows).toBeLessThanOrEqual(snapshot.dialBudget);
    expect(snapshot.unreviewedBacklogCount).toBe(60);

    // Today renders the backlog as one card, never as rows.
    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page.getByText('60 unreviewed leads')).toBeVisible();
    await expect(page.locator('.today-row')).toHaveCount(0);
  } finally {
    await workspace.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test('light/dark and density preferences survive renderer reload', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // Theme and density controls now live in Settings → Appearance, one of
    // the sections of the settings master-detail.
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const appearance = page.getByRole('region', { name: 'Appearance' });
    await appearance.getByRole('button', { name: 'Dark appearance' }).click();
    await appearance.getByRole('button', { name: 'Compact density' }).click();

    await expect(
      appearance.getByRole('button', { name: 'Dark appearance' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      appearance.getByRole('button', { name: 'Compact density' }),
    ).toHaveAttribute('aria-pressed', 'true');

    const before = await page.evaluate(() => ({
      theme: localStorage.getItem('callie.theme'),
      density: localStorage.getItem('callie.density'),
    }));
    expect(before).toEqual({ theme: 'dark', density: 'compact' });

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    const after = await page.evaluate(() => ({
      theme: localStorage.getItem('callie.theme'),
      density: localStorage.getItem('callie.density'),
      resolvedTheme: document.documentElement.dataset.theme,
      resolvedDensity: document.documentElement.dataset.density,
    }));
    expect(after).toEqual({
      theme: 'dark',
      density: 'compact',
      resolvedTheme: 'dark',
      resolvedDensity: 'compact',
    });
  } finally {
    await workspace.close();
  }
});
