import { readCallSessionClearance } from './sessionClearance.ts';
import {lockPreparedCallingLifecycle} from '../calling/preparationLifecycle.ts';
import {readPreparationExecution} from '../calling/preparationExecution.ts';
import { readCallCadence } from './cadence.ts';
import { parkFirmForReview } from './sessionCadence.ts';
import { randomUUID } from 'node:crypto';
import {
  CALL_OUTCOME_CORRECTED_ACTION,
  type CallCadence,
  type CallCorrectionReason,
  type CallLogCorrection,
  type CallOutcome,
  type CallSessionDto,
  type CallSessionRefusalCode,
  type CallSessionStatus,
  type DialRefusalCode,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { CallSessionResult } from './sessionTypes.ts';
import { clearTelephonyReservation, reserveTelephonyCall } from './sessionBudget.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { authorizeBrowserDialCommand } from '../dial/tickets.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm } from '../crm/firms.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { authorizeBrowserDial } from '../dial/authorize.ts';
import { readVoicemailScript } from '../settings/integrations.ts';
import { currentCallingIdentityId } from '../dial/identities.ts';
import { databaseNow } from '../policy/clock.ts';

/**
 * Call sessions: one Twilio call attempt, from authorization to its recording
 * (call-to-booking slice W, migration 0028).
 *
 * ## The flow, and where each decision is taken
 *
 *   1. `createCallSession` — `POST /calls/session`, a person's command. The attempt
 *      limit, the caller id and the budget are checked, then `authorizeBrowserDialCommand`
 *      runs browser authorization (suppression, identity, route at the displayed
 *      version, assignment and holds) and mints the
 *      sixty-second dial ticket, and the telephony reservation is written — all in the
 *      command's one transaction. The answer is the session id and its expiry; **the
 *      number stays on the ticket**.
 *   2. `consumeCallSession` — the TwiML voice route, after the Twilio signature. Exactly
 *      once, inside the minute, for the identity the access token was minted for. It
 *      takes the send gate SHARED first, as a dispatch claim does, and holds it to the
 *      commit: a suppression writer takes the gate EXCLUSIVE, so it either committed
 *      before the re-check (which then refuses) or waits until this authorization has
 *      committed — there is no window between the re-check and the `<Dial>`. Then the
 *      firm row, which serialises the attempt limit across sessions created earlier.
 *      The ticket is consumed through `consumeBrowserDialTicket`, which takes the whole
 *      decision again. The reservation is marked `calling` in the same transaction:
 *      from this commit on, a call may have happened.
 *   3. `recordCallStatus` / `recordCallRecording` — the callbacks, idempotent and
 *      retry-tolerant, by Call SID. The terminal status settles the reservation: at the
 *      billed price when Twilio reports one, otherwise at an estimate from the duration.
 *   4. `sweepCallSessionReservations` — the backstop: an unconsumed session's
 *      reservation is released once the session has expired (no call can have
 *      happened); a consumed one whose callback never came is estimated at its full
 *      reservation once the longest possible call is over.
 *
 * The paid-call pattern of `research/reservations.ts` exactly: reserve (1), mark calling
 * (2), settle by id (3), and a sweep for the lost ones (4).
 */

/** `provider_ledger.provider_key` and `provider_reservations.provider_key` for Twilio minutes. */
export { TELEPHONY_PROVIDER_KEY, telephonyReservationCents, telephonySpentCents, telephonySpentToday } from './sessionBudget.ts';
export type { CallSessionResult } from './sessionTypes.ts';

const refuse = <T>(reason: DialRefusalCode | CallSessionRefusalCode | 'invalid_input'): CallSessionResult<T> => ({ ok: false, reason });

export interface CreateCallSessionInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly callingIdentityId: string;
  readonly deviceId: string;
  readonly commandId: string;
  /** The caller id the Twilio configuration presents (`caller_id_e164`). */
  readonly configuredCallerIdE164: string;
  /**
   * Database time, read once. Absent means the database's `now()`; a test supplies the
   * instant, as `authorizeBrowserDialCommand` takes it (docs/decisions/g4-database-time-is-a-parameter.md).
   */
  readonly at?: string | undefined;
}

