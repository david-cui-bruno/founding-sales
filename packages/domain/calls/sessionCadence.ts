import { CALL_CADENCE } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm } from '../crm/firms.ts';
import { openHold, releaseHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { databaseNow } from '../policy/clock.ts';
import { CALL_CADENCE_PARKED_SOURCE, readCallCadence, isoMicroseconds } from './cadence.ts';
import type { CallSessionRefusal, CallSessionResult } from './sessionTypes.ts';

const refuse = (reason: CallSessionRefusal): { readonly ok: false; readonly reason: CallSessionRefusal } => ({ ok: false, reason });

export { CALL_CADENCE_PARKED_SOURCE, UNANSWERED_OUTCOMES, readCallCadence, type CallCadenceState } from './cadence.ts';

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
    `SELECT EXISTS (SELECT 1 FROM call_sessions WHERE workspace_id=$1 AND firm_id=$2 AND id=$3 AND consumed_at IS NOT NULL
        UNION ALL SELECT 1 FROM phone_handoff_attempts WHERE workspace_id=$1 AND firm_id=$2 AND id=$3) AS placed,
       (SELECT ${isoMicroseconds('max(t)')} FROM (
          SELECT consumed_at AS t FROM call_sessions WHERE workspace_id=$1 AND firm_id=$2
          UNION ALL SELECT reserved_at FROM phone_handoff_attempts WHERE workspace_id=$1 AND firm_id=$2) a) AS latest`,
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
export async function parkFirmForReview(context: RepositoryContext, firmId: string, lastSessionId: string | null): Promise<string> {
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
