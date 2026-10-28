import type { CallSessionRefusalCode, DialRefusalCode } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import { readCallCadence, isoMicroseconds } from './cadence.ts';
import { readCallSessionClearance } from './sessionClearance.ts';
import { sendGateLockName } from '../policy/sendGate.ts';
import { consumeBrowserDialTicket } from '../dial/tickets.ts';
import { markCalling } from '../research/reservations.ts';
import { attributeFirmInteraction } from '../sourcing/attribution.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import {lockPreparedCallingCapability} from '../calling/preparationLifecycle.ts';
import {readPreparationExecution} from '../calling/preparationExecution.ts';
import { lockAudioTestAllowance } from './audioTestPolicy.ts';
import { resolveAudioTestDestination } from './audioTestConsumption.ts';

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
  | CallSessionRefusalCode
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
  readonly ticket_id: string | null;
  readonly firm_id: string | null;
  readonly purpose: 'business' | 'audio_test';
  readonly contact_id: string | null;
  readonly actor_user_id: string;
  readonly reservation_id: string;
  readonly consumed_at: Date | null;
  readonly expires_at: Date;
  readonly expired: boolean;
  readonly [column: string]: unknown;
}

async function clockInstant(db: Queryable): Promise<string> {
  const result = await db.query<{ at: string }>(`SELECT ${isoMicroseconds('clock_timestamp()')} AS at`);
  const at = result.rows[0]?.at;
  if (at === undefined) throw new Error('the database did not answer with its clock');
  return at;
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
    readonly configuredCallerIdE164?: string | undefined;
    /** Database time for the repeated decision; absent is `now()`. */
    readonly at?: string | undefined;
  },
): Promise<{ readonly ok: true; readonly value: ConsumedCallSession } | { readonly ok: false; readonly reason: ConsumeRefusal }> {
  const refused = (reason: ConsumeRefusal): { readonly ok: false; readonly reason: ConsumeRefusal } => ({ ok: false, reason });
  if (!/^CA[0-9a-f]{32}$/u.test(input.callSid)) return refused('session_unknown');
  const purpose = (await db.query<{ purpose: string }>('SELECT purpose FROM call_sessions WHERE workspace_id=$1 AND id=$2', [input.workspaceId, input.sessionId])).rows[0]?.purpose;
  if (purpose === 'business') await lockPreparedCallingCapability(db,input.workspaceId,'session',input.sessionId);
  else if (purpose !== 'audio_test') return refused('session_unknown');

  // 1. The send gate, SHARED, before any row lock, held until the caller commits
  //    (`policy/sendGate.ts`). A suppression, a hold or a firm handover is written under
  //    the gate EXCLUSIVE, so it is either visible to the re-check below or waits for
  //    this authorization's commit.
  //    `lockSendGateForDispatch`'s statement; that function takes a scoped context, and
  //    the scope is built from the session row, which must not be read before the gate.
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [sendGateLockName(input.workspaceId)]);

  // 2. The firm row, FOR NO KEY UPDATE: two consumptions at one firm serialise here, so
  //    the attempt count read after it includes every placed call that committed.
  const { rows: located } = await db.query<{ firm_id: string | null; purpose: string; actor_user_id: string }>(
    'SELECT firm_id,purpose,actor_user_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, input.sessionId],
  );
  const locatedFirm = located[0]?.firm_id;
  if (locatedFirm === undefined || located[0]?.purpose !== purpose) return refused('session_unknown');
  if (locatedFirm !== null) await db.query('SELECT 1 FROM firms WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [
    input.workspaceId,
    locatedFirm,
  ]);
  if (purpose === 'audio_test') {
    if (locatedFirm !== null || !located[0]) return refused('session_unknown');
    const allowanceContext = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), db);
    await lockAudioTestAllowance(allowanceContext);
  }

  // 3. The session row. Its expiry is read against `clock_timestamp()`, the instant of
  //    this statement, not `now()`: a transaction that began inside the minute and then
  //    waited on the gate or the firm past it must see the minute as over (review fold
  //    2) — the sweep may have released the reservation in that wait.
  const { rows } = await db.query<SessionRow>(
    `SELECT id, workspace_id, ticket_id, firm_id, purpose, contact_id, actor_user_id, reservation_id, consumed_at, expires_at,
            (expires_at <= clock_timestamp()) AS expired
       FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [input.workspaceId, input.sessionId],
  );
  const session = rows[0];
  if (session === undefined) return refused('session_unknown');
  // A merge moved the session between the two reads: the lock is on the wrong firm.
  if (session.firm_id !== locatedFirm || session.purpose !== purpose) return refused('session_unknown');
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
    `SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`,
    [input.workspaceId, session.actor_user_id],
  );
  const member = members[0];
  if (member === undefined) return refused('member_inactive');
  const context = repositoryContext(
    workspaceScope(input.workspaceId, { kind: 'user', userId: session.actor_user_id, role: member.role }),
    db,
  );
  if (session.purpose === 'business') {
    if (!session.firm_id || !session.ticket_id) return refused('session_unknown');
    const preparation=await readPreparationExecution(context,session.firm_id);
    if(!preparation.ok)return refused(preparation.reason);
  }

  // 6. The cadence (slice C1), under the firm lock: sessions created together cannot all
  //    be placed. Every placed call is an attempt from its consumption
  //    (`readCallCadence`), so the second of two sessions is refused as the same day's
  //    attempt, or as the one past the limit. Nothing is parked from here: recording the
  //    fourth unanswered attempt does that (`parkIfCadenceSpent`).
  //    The bound is `clock_timestamp()`, read here after the locks (review of C1, fold 3):
  //    a transaction's `now()` is its start, and a call another consumption placed and
  //    committed while this one waited on the firm lock is later than that start.
  const clock = await clockInstant(db);
  if (session.purpose === 'business' && session.firm_id) {
    const cadence = await readCallCadence(context, session.firm_id, input.at ?? clock, clock);
    if (cadence.refusal !== null) return refused(cadence.refusal);
  }

  // Every write from here on is undone together if the reservation cannot move to
  // `calling`: a call is authorized only with its money marked as possibly spent.
  await db.query('SAVEPOINT consume_call_session');
  const undo = async (reason: ConsumeRefusal): Promise<{ readonly ok: false; readonly reason: ConsumeRefusal }> => {
    await db.query('ROLLBACK TO SAVEPOINT consume_call_session');
    return refused(reason);
  };
  // The whole decision again, at the last moment before the number leaves the server.
  const destination = session.purpose === 'audio_test'
    ? await resolveAudioTestDestination(context, session.id, input.configuredCallerIdE164)
    : await consumeBusinessDestination(context, session.ticket_id, input);
  if (!destination.ok) return await undo(destination.reason);
  const { e164, callerIdE164 } = destination.value;
  const consumedAt = await clockInstant(db);
  if (Date.parse(consumedAt) >= session.expires_at.getTime()) return await undo('session_expired');

  const placed = await db.query(
    `UPDATE call_sessions SET consumed_at = $4::timestamptz, twilio_call_sid = $3, updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND id = $2 AND consumed_at IS NULL AND expires_at>$4::timestamptz`,
    [input.workspaceId, input.sessionId, input.callSid, consumedAt],
  );
  if (!placed.rowCount) return await undo('session_expired');
  // From this commit on, a call may have happened: the reservation says so. Required:
  // a reservation that did not move is a call nobody would pay for.
  if (!(await markCalling(context, session.reservation_id))) return await undo('reservation_closed');
  const { rows: limits } = await db.query<{ max_units: number | null }>(
    'SELECT max_units FROM provider_reservations WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, session.reservation_id],
  );
  const maxSeconds = session.purpose === 'audio_test' ? 60 : Math.max(60, Number(limits[0]?.max_units ?? 1) * 60);
  if (session.purpose === 'business' && session.firm_id) {
    await attributeFirmInteraction(context,{firmId:session.firm_id,kind:'call',subjectId:session.id});
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
  }
  const final = await readCallSessionClearance(context, session.id);
  if (!final.ok) return await undo(final.reason);
  return {
    ok: true,
    value: { sessionId: session.id, workspaceId: input.workspaceId, e164, callerIdE164, maxSeconds },
  };
}

async function consumeBusinessDestination(
  context: ReturnType<typeof repositoryContext>,
  ticketId: string | null,
  input: { readonly at?: string | undefined; readonly configuredCallerIdE164?: string | undefined },
): Promise<{ readonly ok: true; readonly value: { readonly e164: string; readonly callerIdE164: string } } | { readonly ok: false; readonly reason: ConsumeRefusal }> {
  if (!ticketId) return { ok: false, reason: 'ticket_unknown' };
  const ticket = (await context.db.query<{ device_id: string; calling_identity_id: string }>(
    'SELECT device_id,calling_identity_id FROM dial_tickets WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, ticketId],
  )).rows[0];
  if (!ticket || context.scope.actor.kind !== 'user') return { ok: false, reason: 'ticket_unknown' };
  const device = (await context.db.query("SELECT id FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND status='active' FOR SHARE",
    [context.scope.workspaceId, ticket.device_id, context.scope.actor.userId])).rows[0];
  if (!device) return { ok: false, reason: 'ticket_wrong_device' };
  const consumed = await consumeBrowserDialTicket(context, { ticketId, deviceId: ticket.device_id, ...(input.at === undefined ? {} : { at: input.at }) });
  if (!consumed.ok) return consumed;
  const callerIdE164 = (await context.db.query<{ e164: string }>('SELECT e164 FROM calling_identities WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, ticket.calling_identity_id])).rows[0]?.e164;
  if (!callerIdE164) return { ok: false, reason: 'identity_missing' };
  if (input.configuredCallerIdE164 !== undefined && callerIdE164 !== input.configuredCallerIdE164) return { ok: false, reason: 'caller_id_mismatch' };
  return { ok: true, value: { e164: consumed.value.e164, callerIdE164 } };
}
