import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'playwright/test';

import { launchFounderWorkspace } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

/** Imports `count` leads through the real UI and closes the import dialog. */
async function importLeads(
  page: import('playwright/test').Page,
  csvPath: string,
  count: number,
): Promise<void> {
  await page.getByRole('link', { name: 'Leads' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByLabel('CSV file').setInputFiles(csvPath);
  await page.getByRole('button', { name: 'Preview rows' }).click();
  await expect(page.getByText(`${count} rows ready`)).toBeVisible();
  await page.getByRole('button', { name: `Import ${count} rows` }).click();
  await page.getByRole('row', { name: /Wave Lead00/ }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

function waveCsv(count: number): string {
  const rows = ['Name,Phone,Email,Source,Doors,Organization'];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, '0');
    rows.push(
      `Wave Lead${suffix},+1401666${(2000 + index).toString()},wave${suffix}@example.com,registry,4,Wave Org ${suffix}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

test('call flow: Enter opens the lead page, outcome + callback removes the lead from Today across relaunch', async () => {
  test.setTimeout(180_000);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-today-call-'));
  const csvPath = join(fixtureDirectory, 'wave-leads.csv');
  await writeFile(csvPath, waveCsv(3));

  const workspace = await launchFounderWorkspace();
  const { userDataPath } = workspace;

  try {
    const { page } = workspace;
    await importLeads(page, csvPath, 3);

    // Triage one lead to Ready through the real triage mode (R-key surface).
    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page.getByText('3 unreviewed leads')).toBeVisible();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText('Reviewing 1 of 3')).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.getByText('Reviewing 2 of 3')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('2 unreviewed leads')).toBeVisible();

    // The freshly ready lead's first cadence touch is discretionary work
    // that waits on a priority projection; simulate the inbound reply that
    // makes it promised work (Fresh inbound) through the real preload
    // complete command.
    const readyLead = await page.evaluate(async () => {
      const list = await window.callie.leads.list({
        query: '', stages: ['ready'], priorities: [], sort: 'person_name',
        cursor: null, limit: 10,
      });
      const row = list.rows[0]!;
      const detail = await window.callie.leadDetail.get({ personId: row.personId });
      await window.callie.today.complete({
        salesCycleId: detail.salesCycleId,
        actionId: detail.nextAction!.id,
        outcome: 'replied',
        activityId: null,
      });
      return { personId: row.personId, personName: row.personName };
    });

    // Remount Today so the route refetches after the preload-side write.
    await page.getByRole('link', { name: 'Leads' }).click();
    await page.getByRole('link', { name: 'Today' }).click();
    const nextUp = page.getByRole('group', { name: /^Next up:/ });
    await expect(nextUp).toBeVisible();

    // Enter on the focused Next up card logs the call and opens the page.
    await nextUp.focus();
    await page.keyboard.press('Enter');
    const fullPage = page.locator('.lead-full-page');
    await expect(fullPage).toBeVisible();
    await expect(
      fullPage.getByRole('region', { name: 'Call outcome' }),
    ).toBeVisible();

    // Outcome: Spoke, plus a promised callback one week out.
    await fullPage.getByRole('button', { name: 'Spoke' }).click();
    const callbackDate = new Date(Date.now() + 7 * 86_400_000);
    const iso = callbackDate.toISOString().slice(0, 10);
    await fullPage.getByLabel('Callback promised').fill(iso);
    await fullPage.getByRole('button', { name: 'Save & next' }).click();

    // The queue held nothing else: back on Today with the queue done.
    await expect(page.locator('.lead-full-page')).toHaveCount(0);
    await expect(page.getByText(/Queue done · /)).toBeVisible();
    await expect(page.locator('.today-row')).toHaveCount(0);

    // The real snapshot agrees: the called lead left every lane.
    const snapshot = await page.evaluate(() => window.callie.today.get());
    const laneMembers = snapshot.lanes.flatMap((lane) =>
      lane.items.map((item) => item.personId),
    );
    expect(laneMembers).not.toContain(readyLead.personId);
    expect(snapshot.conversationsHeld).toBe(1);
  } finally {
    await workspace.stop();
  }

  // Relaunch: the callback promise keeps the lead out of Today until its date.
  const relaunched = await launchFounderWorkspace({ userDataPath });
  try {
    const { page } = relaunched;
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText('2 unreviewed leads')).toBeVisible();
    await expect(page.locator('.today-row')).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.callie.today.get());
    const laneMembers = snapshot.lanes.flatMap((lane) =>
      lane.items.map((item) => item.salesCycleId),
    );
    expect(laneMembers).toHaveLength(0);
  } finally {
    await relaunched.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test('triage mode: 1/2/3 decisions advance the counter and the position resumes across relaunch', async () => {
  test.setTimeout(180_000);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-today-triage-'));
  const csvPath = join(fixtureDirectory, 'wave-leads.csv');
  await writeFile(csvPath, waveCsv(6));

  const workspace = await launchFounderWorkspace();
  const { userDataPath } = workspace;

  try {
    const { page } = workspace;
    await importLeads(page, csvPath, 6);

    await page.getByRole('link', { name: 'Today' }).click();
    await expect(page.getByText('6 unreviewed leads')).toBeVisible();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText('Reviewing 1 of 6')).toBeVisible();

    // 1 = Ready (confirm-ready transition).
    await page.keyboard.press('1');
    await expect(page.getByText('Reviewing 2 of 6')).toBeVisible();

    // 2 = Later (+30d resurface).
    await page.keyboard.press('2');
    await expect(page.getByText('Reviewing 3 of 6')).toBeVisible();

    // 3 = Not a fit: requires picking through the dismissal Select.
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: 'Confirm dismiss' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm dismiss' }).click();
    await expect(page.getByText('Reviewing 4 of 6')).toBeVisible();

    // Esc exits saving the position. Ready and Dismiss leave the backlog;
    // the Later lead stays unreviewed (it resurfaces in 30 days), so the
    // card honestly counts 4.
    await page.keyboard.press('Escape');
    await expect(page.getByText('4 unreviewed leads')).toBeVisible();
  } finally {
    await workspace.stop();
  }

  // Relaunch: the pass resumes exactly where the founder left it.
  const relaunched = await launchFounderWorkspace({ userDataPath });
  try {
    const { page } = relaunched;
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText('4 unreviewed leads')).toBeVisible();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText('Reviewing 4 of 6')).toBeVisible();
  } finally {
    await relaunched.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});
