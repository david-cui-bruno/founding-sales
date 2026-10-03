import { randomUUID } from 'node:crypto';
import { authorizeRecordingRecovery, completeRecordingRecovery } from '@fss/domain/meetings/recordingRecovery.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { MeetingAudioUnavailableError, MEETING_AUDIO_TOTAL_TIMEOUT_MS, sha256Base64 } from '../integrations/meetingAudio.ts';
import { recordingRecoveryCommandSchema, recordingRecoveryUrlSchema } from '@fss/contracts';
import { uuid } from '@fss/contracts';
import { readMeetingTranscript, MeetingTranscriptChangedError, MeetingTranscriptCursorError } from '@fss/domain/meetings/transcripts.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';
export const MEETING_TRANSCRIPTION_PATHS: readonly string[] = ['/meetings/transcript', '/meetings/recordings/recovery-url', '/meetings/recordings/recovery-complete'];
export async function routeMeetingTranscription(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
    if (!MEETING_TRANSCRIPTION_PATHS.includes(request.path))
        return null;
    if (options.auth === undefined)
        return { status: 404, body: { error: 'not_found' } };
    if (request.path !== '/meetings/transcript') return await routeRecovery(request, options);
    if (request.method !== 'GET')
        return { status: 405, body: { error: 'method_not_allowed' } };
    const auth = await requirePrincipal(options.auth, request);
    if (!auth.ok)
        return auth.result;
    const scoped = contextForPrincipal(options.auth, auth.principal);
    if (!scoped.ok)
        return scoped.result;
    const meetingId = uuid.safeParse(request.query?.get('meetingId'));
    const cursor = request.query?.get('cursor') ?? undefined;
    if (!meetingId.success || (cursor?.length ?? 0) > 500)
        return { status: 400, body: { error: 'invalid_input' } };
    try {
        const value = await readMeetingTranscript(scoped.context, { meetingId: meetingId.data, ...(cursor === undefined ? {} : { cursor }) });
        return value === null ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: value };
    }
    catch (error) {
        if (error instanceof MeetingTranscriptChangedError)
            return { status: 409, body: { error: 'transcript_changed' } };
        if (error instanceof MeetingTranscriptCursorError)
            return { status: 400, body: { error: 'invalid_cursor' } };
        throw error;
    }
}

async function routeRecovery(request: ApiRequest, options: RoutingOptions): Promise<RouteResult> {
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const auth = options.auth, audio = options.meetingAudio;
  if (auth === undefined || audio === undefined) return { status: 404, body: { error: 'not_found' } };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;
  const deps = { auth, request, principal: authenticated.principal };
  const refused = { ok: false as const, reason: 'recording_recovery_unavailable' };
  if (request.path === '/meetings/recordings/recovery-url') {
    type Receipt = { status: 'ready' } | { status: 'upload'; recordingId: string; meetingId: string; key: string; sha256: string; sizeBytes: number; uploadId: string; issuedTo: string };
    const answer = await runRouteCommand<typeof recordingRecoveryCommandSchema, Receipt>(deps, recordingRecoveryCommandSchema, 'meeting_recording_recovery_url', async (context, body) => {
      const source = await authorizeRecordingRecovery(context, body.recordingId);
      if (source === null) return refused;
      if (source.status === 'ready') return { ok: true, value: { status: 'ready' } };
      if (source.status !== 'needs_reupload') return refused;
      return { ok: true, value: { ...source, status: 'upload', uploadId: randomUUID(), issuedTo: authenticated.principal.userId } };
    });
    if (answer.status !== 200) return answer;
    const envelope = answer.body as { status: string; replayed: boolean; result: Receipt };
    // A replay also creates a bearer credential. Recheck current ownership under locks.
    return await withTransaction(auth.db, async () => {
      const input = recordingRecoveryCommandSchema.parse(request.body);
      const current = await authorizeRecordingRecovery(scoped.context, input.recordingId);
      if (current === null) return { status: 409, body: { status: 'refused', reason: refused.reason } };
      if (current.status === 'ready') return { status: 200, body: { ...envelope, result: { status: 'ready' } } };
      const kept = envelope.result;
      if (current.status !== 'needs_reupload' || kept.status !== 'upload' || kept.issuedTo !== authenticated.principal.userId || kept.key !== current.key || kept.sha256 !== current.sha256 || kept.sizeBytes !== current.sizeBytes) return { status: 409, body: { status: 'refused', reason: refused.reason } };
      const put = await audio.presignPut({ key: current.key, sizeBytes: current.sizeBytes, sha256Hex: current.sha256, uploadId: kept.uploadId });
      const result = recordingRecoveryUrlSchema.parse({ status: 'upload', recordingId: current.recordingId, meetingId: current.meetingId, sha256: current.sha256, sizeBytes: current.sizeBytes, upload: { status: 'upload', key: current.key, ...put } });
      return { status: 200, body: { ...envelope, result } };
    });
  }
  try {
    return await runRouteCommand(deps, recordingRecoveryCommandSchema, 'meeting_recording_recovery_complete', async (context, body) => {
      const source = await authorizeRecordingRecovery(context, body.recordingId);
      if (source === null) return refused;
      const receipts = `FROM command_receipts WHERE workspace_id=$1 AND command_kind='meeting_recording_recovery_url'
        AND result_status='accepted' AND result->>'key'=$2 AND result->>'issuedTo'=$3 AND result->>'sha256'=$4 AND result->>'sizeBytes'=$5`;
      const params = [context.scope.workspaceId, source.key, authenticated.principal.userId, source.sha256, String(source.sizeBytes)];
      const result = await completeRecordingRecovery(context, body, async key => {
        const head = await audio.head(key, AbortSignal.timeout(MEETING_AUDIO_TOTAL_TIMEOUT_MS));
        if (!head.found) return { verdict: 'recording_missing', uploadId: null };
        return { verdict: head.sizeBytes !== source.sizeBytes ? 'recording_size_mismatch' : head.sha256Base64 !== sha256Base64(source.sha256) ? 'recording_checksum_mismatch' : 'ok', uploadId: head.uploadId };
      }, {
        issued: async () => (await auth.db.query(`SELECT 1 ${receipts} LIMIT 1`, params)).rows.length > 0,
        wrote: async (_key, uploadId) => (await auth.db.query(`SELECT 1 ${receipts} AND result->>'uploadId'=$6 LIMIT 1`, [...params, uploadId])).rows.length > 0,
      });
      return result === 'refused' ? refused : { ok: true, value: { status: result } };
    });
  } catch (error) {
    if (error instanceof MeetingAudioUnavailableError) return { status: 503, body: { error: 'storage_unavailable' } };
    throw error;
  }
}
