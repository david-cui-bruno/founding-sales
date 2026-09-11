import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

import { expectCleanInboxReadyZero, launchFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

type ThemeCase = { theme: 'light' | 'dark'; width: 1440 | 1050; height: 900 | 700 };
const cases: readonly ThemeCase[] = [
  { theme: 'light', width: 1440, height: 900 },
  { theme: 'dark', width: 1050, height: 700 },
];

const makeRows = (): string[] => {
  const rows = ['Name,Phone,Email,Source,Segment,Doors,Organization'];
  for (let index = 1; index <= 208; index += 1) {
    const serial = String(index).padStart(3, '0');
    rows.push(`Reliability Person ${serial},+1415555${String(1000 + index)},reliability-${serial}@example.test,custom,cold,${3 + (index % 7)},Reliability Org ${serial}`);
  }
  return rows;
};

async function setThemeBeforeLeads(page: Page, theme: ThemeCase['theme']) {
  await navigateFounderRoute(page, 'Settings');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('region', { name: 'Appearance', exact: true })
    .getByRole('button', { name: theme === 'light' ? 'Light appearance' : 'Dark appearance', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function importRows(page: Page, csvPath: string) {
  await navigateFounderRoute(page, 'Leads');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
  await dialog.getByLabel('CSV file').setInputFiles(csvPath);
  await dialog.getByRole('button', { name: 'Preview rows', exact: true }).click();
  await expect(dialog.getByText('208 rows ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 208 rows', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();
}

async function readAllReliabilityDetails(page: Page) {
  return page.evaluate(async () => {
    const first = await window.callie.leads.list({ query: 'Reliability Person', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 200 });
    if (first.rows.length !== 200 || first.total !== 208 || first.nextCursor === null) {
      throw new Error(`Unexpected first readback page: ${first.rows.length}/${first.total}/${first.nextCursor}`);
    }
    const second = await window.callie.leads.list({ query: 'Reliability Person', stages: [], priorities: [], sort: 'person_name', cursor: first.nextCursor, limit: 200 });
    if (second.rows.length !== 8 || second.total !== 208 || second.nextCursor !== null) {
      throw new Error(`Unexpected second readback page: ${second.rows.length}/${second.total}/${second.nextCursor}`);
    }
    const rows = [...first.rows, ...second.rows];
    return Promise.all(rows.map(row => window.callie.leadDetail.get({ personId: row.personId })));
  });
}

for (const scenario of cases) {
  test(`packaged ${scenario.theme} fresh profile imports 208, reaches row 208 by keyboard, mutates an exact selected pair, and keeps Inbox zero`, async () => {
    test.setTimeout(240_000);
    const fixtureDirectory = await mkdtemp(join(tmpdir(), `callie-reliability-208-${scenario.theme}-`));
    const csvPath = join(fixtureDirectory, 'reliability-208.csv');
    await writeFile(csvPath, `${makeRows().join('\n')}\n`);
    const workspace = await launchFounderWorkspace();

    try {
      const { page } = workspace;
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await setThemeBeforeLeads(page, scenario.theme);
      await importRows(page, csvPath);
      await expect(page.getByRole('heading', { name: /^Leads\s*·\s*208 people$/ })).toBeVisible();

      const sort = page.getByRole('combobox', { name: 'Sort leads', exact: true });
      await sort.click();
      await page.getByRole('option', { name: 'Name', exact: true }).click();
      await expect(page.getByText('Showing 200 of 208', { exact: true })).toBeVisible();
      await expect(page.getByRole('grid', { name: 'Leads', exact: true })).toHaveAttribute('aria-rowcount', '201');
      const firstRow = page.getByRole('row', { name: /Reliability Person 001/ });
      await expect(firstRow).toBeVisible();
      await expect(firstRow).toHaveAttribute('data-person-id', /.+/);
      await expect(firstRow).toHaveAttribute('aria-rowindex', '2');
      const firstPersonId = await firstRow.getAttribute('data-person-id');
      await page.getByRole('checkbox', { name: 'Select Reliability Person 001', exact: true }).check();
      await expect(page.getByRole('toolbar', { name: 'Bulk actions', exact: true })).toContainText('1 selected');

      await page.getByRole('button', { name: 'Load more', exact: true }).click();
      await expect(page.getByText('Showing 208 of 208', { exact: true })).toBeVisible();
      await expect(page.getByRole('grid', { name: 'Leads', exact: true })).toHaveAttribute('aria-rowcount', '209');
      let activeRow = page.getByRole('row', { name: /Reliability Person 001/ });
      await activeRow.focus();
      for (let index = 0; index < 207; index += 1) {
        await page.keyboard.press('ArrowDown');
        const serial = String(index + 2).padStart(3, '0');
        await expect(page.getByRole('row', { name: new RegExp(`Reliability Person ${serial}`) })).toBeFocused();
      }
      activeRow = page.getByRole('row', { name: /Reliability Person 208/ });
      await expect(activeRow).toBeFocused();
      await expect(activeRow).toHaveAttribute('data-person-id', /.+/);
      await expect(activeRow).toHaveAttribute('aria-rowindex', '209');
      const lastPersonId = await activeRow.getAttribute('data-person-id');
      expect(lastPersonId).not.toBe(firstPersonId);
      await page.keyboard.press('Enter');
      const inspector = page.getByRole('complementary', { name: 'Reliability Person 208 details', exact: true });
      await expect(inspector).toBeVisible();
      const details = inspector.locator('summary').filter({ hasText: /^Details$/ });
      if (await details.isVisible()) await details.click();
      await expect(inspector).toContainText('Reliability Org 208');
      await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();

      await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill('Reliability Person 208');
      await expect(page.getByRole('row', { name: /Reliability Person 208/ })).toBeVisible();
      await page.getByRole('checkbox', { name: 'Select Reliability Person 208', exact: true }).check();
      const bulk = page.getByRole('toolbar', { name: 'Bulk actions', exact: true });
      await expect(bulk).toContainText('2 selected · 1 outside view');
      await page.screenshot({ path: test.info().outputPath(`reliability-leads-selected-pair-${scenario.theme}-${scenario.width}.png`), animations: 'disabled' });

      await bulk.getByRole('button', { name: 'Set organization', exact: true }).click();
      await bulk.getByRole('textbox', { name: 'Organization for 2 selected', exact: true }).fill(`Reliability Mutated Pair ${scenario.theme.toUpperCase()} LLC`);
      await bulk.getByRole('button', { name: 'Save organization', exact: true }).click();
      await expect(page.getByText('Saved', { exact: true })).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Bulk actions', exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: /^Organization for 2 selected$/ })).toHaveCount(0);

      const readback = await readAllReliabilityDetails(page);
      expect(readback).toHaveLength(208);
      expect(new Set(readback.map(detail => detail.personId)).size).toBe(208);
      expect(new Set(readback.map(detail => detail.personName)).size).toBe(208);
      const changed = readback.filter(detail => detail.organizationLabel === `Reliability Mutated Pair ${scenario.theme.toUpperCase()} LLC`);
      expect(changed.map(detail => detail.personName).sort()).toEqual(['Reliability Person 001', 'Reliability Person 208']);
      const unchanged = readback.filter(detail => detail.organizationLabel !== `Reliability Mutated Pair ${scenario.theme.toUpperCase()} LLC`);
      expect(unchanged).toHaveLength(206);
      for (const detail of unchanged) {
        const serial = detail.personName.replace('Reliability Person ', '');
        expect(detail.organizationLabel).toBe(`Reliability Org ${serial}`);
      }

      await expectCleanInboxReadyZero(page);
      await expect(page.getByText('Open local lifecycle reviews. Other review sources are not integrated into this Inbox.', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: /^Unmatched communications\s+0$/ })).toBeVisible();
      for (const label of ['Ambiguous identities', 'Transcript suggestions', 'Import problems', 'Adapter failures'] as const) {
        await page.getByRole('tab', { name: new RegExp(`^${label}\\s+Not available in this Inbox$`) }).click();
        const clear = page.locator('.review-queue__clear');
        await expect(clear.getByText('Not available in this Inbox', { exact: true })).toBeVisible();
        await expect(clear.getByText('This source is not integrated into this local Inbox. No count or health conclusion is available.', { exact: true })).toBeVisible();
      }
    } finally {
      await workspace.close();
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
}
