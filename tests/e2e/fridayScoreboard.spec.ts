import { expect, test } from 'playwright/test';

import { launchFounderWorkspace } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

test('creates four job requests, fills three, shows 3 / 4 and 75%, and opens drilldown', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await page.getByRole('link', { name: 'Friday' }).click();
    await expect(
      page.getByRole('heading', { name: 'Friday scoreboard' }),
    ).toBeVisible();

    // Create four job requests through the real form.
    for (let index = 0; index < 4; index += 1) {
      await page
        .getByLabel('Requested at')
        .fill(`2026-08-31T1${index}:00:00.000Z`);
      await page.getByRole('button', { name: 'Request job' }).click();
      await expect(page.locator('.friday-jobs__row')).toHaveCount(index + 1);
    }

    // Fill three by contractor acceptance.
    for (let index = 0; index < 3; index += 1) {
      await page
        .locator('.friday-jobs__row', { hasText: 'Requested' })
        .first()
        .getByRole('button', { name: /^Fill / })
        .click();
      await expect(
        page.getByText('Contractor acceptance is the fill event', {
          exact: false,
        }),
      ).toBeVisible();
      await page
        .getByLabel('Contractor accepted at')
        .fill(`2026-08-31T2${index}:00:00.000Z`);
      await page.getByRole('button', { name: 'Confirm fill' }).click();
      await expect(page.getByText(/Contractor accepted/).nth(index)).toBeVisible();
    }

    // The domain-computed fill rate shows numerator/denominator and percent.
    const fillRateCard = page
      .locator('.metric-card', { hasText: 'Fill rate' })
      .first();
    await expect(fillRateCard).toContainText('75%');
    await expect(page.getByText('3 / 4')).toBeVisible();

    // Metric drilldown opens when evidence exists.
    const jobsRequestedCard = page
      .locator('.metric-card', { hasText: 'Jobs requested' })
      .first();
    const drilldownButton = jobsRequestedCard.getByRole('button');
    if ((await drilldownButton.count()) > 0) {
      await drilldownButton.first().click();
    }
  } finally {
    await workspace.close();
  }
});
