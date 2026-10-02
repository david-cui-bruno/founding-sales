import { CALL_ANALYSIS_PENDING_SOURCE, PENDING_HOLD_REVIEW_AFTER_HOURS, type BlockedActionKind } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { openHold } from '../policy/holds.ts';
import { lockSendGateForStopFact, sendGateLockName } from '../policy/sendGate.ts';
import { readCallTranscription } from '../settings/integrations.ts';
import { callAnalysisAdmission } from './analysisEligibility.ts';
import { enqueueCallTranscription, transcriptionWorkerAvailable, type EnqueueTranscriptionOutcome } from './transcription.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';

/**
 * The pending-review hold (slice 3a, DESIGN-S3A §2.5).
 *
 * An answered call that will be transcribed and analysed has nothing logged yet, and until
 * David logs it (or says there is nothing to log) the firm's automated e-mail, its
 * enrollments and its call tasks wait. Calling does not: he may ring the firm again.
 *
 * ## Admission: from the accumulated facts, on every delivery
 *
 * Twilio's status and recording callbacks arrive in any order, repeated, and each carries
 * only part of the story: a terminal `completed` may come before the `in-progress` that
 * would set `answered_at` (which then never moves backward), and the duration may come on
 * a repeated terminal callback or only with the recording. So `admitPendingHold` runs on
 * **every** status and recording delivery, duplicates included, and reads the facts the
 * row has accumulated so far. It opens the hold when all of these hold:
 *
 *   * the call is admitted to the analysis path (`callAnalysisAdmission`,
 *     `analysisEligibility.ts`): `answered_at` set, a recording of at least
 *     `TRANSCRIPTION_MINIMUM_SECONDS` by its own duration, and `call_transcription` on —
 *     the rule the transcription enqueue applies, so a call is held exactly when it is on
 *     its way to an analysis (slice S3T). In practice that is the recording delivery;
 *   * its transcription is queued (a `call.transcribe` job exists): `admitToAnalysisPath`
 *     enqueues it first, in the same delivery, so the two never part (review S3T, finding 2);
 *   * the call has no log;
 *   * no `call_analysis_pending` hold for this session has **ever** existed.
 *
 * Before S3T the hold asked for a terminal status, `answered_at` or a provider status of
 * `completed`, and `coalesce(duration_seconds, recording_duration_seconds) >= 20`. It held
 * calls that were never analysed (no recording, a short recording, no recorded answer) and
 * missed calls that were (a short call duration with a longer recording).
 *
 * ## Locks
 *
 * Both callbacks take the send gate, then the firm, then the session row — the gate
 * serialises the existence check and the insert, so two deliveries never both open one,
 * and a released hold is never reopened. `active_holds_one_pending_review` (0036) says the
 * same in the database.
 *
 * ## The hold
 *
 * A firm-scoped `scoped_pause`, source kind `call_analysis_pending`, source id the session,
 * recovery `review_call`, blocking `email_send`, `enrollment_advance` and `call_task` — not
 * `dial_authorization`. No new reason code, so every installed firm page parses it.
 * Released at the call's first log link (`logCallOutcome`) or by Dismiss. After three hours
 * open it is in Needs review: a derived read, no job.
 */

export const PENDING_HOLD_BLOCKED_ACTIONS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'enrollment_advance',
  'call_task',
]);

export { CALL_ANALYSIS_PENDING_SOURCE, PENDING_HOLD_REVIEW_AFTER_HOURS };

/**
 * The callbacks' prefix: the send gate, then the firm, for the session a Call SID names,
 * before the session row's own lock. Located unlocked; not found is `null`, and the caller
 * answers it as any unknown SID (the SID is set when the call is placed, so only a callback
 * racing its own placement lands here).
 */
