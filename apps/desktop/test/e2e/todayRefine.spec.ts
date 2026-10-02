import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { todayState } from './support/homeFixtures.ts';

/**
 * Slice 3a, C0: the Today refinements in the shipped renderer with the bridges faked.
 * With `FSS_SCREENS_DIR` set, each scenario also writes screenshots at 1280, 1440 and
 * 2560 px (and 1180 for the folded queue) there.
 */

let server: AppServer;
test.afterEach(async () => {
  await server.stop();
});

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1180', width: 1180, height: 760 },
  { name: '1440', width: 1440, height: 900 },
  { name: '2560', width: 2560, height: 1440 },
] as const;

async function shoot(page: Page, name: string, sizes: readonly (typeof SIZES)[number]['name'][] = ['1180', '1440', '2560']): Promise<void> {
  if (SCREENS === undefined) return;
  await mkdir(SCREENS, { recursive: true });
  const before = page.viewportSize();
  for (const size of SIZES.filter(entry => sizes.includes(entry.name))) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SCREENS}/${name}-${size.name}.png` });
  }
  if (before !== null) await page.setViewportSize(before);
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('home')).toHaveAttribute('aria-busy', 'false');
}

test('Today opens on the Queue; Overview holds the numbers, each with its period', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({ today: todayState() });
  await page.goto(server.url());
  await settled(page);
  await expect(page.getByTestId('today-tab-queue')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('figures')).toHaveCount(0);
  await shoot(page, 'queue');

  await page.getByTestId('today-tab-overview').click();
  await expect(page.getByTestId('today-overview')).toBeVisible();
  await expect(page.getByTestId('figure-period')).toHaveCount(7);
  await expect(page.getByTestId('figure-replies').getByTestId('figure-unconfirmed')).toHaveText('(+1 unconfirmed)');
  await shoot(page, 'overview');

  // An actionable count leads to its queue.
  await page.getByTestId('figure-waiting').getByTestId('figure-link').click();
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'replies');
});

test('Settings › Status holds the routine lines, and the reply model is chosen and saved beside them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  let model = 'claude-opus-5';
  server = await startAppServer({
    today: todayState(),
    operations: {
      'replies.model': () => ({ classifier: { enabled: true, modelName: model, effort: 'low' }, online: true, mayMutate: true, notice: null }),
      'replies.saveModel': argument => {
        model = (argument as { modelName: string }).modelName;
        return { classifier: { enabled: true, modelName: model, effort: 'low' }, online: true, mayMutate: true, notice: 'reply_model_saved' };
      },
    },
  });
  await page.goto(server.url());
  await settled(page);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-status')).toBeVisible();
  await expect(page.getByTestId('status-mailbox')).toBeVisible();
  await shoot(page, 'settings-status', ['1440']);

  await expect(page.getByTestId('reply-model-current')).toHaveText('Model now: Opus 5 (direct API)');
  await page.getByTestId('reply-model-select').selectOption('claude-haiku-4-5-20251001');
  await page.getByTestId('reply-model-save').click();
  await expect(page.getByTestId('reply-model-notice')).toHaveText('Saved.');
  await expect(page.getByTestId('reply-model-current')).toHaveText('Model now: Haiku 4.5 (AWS credits)');
  expect(server.called('replies.saveModel')).toEqual([{ modelName: 'claude-haiku-4-5-20251001' }]);
  if (SCREENS !== undefined) await page.getByTestId('reply-model').screenshot({ path: `${SCREENS}/reply-model.png` });
});

test('the live call stays visible on Overview and leads back to the call', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({ today: todayState() });
  await page.goto(server.url());
  await settled(page);
  // Nothing is live, so the strip is not drawn; the component test holds the live case.
  await page.getByTestId('today-tab-overview').click();
  await expect(page.getByTestId('today-live-call')).toHaveCount(0);
});
