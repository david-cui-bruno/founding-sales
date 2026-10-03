import { randomUUID } from 'node:crypto';
import { MEETING_TRANSCRIPTION_LIMITS, meetingSpeechSchema, type MeetingProcessingStatus, type RecordingSourceKind } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate, readFirm } from '../crm/firms.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { lockSettingForRead } from '../settings/store.ts';
import { markCalling, settleAttempt } from '../research/reservations.ts';
import { resolveMeetingRecording } from './recordingIdentity.ts';
import { lockMeetingBudget, meetingBudgetDay, meetingFunding, meetingSpent, meetingTranscriptionCents } from './transcriptionBudget.ts';
import type { MeetingProviderResult, PreparedMeetingAudio, MeetingTranscriptionProvider } from './transcriptionTypes.ts';

export interface MeetingSource {
  id: string; meeting_id: string; firm_id: string | null; meeting_state: string; s3_key: string; sha256: string;
  size_bytes: string; source_kind: RecordingSourceKind; participant_label: string; processing_status: MeetingProcessingStatus;
  [key: string]: unknown;
}
export interface MeetingAttempt {
  id: string; recording_id: string | null; original_recording_id: string; reservation_id: string; job_name: string;
  input_key: string; output_key: string; duration_ms: number; source_kind: RecordingSourceKind;
  state: 'reserved' | 'submitting' | 'started' | 'complete' | 'failed' | 'estimated' | 'released';
  deadline_at: Date; looks: number; [key: string]: unknown;
}
const active = (a: MeetingAttempt) => ['reserved', 'submitting', 'started'].includes(a.state);
/** Resolve before and after firm → meeting locks. A fold never changes an object's stored key. */
export async function meetingSource(context: RepositoryContext, recordingId: string, lock = false): Promise<MeetingSource | null> {
  const identity = await resolveMeetingRecording(context, recordingId);
  if (identity === null) return null;
  const sql = `SELECT r.*,m.firm_id,m.state AS meeting_state FROM meeting_recordings r JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE r.workspace_id=$1 AND r.id=$2`;
  const before = (await context.db.query<MeetingSource>(sql, [context.scope.workspaceId, identity.recordingId])).rows[0];
  if (before === undefined) return null;
  if (before.firm_id === null) {
    if (context.scope.actor.kind === 'user' && context.scope.actor.role !== 'admin') return null;
  } else {
    const firm = await (lock ? loadFirmForUpdate : readFirm)(context, before.firm_id);
    if (firm === null || !decideFirmMutation(context, firm).permitted) return null;
  }
  if (!lock) return before;
  await context.db.query('SELECT id FROM meetings WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, before.meeting_id]);
  const current = (await context.db.query<MeetingSource>(`${sql} FOR UPDATE OF r`, [context.scope.workspaceId, before.id])).rows[0];
  return current !== undefined && current.meeting_id === before.meeting_id && current.firm_id === before.firm_id ? current : null;
}
export async function holdMeetingSource(context: RepositoryContext, recordingId: string, reason: string, at: string, version: number): Promise<void> {
  const state: MeetingProcessingStatus = reason === 'source_missing' ? 'needs_reupload' : reason === 'daily_limit' ? 'budget_held'
    : reason === 'funding_unverified' ? 'funding_unverified' : ['disabled','zero_allowance','not_eligible','budget_expired'].includes(reason) ? 'disabled' : 'failed';
  const day = await meetingBudgetDay(context, at);
  await context.db.query(`UPDATE meeting_recordings SET processing_status=$3,processing_reason=$4,next_wake_at=$5,processing_settings_version=$6
    WHERE workspace_id=$1 AND id=$2 AND NOT EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.workspace_id=$1 AND t.recording_id=$2)`, [context.scope.workspaceId, recordingId, state, reason, day.next, version]);
}
export async function readMeetingAttempt(context: RepositoryContext, attemptId: string): Promise<MeetingAttempt | null> {
  return (await context.db.query<MeetingAttempt>('SELECT * FROM meeting_transcription_attempts WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, attemptId])).rows[0] ?? null;
}
const reserved = (a: MeetingAttempt) => ({ kind: 'reserved' as const, attemptId: a.id, reservationId: a.reservation_id, jobName: a.job_name, outputKey: a.output_key });
const held = (reason: string) => ({ kind: 'held' as const, reason });
/** Caller commits before dispatch: no provider effect is made by this function. */
export async function beginMeetingTranscription(context: RepositoryContext, input: { recordingId: string; prepared: PreparedMeetingAudio; at: string; accountId: string; jobPrefix: string }) {
  await lockSettingForRead(context, 'meeting_transcription');
  await lockMeetingBudget(context);
  const source = await meetingSource(context, input.recordingId, true);
  if (source === null) return held('not_eligible');
  const existing = (await context.db.query<MeetingAttempt>(`SELECT * FROM meeting_transcription_attempts WHERE workspace_id=$1 AND recording_id=$2 AND state IN ('reserved','submitting','started') ORDER BY created_at,id LIMIT 1`, [context.scope.workspaceId, source.id])).rows[0];
  if (existing !== undefined) return existing.state === 'reserved' ? reserved(existing) : held('collecting');
  if ((await context.db.query('SELECT id FROM meeting_transcripts WHERE workspace_id=$1 AND recording_id=$2 LIMIT 1', [context.scope.workspaceId, source.id])).rows.length > 0) return held('already_ready');
  const funding = await meetingFunding(context, input.at, input.accountId);
  const stop = async (reason: string) => { await holdMeetingSource(context, source.id, reason, input.at, funding.version); return held(reason); };
  if (source.firm_id === null || source.meeting_state === 'cancelled') return stop('not_eligible');
  if (funding.reason !== null) return stop(funding.reason);
  const identity = await resolveMeetingRecording(context, source.id);
  const ids = [source.id, ...identity?.aliasIds ?? []];
  const history = (await context.db.query<{ total: string; paid: string; own_attempt: number }>(`SELECT count(*)::text AS total,
    count(*) FILTER (WHERE state NOT IN ('released','reserved'))::text AS paid,
    COALESCE(max(attempt) FILTER (WHERE subject_id=$2),0)::integer AS own_attempt
    FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='meeting_transcription' AND subject_id=ANY($3::uuid[])`, [context.scope.workspaceId, source.id, ids])).rows[0]!;
  if (Number(history.paid) >= 2) return stop('attempt_limit');
  if (Number(history.total) >= 6) return stop('reservation_limit');
  const cents = meetingTranscriptionCents(input.prepared.durationMs);
  const day = await meetingBudgetDay(context, input.at);
  if (await meetingSpent(context, day.date) + cents > funding.setting.dailyCeilingCents) return stop('daily_limit');
  if (!/^meetings-processing\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.flac$/u.test(input.prepared.inputKey) || !/^[A-Za-z0-9_-]{1,80}$/u.test(input.jobPrefix)) return stop('invalid_media_identity');
  const reservationId = randomUUID(), attemptId = randomUUID();
  const jobName = `${input.jobPrefix}-meeting-${attemptId}`;
  const outputKey = input.prepared.inputKey.replace(/\.flac$/u, '.json');
  await context.db.query(`INSERT INTO provider_reservations (id,workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,priced_unit,max_units,unit_price_micros,state)
    VALUES ($1,$2,'aws_transcribe.standard','meeting_transcription',$3,$4,$5,$6,$7,'minute',$8,6000,'reserved')`, [reservationId, context.scope.workspaceId, source.id, history.own_attempt + 1, day.date, day.zone, cents, Math.max(1, Math.ceil(input.prepared.durationMs / 60000))]);
  await context.db.query(`INSERT INTO meeting_transcription_attempts (id,workspace_id,recording_id,original_recording_id,reservation_id,job_name,input_key,output_key,duration_ms,source_kind,created_at,deadline_at,next_check_at)
    VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$10::timestamptz+interval '120 minutes',$10)`, [attemptId, context.scope.workspaceId, source.id, reservationId, jobName, input.prepared.inputKey, outputKey, input.prepared.durationMs, source.source_kind, input.at]);
  await context.db.query(`UPDATE meeting_recordings SET processing_status='preparing',processing_reason=NULL,duration_ms=$3,processing_settings_version=$4 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, source.id, input.prepared.durationMs, funding.version]);
  return { kind: 'reserved' as const, attemptId, reservationId, jobName, outputKey };
}
async function release(context: RepositoryContext, attempt: MeetingAttempt, at: string, ownSubmitting = false): Promise<void> {
  await settleAttempt(context, { reservationId: attempt.reservation_id, at, outcome: { kind: ownSubmitting ? 'released_not_called' : 'released' } });
  await context.db.query("UPDATE meeting_transcription_attempts SET state='released',finished_at=$3 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, attempt.id, at]);
}
async function dispatchGate(context: RepositoryContext, attempt: MeetingAttempt, input: { at: string; accountId: string }, liveClock = false) {
  const source = attempt.recording_id === null ? null : await meetingSource(context, attempt.recording_id, true);
  if (liveClock) input.at = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  const funding = await meetingFunding(context, input.at, input.accountId);
  let reason = source === null || source.firm_id === null || source.meeting_state === 'cancelled' ? 'not_eligible' : funding.reason;
  const day = await meetingBudgetDay(context, input.at);
  const reservation = (await context.db.query<{ business_date: string }>('SELECT business_date::text FROM provider_reservations WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, attempt.reservation_id])).rows[0];
  if (reason === null && reservation?.business_date !== day.date) reason = 'budget_expired';
  if (reason === null && await meetingSpent(context, day.date) > funding.setting.dailyCeilingCents) reason = 'daily_limit';
  if (reason !== null && source !== null) await holdMeetingSource(context, source.id, reason, input.at, funding.version);
  return reason;
}
/** Durable paid marker. Only the winner may carry its dispatch into the next committed chunk. */
export async function dispatchMeetingTranscription(context: RepositoryContext, input: { attemptId: string; at: string; accountId: string }) {
  await lockSettingForRead(context, 'meeting_transcription'); await lockMeetingBudget(context);
  const attempt = await readMeetingAttempt(context, input.attemptId);
  if (attempt === null || attempt.state !== 'reserved') return held('collecting');
  const reason = await dispatchGate(context, attempt, input);
  if (reason !== null) { await release(context, attempt, input.at); return held(reason); }
  if (!await markCalling(context, attempt.reservation_id)) return held('collecting');
  await context.db.query("UPDATE meeting_transcription_attempts SET state='submitting' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, attempt.id]);
  return { kind: 'dispatch' as const, jobName: attempt.job_name, inputKey: attempt.input_key, outputKey: attempt.output_key, sourceKind: attempt.source_kind };
}
/** Only called with this claim's committed dispatch cursor. A new claim only collects. */
export async function submitMeetingTranscription(context: RepositoryContext, input: { attemptId: string; at: string; accountId: string; provider: MeetingTranscriptionProvider }) {
  await lockSettingForRead(context, 'meeting_transcription'); await lockMeetingBudget(context);
  const attempt = await readMeetingAttempt(context, input.attemptId);
  if (attempt === null || attempt.state !== 'submitting') return;
  const boundary = { at: input.at, accountId: input.accountId };
  const reason = await dispatchGate(context, attempt, boundary, true);
  if (reason !== null) { await release(context, attempt, boundary.at, true); return; }
  let answer: 'started' | 'ambiguous' | 'refused';
  try { answer = await input.provider.start({ jobName: attempt.job_name, inputKey: attempt.input_key, outputKey: attempt.output_key, sourceKind: attempt.source_kind }); }
  catch { answer = 'ambiguous'; }
  if (answer === 'refused') { await completeMeetingTranscription(context, { attemptId: attempt.id, at: boundary.at, result: { kind: 'failed', code: 'provider_refused' } }); return; }
  await context.db.query("UPDATE meeting_transcription_attempts SET state='started',next_check_at=$3::timestamptz+interval '30 seconds' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, attempt.id, boundary.at]);
  await context.db.query("UPDATE meeting_recordings SET state='transcribing',processing_status='transcribing',processing_reason=NULL WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, attempt.recording_id]);
}
/** Already-started work always settles, even after deletion or disablement. No deleted subject is recreated. */
export async function completeMeetingTranscription(context: RepositoryContext, input: { attemptId: string; result: MeetingProviderResult; at: string }): Promise<'pending' | 'complete' | 'failed' | 'gone'> {
  await lockMeetingBudget(context);
  let attempt = await readMeetingAttempt(context, input.attemptId);
  if (attempt === null) return 'gone';
  if (!active(attempt)) return attempt.state === 'complete' ? 'complete' : 'failed';
  const source = attempt.recording_id === null ? null : await meetingSource(context, attempt.recording_id, true);
  // A fold or deletion may have committed while acquiring the current association's locks.
  attempt = (await context.db.query<MeetingAttempt>('SELECT * FROM meeting_transcription_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, attempt.id])).rows[0]!;
  if (!active(attempt)) return attempt.state === 'complete' ? 'complete' : 'failed';
  const expired = Date.parse(input.at) >= attempt.deadline_at.getTime();
  if (attempt.state === 'reserved') { if (expired) await release(context, attempt, input.at); return 'pending'; }
  if (input.result.kind === 'pending' && !expired) {
    await context.db.query("UPDATE meeting_transcription_attempts SET looks=looks+1,next_check_at=$3::timestamptz + LEAST(300,30*power(2,LEAST(looks,4))) * interval '1 second' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, attempt.id, input.at]);
    return 'pending';
  }
  let result = input.result;
  if (expired && result.kind === 'pending') result = { kind: 'failed', code: 'collection_timeout' };
  if (result.kind === 'complete' && (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/u.test(result.language)
    || result.utterances.length > MEETING_TRANSCRIPTION_LIMITS.maxUtterances
    || Buffer.byteLength(JSON.stringify(result.utterances)) > MEETING_TRANSCRIPTION_LIMITS.maxTextBytes
    || result.utterances.some(u => !meetingSpeechSchema.safeParse(u).success || u.endMs > attempt.duration_ms))) result = { kind: 'failed', code: 'output_invalid' };
  if (result.kind === 'complete') {
    const utterances = result.utterances.map(u => attempt.source_kind === 'participant' ? { ...u, speaker: null, attribution: 'source_label' as const } : u);
    const bytes = Number((await context.db.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(utterances)])).rows[0]!.bytes);
    result = bytes > MEETING_TRANSCRIPTION_LIMITS.maxTextBytes ? { kind: 'failed', code: 'output_too_large' } : { ...result, utterances };
  }
  const reason = result.kind === 'failed' ? (/^[a-z][a-z0-9_]{0,79}$/u.test(result.code) ? result.code : 'provider_failed_unknown') : null;
  const free = reason === 'provider_refused' || reason === 'provider_failed';
  await settleAttempt(context, { reservationId: attempt.reservation_id, at: input.at, outcome: free ? { kind: 'settled', cents: 0 } : { kind: 'estimated' } });
  const state = result.kind === 'complete' ? 'complete' : reason === 'collection_timeout' ? 'estimated' : 'failed';
  await context.db.query('UPDATE meeting_transcription_attempts SET state=$3,reason=$4,finished_at=$5 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, attempt.id, state, reason, input.at]);
  if (source === null || attempt.recording_id !== source.id) return 'gone';
  if (source.firm_id === null || source.meeting_state === 'cancelled') {
    await holdMeetingSource(context, source.id, 'not_eligible', input.at, 0); return 'gone';
  }
  if (result.kind === 'complete') {
    const utterances = result.utterances;
    await context.db.query(`INSERT INTO meeting_transcripts (workspace_id,recording_id,original_recording_id,version,duration_ms,language,utterances,created_at)
      SELECT $1,$2,$3,COALESCE(max(version),0)+1,$4,$5,$6::jsonb,$7 FROM meeting_transcripts WHERE workspace_id=$1 AND original_recording_id=$3`, [context.scope.workspaceId, source.id, attempt.original_recording_id, attempt.duration_ms, result.language, JSON.stringify(utterances), input.at]);
    await context.db.query("UPDATE meeting_recordings SET state='transcribed',processing_status='ready',processing_reason=NULL,duration_ms=$3 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, source.id, attempt.duration_ms]);
    await context.db.query('UPDATE meetings SET transcript_source_revision=transcript_source_revision+1 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, source.meeting_id]);
    return 'complete';
  }
  await holdMeetingSource(context, source.id, reason ?? 'output_invalid', input.at, 0);
  return 'failed';
}
