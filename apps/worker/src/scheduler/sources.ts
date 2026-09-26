import type { SessionQueryable } from '@fss/domain/db';
import { canaryJobKey, insertCanaryRun, quarterHourOf, type JobSpecification } from '@fss/domain/jobs';
import type { DueWorkSource } from './schedulerPass.ts';

/**
 * The due-work sources the scheduler pass reads.
 *
 * Only the canary exists in this slice; the sequence, Today, mail-sync, mail-recovery,
 * watch-renewal and retention sources are the lanes that own those tables,
 * and each one is a `DueWorkSource` added to the `sources` array the pass is given,
 * without touching the pass itself. The Appendix C key builders are in `@fss/domain/jobs`, so
 * a later lane composes its key rather than inventing one.
 */

/**
 * One canary per workspace per quarter hour (13.3). The row and the job are inserted
 * in the pass's transaction, so a pass that rolls back leaves neither, and both are
 * idempotent on the quarter hour, so a pass that runs twice in a minute leaves one.
 */
export function canarySource(): DueWorkSource {
  return {
    name: 'canary',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const quarterHour = quarterHourOf(now);
      const { rows } = await session.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      const specifications: JobSpecification[] = [];
      for (const row of rows) {
        await insertCanaryRun(session, row.id, now);
        specifications.push({
          workspaceId: row.id,
          kind: 'canary',
          idempotencyKey: canaryJobKey(now),
          payload: { quarterHour },
          maxAttempts: 4,
        });
      }
      return specifications;
    },
  };
}
