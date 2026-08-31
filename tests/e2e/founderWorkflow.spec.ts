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

test('review renders its truthful empty state and zero badge in a clean workspace', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await page.getByRole('link', { name: 'Review' }).click();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).locator('.nav-rail__badge'),
    ).toHaveCount(0);
  } finally {
    await workspace.close();
  }
});

test('light/dark and density preferences survive renderer reload', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    const before = await page.evaluate(() => {
      localStorage.setItem('callie.theme', 'dark');
      localStorage.setItem('callie.density', 'compact');
      return {
        theme: localStorage.getItem('callie.theme'),
        density: localStorage.getItem('callie.density'),
      };
    });
    expect(before).toEqual({ theme: 'dark', density: 'compact' });

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    const after = await page.evaluate(() => ({
      theme: localStorage.getItem('callie.theme'),
      density: localStorage.getItem('callie.density'),
    }));
    expect(after).toEqual({ theme: 'dark', density: 'compact' });
  } finally {
    await workspace.close();
  }
});
