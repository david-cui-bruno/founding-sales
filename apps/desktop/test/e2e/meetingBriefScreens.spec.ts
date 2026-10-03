import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';

/**
 * Lane M2: the meeting brief opened inline from the firm page's Meetings row. With
 * `FSS_SCREENS_DIR` set it writes screenshots at 1180 and 1440 px. Invented firm and person.
 */

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1180', width: 1180, height: 900 },
  { name: '1440', width: 1440, height: 1000 },
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

const DAY = 86_400_000;
const at = (days: number): string => new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + 15 * 3_600_000).toISOString();
const MEETING = '44444444-4444-4444-8444-444444444401';

const entry = (label: string | null, text: string, source: string, provenance: string, when: string | null, sourceUrl: string | null = null) => ({
  label,
  text,
  source,
  provenance,
  at: when,
  sourceUrl,
});

const brief = {
  meetingId: MEETING,
  firmId: FIRM_ID,
  meeting: { title: 'Callie demo between David and Dana Example', attendeeName: 'Dana Example', state: 'booked', startsAt: at(2), endsAt: at(2), locationType: 'zoom_video' },
  sections: {
    whyThisDemo: {
      items: [
        entry('Notes', 'Maintenance requests come in by text and get lost over weekends.', 'booking_notes', 'stated', at(-3)),
        entry('Which property management software do you use?', 'AppFolio', 'booking_answer', 'stated', at(-3)),
        entry('Asked for a demo', 'Can you show us how the after-hours line works?', 'call_signal', 'observed', at(-5)),
        entry('Next step · You', 'Send the calendar link (today)', 'call_next_step', 'inferred', at(-5)),
      ],
      omitted: 0,
    },
    firm: {
      items: [
        entry('Prepared research', 'Ask for Dana, the operations lead.', 'prepared_brief', 'unverified', '2026-09-20'),
        entry('Prepared research', 'Uses AppFolio; about 240 doors across Providence.', 'prepared_brief', 'unverified', '2026-09-20'),
        entry('Software', 'Pay rent online through our AppFolio portal', 'research_fact', 'observed', at(-12), 'https://www.dana-example.example/residents'),
        entry('Maintenance workflow', 'Submit a maintenance request by text or through the portal', 'research_fact', 'observed', at(-12), 'https://www.dana-example.example/maintenance'),
      ],
      omitted: 0,
    },
    conversations: {
      items: [
        entry('interested', 'You reached Dana. She asked for a demo of the after-hours line.', 'call', 'inferred', at(-5)),
        entry('voicemail_left', 'No summary', 'call', 'observed', at(-9)),
        entry('E-mail', 'Re: Callie demo', 'email_thread', 'observed', at(-4)),
      ],
      omitted: 0,
    },
    objections: { items: [entry('price', 'It sounds expensive for a team our size.', 'call_objection', 'observed', at(-5))], omitted: 0 },
    commitments: { items: [entry('You', 'I will send you a calendar link today', 'call_commitment', 'observed', at(-5))], omitted: 0 },
  },
  generatedAt: at(0),
};

const operations = {
  'calling.history': () => ({ calls: [] }),
  'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
  'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
  'meetings.forFirm': () => ({
    meetings: [
      { meetingId: MEETING, state: 'booked', startsAt: at(2), endsAt: at(2), attendanceSource: null },
      { meetingId: '44444444-4444-4444-8444-444444444402', state: 'held', startsAt: at(-20), endsAt: at(-20), attendanceSource: 'manual' },
    ],
    stageSuggestion: null,
  }),
  'meetings.brief': () => ({ brief, reason: null }),
};

test('the firm page: a meeting this week opens its brief inline', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }), operations });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('firm-meeting-row')).toHaveCount(2);
  await expect(page.getByTestId('meeting-brief-toggle')).toHaveCount(1);
  await page.getByTestId('firm-meetings').scrollIntoViewIfNeeded();
  await shoot(page, 'brief-closed');
  await page.getByTestId('meeting-brief-toggle').click();
  await expect(page.getByTestId('meeting-brief')).toBeVisible();
  expect(app.called('meetings.brief')).toHaveLength(1);
  await page.getByTestId('meeting-brief').scrollIntoViewIfNeeded();
  await shoot(page, 'brief-open');
  await page.getByTestId('brief-section-whyThisDemo').getByTestId('brief-show-more').click();
  await shoot(page, 'brief-show-more');
});
