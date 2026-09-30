import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { sweepCallSessionReservations, workspacesOwingCallSessionSweep } from '@fss/domain/calls/sessions.ts';
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
      await sweepCallSessionReservations(repositoryContext(input.scope, input.session));
    },
  };
}

export function telephonySweepSource(): DueWorkSource {
  return {
    name: 'telephony-sweep',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const owing = await workspacesOwingCallSessionSweep(session);
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
