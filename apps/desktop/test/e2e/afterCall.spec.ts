import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import type { CallSessionDto } from '@fss/contracts';
import { startAppServer, type AppServer, type AppServerOptions } from './support/appServer.ts';
import { CALLABLE_ADVICE, FIRM_ID, expandedFirm, todayState } from './support/homeFixtures.ts';
import { HOLD_ITEM, PROPOSALS, STAGE_ITEM, analysisAnswer, proposalItem, reviewAnswer, SESSION_ID } from '../support/analysisAnswers.ts';
import type { TodayState } from '../../src/renderer/todayContract.ts';

/**
 * Slice 3a, lane C: the after-call block, Needs review, the task card and the recap, in the
 * shipped renderer with the bridges faked, on C0's Queue and Overview. With `FSS_SCREENS_DIR`
 * set each scenario writes screenshots at 1180, 1440 and 2560 px.
 */

let server: AppServer;
test.afterEach(async () => {
  await server.stop();
});

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1180', width: 1180, height: 780 },
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

const CALL: CallSessionDto = {
  sessionId: SESSION_ID,
  firmId: FIRM_ID,
  status: 'completed',
  startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  answeredAt: new Date(Date.now() - 12 * 60_000 + 8_000).toISOString(),
  endedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
  durationSeconds: 232,
  hasRecording: true,
  callLogId: null,
  hasTranscript: true,
};

function expandNorthwind(argument: unknown): TodayState {
  const firmId = (argument as { firmId?: string } | null)?.firmId ?? '';
  const today = server.today.state();
  const next = { ...today, expanded: firmId === FIRM_ID ? expandedFirm() : null, dialAdvice: firmId === FIRM_ID ? [CALLABLE_ADVICE] : [], notice: null };
  server.today.setState(next);
  return next;
}

function operations(extra: NonNullable<AppServerOptions['operations']> = {}): NonNullable<AppServerOptions['operations']> {
  return {
    'today.expand': expandNorthwind,
    'calling.status': () => ({ provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } }),
    'calling.history': () => ({ calls: [CALL] }),
    ...extra,
  };
}

const review = (...items: object[]): { items: object[] } => JSON.parse(JSON.stringify(reviewAnswer(items))) as { items: object[] };
const analysis = (proposals: Parameters<typeof analysisAnswer>[0] = {}) => ({ analysis: JSON.parse(JSON.stringify(analysisAnswer(proposals))) as object, reason: null });

async function settled(page: Page): Promise<void> {
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('home')).toHaveAttribute('aria-busy', 'false');
}

test('a completed call shows its notes and one block of suggestions, and one Apply sends the ticked ones', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    today: todayState(),
    operations: operations({
      'calling.analysis': () => analysis(),
      'calling.proposalsApply': argument => ({
        applied: { analysisId: (argument as { analysisId: string }).analysisId, callSessionId: SESSION_ID, callLogId: '77777777-7777-4777-8777-7777777777aa', results: [], followUps: [] },
        reason: null,
        keyReasons: {},
      }),
    }),
  });
  await page.goto(server.url());
  await settled(page);

  await expect(page.getByTestId('analysis-completed')).toBeVisible();
  await expect(page.getByTestId('suggestions')).toHaveCount(1);
  // Only the outcome and the promise start ticked.
  await expect(page.getByTestId('suggestion-check-outcome')).toBeChecked();
  await expect(page.getByTestId('suggestion-check-buying_signal')).not.toBeChecked();
  await expect(page.getByTestId('suggestion-evidence-buying_signal')).toContainText('We want to try it on our own portfolio');
  await shoot(page, 'after-call');

  await page.getByTestId('suggestion-check-buying_signal').check();
  await page.getByTestId('apply').click();
  await expect.poll(() => server.called('calling.proposalsApply').length).toBe(1);
  const sent = server.called('calling.proposalsApply')[0] as Record<string, unknown>;
  expect(sent['keys']).toEqual(['outcome', 'buying_signal', 'task:0123456789abcdef']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Needs review is a group in the Queue; its item opens its correction in place and a second click closes it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const items = [
    HOLD_ITEM,
    proposalItem(PROPOSALS.correctedNumber, { firmId: FIRM_ID }),
    proposalItem(PROPOSALS.referral, { firmId: FIRM_ID }),
    STAGE_ITEM,
  ].map(item => ({ ...item, firmId: FIRM_ID }));
  server = await startAppServer({
    today: todayState(),
    operations: operations({ 'calling.analysis': () => analysis({ proposals: [PROPOSALS.outcome, PROPOSALS.correctedNumber] }), 'review.list': () => review(...items) }),
  });
  await page.goto(server.url());
  await settled(page);

  await expect(page.locator('[data-testid="queue-group"][data-group="review"]')).toBeVisible();
  await expect(page.getByTestId('review-row')).toHaveCount(4);
  await expect(page.getByTestId('review-label').first()).toHaveText('Waiting for this call’s notes');
  await expect(page.getByTestId('review-panel')).toBeVisible();
  await shoot(page, 'needs-review');

  await page.getByTestId('review-correct-phone').click();
  await expect(page.getByTestId('basics-phone')).toBeFocused();
  await page.getByTestId('review-correct-phone').click();
  await expect(page.getByTestId('basics-editor')).toHaveCount(0);
  await page.getByTestId('review-correct-phone').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('basics-editor')).toHaveCount(0);
  // Nothing navigated away.
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'today');
});

