import { mkdir } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { outcomesView } from '../support/meetingOutcomesFixture.ts';
import { transcriptPage, MID } from '../support/meetingTranscriptFixture.ts';
const screens = process.env['FSS_SCREENS_DIR']; let app: AppServer;
test.afterEach(async () => { await app?.stop(); });
for (const mode of ['current', 'partial', 'empty', 'error'] as const) test(`meeting notes: ${mode}, wide and narrow`, async ({ page }) => {
  const view = outcomesView(mode === 'error' ? 'current' : mode);
  if (mode === 'empty') { view.items = []; view.tasks = []; view.overview = ''; view.notes.debrief = ''; view.holds = ['analysis_disabled']; }
  if (mode === 'partial') { view.items[0]!.reviewReasons = ['owner_unknown']; view.tasks = []; }
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }), operations: {
    'calling.history': () => ({ calls: [] }), 'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
    'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
    'meetings.forFirm': () => ({ meetings: [{ meetingId: MID, state: 'held', startsAt: '2026-10-03T14:00:00.000Z', endsAt: '2026-10-03T14:20:00.000Z', attendanceSource: 'manual' }] }),
    'recordings.state': () => ({ folder: { path: '/example/demos', isDefault: true, available: true }, items: [], notice: null }),
    'recordings.forFirm': () => ({ truncated: false, recordings: [] }),
    'meetings.outcomes': () => mode === 'error' ? { view: null, reason: 'offline' } : { view, reason: null },
    'meetings.transcript': () => ({ page: transcriptPage(), reason: null }),
  } });
  await page.setViewportSize({ width: 1280, height: 1000 }); await page.goto(app.url(`#firm/${FIRM_ID}`));
  await page.getByRole('button', { name: 'Notes & tasks' }).click();
  await expect(page.getByRole('region', { name: 'Meeting notes and tasks' })).toBeVisible();
  if (mode !== 'error') await expect(page.getByLabel('Your notes', { exact: true })).toBeVisible();
  else await expect(page.getByText(/could not load the latest notes/)).toBeVisible();
  if (screens !== undefined) {
    await mkdir(screens, { recursive: true });
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 1000 }); await page.getByTestId('meeting-outcomes').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${screens}/meeting-outcomes-${mode}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.getByRole('button', { name: 'Notes & tasks' }).click(); await expect(page.getByLabel('Your notes', { exact: true })).toHaveCount(0);
});
