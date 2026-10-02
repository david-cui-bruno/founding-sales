import { randomUUID } from 'node:crypto';
import {
  CALL_CADENCE,
  type CallCadence,
  type CallOutcome,
  type CallSessionDto,
  type CallSessionRefusalCode,
  type CallSessionStatus,
  type DialRefusalCode,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { authorizeDialCommand, consumeDialTicket } from '../dial/tickets.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm } from '../crm/firms.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { openHold, releaseHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { authorizeDial } from '../dial/authorize.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { correctSettledCents, markCalling, settleAttempt, type SettleOutcome } from '../research/reservations.ts';
import { readTelephonyBudget, readVoicemailScript } from '../settings/integrations.ts';
import { clearMonthlyCash, lockMonthlyCash } from '../settings/cashCeiling.ts';
import { currentCallingIdentityId } from '../dial/identities.ts';
import { localDate, localParts } from '../src/rules/localClock.ts';
import { databaseNow } from '../policy/clock.ts';
import { sendGateLockName } from '../policy/sendGate.ts';
import { admitPendingHold, lockGateAndFirmForCallSid } from './pendingHold.ts';

/**
 * Call sessions: one Twilio call attempt, from authorization to its recording
 * (call-to-booking slice W, migration 0028).
 *
 * ## The flow, and where each decision is taken
 *
 *   1. `createCallSession` — `POST /calls/session`, a person's command. The attempt
 *      limit, the caller id and the budget are checked, then `authorizeDialCommand`
 *      runs the whole of `authorizeDial` (suppression, identity, route at the displayed
 *      version, assignment, zone, posture, calling window, holds) and mints the
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
 *      The ticket is consumed through `consumeDialTicket`, which takes the whole
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
export const TELEPHONY_PROVIDER_KEY = 'twilio.voice';

export type CallSessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DialRefusalCode | CallSessionRefusalCode | 'invalid_input' };

const refuse = <T>(reason: DialRefusalCode | CallSessionRefusalCode | 'invalid_input'): CallSessionResult<T> => ({
  ok: false,
  reason,
});

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
   * instant, as `authorizeDialCommand` takes it (docs/decisions/g4-database-time-is-a-parameter.md).
   */
  readonly at?: string | undefined;
}

/** Cents a reservation of `minutes` at `unitPriceMicros` per minute holds, rounded up. */
export function telephonyReservationCents(minutes: number, unitPriceMicros: number): number {
  return Math.ceil((Math.trunc(minutes) * Math.trunc(unitPriceMicros)) / 10_000);
}

export async function createCallSession(
  context: RepositoryContext,
  input: CreateCallSessionInput,
): Promise<CallSessionResult<{ readonly sessionId: string; readonly expiresAt: string }>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('identity_not_owned');

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
    const decision = await authorizeDial(context, {
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

  // The budget, serialised per workspace so two sessions cannot both fit the last cents.
  const budget = await readTelephonyBudget(context);
  if (budget.dailyCeilingCents <= 0) return refuse('telephony_budget_disabled');
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:telephony_budget`,
  ]);
  const zone = await workspaceBusinessZone(context);
  const businessDate = localDate(now, zone);
  const cents = telephonyReservationCents(budget.maxMinutesPerCall, budget.unitPriceMicros);
  const spentCents = await telephonySpentCents(context, businessDate);
  if (spentCents + cents > budget.dailyCeilingCents) return refuse('telephony_budget_exhausted');
  // And the month's cash ceiling (slice P1, invariant I2), under the workspace's monthly
  // lock taken inside the daily one, so the reservation inserted below is the one both
  // checks were made against.
  if (!(await clearMonthlyCash(context, { at: now, zone, cents }))) return refuse('monthly_cash_ceiling');

  // The whole dial decision, and the ticket.
  const ticket = await authorizeDialCommand(context, {
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
  const { rows: reserved } = await context.db.query<{ id: string }>(
    `INSERT INTO provider_reservations
       (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
        cents, priced_unit, max_units, unit_price_micros, state)
     VALUES ($1, $2, 'call_session', $3, 1, $4::date, $5, $6, 'minute', $7, $8, 'reserved')
     RETURNING id`,
    [
      context.scope.workspaceId,
      TELEPHONY_PROVIDER_KEY,
      sessionId,
      businessDate,
      zone,
      cents,
      budget.maxMinutesPerCall,
      budget.unitPriceMicros,
    ],
  );
  const reservationId = reserved[0]?.id;
  if (reservationId === undefined) throw new Error('the telephony reservation insert returned no row');

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
    detail: { firmId: ticket.value.firmId, ticketId: ticket.value.ticketId, reservedCents: cents },
  });
  return { ok: true, value: { sessionId, expiresAt: ticket.value.expiresAt } };
}

// ---------------------------------------------------------------------------
// The cadence (slice C1)
// ---------------------------------------------------------------------------

/** `active_holds.source_event_kind` of the hold that parks a firm after its last unanswered attempt. */
export const CALL_CADENCE_PARKED_SOURCE = 'call_cadence_parked';

/** Outcomes recorded for a placed call that say nobody answered: recording one may park the firm. */
export const UNANSWERED_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>(['no_answer', 'busy', 'voicemail_left']);
/** Twilio's final status of the dialled leg when nobody answered, before an outcome is recorded. */
const UNANSWERED_PROVIDER_STATUSES: ReadonlySet<string> = new Set(['no-answer', 'busy']);
/**
 * Outcomes that start the count again: somebody was reached ("a connected conversation")
 * or asked to be called back. Any call log counts, placed from Callie or not — a callback
 * that rang David's cellphone is logged the same way.
 */
const RESETTING_OUTCOMES: readonly CallOutcome[] = [
  'interested',
  'referral_or_wrong_person',
  'callback_requested',
  'not_interested',
  'do_not_call',
];

export interface CallCadenceState extends CallCadence {
  /** The last unanswered attempt's session, for the parking hold's source event. */
  readonly lastAttemptSessionId: string | null;
  /** The open parking hold, when the firm is parked and the hold has been written. */
  readonly parkingHoldId: string | null;
}

/**
 * The firm's calling cadence at `at` (`CALL_CADENCE`): how many attempts count, which
 * attempt the next call would be, and why the cadence would refuse one now.
 *
 * **Every placed (consumed) session is an attempt from the moment it is consumed**, and
 * stays an unanswered attempt in the window's history until an outcome that says
 * somebody was reached — a resetting outcome — is recorded for the firm. A call that
 * rang out, reached a machine, failed, or was never classified is an attempt; nothing
 * expires one but the window itself (review of C1, fold 1, finding 2).
 *
 * Counted in the window `(at − windowDays, at]` — bounded above, so a late decision about
 * an old call looks at the window it belongs to (review of C1, fold 2) — and since the
 * later of the last resetting outcome recorded for the firm and the last release of a
 * parking hold (the review).
 *
 * Spacing is on the firm's own clock, from every counted session's time: at most one
 * attempt a local date, and the next at least `spacingMinutes` of the clock away from the
 * previous one's time of day. The calling window itself is `authorizeDial`'s. A firm with
 * no zone is not spaced here; `authorizeDial` refuses it (`zone_unresolved`).
 */
/** A timestamptz expression as ISO 8601 text in UTC, to the microsecond (no JS Date). */
function isoMicroseconds(expression: string): string {
  return `to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The database's instant of this statement, not of the transaction's start. */
async function clockInstant(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ at: string }>(`SELECT ${isoMicroseconds('clock_timestamp()')} AS at`);
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('the database did not answer with its clock');
  return at;
}

export async function readCallCadence(
  context: RepositoryContext,
  firmId: string,
  at: string,
  /**
   * Count every call placed up to this instant as well, when it is later than `at`.
   * Consumption passes `clock_timestamp()` read after its locks (review of C1, fold 3).
   */
  countThrough?: string,
): Promise<CallCadenceState> {
  const workspaceId = context.scope.workspaceId;
  const { rows: resets } = await context.db.query<{ reset_at: string | null }>(
    `SELECT ${isoMicroseconds('max(t)')} AS reset_at FROM (
       SELECT occurred_at AS t FROM call_logs
        WHERE workspace_id = $1 AND firm_id = $2 AND outcome = ANY($3::text[])
       UNION ALL
       SELECT released_at AS t FROM active_holds
        WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = ($2::uuid)::text
          AND source_event_kind = $4 AND released_at IS NOT NULL
     ) AS resets`,
    [workspaceId, firmId, [...RESETTING_OUTCOMES], CALL_CADENCE_PARKED_SOURCE],
  );
  const resetAt = resets[0]?.reset_at ?? null;

  const { rows: sessions } = await context.db.query<{ id: string; consumed_at: Date; outcome: CallOutcome | null }>(
    `SELECT s.id, s.consumed_at, l.outcome
       FROM call_sessions s
       LEFT JOIN call_logs l ON l.workspace_id = s.workspace_id AND l.id = s.call_log_id
      WHERE s.workspace_id = $1 AND s.firm_id = $2 AND s.consumed_at IS NOT NULL
        AND s.consumed_at > $3::timestamptz - make_interval(days => $4)
        AND s.consumed_at <= GREATEST($3::timestamptz, COALESCE($6::timestamptz, $3::timestamptz))
        AND ($5::timestamptz IS NULL OR s.consumed_at > $5::timestamptz)
      ORDER BY s.consumed_at, s.id`,
    [workspaceId, firmId, at, CALL_CADENCE.windowDays, resetAt, countThrough ?? null],
  );
  const attempts = sessions.filter(row => row.outcome === null || !RESETTING_OUTCOMES.includes(row.outcome));
  const last = attempts.at(-1) ?? null;

  const { rows: holds } = await context.db.query<{ id: string }>(
    `SELECT id FROM active_holds
      WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = ($2::uuid)::text
        AND source_event_kind = $3 AND released_at IS NULL
      ORDER BY started_at, id LIMIT 1`,
    [workspaceId, firmId, CALL_CADENCE_PARKED_SOURCE],
  );
  const parkingHoldId = holds[0]?.id ?? null;

  const count = attempts.length;
  const parked = count >= CALL_CADENCE.unansweredLimit || parkingHoldId !== null;
  let refusal: CallCadence['refusal'] = parked ? 'call_attempts_exhausted' : null;
  if (refusal === null && last !== null) {
    const { rows: firms } = await context.db.query<{ time_zone: string | null }>(
      'SELECT time_zone FROM firms WHERE workspace_id = $1 AND id = $2',
      [workspaceId, firmId],
    );
    const zone = firms[0]?.time_zone ?? null;
    if (zone !== null) {
      const previous = localParts(last.consumed_at.toISOString(), zone);
      const current = localParts(at, zone);
      if (previous.date === current.date) refusal = 'call_attempt_today';
      else if (Math.abs(current.minuteOfDay - previous.minuteOfDay) < CALL_CADENCE.spacingMinutes) {
        refusal = 'call_attempt_too_soon';
      }
    }
  }
  return {
    unansweredAttempts: count,
    nextAttempt: parked ? null : count + 1,
    limit: CALL_CADENCE.unansweredLimit,
    parked,
    refusal,
    lastAttemptSessionId: last?.id ?? null,
    parkingHoldId,
  };
}

/**
 * A placed session was just recorded as unanswered — an outcome of no answer, busy or a
 * voicemail left, or Twilio's final no-answer/busy with no outcome yet. If that brings
 * the firm's attempts to the limit, park it now (review of C1, fold 1, finding 3), so the
 * `tel:` path is held too and nothing reopens calling without a review. Idempotent.
 */
export async function parkIfCadenceSpent(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly sessionId: string },
): Promise<string | null> {
  // The gate before anything is read: two recordings cannot both find no hold.
  await lockSendGateForStopFact(context);
  // Counted in the 14-day window that ends at the firm's latest placed call: four there
  // is four within one window. A late classification of an old call can complete that
  // window, never a window that never held four (review of C1, fold 2, finding 3).
  // The bound stays text at the database's microseconds (review of C1, fold 3): through
  // a JS Date it would lose them, and the latest call would fall outside its own window.
  const { rows } = await context.db.query<{ placed: boolean; latest: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM call_sessions WHERE workspace_id = $1 AND id = $3 AND consumed_at IS NOT NULL) AS placed,
            (SELECT ${isoMicroseconds('max(consumed_at)')} FROM call_sessions WHERE workspace_id = $1 AND firm_id = $2) AS latest`,
    [context.scope.workspaceId, input.firmId, input.sessionId],
  );
  const latest = rows[0]?.latest ?? null;
  if (rows[0]?.placed !== true || latest === null) return null;
  const cadence = await readCallCadence(context, input.firmId, latest);
  if (cadence.unansweredAttempts < CALL_CADENCE.unansweredLimit) return cadence.parkingHoldId;
  return await parkFirmForReview(context, input.firmId, input.sessionId);
}

/**
 * Park a firm for review: a firm-scoped `scoped_pause` hold on dial authorisation, the
 * existing mechanism for "calling is paused for this firm". Written once: a second
 * refused attempt finds the open hold. Released by `resumeCallCadence`, which is the review.
 */
async function parkFirmForReview(context: RepositoryContext, firmId: string, lastSessionId: string | null): Promise<string> {
  // The gate first, then the check: concurrent parkers serialise here, and the second
  // finds the first one's hold (review of C1, fold 1, finding 7).
  await lockSendGateForStopFact(context);
  const existing = await readParkingHold(context, firmId);
  if (existing !== null) return existing;
  const holdId = await openHold(context, {
    scopeKind: 'firm',
    scopeKey: firmId,
    reasonCode: 'scoped_pause',
    blockedActionKinds: ['dial_authorization'],
    sourceEventKind: CALL_CADENCE_PARKED_SOURCE,
    ...(lastSessionId === null ? {} : { sourceEventId: lastSessionId }),
    recoveryAction: 'resume_after_review',
  });
  await recordCrmAuditEvent(context, {
    action: 'call.cadence_parked',
    subjectKind: 'active_hold',
    subjectId: holdId,
    detail: { firmId, lastSessionId, unansweredLimit: CALL_CADENCE.unansweredLimit },
  });
  return holdId;
}

async function readParkingHold(context: RepositoryContext, firmId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM active_holds
      WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = ($2::uuid)::text
        AND source_event_kind = $3 AND released_at IS NULL
      ORDER BY started_at, id LIMIT 1 FOR UPDATE`,
    [context.scope.workspaceId, firmId, CALL_CADENCE_PARKED_SOURCE],
  );
  return rows[0]?.id ?? null;
}

