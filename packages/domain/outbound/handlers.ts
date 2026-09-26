import type { JobHandler } from '../jobs/handlerRegistry.ts';
import { repositoryContext } from '../db/workspaceScope.ts';
import { payloadMailboxId } from '../mail/coalesce.ts';
import { recordMailboxHeartbeat } from '../mail/mailboxes.ts';
import { reconcileMailbox, type ReconcileDeps } from './reconcile.ts';

/**
 * The `mail.reconcile` handler of Appendix C (12.5, Appendix B).
 *
 * | Work | Idempotency key | Effect protection |
 * |---|---|---|
 * | Mail reconciliation | `mail-reconcile:{mailbox}:{minute}` | Fence state machine |
 *
 * The protection is `outbound_fence`, and the registry refuses a handler that
 * declares anything else. It is honest in a way worth spelling out: running this
 * handler twice does not produce two of anything, because every transition it can
 * make is guarded by the fence's own `WHERE state = ...`. A second run of a fence
 * already moved to `sent` moves nothing and reports `not_reconciling`.
 *
 * The key carries a minute, so the scheduler materializes at most one reconciliation
 * per mailbox per minute however many fences are in doubt — and the handler then
 * reconciles *all* of that mailbox's outstanding fences in one claim, which is one
 * access-token refresh instead of twenty.
 *
 * ## This handler never sends
 *
 * It is the only outbound code path a replacement worker may take, and the strongest
 * statement about it is the absence: there is no call to `sendMessage` anywhere in
 * its reach. Appendix B — "a replacement worker may reconcile but never send a
 * dispatching fence again" — is therefore true by construction rather than by care.
 */

export interface OutboundHandlerOptions {
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
  /** How many fences one claim reconciles. A bound, so a backlog cannot hold a lease. */
  readonly limit?: number | undefined;
}

/**
 * A reconciliation is a handful of Sent searches. Two minutes is comfortably more
 * than a bounded pass and comfortably less than a stuck worker's time to notice.
 */
export const RECONCILE_LEASE_SECONDS = 120;

export function mailReconcileHandler(
  deps: ReconcileDeps,
  options: OutboundHandlerOptions = {},
): JobHandler {
  return {
    kind: 'mail.reconcile',
    protection: 'outbound_fence',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? RECONCILE_LEASE_SECONDS,
    handle: async input => {
      const mailboxId = payloadMailboxId(input.job.payload);
      const context = repositoryContext(input.scope, input.session);
      const reports = await reconcileMailbox(context, deps, {
        mailboxId,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      await recordMailboxHeartbeat(input.session, {
        workspaceId: input.scope.workspaceId,
        mailboxId,
        detail: {
          reconciled: reports.length,
          settled: reports.filter(report => report.outcome === 'sent').length,
          terminal: reports.filter(report => report.outcome === 'unknown_terminal').length,
        },
      });
      // A rate limit is the one outcome worth retrying the whole job for: the
      // backoff ladder is a better place to wait than a lease.
      if (reports.some(report => report.outcome === 'rate_limited')) {
        throw new Error('Gmail rate-limited the Sent-folder reconciliation');
      }
    },
  };
}
