import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { retentionBatchHandler } from '@fss/domain/retention/handler.ts';
import { RETENTION_LEDGER_KINDS, retentionBatchJobKey, retentionPeriodOf } from '@fss/domain/retention/kinds.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `retention.batch` job and the source that materializes it (10.3, 13.1,
 * Appendix C).
 *
 * The handler body is in `@fss/domain/retention`, beside the sweeps it runs, for the
 * reason every lane before this one kept its handler there: everything it touches is
 * domain code, and the at-least-once harness has to be able to register it without
 * importing `apps/worker`. This file is the composition — what this process
 * registers, and what the one-minute pass asks for.
 *
 * ## One job per workspace, kind and UTC day
 *
 * The key is Appendix C's `retention:{kind}:{period}` and the period is the UTC
 * calendar day, so every pass after the first on a given day finds
 * `UNIQUE(workspace_id, kind, idempotency_key)` already satisfied and inserts
 * nothing. A workspace whose scheduler was down all morning gets its sweep on the
 * first pass afterwards rather than losing the day — the same property
 * `todayBuildSource` relies on, and the reason neither source needs a "have I run
 * today" flag of its own.
 *
 * ## Why every kind, including the ones that sweep nothing
 *
 * `RETENTION_LEDGER_KINDS` is all eleven, and the source materializes a job for each
 * one every day, including `audit_events` (retained), `suppression_history`
 * (retained) and `operational_logs` (CloudWatch's). Those jobs write a ledger row
 * saying so and delete nothing.
 *
 * That is deliberate and it is the difference between a retention report and a
 * retention *claim*. A kind with no ledger rows is indistinguishable from a kind
 * whose job has been failing silently for a month; a kind with a row a day saying
 * `retained` is a horizon somebody can audit. Eleven rows a workspace a day is
 * nothing, and it is the cheapest proof of a negative available.
 */
export { retentionBatchHandler };

export function retentionBatchJobHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number; readonly limit?: number } = {},
): JobHandler {
  return retentionBatchHandler(options);
}

export function retentionSource(): DueWorkSource {
  return {
    name: 'retention-batch',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const period = retentionPeriodOf(now);
      const { rows } = await session.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      const specifications: JobSpecification[] = [];
      for (const row of rows) {
        for (const dataKind of RETENTION_LEDGER_KINDS) {
          specifications.push({
            workspaceId: row.id,
            kind: 'retention.batch',
            idempotencyKey: retentionBatchJobKey(dataKind, period),
            payload: { dataKind, period },
            // Six, matching the handler: a dead retention job is a horizon quietly
            // not being enforced, and the ladder should outlast a transient.
            maxAttempts: 6,
          });
        }
      }
      return specifications;
    },
  };
}
