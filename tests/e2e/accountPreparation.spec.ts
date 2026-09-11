import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from 'playwright/test';
import { launchFounderWorkspace, type FounderWorkspace } from '../support/founderWorkspace';

/**
 * Separate unmet AUTOMATED RESEARCH contract. The executable tests below cover
 * manually entered local companies only. They do not replace research/provider,
 * cohort quality, worker authority, or real-workspace activation acceptance.
 */
export const accountPreparationAcceptanceGap = Object.freeze({
  status: 'automated_research_entry_not_implemented',
  executableAutomatedResearchUiTests: 0,
  assembledSourceEvidence: 'tests/integration/accountPreparationWorkflow.test.ts',
  historicalSourceEvidence: 'tests/integration/accountMigrationPreservation.test.ts',
  requiredUserPath: [
    'Approve residential/regional PM audience and bounded durable research budget through real UI',
    'Discover via configured adapter and fetch official company pages through fictional external HTTP',
    'Restart after durable receipt, then show source-backed account in actual Today queue',
    'Open actual account detail and inspect published route, unknowns, and separate policy readiness',
    'Verify missing clearance refuses action without creating a Person or sending/calling',
    'Verify legacy callbacks, drafts, unknown sends and opt-outs remain visible and unchanged',
    'Preserve theme, density, selection and unsaved edits through the approved entry/navigation',
  ],
  separateGates: ['automated research entry presentation and implementation',
    'authorized real public-company cohort quality/cost review', 'real-workspace activation'],
} as const);

async function accounts(page: Page) {
  const snapshot = await page.evaluate(() => window.callie.localWorkspace.get());
  expect(snapshot.accounts.state).toBe('available');
  if (snapshot.accounts.state !== 'available') throw Error('Local account read unavailable');
  return snapshot.accounts.snapshots;
}
async function openIntake(page: Page, name: string, domain = '') {
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Company domain (optional)', exact: true }).fill(domain);
  await page.getByRole('button', { name: 'Review company', exact: true }).click();
}

test('real local company intake reviews, creates, reuses and reopens without fabricating research or worker authority', async () => {
  test.setTimeout(180_000);
  const first = await launchFounderWorkspace();
  let workspace: FounderWorkspace = first;
  const errors: string[] = [], requests: string[] = [];
  const observe = () => {
    workspace.page.on('pageerror', error => errors.push(error.message));
    workspace.page.on('request', request => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  };
  try {
    observe();
    let page = workspace.page;
    expect(await accounts(page)).toEqual([]);
    expect(await page.evaluate(() => window.callie.delegation.status())).toMatchObject({ state: 'unconfigured', workspaceId: null });
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'legacy', transitionReceipt: null });
    const initialCommitments = (await page.evaluate(() => window.callie.localWorkspace.getCommitments())).items;
    // First use must work from the fresh default mode, without a transition.
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await expect(page.getByText('Local account library', { exact: true })).toBeVisible();
    await openIntake(page, 'Harbor Test Management', 'harbor.example');
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeEnabled();
    expect(await accounts(page)).toEqual([]); // Review is not creation.
    await page.getByRole('button', { name: 'Create company', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Harbor Test Management', exact: true })).toBeVisible();
    const created = await accounts(page);
    expect(created).toHaveLength(1);
    expect(created[0].account).toMatchObject({ name: 'Harbor Test Management', domain: 'harbor.example', version: 1 });
    expect(created[0].claims).toEqual([]);
    expect(created[0].portfolio).toEqual([]);
    expect(created[0].routes).toEqual([]);
    await expect(page.getByText('Portfolio not recorded.', { exact: true })).toBeVisible();
    const accountId = created[0].account.id;
    expect(await page.evaluate(() => window.callie.localWorkspace.get())).toMatchObject({ workflowMode: 'legacy', transitionReceipt: null });
    expect((await page.evaluate(() => window.callie.localWorkspace.getCommitments())).items).toEqual(initialCommitments);
    expect(await page.evaluate(() => window.callie.delegation.status())).toMatchObject({ state: 'unconfigured', workspaceId: null });

    // The later supported transition is only inside the disposable fixture.
    // It must preserve the company created through the legacy/local-only entry.
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
    await page.getByRole('checkbox', { name: /one-way local change/i }).check();
    await page.getByRole('button', { name: 'Switch to Native Desk', exact: true }).click();
    await expect(page.getByText(/Native Desk is active/i)).toBeVisible();
    const transition = (await page.evaluate(() => window.callie.localWorkspace.get())).transitionReceipt;
    const commitments = (await page.evaluate(() => window.callie.localWorkspace.getCommitments())).items;
    expect(await accounts(page)).toEqual(created);
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();

    // A full-domain collision with a different name requires explicit reuse.
    await openIntake(page, 'Different Harbor Name', 'harbor.example');
    await expect(page.getByRole('button', { name: 'Open existing company', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).not.toBeEnabled();
    expect(await accounts(page)).toEqual(created);
    await page.getByRole('button', { name: 'Open existing company', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Harbor Test Management', exact: true })).toBeVisible();
    expect(await accounts(page)).toEqual(created);

    // No database seeding, debug hook, or write through page.evaluate.
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Local account · Harbor Test Management', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Harbor Test Management', exact: true })).toBeVisible();
    for (const size of [{ width: 1440, height: 900 }, { width: 1050, height: 700 }]) {
      await page.setViewportSize(size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`local-company-${size.width}.png`), animations: 'disabled' });
      const audit = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
      expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
    }
    await workspace.stop();
    workspace = await launchFounderWorkspace({ userDataPath: first.userDataPath });
    observe(); page = workspace.page;
    expect(await accounts(page)).toEqual(created);
    expect((await accounts(page))[0].account.id).toBe(accountId);
    expect((await page.evaluate(() => window.callie.localWorkspace.get())).transitionReceipt).toEqual(transition);
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Local account · Harbor Test Management', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Harbor Test Management', exact: true })).toBeVisible();
    await openIntake(page, '  HARBOR TEST MANAGEMENT  ');
    await expect(page.getByRole('button', { name: 'Open existing company', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open existing company', exact: true }).click();
    expect(await accounts(page)).toEqual(created);

    await openIntake(page, 'No Domain Test Management');
    await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Create company', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No Domain Test Management', exact: true })).toBeVisible();
    const final = await accounts(page);
    expect(final).toHaveLength(2);
    expect(final.find(item => item.account.id === accountId)).toEqual(created[0]);
    expect(final.find(item => item.account.name === 'No Domain Test Management')?.account.domain).toBeNull();
    expect(final.every(item => !item.claims.length && !item.routes.length && !item.portfolio.length)).toBe(true);
    expect((await page.evaluate(() => window.callie.localWorkspace.getCommitments())).items).toEqual(commitments);
    expect(await page.evaluate(() => window.callie.daily.get())).toMatchObject({ workspaceId: null, workflowMode: 'meeting_first', accounts: [], calls: { accountIds: [] }, answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [] });
    expect(await page.evaluate(() => window.callie.delegation.status())).toMatchObject({ state: 'unconfigured', workspaceId: null, configuration: null });
    expect(requests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await workspace.stop();
    await first.close();
  }
});
