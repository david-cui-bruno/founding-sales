import { mkdir } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { adminState } from './support/adminFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { transcriptPage, MID } from '../support/meetingTranscriptFixture.ts';
const screens = process.env['FSS_SCREENS_DIR'];
let app: AppServer;
test.afterEach(async () => { await app?.stop(); });
for (const mode of ['ready', 'partial', 'funding', 'unavailable'] as const) {
  test(`meeting transcript: ${mode}, including narrow window`, async ({ page }) => {
    const value = transcriptPage(mode === 'unavailable' ? 'ready' : mode);
    app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }), operations: {
      'calling.history': () => ({ calls: [] }),
      'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
      'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
      'meetings.forFirm': () => ({ meetings: [{ meetingId: MID, state: 'ended', startsAt: '2026-10-02T19:00:00.000Z', endsAt: '2026-10-02T19:20:00.000Z', attendanceSource: null }] }),
      'recordings.state': () => ({ folder: { path: '/example/demos', isDefault: true, available: true }, items: [], notice: null }),
      'recordings.forFirm': () => ({ truncated: false, recordings: value.recordings.map(row => ({ recordingId: row.recordingId, meetingId: MID, segment: row.segment, participantLabel: row.participantLabel, state: row.status === 'ready' ? 'transcribed' : row.status === 'needs_reupload' ? 'failed' : 'uploaded', createdAt: '2026-10-02T20:00:00.000Z' })) }),
      'meetings.transcript': () => mode === 'unavailable' ? { page: null, reason: 'offline' } : { page: value, reason: null },
    } });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(app.url(`#firm/${FIRM_ID}`));
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.getByTestId('transcript-content')).toBeVisible();
    if (mode !== 'unavailable') await expect(page.getByTestId('transcript-source')).toHaveCount(2);
    else await expect(page.getByText(/The transcript is unavailable/)).toBeVisible();
    if (screens !== undefined) {
      await mkdir(screens, { recursive: true });
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByTestId('meeting-transcript').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${screens}/meeting-transcript-${mode}-${width}.png` });
      }
    }
    await page.getByRole('button', { name: 'Transcript', exact: true }).click();
    await expect(page.getByTestId('transcript-content')).toHaveCount(0);
  });
}
test('meeting transcript: settings are off with zero allowance', async ({ page }) => {
  const state = adminState();
  app = await startAppServer({ admin: { ...state, integrations: { callingProvider: 'tel', telephonyBudget: { dailyCeilingCents: 100, maxMinutesPerCall: 30, unitPriceMicros: 14000 }, calendarIntegration: 'off', voicemailScript: 'Hi there.', configured: { twilioVoice: { ok: false, missing: [] }, calcom: { ok: false, missing: [] } }, spentTodayCents: 0, meetingTranscription: { setting: { enabled: false, dailyCeilingCents: 0, creditCoverage: null }, spentTodayCents: 0 } } } });
  await page.goto(app.url('#admin'));
  await expect(page.getByRole('switch', { name: 'Transcribe demo meetings' })).toBeDisabled();
  await page.getByTestId('meeting-transcription-settings').scrollIntoViewIfNeeded();
  if (screens !== undefined) { await mkdir(screens, { recursive: true }); await page.screenshot({ path: `${screens}/meeting-transcript-settings.png` }); }
});