export async function lockGateAndFirmForCallSid(
  db: Queryable,
  callSid: string,
): Promise<{ readonly workspaceId: string; readonly firmId: string } | null> {
  const { rows: located } = await db.query<{ workspace_id: string; firm_id: string }>(
    `SELECT workspace_id, firm_id FROM call_sessions WHERE twilio_call_sid = $1 OR dial_call_sid = $1
      ORDER BY (twilio_call_sid = $1) DESC LIMIT 1`,
    [callSid],
  );
  const at = located[0];
  if (at === undefined) return null;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sendGateLockName(at.workspace_id)]);
  await db.query('SELECT 1 FROM firms WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [at.workspace_id, at.firm_id]);
  return { workspaceId: at.workspace_id, firmId: at.firm_id };
}

type SessionFacts = {
  readonly firm_id: string;
  readonly status: string;
  readonly provider_status: string | null;
  readonly answered: boolean;
  readonly recording: boolean;
  readonly recording_seconds: number | null;
  readonly call_log_id: string | null;
  readonly ever_held: boolean;
  readonly transcribe_queued: boolean;
};

/**
 * Admit the pending hold for one session if its accumulated facts now call for one.
 * The caller holds the gate, the firm and the session row (the callbacks' order). Returns
 * the hold opened, or null.
 */
export async function admitPendingHold(context: RepositoryContext, sessionId: string): Promise<string | null> {
  const { rows } = await context.db.query<SessionFacts>(
    `SELECT s.firm_id, s.status, s.provider_status, s.answered_at IS NOT NULL AS answered,
            s.recording_path IS NOT NULL AS recording, s.recording_duration_seconds AS recording_seconds, s.call_log_id,
            EXISTS (SELECT 1 FROM active_holds h
                     WHERE h.workspace_id = s.workspace_id AND h.source_event_kind = $3
                       AND h.source_event_id = s.id::text) AS ever_held,
            EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = s.workspace_id AND j.kind = 'call.transcribe'
                     AND j.payload ->> 'callSessionId' = s.id::text) AS transcribe_queued
       FROM call_sessions s WHERE s.workspace_id = $1 AND s.id = $2`,
    [context.scope.workspaceId, sessionId, CALL_ANALYSIS_PENDING_SOURCE],
  );
  const facts = rows[0];
  if (facts === undefined) return null;
  // No transcription queued, no analysis to come: nothing to wait for (review S3T, finding 2).
  if (facts.call_log_id !== null || facts.ever_held || !facts.transcribe_queued) return null;
  const transcription = await readCallTranscription(context);
  const admitted = callAnalysisAdmission({
    status: facts.status,
    providerStatus: facts.provider_status,
    answered: facts.answered,
    recording: facts.recording,
    recordingSeconds: facts.recording_seconds === null ? null : Number(facts.recording_seconds),
    transcriptionOn: transcription.enabled && transcription.dailyCeilingCents > 0,
  });
  if (admitted.kind !== 'eligible') return null;

  // `openHold` takes the gate again (re-entrant: the callback holds it already).
  const holdId = await openHold(context, {
    scopeKind: 'firm',
    scopeKey: facts.firm_id,
    reasonCode: 'scoped_pause',
    blockedActionKinds: PENDING_HOLD_BLOCKED_ACTIONS,
    sourceEventKind: CALL_ANALYSIS_PENDING_SOURCE,
    sourceEventId: sessionId,
    recoveryAction: 'review_call',
  });
  await recordCrmAuditEvent(context, {
    action: 'call.pending_review_held',
    subjectKind: 'active_hold',
    subjectId: holdId,
    detail: { firmId: facts.firm_id, callSessionId: sessionId },
  });
  return holdId;
}

/**
 * The analysis path's admission, for one delivery (review S3T, finding 2): first the idempotent
 * transcription enqueue (`enqueueCallTranscription`, keyed by the session, so a repeated
 * delivery queues nothing more), then the hold, which is admitted only once that job exists.
 * Run by both callbacks on every final delivery, inside their transaction and after their
 * gate → firm → session prefix, so whichever delivery completes the facts — the recording, or
 * an answer that arrives after it — queues the transcription and holds the firm together:
 * a call is never held without its transcription queued.
 */
