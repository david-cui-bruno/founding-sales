import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID, OPPORTUNITY_ID, pipelineView } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';

/**
 * Lane M1: the firm page's Meetings rows with attendance, the "Move to Demo booked" line, and
 * the board card that follows. With `FSS_SCREENS_DIR` set each scenario writes screenshots at
 * 1180 and 1440 px. Invented firm; no real number or address.
 */

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1180', width: 1180, height: 800 },
  { name: '1440', width: 1440, height: 900 },
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

const meeting = (n: number, state: string, startsAt: string, attendanceSource: string | null = null) => ({
  meetingId: `44444444-4444-4444-8444-44444444440${String(n)}`,
  state,
  startsAt,
  endsAt: startsAt.replace(':00:00.000Z', ':30:00.000Z'),
  attendanceSource,
});

// The server's state after the confirmation: the read after it says held.
let confirmed = false;
const operations = {
  'calling.history': () => ({ calls: [] }),
  'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
  'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
  'meetings.forFirm': () => ({
    meetings: [
      meeting(1, 'booked', '2026-10-14T15:00:00.000Z'),
      confirmed ? meeting(2, 'held', '2026-10-01T15:00:00.000Z', 'manual') : meeting(2, 'ended', '2026-10-01T15:00:00.000Z'),
      meeting(3, 'held', '2026-09-24T15:00:00.000Z', 'manual'),
      meeting(4, 'no_show', '2026-09-17T15:00:00.000Z', 'calcom_no_show'),
      meeting(5, 'no_show', '2026-09-10T15:00:00.000Z', 'manual'),
    ],
    stageSuggestion: { stageKey: 'demo_booked', opportunityId: OPPORTUNITY_ID },
  }),
  'meetings.setAttendance': () => {
    confirmed = true;
    return { set: { meetingId: '44444444-4444-4444-8444-444444444402', state: 'held', attendanceSource: 'manual' }, reason: null };
  },
};

test('the firm page: ended with Attended and No-show, Held and No-show with Undo, and the stage suggestion', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }), operations });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('firm-meeting-row')).toHaveCount(5);
  await expect(page.getByTestId('stage-suggestion')).toBeVisible();
  await page.getByTestId('firm-meetings').scrollIntoViewIfNeeded();
  await shoot(page, 'meetings-rows');
  // Quiet until hover: the ended row's actions.
  await page.getByTestId('firm-meeting-row').nth(1).hover();
  await expect(page.getByTestId('attendance-attended')).toBeVisible();
  await shoot(page, 'meetings-ended-hover');
  await page.getByTestId('attendance-attended').click();
  await expect(page.getByTestId('firm-meeting-row').nth(1).getByTestId('firm-meeting-state')).toHaveText('Held');
  expect(app.called('meetings.setAttendance')).toHaveLength(1);
  await page.getByTestId('firm-meeting-row').nth(1).hover();
  await shoot(page, 'meetings-held-undo-hover');
});

test('the board card: ended reads "not confirmed", and the suggestion is one click', async ({ page }) => {
  const view = pipelineView();
  const pipeline = {
    ...view,
    cards: {
      [FIRM_ID]: {
        value: null,
        meeting: { meetingId: '44444444-4444-4444-8444-444444444401', state: 'booked', startsAt: '2026-10-14T15:00:00.000Z' },
        evidence: null,
        pinned: false,
        closeReason: null,
        stageSuggestion: { stageKey: 'engaged', opportunityId: OPPORTUNITY_ID },
      },
    },
  };
  app = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, pipeline }), operations });
  await page.goto(app.url('#pipeline'));
  await expect(page.getByTestId('card-stage-suggestion')).toBeVisible();
  await shoot(page, 'board-suggestion');
});
