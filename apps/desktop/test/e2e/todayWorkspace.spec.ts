import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import type { CallSessionDto } from '@fss/contracts';
import {
  CALLABLE_ADVICE,
  DUE_FIRM_ID,
  FIRM_ID,
  OTHER_FIRM_ID,
  REPLY_FIRM_ID,
  expandedFirm,
  todayState,
} from './support/homeFixtures.ts';
import { startAppServer, type AppServer, type AppServerOptions } from './support/appServer.ts';
import type { TodayState } from '../../src/renderer/todayContract.ts';

/**
 * Today in the v2 design (slice S2), in the shipped renderer with the bridges faked.
 *
 * The three regions and their order, the "can't call yet" explanation and its inline fix,
 * Log incoming call, the keyboard (no key dials, none fires while typing), the queue
 * folding below 1280 px, and the latest call's steps refreshing in place while they are on
 * their way and not afterwards.
 *
 * With `FSS_SCREENS_DIR` set, each scenario also writes screenshots at 1280, 1440 and 2560
 * px there (`npm run test:e2e --workspace apps/desktop -- todayWorkspace`).
 *
 * No real business name or number appears; the numbers are in the NANP 555-01XX block.
 */

let server: AppServer;
test.afterEach(async () => {
  await server.stop();
});

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
  { name: '2560', width: 2560, height: 1440 },
] as const;

async function shoot(page: Page, name: string, sizes: readonly (typeof SIZES)[number]['name'][] = ['1280', '1440', '2560']): Promise<void> {
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

const ANSWERED_CALL: CallSessionDto = {
  sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  firmId: FIRM_ID,
  status: 'completed',
  startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  answeredAt: new Date(Date.now() - 6 * 60_000 + 8_000).toISOString(),
  endedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  durationSeconds: 232,
  hasRecording: true,
  callLogId: null,
  hasTranscript: false,
};

/**
 * Any card opens, as the real bridge opens it: the shared fixture opens only Northwind,
 * which is enough for the lanes' specs and not for walking a queue.
 */
function expandAny(argument: unknown): TodayState {
  const firmId = (argument as { firmId?: string } | null)?.firmId ?? '';
  const today = server.today.state();
  const card = today.cards.find(entry => entry.firmId === firmId);
  const expanded =
    firmId === FIRM_ID
      ? expandedFirm()
      : card === undefined
        ? null
        : expandedFirm({ firmId, firmName: card.firmName, lane: card.lane, counts: card.counts, tasks: [], routes: [] });
  const next = { ...today, expanded, dialAdvice: firmId === FIRM_ID ? [CALLABLE_ADVICE] : [], notice: null };
  server.today.setState(next);
  return next;
}

/** Twilio calling on, attempt 2 of 4, and the firm's history as given. */
function calling(history: () => readonly CallSessionDto[]): NonNullable<AppServerOptions['operations']> {
  return {
    'today.expand': expandAny,
    'calling.status': () => ({
      provider: 'twilio',
      cadence: { unansweredAttempts: 1, nextAttempt: 2, limit: 4, parked: false, refusal: null },
    }),
    'calling.history': () => ({ calls: history() }),
  };
}

/** The four lanes, plus a fifth firm that cannot be called yet. */
function withBlocked(overrides: Partial<TodayState> = {}): TodayState {
  const base = todayState();
  return todayState({
    cards: [
      ...base.cards,
      {
        firmId: '99999999-0000-4000-8000-000000000001',
        firmName: 'Bluebonnet Test Property Management of North Central Texas and the Brazos Valley',
        lane: 'new_firm',
        dueAt: '2026-09-02T12:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 0 },
        blockers: ['no_phone', 'no_location'],
      },
    ],
    ...overrides,
  });
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
  await expect(page.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('home')).toHaveAttribute('aria-busy', 'false');
}

test('three regions: the queue in the plan’s order, the first firm’s brief, and the call', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({ today: withBlocked(), operations: calling(() => [ANSWERED_CALL]) });
  await page.goto(server.url());
  await settled(page);

  // Callbacks, then replies, then what is due, then new prospects, then the blocked firm.
  await expect(page.getByTestId('queue-group')).toHaveCount(5);
  expect(await page.getByTestId('queue-group').evaluateAll(groups => groups.map(group => group.getAttribute('data-group')))).toEqual([
    'callbacks',
    'replies',
    'due',
    'prospects',
    'blocked',
  ]);
  await expect(page.getByTestId('queue-firm')).toHaveText([
    'Northwind Test Holdings',
    'Ashgrove Test Partners',
    'Copperline Test Holdings',
    'Larkspur Test Foundry',
    'Bluebonnet Test Property Management of North Central Texas and the Brazos Valley',
  ]);
  await expect(page.getByTestId('queue-line').last()).toHaveText('No phone number · No location or time zone');
  // The callable count leaves the blocked firm out.
  await expect(page.getByTestId('queue-count')).toHaveText('4');

  // The first firm of the queue is open without a press; the call panel reads the
  // announcement and offers the one usable number with the server's advice.
  expect(server.called('today.expand')[0]).toEqual({ firmId: FIRM_ID });
  await expect(page.getByTestId('queue-row').first()).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('call-announcement-text')).toContainText('This call is being recorded and transcribed');
  await expect(page.getByTestId('dial')).toHaveText('Call +14015550187');
  await expect(page.getByTestId('call-attempt')).toHaveText('Attempt 2 of 4');
  await expect(page.getByTestId('today-tasks').getByTestId('today-task')).toHaveCount(5);
  await expect(page.getByTestId('brief-absent')).toBeVisible();
  // The latest call, answered four minutes ago: recorded, transcript on its way.
  await expect(page.getByTestId('latest-step-recording')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('latest-step-transcription')).toHaveAttribute('data-state', 'pending');
  await shoot(page, 'today-idle');
});

