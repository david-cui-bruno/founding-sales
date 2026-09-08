import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from 'playwright/test';

import { launchSeededFounderWorkspace } from '../support/founderWorkspace';

test.describe.configure({ mode: 'serial' });

const routes = [
  { route: 'Today', link: 'Today' },
  { route: 'Leads', link: 'Leads' },
  { route: 'Pipeline', link: 'Pipeline' },
  { route: 'Conversations', link: 'Conversations' },
  { route: 'Learnings', link: 'Learnings' },
  { route: 'Inbox', link: 'Inbox' },
  { route: 'Friday', link: 'Friday' },
] as const;

test('seeded workspace routes have no serious or critical axe violations', async () => {
  const workspace = await launchSeededFounderWorkspace();

  try {
    const { page } = workspace;

    for (const { route, link } of routes) {
      await page.getByRole('link', { name: link }).click();
      await expect(page.getByRole('main')).toBeVisible();

      // Electron over CDP cannot create helper pages, so axe runs in
      // legacy mode inside the existing renderer page.
      const results = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      );

      expect(
        blocking.map((violation) => ({
          route,
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({ target: node.target, failure: node.failureSummary })),
        })),
      ).toEqual([]);
    }
  } finally {
    await workspace.close();
  }
});
