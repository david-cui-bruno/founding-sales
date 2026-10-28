import type { CallSessionStatus } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { correctSettledCents, settleAttempt, type SettleOutcome } from '../research/reservations.ts';
import { lockMonthlyCash } from '../settings/cashCeiling.ts';
import { admitToAnalysisPath, lockGateAndFirmForCallSid } from './pendingHold.ts';
import { parkIfCadenceSpent } from './sessionCadence.ts';
import { telephonyReservationCents } from './sessionBudget.ts';
import type { EnqueueTranscriptionOutcome } from './transcription.ts';
import { eraseExpiredAudioTestDestinations } from './audioTestErasure.ts';

const UNANSWERED_PROVIDER_STATUSES: ReadonlySet<string> = new Set(['no-answer', 'busy']);

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
      /** The delivery's transcription enqueue (`admitToAnalysisPath`), for the route to log. */
      readonly transcription?: EnqueueTranscriptionOutcome;
    };

interface CallbackSessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly firm_id: string | null;
  readonly purpose: 'business' | 'audio_test';
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
    `SELECT id, workspace_id, firm_id, purpose, contact_id, actor_user_id, reservation_id, status, answered_at
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

  if (session.purpose === 'business' && session.firm_id && forward && status === 'in_progress' && session.answered_at === null) {
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
  if (session.purpose === 'business' && session.firm_id && forward && terminal && UNANSWERED_PROVIDER_STATUSES.has(input.providerStatus)) {
    const { rows: logged } = await db.query<{ call_log_id: string | null }>(
      'SELECT call_log_id FROM call_sessions WHERE workspace_id = $1 AND id = $2',
      [session.workspace_id, session.id],
    );
    if (logged[0]?.call_log_id == null) await parkIfCadenceSpent(context, { firmId: session.firm_id, sessionId: session.id });
  }

  // Slice 3a: every delivery, duplicates included, may complete the facts the pending-review
  // hold is admitted on (since S3T the analysis path's: an answer, then the recording). An
  // answer that arrives after the recording queues its transcription here (review S3T, 2).
  const admitted = session.purpose === 'business'
    ? await admitToAnalysisPath(db, { workspaceId: session.workspace_id, sessionId: session.id }) : null;

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

  if (session.purpose === 'audio_test') await eraseExpiredAudioTestDestinations(context, session.id);
  return {
    known: true,
    sessionId: session.id,
    status: forward ? status : session.status,
    applied: forward,
    settlement,
    ...(admitted ? { transcription: admitted.transcription } : {}),
  };
}

/**
 * A recording callback. Only the URL's path is kept (the host is Twilio's API and the
 * media needs the account's credentials either way). Idempotent. The session it names is
 * returned once the recording is stored, for slice C2's transcription enqueue.
 */
export async function recordCallRecording(
  db: Queryable,
  input: {
    readonly callSid: string;
    readonly recordingSid: string;
    readonly recordingUrl: string;
    readonly durationSeconds?: number | undefined;
    /**
     * Twilio's `RecordingStatus` was `completed` (or absent). A recording that is not final
     * (`absent`, `failed`) has no audio: its path and duration are not stored, so nothing is
     * transcribed or held on it, now or at a later status delivery (review S3T, finding 2).
     */
    readonly final?: boolean | undefined;
  },
): Promise<{
  readonly known: boolean;
  readonly recorded?: { readonly workspaceId: string; readonly sessionId: string };
  readonly transcription?: EnqueueTranscriptionOutcome;
}> {
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
  const final = input.final !== false;
  await db.query(
    `UPDATE call_sessions SET recording_sid = $3, recording_path = COALESCE($4, recording_path),
            recording_duration_seconds = COALESCE($5::integer, recording_duration_seconds), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [session.workspace_id, session.id, input.recordingSid, final ? path : null, final ? duration : null],
  );
  if (!final) return { known: true };
  if (session.purpose === 'audio_test') {
    await eraseExpiredAudioTestDestinations(systemContext(db, session.workspace_id), session.id);
    return { known: true, recorded: { workspaceId: session.workspace_id, sessionId: session.id } };
  }
  // The transcription enqueue (slice C2), then the hold: one admission (review S3T, finding 2).
  const admitted = await admitToAnalysisPath(db, { workspaceId: session.workspace_id, sessionId: session.id });
  return { known: true, recorded: { workspaceId: session.workspace_id, sessionId: session.id }, transcription: admitted.transcription };
}
