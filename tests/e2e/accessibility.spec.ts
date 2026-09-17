import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from 'playwright/test';

import { launchFounderWorkspace, navigateFounderRoute } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

const routes = ['Today', 'Accounts', 'Campaigns', 'Settings'] as const;

async function expectAccessible(page: Page, route: string) {
  // Electron over CDP cannot create helper pages, so axe runs in
  // legacy mode inside the existing renderer page.
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  const blocking = results.violations.filter(violation =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(blocking.map(violation => ({
    route, id: violation.id, impact: violation.impact,
    nodes: violation.nodes.map(node => ({ target: node.target, failure: node.failureSummary })),
  }))).toEqual([]);
}

test('workspace routes have no serious or critical axe violations', async () => {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;

    for (const route of routes) {
      await navigateFounderRoute(page, route);
      await expect(page.getByRole('main')).toBeVisible();

      await expectAccessible(page, route);
    }
  } finally {
    await workspace.close();
  }
});
