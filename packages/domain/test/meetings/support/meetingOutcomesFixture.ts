import { meetingTranscriptionFixture } from './meetingTranscriptionFixture.ts';
import { saveMeetingNotes } from '../../../meetings/notes.ts';
import { withTransaction } from '../../../db/queryable.ts';
export async function meetingOutcomesFixture() {
  const f = await meetingTranscriptionFixture();
  const save = async (meetingId: string, debrief: string, expectedRevision = 0, sufficient = true) =>
    await withTransaction(f.db.session, () => saveMeetingNotes(f.context, { meetingId, debrief, expectedRevision, sufficient, speakerMappings: [], itemOverrides: [] }));
  const speech = async (meetingId: string, text: string, speaker: string | null = null) => {
    const recordingId = await f.recording(meetingId);
    const transcriptId = await f.transcript(recordingId);
    await f.db.session.query("UPDATE meeting_transcripts SET utterances=$3::jsonb WHERE workspace_id=$1 AND id=$2", [f.workspace, transcriptId,
      JSON.stringify([{ startMs: 0, endMs: 900, text, speaker, attribution: 'source_label' }])]);
    await f.db.session.query('UPDATE meetings SET transcript_source_revision=transcript_source_revision+1 WHERE workspace_id=$1 AND id=$2', [f.workspace, meetingId]);
    return { recordingId, transcriptId };
  };
  const tasks = async (meetingId: string) => (await f.db.session.query('SELECT * FROM meeting_tasks WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY id', [f.workspace, meetingId])).rows;
  return { ...f, save, speech, tasks };
}
