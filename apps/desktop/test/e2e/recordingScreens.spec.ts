import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { adminState } from './support/adminFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';
import type { RecordingItem, RecordingsView } from '../../src/shared/recordings.ts';

/**
 * Lane M4: the demo recording states where David sees them — Today's quiet Recordings group
 * (needs matching, failed), the firm page's meeting rows and Recordings list (waiting,
 * uploading, uploaded, failed), and Settings › Demo recordings folder. With `FSS_SCREENS_DIR`
 * set each scenario writes screenshots at 1280 and 1440 px. Invented folders, firms and people.
 */

const SCREENS = process.env['FSS_SCREENS_DIR'];
const SIZES = [
  { name: '1280', width: 1280, height: 800 },
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

const M = (n: number): string => `44444444-4444-4444-8444-44444444440${String(n)}`;
const item = (n: number, overrides: Partial<RecordingItem>): RecordingItem => ({
  itemId: String(n).repeat(32).slice(0, 32),
  version: 1,
  folderName: '2026-10-01 10.01.12 Callie demo between David Cui and Jordan Placeholder 81234567890',
  startedAt: '2026-10-01T15:01:12.000Z',
  state: 'waiting',
  meetingId: null,
  uploaded: 0,
  total: 2,
  failure: null,
  choices: [],
  ...overrides,
});
const view = (items: RecordingItem[]): RecordingsView => ({
  folder: { path: '/Users/david/Movies/Callie Demos', isDefault: true, available: true },
  items,
  notice: null,
});

const SORT = view([
  item(1, {
    state: 'needs_matching',
    folderName: '2026-10-02 13.58.40 Zoom Meeting 81234567891',
    startedAt: '2026-10-02T18:58:40.000Z',
    choices: [
      { meetingId: M(1), startsAt: '2026-10-02T19:00:00.000Z', firmId: FIRM_ID, firmName: 'Northwind Test Holdings', attendee: 'Jordan Placeholder' },
      { meetingId: M(2), startsAt: '2026-10-02T19:20:00.000Z', firmId: null, firmName: null, attendee: 'riley@example.test' },
    ],
  }),
  item(2, { state: 'failed', failure: 'upload_failed', meetingId: M(3), folderName: '2026-09-30 09.00.03 Callie demo between David Cui and Sam Example 81234567892' }),
]);

test('Today: a quiet Recordings group for needs matching and failed, with Choose meeting', async ({ page }) => {
  app = await startAppServer({ operations: { 'recordings.state': () => SORT, 'calling.history': () => ({ calls: [] }) } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(app.url());
  await expect(page.getByTestId('recording-to-sort')).toHaveCount(2);
  await shoot(page, 'today-recordings');
  await page.getByTestId('recording-choose').click();
  await page.getByTestId('recording-choice').first().click();
  await expect(page.getByTestId('recording-attach')).toBeEnabled();
  await shoot(page, 'today-recordings-choose');
});

test('the firm page: each meeting’s recording state, and its Recordings list', async ({ page }) => {
  const meeting = (n: number, state: string, startsAt: string) => ({ meetingId: M(n), state, startsAt, endsAt: startsAt.replace(':00:00.000Z', ':20:00.000Z'), attendanceSource: null });
  app = await startAppServer({
    crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }),
    operations: {
      'calling.history': () => ({ calls: [] }),
      'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
      'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
      'meetings.forFirm': () => ({
        meetings: [
          meeting(1, 'ended', '2026-10-02T19:00:00.000Z'),
          meeting(4, 'ended', '2026-10-01T15:00:00.000Z'),
          meeting(5, 'ended', '2026-09-30T14:00:00.000Z'),
          meeting(3, 'ended', '2026-09-29T14:00:00.000Z'),
        ],
      }),
      'recordings.state': () =>
        view([
          item(4, { state: 'waiting', meetingId: M(1), folderName: '2026-10-02 14.01.00 Callie demo between David Cui and Jordan Placeholder 81234567893', startedAt: '2026-10-02T19:01:00.000Z' }),
          item(5, { state: 'uploading', meetingId: M(4), uploaded: 1, total: 3 }),
          item(7, { state: 'failed', failure: 'no_audio', meetingId: M(3), folderName: '2026-09-29 10.00.00 Callie demo 81234567895', startedAt: '2026-09-29T15:00:00.000Z' }),
        ]),
      // R4: a registered meeting's recordings come from the server.
      'recordings.forFirm': () => ({
        truncated: false,
        recordings: [1, 2].map(n => ({
          recordingId: `55555555-5555-4555-8555-55555555555${String(n)}`,
          meetingId: M(5),
          segment: 1,
          participantLabel: n === 1 ? 'audioDavidCui11234567894.m4a' : 'audioSamExample21234567894.m4a',
          state: 'uploaded' as const,
          createdAt: '2026-09-30T15:30:00.000Z',
        })),
      }),
    },
  });
  await page.goto(app.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('meeting-recording-state')).toHaveCount(4);
  await page.getByTestId('firm-recordings').scrollIntoViewIfNeeded();
  await shoot(page, 'firm-recordings');
  await expect(page.getByTestId('firm-recording-registered')).toHaveCount(1);
  await page.getByTestId('firm-recording').nth(2).hover();
  await expect(page.getByTestId('firm-recording-retry')).toBeVisible();
  await shoot(page, 'firm-recordings-failed-hover');
});

test('Settings: the demo recordings folder, Choose… and Import a recording folder…', async ({ page }) => {
  app = await startAppServer({ admin: adminState(), operations: { 'recordings.state': () => view([]), 'recordings.chooseFolder': () => view([]) } });
  await page.goto(app.url('#admin'));
  await expect(page.getByTestId('recordings-folder-path')).toHaveText('/Users/david/Movies/Callie Demos');
  await page.getByTestId('recordings-folder-section').scrollIntoViewIfNeeded();
  await shoot(page, 'settings-recordings-folder');
  await page.getByTestId('recordings-folder-choose').click();
  expect(app.called('recordings.chooseFolder')).toHaveLength(1);
});
