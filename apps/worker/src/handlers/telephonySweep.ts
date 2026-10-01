import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { sweepCallSessionReservations, workspacesOwingCallSessionSweep } from '@fss/domain/calls/sessions.ts';
import { sweepTranscriptionReservations, workspacesOwingTranscriptionSweep } from '@fss/domain/calls/transcription.ts';
import { sweepClassificationReservations, workspacesOwingClassificationSweep } from '@fss/domain/classification/classify.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey, quarterHourOf } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `telephony.sweep` job and its source (call-to-booking slice W, review fold 1,
 * finding 5): the backstop of the paid-call pattern for Twilio minutes.
 *
 * `sweepCallSessionReservations` releases the reservation of a session nobody placed
 * once its minute is over, and estimates at the full reservation a placed call whose
 * final callback never came once the longest call it could have been is over, plus
 * fifteen minutes. Without it an abandoned session holds the day's telephony budget and
 * a lost callback leaves a reservation `calling` for ever.
 *
 * ## Coalesced
 *
 * The key is `telephony-sweep:{workspace}:{quarter hour}`, so a pass that runs every
 * minute materializes at most one job a quarter hour for a workspace, and only for a
 * workspace that owes one: the source asks the sweep's own predicate
 * (`workspacesOwingCallSessionSweep`), so a quiet workspace inserts nothing and the
 * backlog stays truthful. The switch is not consulted: a workspace that turned calling
 * off still has its last reservations finalised.
 *
 * Slice C2 adds the transcription reservations (`sweepTranscriptionReservations`): one
 * still open half an hour after it was written belongs to a `call.transcribe` claim that
 * is gone, and is released (`reserved`) or estimated (`calling`) the same way. A workspace
 * owes a sweep when either predicate finds work. Slice P1 adds the reply classifier's
 * reservations the same way (`sweepClassificationReservations`, half an hour).
 *
 * There is no heartbeat: the job is one short transaction over at most a handful of
 * rows, well inside its sixty-second lease, and the job registry has no heartbeat
 * mechanism for a handler that is not chunked.
 */
export const TELEPHONY_SWEEP_MAX_ATTEMPTS = 4;

export function telephonySweepJobHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number } = {},
): JobHandler {
  return {
    kind: 'telephony.sweep',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? TELEPHONY_SWEEP_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const context = repositoryContext(input.scope, input.session);
      // One lock order (slice P1, fix round 2): the call sessions' rows in one statement,
      // then the settlements under the monthly spend lock; the transcription and classifier
      // subjects only by try-lock, which never waits, so nothing here waits while holding
      // the monthly lock.
      await sweepCallSessionReservations(context);
      await sweepTranscriptionReservations(context);
      await sweepClassificationReservations(context);
    },
  };
}

export function telephonySweepSource(): DueWorkSource {
  return {
    name: 'telephony-sweep',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const owing = [
        ...new Set([
          ...(await workspacesOwingCallSessionSweep(session)),
          ...(await workspacesOwingTranscriptionSweep(session)),
          ...(await workspacesOwingClassificationSweep(session)),
        ]),
      ];
      if (owing.length === 0) return [];
      const { rows } = await session.query<{ id: string; slug: string }>(
        'SELECT id, slug FROM workspaces WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[...owing]],
      );
      const quarterHour = quarterHourOf(now);
      return rows.map(row => ({
        workspaceId: row.id,
        kind: 'telephony.sweep' as const,
        idempotencyKey: jobIdempotencyKey.telephonySweep(row.slug, quarterHour),
        payload: { quarterHour },
        maxAttempts: TELEPHONY_SWEEP_MAX_ATTEMPTS,
      }));
    },
  };
}