export async function admitToAnalysisPath(
  db: Queryable,
  input: { readonly workspaceId: string; readonly sessionId: string },
): Promise<{ readonly transcription: EnqueueTranscriptionOutcome; readonly holdId: string | null }> {
  const transcription = await enqueueCallTranscription(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    // The key is the worker's alone; a live worker that can transcribe says so in its heartbeat.
    keyConfigured: await transcriptionWorkerAvailable(db),
  });
  const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
  return { transcription, holdId: await admitPendingHold(context, input.sessionId) };
}

/**
 * Release the session's open pending hold, if any: at the call's first log link, and by
 * Dismiss. Releasing is permissive, so it needs no gate of its own (`policy/sendGate.ts`).
 * Only this source kind for this session: a cadence park that names the same session as
 * its last attempt is a different hold and stays.
 */
export async function releasePendingHold(context: RepositoryContext, sessionId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `UPDATE active_holds SET released_at = now()
      WHERE workspace_id = $1 AND source_event_kind = $2 AND source_event_id = $3 AND released_at IS NULL
      RETURNING id`,
    [context.scope.workspaceId, CALL_ANALYSIS_PENDING_SOURCE, sessionId],
  );
  return rows[0]?.id ?? null;
}

export type DismissPendingOutcome =
  | { readonly ok: true; readonly value: { readonly callSessionId: string; readonly releasedHoldId: string | null } }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_assigned' | 'invalid_input' };

/**
 * `POST /calls/pending/dismiss`: David says the call needs no log. Gate → firm → session,
 * the callbacks' order, then the release. A session with no open hold answers null.
 *
 * A hold whose session is gone (deletion releases it in the same transaction now, so only a
 * hold from before that, or one a future path strands) is found by its source id and
 * released at the firm it blocks, under the same gate → firm order: a hold is never left
 * with no recovery (review S3B, finding 2).
 */
export async function dismissPendingHold(
  context: RepositoryContext,
  input: { readonly callSessionId: string },
): Promise<DismissPendingOutcome> {
  if (context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const { rows: located } = await context.db.query<{ firm_id: string; session: boolean }>(
    `SELECT firm_id, true AS session FROM call_sessions WHERE workspace_id = $1 AND id = $2
     UNION ALL
     SELECT h.scope_key::uuid, false FROM active_holds h
      WHERE h.workspace_id = $1 AND h.source_event_kind = $3 AND h.source_event_id = $2::text
        AND h.released_at IS NULL AND h.scope_kind = 'firm'
        AND NOT EXISTS (SELECT 1 FROM call_sessions s WHERE s.workspace_id = $1 AND s.id = $2)
     LIMIT 1`,
    [context.scope.workspaceId, input.callSessionId, CALL_ANALYSIS_PENDING_SOURCE],
  );
  const firmId = located[0]?.firm_id;
  if (firmId === undefined) return { ok: false, reason: 'not_found' };
  const sessionExists = located[0]?.session === true;
  await lockSendGateForStopFact(context);
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return { ok: false, reason: 'not_found' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { ok: false, reason: decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found' };
  const { rows: live } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, input.callSessionId],
  );
  if (sessionExists ? live[0]?.firm_id !== firmId : live.length > 0) return { ok: false, reason: 'not_found' };
  const released = await releasePendingHold(context, input.callSessionId);
  if (released !== null) {
    await recordCrmAuditEvent(context, {
      action: 'call.pending_review_dismissed',
      subjectKind: 'active_hold',
      subjectId: released,
      detail: { firmId, callSessionId: input.callSessionId },
    });
  }
  return { ok: true, value: { callSessionId: input.callSessionId, releasedHoldId: released } };
}