test('the recap and the acceptance read are on Overview, each figure with its period, and hide when unread', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    today: todayState(),
    operations: operations({
      'calling.analysis': () => ({ analysis: null, reason: 'not_found' }),
      'calling.recap': () => ({
        recap: {
          businessDate: '2026-09-21',
          businessTimeZone: 'America/New_York',
          callsAnalysed: 6,
          smallSample: false,
          objections: [
            { category: 'has_solution', calls: 3, recurring: true, quotes: [{ quote: 'We already use AppFolio', callSessionId: SESSION_ID }] },
            { category: 'price', calls: 1, recurring: false, quotes: [{ quote: 'Too expensive for us', callSessionId: SESSION_ID }] },
          ],
          coaching: { observation: 'Ask a question before you pitch.', callSessionId: SESSION_ID },
        },
      }),
      'calling.acceptance': () => ({
        acceptance: {
          minimumDecided: 5,
          types: [
            { type: 'callback', unchanged: 4, edited: 1, declined: 0, bypassed: 0, undecided: 0, acceptedUnchangedShare: 0.8, insufficient: false },
            { type: 'buying_signal', unchanged: 1, edited: 0, declined: 0, bypassed: 0, undecided: 2, acceptedUnchangedShare: 1, insufficient: true },
          ],
          incorrect: [],
        },
      }),
    }),
  });
  await page.goto(server.url());
  await settled(page);
  await page.getByTestId('today-tab-overview').click();

  await expect(page.getByTestId('recap-count')).toHaveText('6 calls analysed today');
  await expect(page.getByTestId('recap-small')).toHaveCount(0);
  await expect(page.getByTestId('recap-objection-count').first()).toHaveText('in 3 of 6 calls · recurring');
  await expect(page.getByTestId('recap-objection-count').nth(1)).toHaveText('in 1 of 6 calls');
  await expect(page.getByTestId('recap-coaching')).toContainText('Ask a question before you pitch.');
  await expect(page.getByTestId('acceptance-insufficient')).toHaveText('insufficient: 1 of 5 decided');
  await shoot(page, 'recap-overview');
});

test('a recap under five calls says "Small sample", and an unanswered recap read hides the block', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    today: todayState(),
    operations: operations({
      'calling.analysis': () => ({ analysis: null, reason: 'not_found' }),
      'calling.recap': () => ({
        recap: { businessDate: '2026-09-21', businessTimeZone: 'America/New_York', callsAnalysed: 3, smallSample: true, objections: [], coaching: null },
      }),
      'calling.acceptance': () => ({ acceptance: null }),
    }),
  });
  await page.goto(server.url());
  await settled(page);
  await page.getByTestId('today-tab-overview').click();
  await expect(page.getByTestId('recap-small')).toContainText('Small sample: 3 calls');
  await expect(page.getByTestId('acceptance')).toHaveCount(0);
});

test('a failed analysis offers Retry and Enter manually, which opens the outcome form', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    today: todayState(),
    operations: operations({
      'calling.analysis': () => analysis({ state: 'failed' }),
      'calling.analysisRetry': () => analysis({ state: 'pending' }),
    }),
  });
  await page.goto(server.url());
  await settled(page);
  await expect(page.getByTestId('analysis-failed')).toBeVisible();
  await shoot(page, 'after-call-failed', ['1440']);
  await page.getByTestId('analysis-retry').click();
  await expect.poll(() => server.called('calling.analysisRetry')).toEqual([{ callSessionId: SESSION_ID, reason: 'retry' }]);
  await page.getByTestId('analysis-manual').click();
  await expect(page.getByTestId('outcome-panel')).toBeVisible();
});
