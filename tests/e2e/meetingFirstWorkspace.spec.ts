import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from 'playwright/test';
import { launchFounderWorkspace, type FounderWorkspace } from '../support/founderWorkspace';
import { allocatePackagedFixtureDatabase } from '../support/packagedFixtureDatabase';

/**
 * Exact release-candidate coverage for the unpaired boundary, not a fabricated
 * paired workspace. Positive account/draft/meeting rendering has separate
 * real-source fixture tests. Do not infer trusted scope from seeded SQL, forge a
 * pairing, relax TLS, or change release fuses to turn that boundary green.
 */
test('unpaired daily workspace stays empty and read-only through navigation and restart', async () => {
  test.setTimeout(150_000);
  const first = await launchFounderWorkspace();
  let workspace: FounderWorkspace = first;
  const pageErrors: string[] = [];
  const rendererHttpRequests: string[] = [];
  const observe = () => {
    workspace.page.on('pageerror', error => pageErrors.push(error.message));
    workspace.page.on('request', request => {
      if (/^https?:/u.test(request.url())) rendererHttpRequests.push(request.url());
    });
  };
  try {
    observe();
    const before = await workspace.page.evaluate(() => window.callie.daily.get());
    expect(before).toMatchObject({
      workspaceId: null,
      workflowMode: 'legacy',
      freshness: { kind: 'incomplete', remote: 'unknown' },
      accounts: [], calls: { accountIds: [], workloadConflict: false },
      answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [],
    });
    expect(before.issues).toContainEqual({ code: 'scope_unknown', count: 1 });
    expect(await workspace.page.evaluate(() => window.callie.delegation.status()))
      .toMatchObject({ state: 'unconfigured', workspaceId: null, configuration: null });

    for (const theme of ['light', 'dark'] as const) {
      const page = workspace.page;
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.getByRole('button', { name: `${theme === 'light' ? 'Light' : 'Dark'} appearance`, exact: true }).click();
      for (const route of ['Accounts', 'Campaigns'] as const) {
        await page.getByRole('link', { name: route, exact: true }).click();
        await expect(page.getByRole('heading', { name: route, exact: true })).toBeVisible();
        // A visit must not bootstrap account identity or borrow prototype records.
        expect((await page.evaluate(() => window.callie.daily.get())).revision).toBe(before.revision);
        for (const size of [{ width: 1440, height: 900 }, { width: 1050, height: 700 }]) {
          await page.setViewportSize(size);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await page.screenshot({ path: test.info().outputPath(`${route.toLowerCase()}-${theme}-${size.width}.png`), animations: 'disabled' });
          // Electron CDP cannot create Axe's helper target. Audit the existing
          // renderer, matching every other packaged accessibility suite.
          const audit = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
          expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
        }
      }
    }

    await workspace.page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(workspace.page.getByText('No contacts due right now.', { exact: true })).toBeVisible();
    expect((await workspace.page.evaluate(() => window.callie.daily.get())).revision).toBe(before.revision);
    await workspace.stop();
    workspace = await launchFounderWorkspace({ userDataPath: first.userDataPath });
    observe();
    const restarted = await workspace.page.evaluate(() => window.callie.daily.get());
    expect(restarted.revision).toBe(before.revision);
    expect(restarted.workflowMode).toBe('legacy');
    expect(await workspace.page.evaluate(() => window.callie.delegation.status()))
      .toMatchObject({ state: 'unconfigured', workspaceId: null, configuration: null });
    expect(rendererHttpRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await workspace.stop();
    await first.close();
  }
});

test('explicit local transition preserves a real callback and local account without paired authority through restart', async () => {
  test.setTimeout(180_000);
  const fixtures = allocatePackagedFixtureDatabase();
  let workspace: FounderWorkspace | undefined;
  let material = '';
  const pageErrors: string[] = [], rendererHttpRequests: string[] = [];
  const observe = (current: FounderWorkspace) => {
    current.page.on('pageerror', error => pageErrors.push(error.message));
    current.page.on('request', request => { if (/^https?:/u.test(request.url())) rendererHttpRequests.push(request.url()); });
  };
  try {
    workspace = await launchFounderWorkspace({ userDataPath: fixtures.paths.bootstrap, onSpawn: child => { fixtures.captureChild(child); } });
    material = await workspace.page.evaluate(async () => (await window.callie.recovery.beginSetup({ founderConfirmed: true })).material);
    await workspace.stop(); workspace = undefined;
    await fixtures.captureBootstrapEnvelope();
    const seeded = await fixtures.createLocalWorkspaceProfile(material);
    material = '';
    const launch = () => launchFounderWorkspace({ userDataPath: fixtures.paths.current, onSpawn: child => { fixtures.captureChild(child); } });
    workspace = await launch(); observe(workspace);
    const page = workspace.page;
    expect(await page.evaluate(() => typeof window.callie.localWorkspace?.get)).toBe('function');
    const before = await page.evaluate(() => window.callie.localWorkspace.get());
    expect(before).toMatchObject({ scope: 'local_database', workflowMode: 'legacy', transitionReceipt: null,
      accounts: { state: 'available', snapshots: [{ account: { id: seeded.accountId } }] } });
    const beforeWork = await page.evaluate(() => window.callie.localWorkspace.getCommitments());
    expect(beforeWork.items).toHaveLength(1);
    expect(beforeWork.items[0]).toMatchObject({ kind: 'callback', item: { personId: seeded.personId,
      salesCycleId: seeded.salesCycleId, action: { id: seeded.actionId, dueAt: seeded.callbackAt } } });
    const detailBefore = await page.evaluate(personId => window.callie.leadDetail.get({personId}), seeded.personId);

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Switch to Native Desk', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: /one-way local change/i }).check();
    await page.getByRole('button', { name: 'Switch to Native Desk', exact: true }).click();
    await expect(page.getByText(/Native Desk is active/i)).toBeVisible();
    const applied = await page.evaluate(() => window.callie.localWorkspace.get());
    expect(applied.workflowMode).toBe('meeting_first');
    expect(applied.transitionReceipt).not.toBeNull();
    expect(applied.transitionReceipt!.callbackEvidenceIds).toHaveLength(1);
    expect(applied.transitionReceipt!.preservedActionIds).toContain(seeded.actionId);
    expect(applied.transitionReceipt!.parkedReviewActions.some(action => action.cycleId === seeded.automaticCycleId)).toBe(true);

    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Retained callback Property Owner/ }).click();
    await expect(page.getByRole('button', { name: 'Open contact workspace', exact: true })).toBeVisible();
    await expect(page.getByText(/Old acquisition Property Owner/)).toHaveCount(0);
    for (const size of [{ width: 1440, height: 900 }, { width: 1050, height: 700 }]) {
      await page.setViewportSize(size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`retained-local-${size.width}.png`), animations: 'disabled' });
      const audit = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
      expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
    }
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await expect(page.getByText('Local account library', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Fixture Residential Management/ }).click();
    await expect(page.getByRole('heading', { name: 'Fixture Residential Management', exact: true })).toBeVisible();
    const daily = await page.evaluate(() => window.callie.daily.get());
    expect(daily).toMatchObject({workspaceId: null, workflowMode: 'meeting_first', accounts: [], answers: [],
      calls: {accountIds: []}, meetings: [], campaigns: [], ownerStatus: [], transport: []});
    expect(await page.evaluate(() => window.callie.delegation.status())).toMatchObject({ state: 'unconfigured', workspaceId: null });
    const detailAfter = await page.evaluate(personId => window.callie.leadDetail.get({personId}), seeded.personId);
    expect(detailAfter.activities).toEqual(detailBefore.activities);
    expect(detailAfter.nextAction).toEqual(detailBefore.nextAction);
    expect((await page.evaluate(() => window.callie.localWorkspace.getCommitments())).items).toEqual(beforeWork.items);

    await workspace.stop(); workspace = undefined;
    workspace = await launch(); observe(workspace);
    const reopened = await workspace.page.evaluate(() => window.callie.localWorkspace.get());
    expect(reopened.transitionReceipt).toEqual(applied.transitionReceipt);
    expect(reopened.accounts).toMatchObject({state: 'available', snapshots: [{account: {id: seeded.accountId}}]});
    await workspace.page.getByRole('link', {name: 'Accounts', exact: true}).click();
    await workspace.page.getByRole('button', {name: /Fixture Residential Management/}).click();
    await expect(workspace.page.getByRole('heading', {name: 'Fixture Residential Management', exact: true})).toBeVisible();
    expect((await workspace.page.evaluate(() => window.callie.localWorkspace.getCommitments())).items).toEqual(beforeWork.items);
    expect((await workspace.page.evaluate(() => window.callie.daily.get())).workspaceId).toBeNull();
    await workspace.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await workspace.page.getByRole('button', { name: 'Data & storage', exact: true }).click();
    await expect(workspace.page.getByText(/Native Desk is active/i)).toBeVisible();
    await expect(workspace.page.getByRole('button', {name: 'Switch to Native Desk', exact: true})).toHaveCount(0);
    expect(pageErrors).toEqual([]); expect(rendererHttpRequests).toEqual([]);
  } finally { material = ''; await workspace?.stop(); await fixtures.cleanup(); }
});
