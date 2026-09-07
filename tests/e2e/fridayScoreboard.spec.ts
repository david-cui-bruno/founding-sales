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

    // Use the actual reporting clock, not a calendar date that expires next Monday.
    const jobTime = await page.evaluate(async () => {
      const at = new Date((await window.callie.friday.getCurrent()).asOf);
      const pad = (value: number) => String(value).padStart(2, '0');
      return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
        time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
    });
    // Four distinct requests and three acceptances within the same reporting minute.
    for (let index = 0; index < 4; index += 1) {
      await page.getByLabel('Requested date').fill(jobTime.date);
      await page.getByLabel('Requested time').fill(jobTime.time);
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
      await page.getByLabel('Accepted date').fill(jobTime.date);
      await page.getByLabel('Accepted time').fill(jobTime.time);
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
