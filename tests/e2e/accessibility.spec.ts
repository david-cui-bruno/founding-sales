import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from 'playwright/test';

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

test('seeded workspace routes and contact-first detail states have no serious or critical axe violations', async () => {
  const workspace = await launchSeededFounderWorkspace();

  try {
    const { page } = workspace;

    for (const { route, link } of routes) {
      await page.getByRole('link', { name: link }).click();
      await expect(page.getByRole('main')).toBeVisible();

      await expectAccessible(page, route);
    }

    // Use the actual imported referral, not invented provider success or activity.
    await page.getByRole('link', { name: 'Today' }).click();
    const queue = page.getByRole('list', { name: 'Work queue' });
    await expect(queue).toHaveCount(1);
    await queue.getByRole('button', { name: 'Maya Ortiz', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Maya Ortiz details' });
    await expect(inspector.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Email', exact: true })).toHaveCount(1);
    await expectAccessible(page, 'Today contact overview');
    await inspector.locator('summary').filter({ hasText: /^Details$/ }).click();
    await expect(inspector.getByRole('region', { name: 'Fit', exact: true })).toBeVisible();
    await expectAccessible(page, 'Today contact Details');
    await inspector.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(inspector.getByRole('button', { name: 'Log dated past activity', exact: true })).toBeVisible();
    await expectAccessible(page, 'Today contact Activity');
    await inspector.getByRole('button', { name: 'Open full page' }).click();
    const fullPage = page.locator('.lead-full-page');
    await expect(fullPage.getByRole('region', { name: 'Known portfolio' })).toBeVisible();
    await fullPage.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(fullPage.getByRole('region', { name: 'Call outcome' })).toBeVisible();
    await expectAccessible(page, 'Full-page Activity and call outcome');
  } finally {
    await workspace.close();
  }
});
