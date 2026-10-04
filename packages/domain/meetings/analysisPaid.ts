import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSettingForRead, readSetting } from '../settings/store.ts';
import { readMeetingAnalysisSetting } from './analysisSettings.ts';
import { meetingBudgetDay } from './transcriptionBudget.ts';
import { reserveAttempt, markCalling, settleAttempt, listAttempts, type ReservationRow } from '../research/reservations.ts';
import { recordProviderCall } from '../research/ledger.ts';
import { bedrockModelOf } from '../classification/modelTransport.ts';
import { analysisHash } from './analysisInput.ts';
import { buildMeetingAnalysisRequest, validateMeetingAnalysisAnswer } from './analysisModel.ts';
import { lockAnalysisMeeting, readAnalysisRequest, readAnalysisCall, progressMeetingAnalysis, type AnalysisRequestRow } from './analysisRequests.ts';
import type { MeetingAnalysisPort, MeetingAnalysisCall, MeetingAnalysisAttempt, PreparedMeetingAnalysis } from './analysisAdapter.ts';
export const MEETING_ANALYSIS_PROVIDER = 'aws_bedrock.meeting_analysis';
export interface MeetingAnalysisDeps { accountId: string; port: MeetingAnalysisPort }
export type AnalysisBegin = { kind: 'done' } | { kind: 'held'; reason: string } | { kind: 'reserved'; reservationId: string };
export type AnalysisDispatch = { kind: 'done' } | { kind: 'held'; reason: string } | { kind: 'dispatch'; call: MeetingAnalysisCall; prepared: PreparedMeetingAnalysis };
export async function lockMeetingAnalysisBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.scope.workspaceId}:meeting_analysis_budget`]);
}
export async function meetingAnalysisFunding(context: RepositoryContext, at: string, deps: MeetingAnalysisDeps) {
  const setting = await readMeetingAnalysisSetting(context), stored = await readSetting(context, 'meeting_analysis'), coverage = setting.creditCoverage;
  const reason = !setting.enabled ? 'disabled' : setting.dailyCeilingCents === 0 ? 'zero_allowance' : deps.port.kind !== 'bedrock' ? 'route_unavailable'
    : coverage === null || coverage.accountId !== deps.accountId || coverage.status !== 'verified'
      || Date.parse(coverage.verifiedAt) > Date.parse(at) || Date.parse(coverage.validUntil) <= Date.parse(at) ? 'funding_unverified' : null;
  return { setting, version: stored.version, reason };
}
async function hold(context: RepositoryContext, id: string, reason: string, version: number, next: string, at: string): Promise<{ kind: 'held'; reason: string }> {
  for (const attempt of await listAttempts(context, subject(id))) if (attempt.state === 'reserved') await settleAttempt(context, { reservationId: attempt.id, at, outcome: { kind: 'released' } });
  await context.db.query("UPDATE meeting_analysis_requests SET state='held',reason=$3,settings_version=$4,next_wake_at=$5,deadline_at=CASE WHEN paid_attempts=0 THEN NULL ELSE deadline_at END WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, id, reason, version, next]);
  return { kind: 'held', reason };
}
async function lockRequest(context: RepositoryContext, id: string): Promise<AnalysisRequestRow | null> {
  const located = await readAnalysisRequest(context, id);
  if (located?.meeting_id !== null && located?.meeting_id !== undefined && await lockAnalysisMeeting(context, located.meeting_id) === null) return null;
  return await readAnalysisRequest(context, id, true);
}
const subject = (id: string) => ({ subjectKind: 'meeting_analysis' as const, subjectId: id });
function cost(model: string, inputTokens: number, outputTokens: number): number {
  const price = bedrockModelOf(model);
  if (price === undefined) throw new Error('analysis_model_unpriced');
  return Math.ceil((inputTokens * price.inputCentsPerMillion + outputTokens * price.outputCentsPerMillion) / 1000000);
}
async function fail(context: RepositoryContext, id: string, reason: string, at: string): Promise<AnalysisBegin> {
  for (const attempt of await listAttempts(context, subject(id))) await settleAbandoned(context, attempt, at);
  await context.db.query("UPDATE meeting_analysis_requests SET state='failed',reason=$3,finished_at=$4 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, id, reason, at]);
  return { kind: 'done' };
}
export async function beginMeetingAnalysisRequest(context: RepositoryContext, input: { requestId: string; at: string }, deps: MeetingAnalysisDeps): Promise<AnalysisBegin> {
  await lockSettingForRead(context, 'meeting_analysis'); await lockMeetingAnalysisBudget(context);
  const row = await lockRequest(context, input.requestId);
  if (row === null || ['ready', 'failed', 'estimated', 'calling'].includes(row.state)) return { kind: 'done' };
  const funding = await meetingAnalysisFunding(context, input.at, deps);
  if (funding.reason !== null) return await hold(context, row.id, funding.reason, funding.version, '9999-01-01T00:00:00Z', input.at);
  if (row.meeting_id === null || row.paid_attempts >= 2 || bedrockModelOf(row.model_name) === undefined) return await fail(context, row.id, 'attempt_limit', input.at);
  if (row.deadline_at !== null && row.deadline_at.getTime() <= Date.parse(input.at)) return await fail(context, row.id, 'deadline_exceeded', input.at);
  const attempts = await listAttempts(context, subject(row.id)), open = attempts.find(a => a.state === 'reserved');
  if (open !== undefined) return { kind: 'reserved', reservationId: open.id };
  if (row.reservation_count >= 6) return await fail(context, row.id, 'attempt_limit', input.at);
  const call = await readAnalysisCall(context, row);
  if (!call.ok) return await fail(context, row.id, call.reason, input.at);
  const prepared = await deps.port.prepare(call.value);
  if (!prepared.ok) return await fail(context, row.id, prepared.reason, input.at);
  const day = await meetingBudgetDay(context, input.at), cents = cost(row.model_name, prepared.value.inputTokens, prepared.value.request.max_tokens);
  const spent = Number((await context.db.query<{ cents: string }>(`SELECT COALESCE(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END),0)::text AS cents
    FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='meeting_analysis' AND business_date=$2::date`, [context.scope.workspaceId, day.date])).rows[0]?.cents ?? 0);
  if (spent + cents > funding.setting.dailyCeilingCents) return await hold(context, row.id, 'budget_held', funding.version, day.next, input.at);
  const reservation = await reserveAttempt(context, { ...subject(row.id), providerKey: MEETING_ANALYSIS_PROVIDER, attempt: row.reservation_count + 1, at: input.at,
    businessTimeZone: day.zone, cents, modelName: row.model_name, maxInputTokens: prepared.value.inputTokens, maxOutputTokens: prepared.value.request.max_tokens });
  await context.db.query(`UPDATE meeting_analysis_requests SET state='reserved',reservation_id=$3,reservation_count=reservation_count+1,prepared_hash=$4,settings_version=$5,
    deadline_at=COALESCE(deadline_at,$6::timestamptz+interval '120 minutes'),reason=NULL WHERE workspace_id=$1 AND id=$2`,
    [context.scope.workspaceId, row.id, reservation.id, analysisHash(prepared.value.request), funding.version, input.at]);
  return { kind: 'reserved', reservationId: reservation.id };
}
export async function dispatchMeetingAnalysisRequest(context: RepositoryContext, input: { requestId: string; reservationId: string; at: string }, deps: MeetingAnalysisDeps): Promise<AnalysisDispatch> {
  await lockSettingForRead(context, 'meeting_analysis'); await lockMeetingAnalysisBudget(context);
  const row = await lockRequest(context, input.requestId);
  if (row === null || row.state !== 'reserved' || row.reservation_id !== input.reservationId) return { kind: 'done' };
  const funding = await meetingAnalysisFunding(context, input.at, deps);
  const call = await readAnalysisCall(context, row);
  const request = call.ok ? buildMeetingAnalysisRequest(call.value) : null;
  const attempt = (await listAttempts(context, subject(row.id))).find(a => a.id === input.reservationId);
  const reason = funding.reason ?? (!call.ok || request === null || analysisHash(request) !== row.prepared_hash ? 'source_changed' : null)
    ?? (row.deadline_at !== null && row.deadline_at.getTime() <= Date.parse(input.at) ? 'deadline_exceeded' : null);
  if (reason !== null || attempt === undefined || row.paid_attempts >= 2) {
    await settleAttempt(context, { reservationId: input.reservationId, at: input.at, outcome: { kind: 'released' } });
    return await hold(context, row.id, reason ?? 'attempt_limit', funding.version, '9999-01-01T00:00:00Z', input.at);
  }
  if (!call.ok || request === null || !await markCalling(context, attempt.id)) return { kind: 'done' };
  await context.db.query("UPDATE meeting_analysis_requests SET state='calling',paid_attempts=paid_attempts+1 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, row.id]);
  return { kind: 'dispatch', call: call.value, prepared: { request, inputTokens: attempt.maxInputTokens } };
}
export async function completeMeetingAnalysisRequest(context: RepositoryContext, input: { requestId: string; attemptId: string; result: MeetingAnalysisAttempt; at: string }): Promise<'accepted' | 'stale' | 'retry' | 'failed'> {
  await lockMeetingAnalysisBudget(context);
  const row = await lockRequest(context, input.requestId);
  if (row === null || row.reservation_id !== input.attemptId || row.state !== 'calling') return 'stale';
  const attempt = (await listAttempts(context, subject(row.id))).find(a => a.id === input.attemptId);
  if (attempt === undefined) return 'stale';
  await recordProviderCall(context, { providerKey: MEETING_ANALYSIS_PROVIDER, at: input.at, businessTimeZone: attempt.businessTimeZone, costCents: 0 });
  const result = input.result;
  const outcome = result.outcome === 'provider_refused' ? { kind: 'settled' as const, cents: 0 } : result.usage === null ? { kind: 'estimated' as const }
    : { kind: 'settled' as const, cents: cost(row.model_name, result.usage.inputTokens + result.usage.cachedInputTokens, result.usage.outputTokens) };
  await settleAttempt(context, { reservationId: input.attemptId, at: input.at, outcome });
  const call = await readAnalysisCall(context, row);
  if (!call.ok) { await fail(context, row.id, 'source_changed', input.at); return 'stale'; }
  const validated = result.outcome === 'accepted' && result.content !== null ? validateMeetingAnalysisAnswer(JSON.stringify(result.content), call.value.input) : null;
  if (validated?.ok === true) {
    await context.db.query("UPDATE meeting_analysis_requests SET state='ready',result=$3::jsonb,finished_at=$4,reason=NULL WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, row.id, JSON.stringify(validated.value), input.at]);
    if (row.meeting_id !== null) await progressMeetingAnalysis(context, row.meeting_id, input.at);
    return 'accepted';
  }
  const terminal = ['refusal', 'provider_refused'].includes(result.outcome) || row.paid_attempts >= 2 || (row.deadline_at !== null && row.deadline_at.getTime() <= Date.parse(input.at));
  await context.db.query(`UPDATE meeting_analysis_requests SET state=$3,reason=$4,next_wake_at=$5,finished_at=CASE WHEN $3='failed' THEN $5::timestamptz END WHERE workspace_id=$1 AND id=$2`,
    [context.scope.workspaceId, row.id, terminal ? 'failed' : 'queued', result.outcome === 'accepted' ? 'evidence_invalid' : result.outcome, input.at]);
  if (row.meeting_id !== null) await progressMeetingAnalysis(context, row.meeting_id, input.at);
  return terminal ? 'failed' : 'retry';
}
/** Scheduler expiry does not depend on a healthy worker or a surviving source. */
export async function expireMeetingAnalysisRequest(context: RepositoryContext, requestId: string, at: string): Promise<void> {
  await lockMeetingAnalysisBudget(context);
  const row = await lockRequest(context, requestId);
  if (row === null || row.deadline_at === null || row.deadline_at.getTime() > Date.parse(at) || ['ready', 'failed', 'estimated'].includes(row.state)) return;
  for (const attempt of await listAttempts(context, subject(row.id))) await settleAbandoned(context, attempt, at);
  await fail(context, row.id, 'deadline_exceeded', at);
  if (row.meeting_id !== null) await progressMeetingAnalysis(context, row.meeting_id, at);
}
async function settleAbandoned(context: RepositoryContext, attempt: ReservationRow, at: string): Promise<void> {
  if (attempt.state === 'reserved' || attempt.state === 'calling') await settleAttempt(context, { reservationId: attempt.id, at, outcome: { kind: attempt.state === 'reserved' ? 'released' : 'estimated' } });
}

/** Only the fenced worker that owns the committed calling marker may assert it did not call. */
export async function abandonMeetingAnalysisDispatch(context: RepositoryContext, input: { requestId: string; reservationId: string; at: string; reason: string }): Promise<void> {
  await lockMeetingAnalysisBudget(context);
  const row = await lockRequest(context, input.requestId);
  if (row?.state !== 'calling' || row.reservation_id !== input.reservationId) return;
  await settleAttempt(context, { reservationId: input.reservationId, at: input.at, outcome: { kind: 'released_not_called' } });
  await context.db.query("UPDATE meeting_analysis_requests SET paid_attempts=paid_attempts-1 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, row.id]);
  await hold(context, row.id, input.reason, row.settings_version, '9999-01-01T00:00:00Z', input.at);
}
