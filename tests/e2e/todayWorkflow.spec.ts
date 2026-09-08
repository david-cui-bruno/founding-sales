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

function waveCsv(count: number, source = 'registry'): string {
  const rows = ['Name,Phone,Email,Source,Doors,Organization'];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, '0');
    rows.push(
      `Wave Lead${suffix},+1401666${(2000 + index).toString()},wave${suffix}@example.com,${source},4,Wave Org ${suffix}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

test('call outcome flow: opening the lead page and saving a callback removes the lead across relaunch', async () => {
  test.setTimeout(180_000);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-today-call-'));
  const csvPath = join(fixtureDirectory, 'wave-leads.csv');
  await writeFile(csvPath, waveCsv(3));

  const workspace = await launchFounderWorkspace();
  const { userDataPath } = workspace;

  try {
    const { page } = workspace;
    await importLeads(page, csvPath, 3);

    // Optional manual review remains in explicit Details, never default Today.
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(3);
    await page.getByRole('searchbox', { name: 'Search leads' }).fill('Wave Lead00');
    await expect(page.getByRole('row', { name: /Wave Lead/ })).toHaveCount(1);
    await page.getByRole('row', { name: /Wave Lead00/ }).click();
    await page.keyboard.press('Enter');
    const reviewInspector = page.getByRole('complementary', { name: 'Wave Lead00 details' });
    await expect(reviewInspector.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await expect(reviewInspector.getByRole('button', { name: 'Mark ready' })).toHaveCount(0);
    await reviewInspector.locator('summary').filter({ hasText: /^Details$/ }).click();
    await reviewInspector.getByRole('button', { name: 'Founder manual controls' }).click();
    await reviewInspector.getByRole('button', { name: 'Mark ready' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(2);
    // Leads closes the inspector after reviewing the last matching row.
    await expect(page.getByRole('complementary')).toHaveCount(0);

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
    const queue = page.getByRole('list', { name: 'Work queue' });
    await expect(queue).toBeVisible();
    await expect(queue.getByRole('listitem')).toHaveCount(1);

    // Open the lead without initiating outbound. This fixture intentionally has
    // unknown compliance evidence, so actual Phone handoff must remain blocked.
    // The full-page outcome form records a call that already happened.
    await queue.getByRole('button', {
      name: readyLead.personName,
      exact: true,
    }).click();
    const inspector = page.getByRole('complementary', {
      name: `${readyLead.personName} details`,
    });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Call', exact: true })).toBeDisabled();
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    // The row Call action is navigation only, not a provider command.
    await queue.getByRole('button', { name: `Call ${readyLead.personName}`, exact: true }).click();
    const fullPage = page.locator('.lead-full-page');
    await expect(fullPage).toBeVisible();
    await expect(fullPage.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await expect(fullPage.getByRole('region', { name: 'Call outcome' })).toHaveCount(0);
    const beforeOutcome = await page.evaluate((personId) => window.callie.leadDetail.get({ personId }), readyLead.personId);
    expect(beforeOutcome.outboundAttempts).toEqual([]);
    expect(beforeOutcome.activities.filter(activity => activity.kind === 'call')).toEqual([]);
    await fullPage.getByRole('tab', { name: 'Activity', exact: true }).click();
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
    await expect(page.getByText('No contacts due right now.', { exact: true })).toBeVisible();
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
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(2);
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

/** Only lifecycle/outbound state, not asynchronously refreshed research projections. */
async function readLeadState(page: import('playwright/test').Page) {
  return page.evaluate(async () => {
    const list = await window.callie.leads.list({
      query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 100,
    });
    return Promise.all(list.rows.map(async ({ personId }) => {
      const detail = await window.callie.leadDetail.get({ personId });
      return {
        personId, salesCycleId: detail.salesCycleId, stage: detail.stage,
        workflowStatus: detail.workflowStatus, optedOut: detail.optedOut,
        nextAction: detail.nextAction, cadence: detail.cadence,
        activities: detail.activities, history: detail.history,
        outboundAttempts: detail.outboundAttempts,
      };
    }));
  });
}

test('warm contact selection and Details stay read-only and preserve dated work across relaunch', async () => {
  test.setTimeout(180_000);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'callie-today-contacts-'));
  const csvPath = join(fixtureDirectory, 'wave-leads.csv');
  await writeFile(csvPath, waveCsv(6, 'referral'));

  const workspace = await launchFounderWorkspace();
  const { userDataPath } = workspace;
  let before: Awaited<ReturnType<typeof readLeadState>> = [];

  try {
    const { page } = workspace;
    await importLeads(page, csvPath, 6);
    before = await readLeadState(page);
    expect(before).toHaveLength(6);
    for (const detail of before) {
      expect(detail.stage).toBe('unreviewed');
      expect(detail.nextAction?.dueAt).toEqual(expect.any(String));
      expect(detail.outboundAttempts).toEqual([]);
    }

    await page.getByRole('link', { name: 'Today' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(6);
    await expect(page.getByRole('heading', { name: 'Contacts due', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manual review (optional)', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh shortlist', exact: true })).toHaveCount(0);
    const queue = page.getByRole('list', { name: 'Work queue' });
    await expect(queue).toHaveCount(1);
    await expect(queue.getByRole('listitem')).toHaveCount(6);
    const first = queue.getByRole('listitem').first();
    const second = queue.getByRole('listitem').nth(1);
    const firstName = await first.getAttribute('aria-label');
    const secondName = await second.getAttribute('aria-label');
    await first.focus();
    await page.keyboard.press('Enter');
    let inspector = page.getByRole('complementary', { name: `${firstName} details` });
    await expect(inspector.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Email', exact: true })).toHaveCount(1);
    await inspector.locator('summary').filter({ hasText: /^Details$/ }).click();
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toBeVisible();
    expect(await readLeadState(page)).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    inspector = page.getByRole('complementary', { name: `${secondName} details` });
    await expect(inspector.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toHaveCount(0);
    expect(await readLeadState(page)).toEqual(before);
  } finally {
    await workspace.stop();
  }

  // Relaunch preserves every internal dated action, without implicit review or outreach.
  const relaunched = await launchFounderWorkspace({ userDataPath });
  try {
    const { page } = relaunched;
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect.poll(async () => (await page.evaluate(() => window.callie.today.get())).unreviewedBacklogCount).toBe(6);
    await expect(page.getByRole('list', { name: 'Work queue' }).getByRole('listitem')).toHaveCount(6);
    expect(await readLeadState(page)).toEqual(before);
  } finally {
    await relaunched.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});
