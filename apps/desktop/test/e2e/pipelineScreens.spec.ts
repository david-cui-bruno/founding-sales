import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import type { BoardCard } from '@fss/contracts';
import type { PipelineView } from '../../src/renderer/firmWorkspaceContract.ts';
import { assigneeFirmPage, crmState, FIRM_ID, OPPORTUNITY_ID, pipelineView } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';

/**
 * The Pipeline board, its side panel and the firm page, at the three widths (S4).
 *
 * With `FSS_SCREENS_DIR` set each scenario writes screenshots at 1180, 1440 and 2560 px
 * there; without it the scenarios still check what is on screen. No real firm, person or
 * number appears: names are invented and addresses are under `example.test`.
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

const LONG = 'Brazos Valley Single-Family Residential Property Management & Leasing Services of North Texas, LLC';

/** A busier board than the shared fixture: values of both kinds, meetings, evidence, a pin, a long name. */
function busyBoard(): { readonly pipeline: PipelineView } {
  const base = pipelineView();
  const identity = base.columns[1]?.firms[0];
  if (identity === undefined) throw new Error('fixture');
  const firm = (n: number, name: string, stageKey: string, locality: string | null = 'Dallas') => ({
    ...identity,
    id: `1000000${String(n)}-1111-4111-8111-111111111111`,
    name,
    stageKey,
    locality,
    regionCode: locality === null ? null : 'TX',
  });
  const place = (key: string, firms: typeof identity[]) => {
    const column = base.columns.find(entry => entry.stage.key === key);
    if (column !== undefined) column.firms = firms;
  };
  const a = firm(1, 'White Rock Residential', 'new');
  const b = firm(2, LONG, 'new', null);
  const c = firm(3, 'Denton Oaks Management', 'contacting', 'Denton');
  const d = firm(4, 'Mesquite Square Rentals', 'engaged', 'Mesquite');
  const e = firm(5, 'Keller Crossing Homes', 'lost', 'Keller');
  place('new', [a, b]);
  place('contacting', [identity, c]);
  place('engaged', [d]);
  place('lost', [e]);
  const card = (over: Partial<BoardCard>): BoardCard => ({ value: null, meeting: null, evidence: null, pinned: false, closeReason: null, ...over });
  const when = (days: number) => new Date(Date.UTC(2026, 9, 2 + days, 16, 0)).toISOString();
  const cards: Record<string, BoardCard> = {
    [a.id]: card({ value: { monthlyCents: 110_000, kind: 'estimated' }, nextAction: { kind: 'call', label: 'Call back', dueAt: when(1) } }),
    [b.id]: card({}),
    [FIRM_ID]: card({
      value: { monthlyCents: 124_000, kind: 'agreed' },
      meeting: { meetingId: OPPORTUNITY_ID, state: 'booked', startsAt: when(5) },
      evidence: { kind: 'meeting.booked', evidenceId: 'bk_1', occurredAt: when(-1), fromStageKey: 'new' },
      nextAction: { kind: 'demo', label: 'Demo', dueAt: when(5) },
    }),
    [c.id]: card({ value: { monthlyCents: 76_000, kind: 'estimated' }, pinned: true }),
    [d.id]: card({ meeting: { meetingId: OPPORTUNITY_ID, state: 'held', startsAt: when(-3) }, nextAction: { kind: 'follow_up_email', label: 'Check in', dueAt: when(4) } }),
    [e.id]: card({ closeReason: 'Chose a competitor', value: { monthlyCents: 54_000, kind: 'estimated' } }),
  };
  return {
    pipeline: {
      ...base,
      opportunityIdByFirmId: { [FIRM_ID]: OPPORTUNITY_ID, [a.id]: '2000000a-1111-4111-8111-111111111111', [c.id]: '2000000c-1111-4111-8111-111111111111' },
      cards,
      includeLost: true,
    },
  };
}

const operations = {
  'research.open': () => ({
    firm: {
      firmId: FIRM_ID,
      brief: null,
      facts: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          key: 'portfolio_size',
          quote: 'We manage about 650 homes across Dallas–Fort Worth.',
          firstParty: true,
          sourceReference: 'https://northwind.example.test/about',
          retrievedAt: '2026-09-28T14:00:00.000Z',
          confidence: null,
        },
      ],
      judgments: null,
      runs: [],
      links: [],
    },
    settings: null,
    worstCaseRunCents: null,
    spend: null,
    notice: null,
    mayMutate: true,
    role: 'salesperson',
  }),
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
        hasRecording: true,
        callLogId: 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb',
        outcome: 'interested',
      },
    ],
  }),
  'meetings.forFirm': () => ({ meetings: [] }),
  'meetings.unmatched': () => ({ meetings: [] }),
};

test('the board, then the panel beside it', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, ...busyBoard() }), operations });
  await page.goto(app.url('#pipeline'));
  await expect(page.getByTestId('pipeline-board')).toBeVisible();
  await expect(page.getByTestId('board-totals')).toContainText('As of today');
  await shoot(page, 'board');

  await page.getByTestId('pipeline-open-firm').filter({ hasText: 'Northwind' }).click();
  await expect(page.getByTestId('firm-panel-name')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('stage-why')).toBeVisible();
  await shoot(page, 'board-panel');

  const row = page.getByTestId('pipeline-firm').first();
  await row.hover();
  await row.getByTestId('card-move').click();
  await shoot(page, 'board-editor-open');
});

test('the firm page', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage(), ...busyBoard() }), operations });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('heading')).toHaveText('Northwind Test Holdings');
  await expect(page.getByTestId('stage-why')).toBeVisible();
  await expect(page.getByTestId('call-history-outcome')).toHaveText('Conversation');
  await shoot(page, 'firm');
});

test('an empty board, and a board that could not be read', async ({ page }) => {
  const empty = pipelineView();
  for (const column of empty.columns) column.firms = [];
  app = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, pipeline: empty }), operations });
  await page.goto(app.url('#pipeline'));
  await expect(page.getByTestId('board-empty')).toBeVisible();
  await shoot(page, 'board-empty');
});

test('a board waiting for its first answer', async ({ page }) => {
  app = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, ...busyBoard() }), operations });
  const release = app.hold('crm.state');
  await page.goto(app.url('#pipeline'));
  await expect(page.getByTestId('pipeline-loading')).toBeVisible();
  await shoot(page, 'board-loading');
  release();
  await expect(page.getByTestId('pipeline-board')).toBeVisible();
});
