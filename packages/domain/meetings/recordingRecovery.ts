import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { meetingSource } from './transcription.ts';
import type { RecordingCheck, UploaderBinding } from './recordings.ts';

/** Uses current ownership and the stored key, including a folded recording's old prefix. */
export async function authorizeRecordingRecovery(context: RepositoryContext, recordingId: string) {
  if (context.scope.actor.kind !== 'user') return null;
  const source = await meetingSource(context, recordingId, true);
  if (source === null || source.meeting_state === 'cancelled') return null;
  const ready = (await context.db.query('SELECT id FROM meeting_transcripts WHERE workspace_id=$1 AND recording_id=$2 LIMIT 1', [context.scope.workspaceId, source.id])).rows.length > 0;
  return { recordingId: source.id, meetingId: source.meeting_id, key: source.s3_key, sha256: source.sha256,
    sizeBytes: Number(source.size_bytes), status: ready ? 'ready' as const : source.processing_status };
}

/** Replaces bytes only. Identity, paid history, and attempt ceilings are never reset. */
export async function completeRecordingRecovery(context: RepositoryContext, input: { recordingId: string; commandId: string },
  verify: (key: string) => Promise<RecordingCheck>, binding: UploaderBinding): Promise<'resumed' | 'already_ready' | 'refused'> {
  const source = await authorizeRecordingRecovery(context, input.recordingId);
  if (source === null) return 'refused';
  if (source.status === 'ready') return 'already_ready';
  if (source.status !== 'needs_reupload' || !await binding.issued(source.key)) return 'refused';
  const checked = await verify(source.key);
  // Recovery is always bound to this uploader, including administrators.
  if (checked.verdict !== 'ok' || checked.uploadId === null || !await binding.wrote(source.key, checked.uploadId, false)) return 'refused';
  if ((await context.db.query("SELECT id FROM meeting_transcription_attempts WHERE workspace_id=$1 AND recording_id=$2 AND state IN ('reserved','submitting','started') LIMIT 1", [context.scope.workspaceId, source.recordingId])).rows.length > 0) return 'refused';
  const updated = (await context.db.query<{ wake_revision: number }>(`UPDATE meeting_recordings SET processing_status='queued',processing_reason=NULL,
    wake_revision=wake_revision+1,next_wake_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING wake_revision`, [context.scope.workspaceId, source.recordingId])).rows[0]!;
  await enqueueJob(context.db, { workspaceId: context.scope.workspaceId, kind: 'meeting.transcribe',
    idempotencyKey: jobIdempotencyKey.meetingTranscribe(source.recordingId, updated.wake_revision), payload: { recordingId: source.recordingId }, maxAttempts: 3 });
  await recordCrmAuditEvent(context, { action: 'meeting.recording_recovered', subjectKind: 'meeting', subjectId: source.meetingId, detail: { commandId: input.commandId } });
  return 'resumed';
}
