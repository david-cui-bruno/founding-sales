import { expect, test, type Page } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { launchFounderWorkspace, type FounderWorkspace } from '../support/founderWorkspace';

async function openPerson(page: Page, name: string) {
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('row', { name: new RegExp(name) }).click();
  const inspector = page.getByRole('complementary', { name: `${name} details`, exact: true });
  await expect(inspector.getByRole('region', { name: 'Known portfolio', exact: true })).toBeVisible();
  return inspector;
}

test('contact-first workspace keeps edits across people and real process restart without sending or moving lifecycle', async () => {
  test.setTimeout(150_000);
  const info = test.info();
  const first = await launchFounderWorkspace();
  let workspace: FounderWorkspace = first;
  try {
    let page = workspace.page;
    await page.getByRole('link', { name: 'Leads', exact: true }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    // Manual CSV source labels do not assign segments. Declare the intended
    // segments explicitly through the real importer rather than assume them.
    await page.getByLabel('CSV file').setInputFiles({ name: 'explicit-contact-segments.csv', mimeType: 'text/csv', buffer: Buffer.from([
      'Name,Phone,Email,Segment,Organization',
      'Kevin Shin,+14015550101,kevin@example.com,hot,Shin Holdings LLC',
      'Maya Ortiz,+14015550102,maya@example.com,warm,Ortiz Property Group',
      'Dana Reyes,+14015550103,dana@example.com,cold,Reyes Realty',
    ].join('\n')) });
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await expect(page.getByText('3 rows ready')).toBeVisible();
    await page.getByRole('button', { name: 'Import 3 rows' }).click();
    const importDialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
    await importDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(importDialog).toBeHidden();
    const people = await page.evaluate(() => window.callie.leads.list({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 20 }));
    expect(people.rows).toHaveLength(3);
    const kevin = people.rows.find(row => row.personName === 'Kevin Shin')!;
    const before = await page.evaluate(personId => window.callie.leadDetail.get({ personId }), kevin.personId);
    expect(before.segment).toBe('hot');
    const maya = people.rows.find(row => row.personName === 'Maya Ortiz')!;
    expect((await page.evaluate(personId => window.callie.leadDetail.get({ personId }), maya.personId)).segment).toBe('warm');
    expect((await page.evaluate(() => window.callie.outreach.status())).gmail).toBe('unconfigured');
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page.getByText('Prepared conversations', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh shortlist', exact: true })).toHaveCount(0);
    await expect(page.getByText('Do you handle maintenance yourself or use a property manager?', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Work queue', exact: true }).getByRole('button', { name: 'Maya Ortiz', exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Work queue', exact: true }).getByRole('button', { name: 'Kevin Shin', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('warm-contact-queue.png'), animations: 'disabled' });

    let inspector = await openPerson(page, 'Kevin Shin');
    const actions = inspector.getByRole('region', { name: 'Contact actions', exact: true });
    await expect(actions.getByRole('button')).toHaveCount(2);
    await expect(inspector.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toHaveCount(0);
    await actions.getByRole('button', { name: 'Email', exact: true }).click();
    await expect(inspector.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
    await inspector.getByRole('textbox', { name: 'Subject', exact: true }).fill('A reviewed fictional introduction');
    await inspector.getByRole('textbox', { name: 'Message', exact: true }).fill('Kevin-only saved draft. This fixture must never send.');
    await expect(inspector.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await inspector.getByRole('button', { name: 'Close draft', exact: true }).click();
    await expect(inspector.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();

    inspector = await openPerson(page, 'Maya Ortiz');
    await inspector.getByRole('button', { name: 'Email', exact: true }).click();
    await expect(inspector.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await expect(inspector.getByText('maya@example.com', { exact: true }).last()).toBeVisible();
    await inspector.getByRole('button', { name: 'Close draft', exact: true }).click();
    await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();

    await workspace.stop();
    workspace = await launchFounderWorkspace({ userDataPath: first.userDataPath });
    page = workspace.page;
    for (const theme of ['light', 'dark'] as const) {
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.getByRole('button', { name: `${theme === 'light' ? 'Light' : 'Dark'} appearance`, exact: true }).click();
      inspector = await openPerson(page, 'Kevin Shin');
      await inspector.getByRole('button', { name: 'Email', exact: true }).click();
      await expect(inspector.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue('A reviewed fictional introduction');
      await expect(inspector.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Kevin-only saved draft. This fixture must never send.');
      await expect(inspector.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
      for (const width of [1440, 1050]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${theme}-email-${width}.png`), animations: 'disabled' });
      }
      await inspector.getByRole('button', { name: 'Close draft', exact: true }).click();
      await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();
    }
    const after = await page.evaluate(personId => window.callie.leadDetail.get({ personId }), kevin.personId);
    expect({ stage: after.stage, activities: after.activities, history: after.history, nextAction: after.nextAction })
      .toEqual({ stage: before.stage, activities: before.activities, history: before.history, nextAction: before.nextAction });
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Google Desktop client secret', { exact: true })).toHaveValue('');
    await expect(page.getByText(/AI: unconfigured\. Gmail: unconfigured/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('connections-unconfigured.png'), animations: 'disabled' });
  } catch (error) {
    const path = info.outputPath('contact-workspace-failure.txt');
    await writeFile(path, await workspace.page.locator('body').ariaSnapshot());
    await info.attach('contact-workspace-failure', { path, contentType: 'text/plain' });
    throw error;
  } finally {
    await workspace.stop();
    await first.close();
  }
});
