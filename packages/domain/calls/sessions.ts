import { randomUUID } from 'node:crypto';
import {
  CALL_SESSION_DAILY_ATTEMPT_LIMIT,
  type CallSessionRefusalCode,
  type CallSessionStatus,
  type DialRefusalCode,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { authorizeDialCommand, consumeDialTicket } from '../dial/tickets.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { markCalling, settleAttempt, type SettleOutcome } from '../research/reservations.ts';
import { readTelephonyBudget } from '../settings/integrations.ts';
import { localDate } from '../src/rules/localClock.ts';
import { databaseNow } from '../policy/clock.ts';

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
 *      once, inside the minute, for the identity the access token was minted for. The
 *      ticket is consumed through `consumeDialTicket`, which takes the whole decision
 *      again — so a suppression that lands between 1 and 2 refuses here. The
 *      reservation is marked `calling` in the same transaction: from this commit on, a
 *      call may have happened.
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

  // The attempt limit: calls actually placed (consumed sessions) at this firm in the
  // last 24 hours. An authorized session nobody placed is not an attempt.
  const { rows: attempts } = await context.db.query<{ count: string }>(
    `SELECT count(*) AS count FROM call_sessions
      WHERE workspace_id = $1 AND firm_id = $2 AND consumed_at > now() - INTERVAL '24 hours'`,
    [context.scope.workspaceId, input.firmId],
  );
  if (Number(attempts[0]?.count ?? 0) >= CALL_SESSION_DAILY_ATTEMPT_LIMIT) return refuse('call_attempt_limit');

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
  const now = input.at ?? (await databaseNow(context));
  const businessDate = localDate(now, zone);
  const cents = telephonyReservationCents(budget.maxMinutesPerCall, budget.unitPriceMicros);
  const { rows: spent } = await context.db.query<{ cents: string | null }>(
    `SELECT sum(cents)::text AS cents FROM (
       SELECT cost_cents AS cents FROM provider_ledger
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date
       UNION ALL
       SELECT cents FROM provider_reservations
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date AND state IN ('reserved', 'calling')
     ) AS spend`,
    [context.scope.workspaceId, TELEPHONY_PROVIDER_KEY, businessDate],
  );
  if (Number(spent[0]?.cents ?? 0) + cents > budget.dailyCeilingCents) return refuse('telephony_budget_exhausted');

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
// The TwiML consumption
// ---------------------------------------------------------------------------

export type ConsumeRefusal =
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

  const { rows } = await db.query<SessionRow>(
    `SELECT id, workspace_id, ticket_id, firm_id, contact_id, actor_user_id, reservation_id, consumed_at,
            (expires_at <= now()) AS expired
       FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [input.workspaceId, input.sessionId],
  );
  const session = rows[0];
  if (session === undefined) return refused('session_unknown');
  if (session.consumed_at !== null) return refused('already_consumed');
  if (session.expired) return refused('session_expired');
  if (input.identity !== `client:${session.actor_user_id}`) return refused('identity_mismatch');

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

  const { rows: tickets } = await db.query<{ device_id: string; calling_identity_id: string }>(
    'SELECT device_id, calling_identity_id FROM dial_tickets WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, session.ticket_id],
  );
  const ticket = tickets[0];
  if (ticket === undefined) return refused('ticket_unknown');
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
  if (callerIdE164 === undefined) return refused('identity_missing');

  await db.query(
    `UPDATE call_sessions SET consumed_at = now(), twilio_call_sid = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [input.workspaceId, input.sessionId, input.callSid],
  );
  // From this commit on, a call may have happened: the reservation says so.
  await markCalling(context, session.reservation_id);
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
    value: { sessionId: session.id, workspaceId: input.workspaceId, e164: consumed.value.e164, callerIdE164 },
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
  const session = await sessionBySid(db, input.callSid);
  if (session === null || status === null) return { known: false };
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
    // A late or repeated terminal callback may carry what the first did not.
    await db.query(
      `UPDATE call_sessions SET duration_seconds = COALESCE(duration_seconds, $3::integer),
              billed_price_cents = COALESCE(billed_price_cents, $4::integer), updated_at = now()
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

  let settlement: 'settled' | 'estimated' | null = null;
  if (terminal) {
    const { rows: reservations } = await db.query<{ unit_price_micros: number | null; state: string }>(
      'SELECT unit_price_micros, state FROM provider_reservations WHERE workspace_id = $1 AND id = $2',
      [session.workspace_id, session.reservation_id],
    );
    const reservation = reservations[0];
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
 * media needs the account's credentials either way). Idempotent.
 */
export async function recordCallRecording(
  db: Queryable,
  input: { readonly callSid: string; readonly recordingSid: string; readonly recordingUrl: string; readonly durationSeconds?: number | undefined },
): Promise<{ readonly known: boolean }> {
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
  return { known: true };
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
 * Not yet scheduled: a worker job calling this is a later slice's wiring (see the
 * report). It is safe to run at any time and any number of times.
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