test('a firm that cannot be called says why, and the fix is made in place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const blocked = withBlocked();
  server = await startAppServer({
    today: todayState({
      cards: blocked.cards.map(card => (card.firmId === FIRM_ID ? { ...card, blockers: ['no_location'] } : card)),
    }),
    operations: {
      ...calling(() => []),
      'firms.saveBasics': argument => ({
        saved: {
          firmId: FIRM_ID,
          routeId: null,
          locality: 'Dallas',
          regionCode: 'TX',
          timeZone: 'America/Chicago',
          blockers: [],
        },
        reason: null,
        issues: [],
        argument,
      } as never),
    },
  });
  await page.goto(server.url());
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
  // Northwind is now in "can't call yet", so the queue opens on the reply; open Northwind.
  await page.locator(`[data-testid="queue-row"][data-firm="${FIRM_ID}"]`).click();
  await expect(page.getByTestId('firm-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('call-blocker-no_location')).toHaveText('No location or time zone');
  await expect(page.getByTestId('firm-blocked')).toContainText('No location or time zone.');
  await shoot(page, 'today-blocked');

  await page.getByTestId('call-fix-no_location').click();
  await expect(page.getByTestId('basics-region')).toBeFocused();
  await page.getByTestId('basics-locality').fill('Dallas');
  await page.getByTestId('basics-region').fill('tx');
  await page.getByTestId('basics-zone').selectOption('America/Chicago');
  await shoot(page, 'today-editing-location', ['1440']);
  const reads = server.called('today.refresh').length;
  await page.getByTestId('basics-save').click();
  await expect.poll(() => server.called('firms.saveBasics')).toEqual([
    { firmId: FIRM_ID, locality: 'Dallas', regionCode: 'TX', timeZone: 'America/Chicago' },
  ]);
  // Saved: the card is read again, and the list, so the firm is callable without a reload.
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(reads);
  await expect(page.getByTestId('basics-editor')).toHaveCount(0);
});

test('a refused edit names the field at fault and keeps what was typed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    operations: {
      ...calling(() => []),
      'firms.saveBasics': () => ({ saved: null, reason: 'invalid_input', issues: [{ field: 'phone', code: 'phone_invalid' }] }),
    },
  });
  await page.goto(server.url());
  await settled(page);
  await page.keyboard.press('e');
  await expect(page.getByTestId('basics-phone')).toBeFocused();
  await page.getByTestId('basics-phone').fill('12');
  await page.getByTestId('basics-save').click();
  await expect(page.getByTestId('basics-issue-phone')).toContainText('not a phone number Callie can dial');
  await expect(page.getByTestId('basics-phone')).toHaveValue('12');
});

