import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import type { FirmTimelineEvent } from '@fss/contracts';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';

/**
 * The firm page's new reads (S4F): tasks, the activity timeline with "Show more", and the call
 * note. With `FSS_SCREENS_DIR` set each scenario writes screenshots at 1180, 1440 and 2560 px.
 * Invented firm and people; no real number or address.
 */

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1180', width: 1180, height: 800 },
  { name: '1440', width: 1440, height: 900 },
  { name: '2560', width: 2560, height: 1300 },
] as const;

let app: AppServer;
test.afterEach(async () => {
  await app.stop();
});

async function shoot(page: Page, name: string): Promise<void> {
  if (SCREENS === undefined) return;
  await mkdir(SCREENS, { recursive: true });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SCREENS}/${name}-${size.name}.png` });
  }
}

const at = (hours: number): string => new Date(Date.UTC(2026, 9, 2, 16, 0, 0) - hours * 3_600_000).toISOString();
const events = (from: number, count: number, prefix: string): FirmTimelineEvent[] =>
  Array.from({ length: count }, (_, index) => {
    const n = from + index;
    const kinds: FirmTimelineEvent[] = [
      { key: `${prefix}:call:${String(n)}`, at: at(n * 7), kind: 'call', code: 'interested', detail: null },
      { key: `${prefix}:mail:${String(n)}`, at: at(n * 7), kind: 'email_received', code: null, detail: 'Re: after-hours coverage for 650 doors' },
      { key: `${prefix}:stage:${String(n)}`, at: at(n * 7), kind: 'stage_change', code: 'contacting', detail: 'new' },
      { key: `${prefix}:stop:${String(n)}`, at: at(n * 7), kind: 'stop_recorded', code: 'email', detail: 'firm' },
    ];
    return kinds[n % 4] as FirmTimelineEvent;
  });

const NOTE = 'Spoke with Dana. They run about 650 doors across two offices and use a shared inbox after hours. She asked for a one-page overview and said Marcus decides on vendors; call back Tuesday morning when he is in. Mentioned a bad winter last year with frozen pipes.';

const operations = {
  'calling.history': () => ({
    calls: [
      {
        sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        firmId: FIRM_ID,
        status: 'completed',
        startedAt: '2026-09-29T15:00:00.000Z',
        answeredAt: '2026-09-29T15:00:08.000Z',
        endedAt: '2026-09-29T15:04:00.000Z',
        durationSeconds: 232,
        hasRecording: false,
        callLogId: null,
        outcome: 'interested',
        note: NOTE,
      },
    ],
  }),
  'crm.firmTimeline': () => ({ timeline: { events: events(50, 5, 'p2'), nextBefore: null } }),
  'meetings.forFirm': () => ({ meetings: [] }),
  'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
};

function withReads() {
  const base = assigneeFirmPage();
  if (base.visibility !== 'assigned_or_admin') throw new Error('fixture');
  return {
    ...base,
    tasks: [
      { key: 'callback:1', kind: 'callback' as const, label: 'callback', dueAt: '2026-10-07T14:00:00.000Z', status: 'open' as const },
      { key: 'call_task:2', kind: 'call_task' as const, label: 'Send the one-page overview', dueAt: '2026-10-03T15:00:00.000Z', status: 'open' as const },
      { key: 'step:3', kind: 'step' as const, label: 'call_task', dueAt: '2026-10-09T15:00:00.000Z', status: 'held' as const },
    ],
    timeline: { events: events(0, 50, 'p1'), nextBefore: '2026-09-01T00:00:00.000000|stop_recorded|x' },
  };
}

test('tasks, the timeline with Show more, and the call note', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: withReads() }), operations });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('firm-tasks')).toBeVisible();
  await expect(page.getByTestId('firm-task')).toHaveCount(3);
  await expect(page.getByTestId('timeline-row')).toHaveCount(50);
  await expect(page.getByTestId('call-note-text')).toBeVisible();
  await shoot(page, 'firm-reads');
  await page.getByTestId('firm-timeline').scrollIntoViewIfNeeded();
  await shoot(page, 'firm-reads-timeline');

  await page.getByTestId('call-note-toggle').click();
  await page.getByTestId('timeline-more').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(55);
  await expect(page.getByTestId('timeline-more')).toHaveCount(0);
  expect(app.called('crm.firmTimeline')).toHaveLength(1);
  await page.getByTestId('timeline-row').last().scrollIntoViewIfNeeded();
  await shoot(page, 'firm-reads-expanded');
});

test('a firm with no tasks and no activity says so quietly', async ({ page }) => {
  const empty = { ...withReads(), tasks: [], timeline: { events: [], nextBefore: null } };
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: empty }), operations: { ...operations, 'calling.history': () => ({ calls: [] }) } });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('tasks-none')).toBeVisible();
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
  await shoot(page, 'firm-reads-empty');
});
