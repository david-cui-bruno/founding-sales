import { expect, test } from 'playwright/test';

import {
  launchFounderWorkspace,
  workflowFixture,
} from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

test('CSV preview performs no writes; commit imports exactly once; relaunch preserves rows', async () => {
  const workspace = await launchFounderWorkspace();
  let userDataPath: string | undefined;

  try {
    const { page } = workspace;
    userDataPath = workspace.userDataPath;

    await page.getByRole('link', { name: 'Leads' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page
      .getByLabel('CSV file')
      .setInputFiles(workflowFixture('first-week-leads.csv'));
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await expect(page.getByText('3 rows ready')).toBeVisible();

    // Preview is read-only: the grid still shows no imported people.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Kevin Shin/ })).toHaveCount(0);

    // Full pass: preview again and commit once.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page
      .getByLabel('CSV file')
      .setInputFiles(workflowFixture('first-week-leads.csv'));
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await expect(page.getByText('3 rows ready')).toBeVisible();
    await page.getByRole('button', { name: 'Import 3 rows' }).click();
    await page.getByRole('dialog', { name: 'Import leads' }).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Import leads' })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Kevin Shin/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Maya Ortiz/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Dana Reyes/ })).toBeVisible();
  } finally {
    await workspace.stop();
  }

  // Relaunch against the same user-data directory: rows persist.
  const relaunched = await (
    await import('../support/founderWorkspace')
  ).launchFounderWorkspace({ userDataPath });

  try {
    const { page } = relaunched;
    await page.getByRole('link', { name: 'Leads' }).click();
    await expect(page.getByRole('row', { name: /Kevin Shin/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Maya Ortiz/ })).toBeVisible();
  } finally {
    await relaunched.close();
    const { rm } = await import('node:fs/promises');
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});