test('the keyboard walks the queue, searches and edits, never dials, and never fires while typing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({ today: withBlocked(), operations: calling(() => []) });
  await page.goto(server.url());
  await settled(page);

  // Each step waits for the firm it opened to be on screen, as a person's next key would.
  await page.keyboard.press('j');
  await expect(page.getByTestId('firm-name')).toHaveText('Ashgrove Test Partners');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('firm-name')).toHaveText('Copperline Test Holdings');
  await page.keyboard.press('k');
  await expect(page.getByTestId('firm-name')).toHaveText('Ashgrove Test Partners');
  expect(server.called('today.expand').slice(-3)).toEqual([{ firmId: REPLY_FIRM_ID }, { firmId: DUE_FIRM_ID }, { firmId: REPLY_FIRM_ID }]);

  // ⌘K: search today's firms; Enter opens the first match.
  await page.keyboard.press('Meta+k');
  await expect(page.getByTestId('search')).toBeVisible();
  await page.keyboard.type('lark');
  await shoot(page, 'today-search', ['1440']);
  // Typing in the search field moved nothing: "l", "a", "r", "k" are not shortcuts there.
  expect(server.called('today.expand').at(-1)).toEqual({ firmId: REPLY_FIRM_ID });
  await page.keyboard.press('Enter');
  await expect.poll(() => server.called('today.expand').at(-1)).toEqual({ firmId: OTHER_FIRM_ID });

  await page.keyboard.press('?');
  await expect(page.getByTestId('help')).toContainText('No shortcut starts a call');
  await shoot(page, 'today-shortcuts', ['1440']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help')).toHaveCount(0);

  // Every key on the board, and Enter and Space on the page: nothing dials.
  for (const key of ['c', 'Enter', ' ', 'd', 'p', 'Meta+Enter']) await page.keyboard.press(key);
  expect(server.called('today.dial')).toEqual([]);
  expect(server.called('calling.start')).toEqual([]);
});

test('Log incoming call records a callback taken on the mobile, against the firm on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    operations: { ...calling(() => []), 'calls.logIncoming': () => ({ logged: true, reason: null }) },
  });
  await page.goto(server.url());
  await settled(page);

  await page.getByTestId('log-incoming').click();
  await expect(page.getByTestId('incoming-firm')).toHaveValue(FIRM_ID);
  // What happened is required: Save waits for it.
  await expect(page.getByTestId('log-incoming-save')).toBeDisabled();
  await page.getByTestId('incoming-contact').selectOption({ label: 'Dana Example' });
  await page.getByTestId('incoming-minutes').fill('4');
  await page.getByTestId('incoming-outcome').selectOption('interested');
  await page.getByTestId('incoming-note').fill('Called back about the after-hours line');
  await shoot(page, 'today-log-incoming', ['1440']);
  await page.getByTestId('log-incoming-save').click();

  await expect.poll(() => server.called('calls.logIncoming').length).toBe(1);
  const logged = server.called('calls.logIncoming')[0] as Record<string, unknown>;
  expect(logged).toMatchObject({
    firmId: FIRM_ID,
    contactId: '88888888-8888-4888-8888-888888888888',
    durationSeconds: 240,
    outcome: 'interested',
    note: 'Called back about the after-hours line',
  });
  expect(Date.now() - Date.parse(String(logged['occurredAt']))).toBeLessThan(5 * 60_000);
  // Beside the firm it was logged against, not in a page banner (slice 3a, C0).
  await expect(page.getByTestId('feedback-incoming')).toHaveText('Incoming call logged on the firm’s history.');
  await expect(page.getByTestId('banners')).toHaveCount(0);
});

