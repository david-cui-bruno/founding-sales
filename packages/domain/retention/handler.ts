import type { JobHandler } from '../jobs/handlerRegistry.ts';
import { repositoryContext } from '../db/workspaceScope.ts';
import { isRetentionLedgerKind } from './kinds.ts';
import { runRetentionBatch } from './runs.ts';

/**
 * The `retention.batch` job handler (Appendix C, specification 10.3).
 *
 * | Work | Idempotency key | Effect protection |
 * | Retention batch | `retention:{kind}:{period}` | Deletion tombstone and bounded range |
 *
 * `business_uniqueness` is the protection Appendix C names and the registry refuses
 * any other. It is honest here for a reason worth writing down: the effect is not
 * "some rows were deleted", which cannot be made idempotent by wishing — it is the
 * claim of one `retention_runs` row whose `UNIQUE(workspace_id, data_kind, period)`
 * a second attempt loses. A worker whose lease was stolen rolls the whole
 * transaction back, claim included, and the worker that holds the lease sweeps.
 *
 * The handler lives in `@fss/domain` rather than in `apps/worker` for the reason
 * G4's finalizer and G7's mail handlers keep theirs there: everything it touches is
 * domain code, and `packages/domain/jobs/atLeastOnce.ts` has to be able to register
 * it without importing the worker.
 *
 * Six attempts rather than four. The default ladder in
 * `docs/decisions/g5-retry-ladder.md` gives four, and a dead retention job is a
 * horizon quietly not being enforced — which is a finding rather than an outage, so
 * it deserves to be retried across a longer transient than a send does. A sweep is
 * bounded at `RETENTION_BATCH_LIMIT` rows, so a retry is cheap.
 */
export function retentionBatchHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number; readonly limit?: number } = {},
): JobHandler {
  return {
    kind: 'retention.batch',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 6,
    // A bounded delete over an indexed predicate; sixty seconds is the default and
    // is generous for five hundred rows.
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const dataKind = input.job.payload['dataKind'];
      const period = input.job.payload['period'];
      if (typeof dataKind !== 'string' || !isRetentionLedgerKind(dataKind)) {
        throw new Error('a retention.batch payload names one of the retention kinds');
      }
      if (typeof period !== 'string') {
        throw new Error('a retention.batch payload names the period it sweeps');
      }
      const { rows } = await input.session.query<{ now: Date }>('SELECT now() AS now');
      const now = (rows[0]?.now ?? new Date()).toISOString();
      await runRetentionBatch(repositoryContext(input.scope, input.session), {
        dataKind,
        period,
        now,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
    },
  };
}
