import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { saveMeetingNotes } from '../../meetings/notes.ts';
import { readMeetingOutcomes } from '../../meetings/outcomes.ts';
import { readMeetingQualification } from '../../meetings/qualification.ts';
import { readMeetingAnalysisSetting } from '../../meetings/analysisSettings.ts';
import { readMeetingTranscription } from '../../meetings/transcriptionSettings.ts';
import { readMeetingAutoRecordingSetting } from '../../meetings/autoRecordingSettings.ts';
import { meetingTranscriptionFixture } from './support/meetingTranscriptionFixture.ts';

let fixture: Awaited<ReturnType<typeof meetingTranscriptionFixture>>;
beforeAll(async () => { fixture = await meetingTranscriptionFixture(); });
afterAll(async () => { await fixture.db.drop(); });
it('persists partial unknown review notes without qualifying an ended booking or enabling paid work', async () => {
  const { context, db } = fixture;
  const meetingId = await fixture.meeting(), otherId = await fixture.meeting();
  // Fixture: a past scheduled end is not human attendance evidence.
  await db.session.query("UPDATE meetings SET starts_at=now()-interval '1 hour',ends_at=now()-interval '30 minutes' WHERE id=$1", [meetingId]);
  const before = {
    analysis: await readMeetingAnalysisSetting(context), transcription: await readMeetingTranscription(context),
    recording: await readMeetingAutoRecordingSetting(context),
  };
  const input = { meetingId, expectedRevision: 0, debrief: 'Main problem: unknown.\nNext step: unknown.', speakerMappings: [], itemOverrides: [], sufficient: false };
  expect(await withTransaction(db.session, () => saveMeetingNotes(context, input))).toMatchObject({ ok: true, value: { meetingId, revision: 1, sufficient: false } });
  expect(await readMeetingOutcomes(context, { meetingId })).toMatchObject({ meetingId, attendance: 'unconfirmed', notes: { debrief: input.debrief, sufficient: false }, items: [], tasks: [] });
  expect(await readMeetingQualification(context, meetingId)).toMatchObject({ attendanceConfirmed: false, qualified: false, buyingParticipant: 'unknown', maintenanceNeed: 'unknown', openToPaying: 'unknown' });
  expect(await readMeetingOutcomes(context, { meetingId: otherId })).toMatchObject({ notes: { revision: 0, debrief: '' }, tasks: [] });
  expect(await withTransaction(db.session, () => saveMeetingNotes(context, { ...input, debrief: 'Stale replacement' }))).toEqual({ ok: false, reason: 'notes_changed' });
  expect(await readMeetingOutcomes(context, { meetingId })).toMatchObject({ notes: { revision: 1, debrief: input.debrief } });
  expect({ analysis: await readMeetingAnalysisSetting(context), transcription: await readMeetingTranscription(context), recording: await readMeetingAutoRecordingSetting(context) }).toEqual(before);
});