export async function createCallSession(
  context: RepositoryContext,
  input: CreateCallSessionInput,
): Promise<CallSessionResult<{ readonly sessionId: string; readonly expiresAt: string }>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('identity_not_owned');

  await lockPreparedCallingLifecycle(context.db,context.scope.workspaceId,input.firmId);
  await lockSendGateForStopFact(context);
  const preparation=await readPreparationExecution(context,input.firmId);
  if(!preparation.ok)return refuse(preparation.reason);
  await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.firmId]);
  const now = input.at ?? (await databaseNow(context));

  // The cadence (slice C1): unanswered attempts, their spacing, and parking. Before
  // anything is reserved, and a refusal here writes nothing but the parking hold. This
  // is the early refusal: the same cadence is held atomically at consumption, under the
  // firm lock (`consumeCallSession`), so sessions created together cannot all be placed.
  const cadence = await readCallCadence(context, input.firmId, now);
  if (cadence.refusal === 'call_attempts_exhausted' && cadence.parkingHoldId === null) {
    // Parked only by somebody the dial decision accepts for this firm, route and identity
    // (review of C1, fold 1, finding 4): another assignee's firm is refused as such, and a
    // refused command writes nothing.
    const decision = await authorizeBrowserDial(context, {
      firmId: input.firmId,
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
      routeId: input.routeId,
      routeVersion: input.routeVersion,
      callingIdentityId: input.callingIdentityId,
      at: now,
    });
    if (!decision.allowed) return refuse(decision.reason);
    await parkFirmForReview(context, input.firmId, cadence.lastAttemptSessionId);
  }
  if (cadence.refusal !== null) return refuse(cadence.refusal);

  // The caller id Twilio will present is the actor's verified identity, and it must be
  // the one the Twilio configuration names. `authorizeDial` below decides the identity
  // is the actor's own and usable; this only compares the number.
  const { rows: identities } = await context.db.query<{ e164: string }>(
    'SELECT e164 FROM calling_identities WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.callingIdentityId],
  );
  const identity = identities[0];
  if (identity !== undefined && identity.e164 !== input.configuredCallerIdE164) return refuse('caller_id_mismatch');

  const clearance = await clearTelephonyReservation(context, now);
  if (!clearance.ok) return clearance;

  await context.db.query('SAVEPOINT create_call_session');
  const undo = async (reason: DialRefusalCode | CallSessionRefusalCode): Promise<CallSessionResult<{ sessionId: string; expiresAt: string }>> => {
    await context.db.query('ROLLBACK TO SAVEPOINT create_call_session');
    return refuse(reason);
  };

  // The whole dial decision, and the ticket.
  const ticket = await authorizeBrowserDialCommand(context, {
    firmId: input.firmId,
    ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
    routeId: input.routeId,
    routeVersion: input.routeVersion,
    callingIdentityId: input.callingIdentityId,
    deviceId: input.deviceId,
    commandId: input.commandId,
    at: now,
  });
  if (!ticket.ok) return refuse(ticket.reason);

  const sessionId = randomUUID();
  const reservationId = await reserveTelephonyCall(context, sessionId, clearance.value);

  await context.db.query(
    `INSERT INTO call_sessions (id, workspace_id, ticket_id, firm_id, contact_id, actor_user_id, reservation_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      sessionId,
      context.scope.workspaceId,
      ticket.value.ticketId,
      ticket.value.firmId,
      ticket.value.contactId,
      actor.userId,
      reservationId,
      ticket.value.expiresAt,
    ],
  );
  await recordCrmAuditEvent(context, {
    action: 'call.session_authorized',
    subjectKind: 'call_session',
    subjectId: sessionId,
    detail: { firmId: ticket.value.firmId, ticketId: ticket.value.ticketId, reservedCents: clearance.value.cents },
  });
  const final = await readCallSessionClearance(context, sessionId);
  if (!final.ok) return await undo(final.reason);
  return { ok: true, value: { sessionId, expiresAt: ticket.value.expiresAt } };
}

export { CALL_CADENCE_PARKED_SOURCE, UNANSWERED_OUTCOMES, readCallCadence, type CallCadenceState } from './cadence.ts';
export { parkIfCadenceSpent, resumeCallCadence } from './sessionCadence.ts';

/**
 * What the Mac needs to offer an in-app call at one firm (`GET /calls/calling`): the
 * cadence, and the voicemail script's template with the two values the server knows —
 * the caller's name and their own verified number. Null when the firm is not the caller's.
 */
export async function readCallingStatus(
  context: RepositoryContext,
  firmId: string,
): Promise<{
  readonly cadence: CallCadence;
  readonly voicemailTemplate: string;
  readonly callerName: string;
  readonly callbackNumber: string | null;
} | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await firmVisible(context, firmId))) return null;
  const now = await databaseNow(context);
  const state = await readCallCadence(context, firmId, now);
  const { rows: users } = await context.db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [
    actor.userId,
  ]);
  const identityId = await currentCallingIdentityId(context, actor.userId);
  const { rows: identities } =
    identityId === null
      ? { rows: [] as { e164: string }[] }
      : await context.db.query<{ e164: string }>('SELECT e164 FROM calling_identities WHERE workspace_id = $1 AND id = $2', [
          context.scope.workspaceId,
          identityId,
        ]);
  return {
    cadence: {
      unansweredAttempts: state.unansweredAttempts,
      nextAttempt: state.nextAttempt,
      limit: state.limit,
      parked: state.parked,
      refusal: state.refusal,
    },
    voicemailTemplate: await readVoicemailScript(context),
    callerName: users[0]?.display_name ?? '',
    callbackNumber: identities[0]?.e164 ?? null,
  };
}

// ---------------------------------------------------------------------------
// The firm's call history and its recordings (slice C1)
// ---------------------------------------------------------------------------

/**
 * Recordings and call history are the firm's private class (Appendix F: notes, callbacks):
 * the assigned salesperson or an admin. Anybody else, and another workspace's firm, reads
 * as unknown.
 */
async function firmVisible(context: RepositoryContext, firmId: string): Promise<boolean> {
  if (context.scope.actor.kind !== 'user') return false;
  const firm = await readFirm(context, firmId);
  return firm !== null && decideFirmMutation(context, firm).permitted;
}

/** The firm's placed calls, newest first; null when the firm is not the caller's. */
export async function listFirmCallSessions(
  context: RepositoryContext,
  firmId: string,
): Promise<readonly CallSessionDto[] | null> {
  if (!(await firmVisible(context, firmId))) return null;
  const { rows } = await context.db.query<{
    id: string;
    firm_id: string;
    status: CallSessionStatus;
    started_at: Date | null;
    answered_at: Date | null;
    ended_at: Date | null;
    duration_seconds: number | null;
    recording_path: string | null;
    call_log_id: string | null;
    has_transcript: boolean;
  }>(
    `SELECT id, firm_id, status, started_at, answered_at, ended_at, duration_seconds, recording_path, call_log_id,
            EXISTS (SELECT 1 FROM call_transcripts t
                     WHERE t.workspace_id = call_sessions.workspace_id AND t.call_session_id = call_sessions.id) AS has_transcript
       FROM call_sessions
      WHERE workspace_id = $1 AND firm_id = $2 AND consumed_at IS NOT NULL
      ORDER BY consumed_at DESC, id
      LIMIT 100`,
    [context.scope.workspaceId, firmId],
  );
  const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
  return rows.map(row => ({
    sessionId: row.id,
    firmId: row.firm_id,
    status: row.status,
    startedAt: iso(row.started_at),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    durationSeconds: row.duration_seconds,
    hasRecording: row.recording_path !== null,
    callLogId: row.call_log_id,
    // Slice C2: the call history's "Transcript" disclosure is offered only for these.
    hasTranscript: row.has_transcript,
  }));
}

/**
 * Slice 3a (`GET /calls/history?include=outcome`): the outcome of each named call log, by
 * id. The caller has already decided the firm readable and names only its calls' logs.
 */
export async function readCallLogOutcomes(
  context: RepositoryContext,
  callLogIds: readonly string[],
): Promise<ReadonlyMap<string, CallOutcome>> {
  if (callLogIds.length === 0) return new Map();
  const { rows } = await context.db.query<{ id: string; outcome: CallOutcome }>(
    'SELECT id, outcome FROM call_logs WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
    [context.scope.workspaceId, [...callLogIds]],
  );
  return new Map(rows.map(row => [row.id, row.outcome]));
}

/**
 * S4F (`GET /calls/history?include=notes`): the note typed when each named call log was
 * written; absent for a log with none. The caller has already decided the firm readable (the
 * assignee or an admin, Appendix F's note class) and names only its logs.
 */
export async function readCallLogNotes(
  context: RepositoryContext,
  callLogIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (callLogIds.length === 0) return new Map();
  const { rows } = await context.db.query<{ id: string; note: string }>(
    'SELECT id, note FROM call_logs WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND note IS NOT NULL',
    [context.scope.workspaceId, [...callLogIds]],
  );
  return new Map(rows.map(row => [row.id, row.note]));
}

/**
 * S3X (`GET /calls?firmId=&include=corrections`): every correction of each named call log,
 * oldest first, from its `call.outcome_corrected` audit rows — the outcome it was changed
 * from and to, when, by whom, and the reason when one was required. The caller has already
 * decided the firm readable and names only its logs. Codes and ids only.
 */
export async function readCallLogCorrections(
  context: RepositoryContext,
  callLogIds: readonly string[],
): Promise<ReadonlyMap<string, readonly CallLogCorrection[]>> {
  if (callLogIds.length === 0) return new Map();
  const { rows } = await context.db.query<{
    subject_id: string;
    from_outcome: CallOutcome;
    to_outcome: CallOutcome;
    occurred_at: Date;
    actor_user_id: string | null;
    reason: CallCorrectionReason | null;
  }>(
    `SELECT subject_id, detail->>'from' AS from_outcome, detail->>'to' AS to_outcome, occurred_at, actor_user_id,
            detail->>'reason' AS reason
       FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'call_log' AND subject_id = ANY($3::text[])
      ORDER BY subject_id, (detail->>'revision')::int, occurred_at, id`,
    [context.scope.workspaceId, CALL_OUTCOME_CORRECTED_ACTION, [...callLogIds]],
  );
  const byLog = new Map<string, CallLogCorrection[]>();
  for (const row of rows) {
    const list = byLog.get(row.subject_id) ?? [];
    list.push({
      from: row.from_outcome,
      to: row.to_outcome,
      at: row.occurred_at.toISOString(),
      byUserId: row.actor_user_id,
      reason: row.reason,
    });
    byLog.set(row.subject_id, list);
  }
  return byLog;
}

/**
 * The stored recording path of one session, for the playback proxy; null when the session
 * is unknown, not this workspace's, not a firm the caller may read, or has no recording.
 */
export async function recordingPathOfSession(context: RepositoryContext, sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return null;
  const { rows } = await context.db.query<{ firm_id: string; recording_path: string | null }>(
    "SELECT firm_id, recording_path FROM call_sessions WHERE workspace_id = $1 AND id = $2 AND purpose='business'",
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined || row.recording_path === null) return null;
  if (!(await firmVisible(context, row.firm_id))) return null;
  return row.recording_path;
}

// ---------------------------------------------------------------------------
// The TwiML consumption
// ---------------------------------------------------------------------------

export { consumeCallSession, type ConsumeRefusal, type ConsumedCallSession } from './sessionConsumption.ts';

/** The workspace a session belongs to, by id, with no scope: the webhook has none. */
export async function workspaceOfCallSession(db: Queryable, sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return null;
  const { rows } = await db.query<{ workspace_id: string }>('SELECT workspace_id FROM call_sessions WHERE id = $1', [
    sessionId,
  ]);
  return rows.length === 1 ? (rows[0]?.workspace_id ?? null) : null;
}

/** The workspace a Call SID belongs to, parent or child leg. */
export async function workspaceOfCallSid(db: Queryable, callSid: string): Promise<string | null> {
  const { rows } = await db.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM call_sessions WHERE twilio_call_sid = $1 OR dial_call_sid = $1 LIMIT 2',
    [callSid],
  );
  return rows.length === 1 ? (rows[0]?.workspace_id ?? null) : null;
}

// ---------------------------------------------------------------------------
// The callbacks
// ---------------------------------------------------------------------------

export {
  sessionStatusOf, recordCallStatus, recordCallRecording,
  type CallStatusInput, type CallStatusOutcome,
} from './sessionCallbacks.ts';
export { sweepCallSessionReservations, workspacesOwingCallSessionSweep } from './sessionSweep.ts';
