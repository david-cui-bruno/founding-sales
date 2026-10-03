import type { RepositoryContext } from '../db/workspaceScope.ts';
/** Internal identity resolution. Callers still authorize the current meeting before disclosure. */
export async function resolveMeetingRecording(context: RepositoryContext, recordingId: string): Promise<{
    recordingId: string;
    meetingId: string;
    aliasIds: readonly string[];
} | null> {
    const workspace = context.scope.workspaceId;
    const row = (await context.db.query<{
        id: string;
        meeting_id: string;
    }>(`SELECT id,meeting_id FROM meeting_recordings
    WHERE workspace_id=$1 AND (id=$2 OR id=(SELECT recording_id FROM meeting_recording_aliases WHERE workspace_id=$1 AND alias_id=$2))`, [workspace, recordingId])).rows[0];
    if (row === undefined)
        return null;
    const aliases = (await context.db.query<{
        alias_id: string;
    }>('SELECT alias_id FROM meeting_recording_aliases WHERE workspace_id=$1 AND recording_id=$2 ORDER BY alias_id', [workspace, row.id])).rows;
    return { recordingId: row.id, meetingId: row.meeting_id, aliasIds: aliases.map(alias => alias.alias_id) };
}
/** Both meeting locks are held by the fold; do not erase paid work or speech with a duplicate row. */
export async function mergeRecordingIdentity(context: RepositoryContext, from: string, to: string): Promise<void> {
    const workspace = context.scope.workspaceId;
    for (const table of ['meeting_transcripts', 'meeting_transcription_attempts', 'meeting_recording_aliases'] as const) {
        await context.db.query(`UPDATE ${table} SET recording_id=$3 WHERE workspace_id=$1 AND recording_id=$2`, [workspace, from, to]);
    }
    await context.db.query('INSERT INTO meeting_recording_aliases (workspace_id,alias_id,recording_id) VALUES ($1,$2,$3)', [workspace, from, to]);
    await context.db.query('DELETE FROM meeting_recordings WHERE workspace_id=$1 AND id=$2', [workspace, from]);
    await context.db.query(`UPDATE meeting_recordings SET state='transcribed',processing_status='ready',processing_reason=NULL
    WHERE workspace_id=$1 AND id=$2 AND EXISTS (SELECT 1 FROM meeting_transcripts WHERE workspace_id=$1 AND recording_id=$2)`, [workspace, to]);
}