/**
 * "Resume calling" on a parked firm: the review. Releases the parking hold — writing it
 * first if the cadence reached its limit and no call has been refused since — so its
 * release instant starts the count again. Only for someone who may work the firm.
 */
export async function resumeCallCadence(
  context: RepositoryContext,
  input: { readonly firmId: string },
): Promise<CallSessionResult<{ readonly firmId: string; readonly releasedHoldId: string }>> {
  if (context.scope.actor.kind !== 'user') return refuse('not_assigned');
  const firm = await readFirm(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuse(permitted.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
  const now = await databaseNow(context);
  const cadence = await readCallCadence(context, input.firmId, now);
  if (!cadence.parked) return refuse('invalid_input');
  const holdId = cadence.parkingHoldId ?? (await parkFirmForReview(context, input.firmId, cadence.lastAttemptSessionId));
  const released = await releaseHold(context, holdId, 'scoped_pause');
  if (released === null) return refuse('invalid_input');
  await recordCrmAuditEvent(context, {
    action: 'call.cadence_resumed',
    subjectKind: 'active_hold',
    subjectId: holdId,
    detail: { firmId: input.firmId, unansweredAttempts: cadence.unansweredAttempts },
  });
  return { ok: true, value: { firmId: input.firmId, releasedHoldId: holdId } };
}

/**
 * Cents of Twilio minutes spent on one business date: settled ledger cost plus live
 * (reserved or calling) reservations. The budget check and Settings' "spent today" both
 * ask this, so they cannot disagree about the day boundary or what counts.
 */
export async function telephonySpentCents(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ cents: string | null }>(
    `SELECT sum(cents)::text AS cents FROM (
       SELECT cost_cents AS cents FROM provider_ledger
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date
       UNION ALL
       SELECT cents FROM provider_reservations
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date AND state IN ('reserved', 'calling')
     ) AS spend`,
    [context.scope.workspaceId, TELEPHONY_PROVIDER_KEY, businessDate],
  );
  return Number(rows[0]?.cents ?? 0);
}

/** Today's telephony spend, on the workspace's business day. */
export async function telephonySpentToday(context: RepositoryContext): Promise<number> {
  const zone = await workspaceBusinessZone(context);
  return await telephonySpentCents(context, localDate(await databaseNow(context), zone));
}

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
 * The stored recording path of one session, for the playback proxy; null when the session
 * is unknown, not this workspace's, not a firm the caller may read, or has no recording.
 */
export async function recordingPathOfSession(context: RepositoryContext, sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return null;
  const { rows } = await context.db.query<{ firm_id: string; recording_path: string | null }>(
    'SELECT firm_id, recording_path FROM call_sessions WHERE workspace_id = $1 AND id = $2',
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

export type ConsumeRefusal =
  | 'call_attempts_exhausted'
  | 'call_attempt_today'
  | 'call_attempt_too_soon'
  | 'reservation_closed'
  | 'session_unknown'
  | 'already_consumed'
  | 'session_expired'
  | 'identity_mismatch'
  | 'member_inactive'
  | DialRefusalCode;

export interface ConsumedCallSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The server-resolved destination, for `<Number>`. Never leaves the TwiML answer. */
  readonly e164: string;
  /** The actor's verified identity, for `<Dial callerId>`. */
  readonly callerIdE164: string;
  /** `<Dial timeLimit>`: the minutes the reservation holds, so a call cannot outrun its money. */
  readonly maxSeconds: number;
}

interface SessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly ticket_id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly actor_user_id: string;
  readonly reservation_id: string;
  readonly consumed_at: Date | null;
  readonly expired: boolean;
  readonly [column: string]: unknown;
}

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

/**
 * Consume a session for the TwiML route. The caller runs this inside one transaction
 * and has verified the Twilio signature.
 *
 * `identity` is the Voice SDK's `From`, `client:<user id>`: the identity the access
 * token was minted for. A session is consumed for its own actor only.
 */
export async function consumeCallSession(
  db: Queryable,
  input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly callSid: string;
    readonly identity: string;
    /** Database time for the repeated decision; absent is `now()`. */
    readonly at?: string | undefined;
  },
): Promise<{ readonly ok: true; readonly value: ConsumedCallSession } | { readonly ok: false; readonly reason: ConsumeRefusal }> {
  const refused = (reason: ConsumeRefusal): { readonly ok: false; readonly reason: ConsumeRefusal } => ({ ok: false, reason });
  if (!/^CA[0-9a-f]{32}$/u.test(input.callSid)) return refused('session_unknown');

  // 1. The send gate, SHARED, before any row lock, held until the caller commits
  //    (`policy/sendGate.ts`). A suppression, a hold or a firm handover is written under
  //    the gate EXCLUSIVE, so it is either visible to the re-check below or waits for
  //    this authorization's commit.
  //    `lockSendGateForDispatch`'s statement; that function takes a scoped context, and
  //    the scope is built from the session row, which must not be read before the gate.
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [sendGateLockName(input.workspaceId)]);

  // 2. The firm row, FOR NO KEY UPDATE: two consumptions at one firm serialise here, so
  //    the attempt count read after it includes every placed call that committed.
  const { rows: located } = await db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, input.sessionId],
  );
  const locatedFirm = located[0]?.firm_id;
  if (locatedFirm === undefined) return refused('session_unknown');
  await db.query('SELECT 1 FROM firms WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [
    input.workspaceId,
    locatedFirm,
  ]);

  // 3. The session row. Its expiry is read against `clock_timestamp()`, the instant of
  //    this statement, not `now()`: a transaction that began inside the minute and then
  //    waited on the gate or the firm past it must see the minute as over (review fold
  //    2) — the sweep may have released the reservation in that wait.
  const { rows } = await db.query<SessionRow>(
    `SELECT id, workspace_id, ticket_id, firm_id, contact_id, actor_user_id, reservation_id, consumed_at,
            (expires_at <= clock_timestamp()) AS expired
       FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [input.workspaceId, input.sessionId],
  );
  const session = rows[0];
  if (session === undefined) return refused('session_unknown');
  // A merge moved the session between the two reads: the lock is on the wrong firm.
  if (session.firm_id !== locatedFirm) return refused('session_unknown');
  if (session.consumed_at !== null) return refused('already_consumed');
  if (session.expired) return refused('session_expired');
  if (input.identity !== `client:${session.actor_user_id}`) return refused('identity_mismatch');

  // 5. The reservation, still `reserved`. The sweep locks the session before it settles
  //    anything, and this transaction holds that lock now, so the state read here is the
  //    state `markCalling` will find — unless something outside the sweep closed it,
  //    which the savepoint below turns into a refusal rather than an unpaid call.
  const { rows: reservations } = await db.query<{ state: string }>(
    'SELECT state FROM provider_reservations WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [input.workspaceId, session.reservation_id],
  );
  if (reservations[0]?.state !== 'reserved') return refused('reservation_closed');

  const { rows: members } = await db.query<{ role: 'admin' | 'salesperson' }>(
    `SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [input.workspaceId, session.actor_user_id],
  );
  const member = members[0];
  if (member === undefined) return refused('member_inactive');
  const context = repositoryContext(
    workspaceScope(input.workspaceId, { kind: 'user', userId: session.actor_user_id, role: member.role }),
    db,
  );

  // 6. The cadence (slice C1), under the firm lock: sessions created together cannot all
  //    be placed. Every placed call is an attempt from its consumption
  //    (`readCallCadence`), so the second of two sessions is refused as the same day's
  //    attempt, or as the one past the limit. Nothing is parked from here: recording the
  //    fourth unanswered attempt does that (`parkIfCadenceSpent`).
  //    The bound is `clock_timestamp()`, read here after the locks (review of C1, fold 3):
  //    a transaction's `now()` is its start, and a call another consumption placed and
  //    committed while this one waited on the firm lock is later than that start.
  const clock = await clockInstant(db);
  const cadence = await readCallCadence(context, session.firm_id, input.at ?? clock, clock);
  if (cadence.refusal !== null) return refused(cadence.refusal);

  const { rows: tickets } = await db.query<{ device_id: string; calling_identity_id: string }>(
    'SELECT device_id, calling_identity_id FROM dial_tickets WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, session.ticket_id],
  );
  const ticket = tickets[0];
  if (ticket === undefined) return refused('ticket_unknown');

  // Every write from here on is undone together if the reservation cannot move to
  // `calling`: a call is authorized only with its money marked as possibly spent.
  await db.query('SAVEPOINT consume_call_session');
  const undo = async (reason: ConsumeRefusal): Promise<{ readonly ok: false; readonly reason: ConsumeRefusal }> => {
    await db.query('ROLLBACK TO SAVEPOINT consume_call_session');
    return refused(reason);
  };
  // The whole decision again, at the last moment before the number leaves the server.
  const consumed = await consumeDialTicket(context, {
    ticketId: session.ticket_id,
    deviceId: ticket.device_id,
    ...(input.at === undefined ? {} : { at: input.at }),
  });
  if (!consumed.ok) return refused(consumed.reason);

  const { rows: identities } = await db.query<{ e164: string }>(
    'SELECT e164 FROM calling_identities WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, ticket.calling_identity_id],
  );
  const callerIdE164 = identities[0]?.e164;
  if (callerIdE164 === undefined) return await undo('identity_missing');

  await db.query(
    `UPDATE call_sessions SET consumed_at = now(), twilio_call_sid = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [input.workspaceId, input.sessionId, input.callSid],
  );
  // From this commit on, a call may have happened: the reservation says so. Required:
  // a reservation that did not move is a call nobody would pay for.
  if (!(await markCalling(context, session.reservation_id))) return await undo('reservation_closed');
  const { rows: limits } = await db.query<{ max_units: number | null }>(
    'SELECT max_units FROM provider_reservations WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, session.reservation_id],
  );
  const maxSeconds = Math.max(60, Number(limits[0]?.max_units ?? 1) * 60);
  await recordFunnelFact(context, {
    kind: 'call.placed',
    source: 'telephony',
    dedupeKey: session.id,
    firmId: session.firm_id,
    ...(session.contact_id === null ? {} : { contactId: session.contact_id }),
  });
  await recordCrmAuditEvent(context, {
    action: 'call.session_placed',
    subjectKind: 'call_session',
    subjectId: session.id,
    detail: { firmId: session.firm_id, ticketId: session.ticket_id },
  });
  return {
    ok: true,
    value: { sessionId: session.id, workspaceId: input.workspaceId, e164: consumed.value.e164, callerIdE164, maxSeconds },
  };
}

// ---------------------------------------------------------------------------
// The callbacks
// ---------------------------------------------------------------------------

const STATUS_RANK: Readonly<Record<CallSessionStatus, number>> = Object.freeze({
  authorized: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  failed: 3,
  canceled: 3,
});

/** Twilio's `CallStatus` in ours. Busy and no-answer are calls that completed unanswered. */
export function sessionStatusOf(providerStatus: string): CallSessionStatus | null {
  switch (providerStatus) {
    case 'queued':
    case 'initiated':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
      return 'in_progress';
    case 'completed':
    case 'busy':
    case 'no-answer':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}

export interface CallStatusInput {
  /** The session's own leg: `ParentCallSid` when Twilio reports the child, else `CallSid`. */
  readonly callSid: string;
  /** The dialled leg's SID, when this callback is about it. */
  readonly dialCallSid?: string | undefined;
  readonly providerStatus: string;
  readonly durationSeconds?: number | undefined;
  /** Twilio's `Price` in dollars (negative for a charge), when the callback carries one. */
  readonly priceDollars?: number | undefined;
}

export type CallStatusOutcome =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly sessionId: string;
      readonly status: CallSessionStatus;
      readonly applied: boolean;
      readonly settlement: 'settled' | 'estimated' | null;
    };

interface CallbackSessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly actor_user_id: string;
  readonly reservation_id: string;
  readonly status: CallSessionStatus;
  readonly answered_at: Date | null;
  readonly [column: string]: unknown;
}

function systemContext(db: Queryable, workspaceId: string): RepositoryContext {
  return repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), db);
}

async function sessionBySid(db: Queryable, callSid: string): Promise<CallbackSessionRow | null> {
  const { rows } = await db.query<CallbackSessionRow>(
    `SELECT id, workspace_id, firm_id, contact_id, actor_user_id, reservation_id, status, answered_at
       FROM call_sessions WHERE twilio_call_sid = $1 OR dial_call_sid = $1
      ORDER BY (twilio_call_sid = $1) DESC LIMIT 1 FOR UPDATE`,
    [callSid],
  );
  return rows[0] ?? null;
}

/**
 * One status callback. Idempotent: a status never moves backward, each instant is set
 * once, and the reservation settles once (`settleAttempt` is guarded by state). An
 * unknown SID answers `{ known: false }` and writes nothing.
 */
export async function recordCallStatus(db: Queryable, input: CallStatusInput): Promise<CallStatusOutcome> {
  const status = sessionStatusOf(input.providerStatus);
  if (status === null) return { known: false };
  // Every status callback takes the send gate, then the firm, before the session row — the
  // order consumption and Log outcome use — and never asks for the gate while holding the
  // session. A final no-answer or busy may park the firm (`parkIfCadenceSpent`), and since
  // slice 3a any delivery may admit the pending-review hold (`admitPendingHold`);
  // both take the gate EXCLUSIVE (review of C1, fold 2, finding 1; DESIGN-S3A §2.5). Taken
  // for every status, not only the ones that write a hold: the facts a later delivery
  // admits on are the ones an earlier one wrote, so the order is one order for all of them.
  //
  // Not found unlocked is not found (review of C1, fold 3): a session the locked read below
  // could still find would then be held before the gate. The SID is set when the call is
  // placed, so only a callback racing its own placement lands here, and it is answered as
  // any unknown SID is.
  if ((await lockGateAndFirmForCallSid(db, input.callSid)) === null) return { known: false };
  const session = await sessionBySid(db, input.callSid);
  if (session === null) return { known: false };
  const context = systemContext(db, session.workspace_id);

  const forward = STATUS_RANK[status] > STATUS_RANK[session.status];
  const terminal = STATUS_RANK[status] === 3;
  const duration =
    input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
      ? Math.trunc(input.durationSeconds)
      : null;
  const priceCents =
    input.priceDollars !== undefined && Number.isFinite(input.priceDollars)
      ? Math.round(Math.abs(input.priceDollars) * 100)
      : null;

  if (forward) {
    await db.query(
      `UPDATE call_sessions
          SET status = $3,
              provider_status = $4,
              dial_call_sid = COALESCE(dial_call_sid, $5),
              started_at = COALESCE(started_at, now()),
              answered_at = CASE WHEN $3 = 'in_progress' THEN COALESCE(answered_at, now()) ELSE answered_at END,
              ended_at = CASE WHEN $6::boolean THEN COALESCE(ended_at, now()) ELSE ended_at END,
              duration_seconds = COALESCE($7::integer, duration_seconds),
              billed_price_cents = COALESCE($8::integer, billed_price_cents),
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [session.workspace_id, session.id, status, input.providerStatus, input.dialCallSid ?? null, terminal, duration, priceCents],
    );
  } else if (terminal && (duration !== null || priceCents !== null)) {
    // A late or repeated terminal callback may carry what the first did not — and a price
    // is Twilio's final word, so a later one replaces an earlier one (slice P1).
    await db.query(
      `UPDATE call_sessions SET duration_seconds = COALESCE(duration_seconds, $3::integer),
              billed_price_cents = COALESCE($4::integer, billed_price_cents), updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [session.workspace_id, session.id, duration, priceCents],
    );
  }

  if (forward && status === 'in_progress' && session.answered_at === null) {
    await recordFunnelFact(context, {
      kind: 'call.connected',
      source: 'telephony',
      dedupeKey: session.id,
      firmId: session.firm_id,
      ...(session.contact_id === null ? {} : { contactId: session.contact_id }),
    });
  }

  // Twilio's final no-answer or busy, before any outcome: the attempt is established as
  // unanswered, and may be the one that parks the firm.
  if (forward && terminal && UNANSWERED_PROVIDER_STATUSES.has(input.providerStatus)) {
    const { rows: logged } = await db.query<{ call_log_id: string | null }>(
      'SELECT call_log_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
      [session.workspace_id, session.id],
    );
    if (logged[0]?.call_log_id == null) await parkIfCadenceSpent(context, { firmId: session.firm_id, sessionId: session.id });
  }

  // Slice 3a: every delivery, duplicates included, may complete the facts the pending-review
  // hold is admitted on (since S3T the analysis path's: an answer, then the recording).
  await admitPendingHold(context, session.id);

  let settlement: 'settled' | 'estimated' | null = null;
  if (terminal) {
    // Every change to what the month has spent is serialised with the clearances that
    // read it (slice P1): the monthly lock, last, after this callback's other locks.
    await lockMonthlyCash(context);
    const { rows: reservations } = await db.query<{ unit_price_micros: number | null; state: string }>(
      'SELECT unit_price_micros, state FROM provider_reservations WHERE workspace_id = $1 AND id = $2',
      [session.workspace_id, session.reservation_id],
    );
    const reservation = reservations[0];
    if (reservation !== undefined && (reservation.state === 'settled' || reservation.state === 'estimated') && priceCents !== null) {
      // Already closed — from the duration, or from an earlier price — and this callback
      // carries Twilio's price: the ledger is corrected to it, by the difference, once.
      const corrected = await correctSettledCents(context, { reservationId: session.reservation_id, cents: priceCents });
      if (corrected !== null) settlement = 'settled';
    }
    if (reservation !== undefined && (reservation.state === 'reserved' || reservation.state === 'calling')) {
      const { rows: known } = await db.query<{ duration_seconds: number | null; billed_price_cents: number | null }>(
        'SELECT duration_seconds, billed_price_cents FROM call_sessions WHERE workspace_id = $1 AND id = $2',
        [session.workspace_id, session.id],
      );
      const billed = known[0]?.billed_price_cents ?? null;
      const seconds = known[0]?.duration_seconds ?? null;
      let outcome: SettleOutcome | null = null;
      if (billed !== null) {
        outcome = { kind: 'settled', cents: Number(billed) };
      } else if (seconds !== null) {
        const minutes = Math.ceil(Number(seconds) / 60);
        outcome = { kind: 'estimated', cents: telephonyReservationCents(minutes, Number(reservation.unit_price_micros ?? 0)) };
      }
      if (outcome !== null) {
        const settled = await settleAttempt(context, {
          reservationId: session.reservation_id,
          at: new Date().toISOString(),
          outcome,
        });
        if (settled !== null) settlement = outcome.kind === 'settled' ? 'settled' : 'estimated';
      }
    }
  }

  return { known: true, sessionId: session.id, status: forward ? status : session.status, applied: forward, settlement };
}

/**
 * A recording callback. Only the URL's path is kept (the host is Twilio's API and the
 * media needs the account's credentials either way). Idempotent. The session it names is
 * returned once the recording is stored, for slice C2's transcription enqueue.
 */
export async function recordCallRecording(
  db: Queryable,
  input: { readonly callSid: string; readonly recordingSid: string; readonly recordingUrl: string; readonly durationSeconds?: number | undefined },
): Promise<{ readonly known: boolean; readonly recorded?: { readonly workspaceId: string; readonly sessionId: string } }> {
  // Slice 3a: the status callback's prefix — the send gate, then the firm, before the
  // session row — because this delivery may admit the pending-review hold, which takes the
  // gate (DESIGN-S3A §2.5). It used to lock the session first.
  if ((await lockGateAndFirmForCallSid(db, input.callSid)) === null) return { known: false };
  const session = await sessionBySid(db, input.callSid);
  if (session === null) return { known: false };
  if (!/^RE[0-9a-f]{32}$/u.test(input.recordingSid)) return { known: true };
  let path: string | null = null;
  try {
    const url = new URL(input.recordingUrl);
    path = /^\/[A-Za-z0-9/._-]+$/u.test(url.pathname) && url.pathname.length <= 300 ? url.pathname : null;
  } catch {
    path = null;
  }
  const duration =
    input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
      ? Math.trunc(input.durationSeconds)
      : null;
  await db.query(
    `UPDATE call_sessions SET recording_sid = $3, recording_path = COALESCE($4, recording_path),
            recording_duration_seconds = COALESCE($5::integer, recording_duration_seconds), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [session.workspace_id, session.id, input.recordingSid, path, duration],
  );
  await admitPendingHold(systemContext(db, session.workspace_id), session.id);
  return { known: true, recorded: { workspaceId: session.workspace_id, sessionId: session.id } };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Finalise the reservations of sessions whose callbacks will not come (one workspace).
 *
 *   * never consumed and past its minute — `released`: no call can have happened;
 *   * consumed, still open, and older than the longest call it reserved plus fifteen
 *     minutes — `estimated` at the full reservation, because a call may have been billed
 *     and zero is the one answer that is certainly wrong.
 *
 * Scheduled by the worker's `telephony-sweep` source (`telephony.sweep`, every quarter
 * hour for a workspace that owes one: `workspacesOwingCallSessionSweep`). It is safe to
 * run at any time and any number of times.
 */
