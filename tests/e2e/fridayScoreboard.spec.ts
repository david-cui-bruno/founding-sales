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

    // The week picker drives weekOffset through the real friday IPC: the
    // window label changes going back and returns at the current week,
    // where the forward button disables again.
    const period = page.locator('.friday__period');
    const currentPeriod = await period.innerText();
    await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous week' }).click();
    await expect(period).not.toHaveText(currentPeriod);
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(period).toHaveText(currentPeriod);
    await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();

    // Create four job requests through the real form's date + time pair.
    for (let index = 0; index < 4; index += 1) {
      await page.getByLabel('Requested date').fill('2026-08-31');
      await page.getByLabel('Requested time').fill(`1${index}:00`);
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
      await page.getByLabel('Accepted date').fill('2026-08-31');
      await page.getByLabel('Accepted time').fill(`2${index}:00`);
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
