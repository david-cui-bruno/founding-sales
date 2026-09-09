import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from 'playwright/test';
import { launchFounderWorkspace, type FounderWorkspace } from '../support/founderWorkspace';

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
          const audit = await new AxeBuilder({ page }).analyze();
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