export async function sweepCallSessionReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ reservation_id: string; consumed: boolean }>(
    `SELECT s.reservation_id, (s.consumed_at IS NOT NULL) AS consumed
       FROM call_sessions s
       JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
      WHERE s.workspace_id = $1 AND r.state IN ('reserved', 'calling')
        AND ((s.consumed_at IS NULL AND s.expires_at <= now())
             OR (s.consumed_at IS NOT NULL
                 AND s.consumed_at + make_interval(mins => COALESCE(r.max_units, 0) + 15) <= now()))
      ORDER BY s.created_at
      FOR UPDATE OF s`,
    [context.scope.workspaceId],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    const settled = await settleAttempt(context, {
      reservationId: row.reservation_id,
      at,
      outcome: row.consumed ? { kind: 'estimated' } : { kind: 'released' },
    });
    if (settled === null) continue;
    if (row.consumed) estimated += 1;
    else released += 1;
  }
  return { released, estimated };
}

/**
 * The workspaces with at least one call-session reservation the sweep would finalise
 * now: the scheduler's question, asked with no scope because the pass has none. The
 * same predicate as `sweepCallSessionReservations`, so a workspace is named only when
 * the job will find work, whatever its calling switch says — a switch turned off does
 * not strand a reservation.
 */
export async function workspacesOwingCallSessionSweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT s.workspace_id
       FROM call_sessions s
       JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
      WHERE r.state IN ('reserved', 'calling')
        AND ((s.consumed_at IS NULL AND s.expires_at <= now())
             OR (s.consumed_at IS NOT NULL
                 AND s.consumed_at + make_interval(mins => COALESCE(r.max_units, 0) + 15) <= now()))
      ORDER BY s.workspace_id`,
  );
  return rows.map(row => row.workspace_id);
}
