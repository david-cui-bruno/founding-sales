import type { MeetingNoteItem } from '@fss/contracts';
import { withTransaction } from '../../../db/queryable.ts';
import { assembleMeetingAnalysisInput } from '../../../meetings/analysisInput.ts';
import { materializeMeetingAnalysis } from '../../../meetings/analysisRequests.ts';
import { validateMeetingAnalysisAnswer } from '../../../meetings/analysisModel.ts';
import { meetingOutcomesFixture } from './meetingOutcomesFixture.ts';
export async function meetingTasksFixture() {
  const f = await meetingOutcomesFixture();
  const publish = async (meetingId: string, items: readonly MeetingNoteItem[]) => {
    const input = await assembleMeetingAnalysisInput(f.context, { meetingId });
    if (!input.ok) throw new Error(input.reason);
    const validated = validateMeetingAnalysisAnswer(JSON.stringify({ overview: 'Maintenance discussion.', items, reviewReasons: [] }), input.value);
    if (!validated.ok) throw new Error(validated.reason);
    const analysis = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at: '2026-10-04T12:00:00Z' }));
    if (!analysis.ok) throw new Error(analysis.reason);
    await f.db.session.query("UPDATE meeting_analyses SET state='ready',items=$2::jsonb,source_complete=true,tasks_pending=true WHERE id=$1", [analysis.value.analysisId, JSON.stringify(validated.value.items)]);
    return { analysisId: analysis.value.analysisId, meetingId, expectedSourceHash: input.value.sourceHash, items: validated.value.items };
  };
  const promise = async (quote: string, owner: 'you' | 'prospect' | 'unknown' = 'you', deadlineText: string | null = 'tomorrow') => {
    const meetingId = await f.meeting();
    await f.db.session.query("UPDATE meetings SET starts_at='2026-10-03T14:00:00Z',ends_at='2026-10-03T14:20:00Z' WHERE id=$1", [meetingId]);
    const source = await f.speech(meetingId, quote);
    const { saveMeetingNotes } = await import('../../../meetings/notes.ts');
    await withTransaction(f.db.session, () => saveMeetingNotes(f.context, { meetingId, expectedRevision: 0, debrief: '', sufficient: true, itemOverrides: [],
      speakerMappings: [{ recordingId: source.recordingId, speaker: null, owner, label: 'David', zone: 'America/New_York' }] }));
    const item: MeetingNoteItem = { id: 'proposed', kind: 'commitment', text: 'Send the guide', provenance: 'stated', owner, deadline: null, deadlineText, reviewReasons: [],
      evidence: [{ kind: 'transcript', ...source, transcriptVersion: 1, utteranceId: `${source.transcriptId}:1`, quote, startMs: 0, endMs: 900 }] };
    return { ...await publish(meetingId, [item]), source, item };
  };
  return { ...f, publish, promise };
}
