import { expect, test } from 'playwright/test';

import { launchSeededFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

test('logs a call, attaches a pasted transcript, and both survive relaunch', async () => {
  const workspace = await launchSeededFounderWorkspace();
  const { userDataPath } = workspace;

  try {
    const { page } = workspace;

    // Record a real call outcome through the packaged preload/domain boundary.
    // The imported fixture intentionally has unknown compliance evidence, so
    // initiating a new outbound call must remain disabled and fail closed.
    await page.getByRole('row', { name: /Kevin Shin/ }).click();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const list = await window.callie.leads.list({
        query: 'Kevin Shin', stages: [], priorities: [], sort: 'person_name',
        cursor: null, limit: 10,
      });
      const personId = list.rows[0]!.personId;
      const detail = await window.callie.leadDetail.get({ personId });
      await window.callie.today.logCallOutcome({
        personId,
        salesCycleId: detail.salesCycleId,
        outcome: 'spoke',
        callbackAt: null,
        occurredAt: new Date().toISOString(),
      });
    });
    await page.getByRole('button', { name: 'Close inspector' }).click();

    // The call shows up in the Conversations workspace.
    await navigateFounderRoute(page, 'Conversations');
    await page
      .getByRole('button', { name: /Kevin Shin/ })
      .first()
      .click();
    await expect(page.getByText('No transcript attached')).toBeVisible();

    // Attach a pasted transcript through the dialog.
    await page.getByRole('button', { name: 'Attach transcript' }).click();
    await page
      .getByLabel('Transcript text')
      .fill('me: Thanks for taking my call.\nKevin: Sure, what is this about?');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Attach/ })
      .click();
    await expect(page.getByText('Founder')).toBeVisible();
    await expect(
      page.getByText('Thanks for taking my call.'),
    ).toBeVisible();
  } finally {
    await workspace.stop();
  }

  // Relaunch against the same profile: the transcript persists.
  const relaunched = await (
    await import('../support/founderWorkspace')
  ).launchFounderWorkspace({ userDataPath });

  try {
    const { page } = relaunched;
    await navigateFounderRoute(page, 'Conversations');
    await page
      .getByRole('button', { name: /Kevin Shin/ })
      .first()
      .click();
    await expect(
      page.getByText('Thanks for taking my call.'),
    ).toBeVisible();
  } finally {
    await relaunched.close();
    const { rm } = await import('node:fs/promises');
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test('captures an evidence-backed learning that survives relaunch and retire', async () => {
  const workspace = await launchSeededFounderWorkspace();
  const { userDataPath } = workspace;

  try {
    const { page } = workspace;

    await navigateFounderRoute(page, 'Learnings');
    await page
      .getByRole('button', { name: 'Capture learning' })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Capture learning' });
    await dialog
      .getByLabel(/Statement/)
      .fill('Landlords lose days chasing plumbers for urgent repairs.');
    await dialog
      .getByLabel(/Evidence quote 1/)
      .fill('A burst pipe sat for four days last month.');
    await dialog.getByRole('button', { name: 'Save learning' }).click();

    await expect(
      page.getByText('Landlords lose days chasing plumbers for urgent repairs.'),
    ).toBeVisible();
  } finally {
    await workspace.stop();
  }

  const relaunched = await (
    await import('../support/founderWorkspace')
  ).launchFounderWorkspace({ userDataPath });

  try {
    const { page } = relaunched;
    await navigateFounderRoute(page, 'Learnings');
    await expect(
      page.getByText('Landlords lose days chasing plumbers for urgent repairs.'),
    ).toBeVisible();

    // Retire it and confirm the status change is reflected.
    await page.getByRole('button', { name: 'Retire' }).click();
    await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  } finally {
    await relaunched.close();
    const { rm } = await import('node:fs/promises');
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});