test('below 1280 px the queue folds behind a button, and the firm and the call keep their room', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  server = await startAppServer({ today: withBlocked(), operations: calling(() => []) });
  await page.goto(server.url());
  await settled(page);
  await expect(page.getByTestId('queue-region')).toBeHidden();
  await expect(page.locator('[data-region="call"]')).toBeVisible();
  if (SCREENS !== undefined) await page.screenshot({ path: `${SCREENS}/today-narrow-1180.png` });
  await page.getByTestId('queue-toggle').click();
  await expect(page.getByTestId('queue-region')).toBeVisible();
  if (SCREENS !== undefined) await page.screenshot({ path: `${SCREENS}/today-narrow-queue-open-1180.png` });
  await page.locator(`[data-testid="queue-row"][data-firm="${DUE_FIRM_ID}"]`).click();
  await expect(page.getByTestId('queue-region')).toBeHidden();
});

test('the latest call’s steps refresh in place while they are on their way, and stop when done', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let reads = 0;
  server = await startAppServer({
    operations: calling(() => {
      reads += 1;
      // The third read finds the transcript and the summary.
      return reads < 3
        ? [ANSWERED_CALL]
        : [
            {
              ...ANSWERED_CALL,
              hasTranscript: true,
              summary: {
                summary: 'Dana handles maintenance calls; nights go to an answering service. She wants the owner to see a demo.',
                nextSteps: [],
                commitments: [],
                model: 'claude-haiku-4-5',
                createdAt: new Date().toISOString(),
              },
            },
          ];
    }),
  });
  await page.goto(server.url());
  await settled(page);
  await expect(page.getByTestId('latest-step-transcription')).toHaveAttribute('data-state', 'pending');
  await shoot(page, 'today-analysis-pending', ['1440']);
  await expect(page.getByTestId('latest-step-analysis')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(page.getByTestId('latest-call-summary')).toContainText('Dana handles maintenance calls');
  await shoot(page, 'today-analysis-done');
  // Done: no more reads.
  const settledReads = reads;
  await page.waitForTimeout(6_000);
  expect(reads).toBe(settledReads);
});

test('the selected firm, the queue, both forms and what was typed survive a round trip through Pipeline and Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  server = await startAppServer({ today: withBlocked(), operations: calling(() => []) });
  await page.goto(server.url());
  await settled(page);
  // The firm that is open when the person leaves is the firm that is open when they return.
  await page.locator(`[data-testid="queue-row"][data-firm="${REPLY_FIRM_ID}"]`).click();
  await expect(page.getByTestId('firm-name')).toHaveText('Ashgrove Test Partners');
  await page.getByTestId('firm-outcome').click();
  await page.getByTestId('outcome-note').fill('Ask for Glen on Tuesday');
  await page.getByTestId('firm-edit').click();
  await page.getByTestId('basics-locality').fill('Waco');
  // The queue's scroll: a short window so the list overflows.
  await page.getByTestId('queue-list').evaluate(list => {
    list.scrollTop = 90;
  });
  const scrolled = await page.getByTestId('queue-list').evaluate(list => list.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  for (const away of ['nav-pipeline', 'nav-settings'] as const) {
    await page.getByTestId(away).click();
    await expect(page.getByTestId('nav-today')).not.toHaveAttribute('aria-current', 'page');
    await page.getByTestId('nav-today').click();
    await expect(page.getByTestId('firm-name')).toHaveText('Ashgrove Test Partners');
    // Today opens on the Queue, with both forms where they were left and their text in them.
    await expect(page.getByTestId('today-tab-queue')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('outcome-note')).toHaveValue('Ask for Glen on Tuesday');
    await expect(page.getByTestId('basics-locality')).toHaveValue('Waco');
    await expect(page.getByTestId('queue-note')).toHaveCount(1);
    await expect.poll(() => page.getByTestId('queue-list').evaluate(list => list.scrollTop)).toBe(scrolled);
  }
});

test('the card’s numbers come from the server’s advice, as before', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  server = await startAppServer({
    operations: calling(() => []),
    onRefresh: today => ({ ...today, expanded: today.expanded === null ? null : expandedFirm(), dialAdvice: [{ ...CALLABLE_ADVICE, callable: false, reasons: ['outside_calling_window'] }] }),
  });
  await page.goto(server.url());
  await settled(page);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('dial-reason')).toHaveText('It is outside this firm’s calling hours.');
  await expect(page.getByTestId('dial')).toBeDisabled();
});
