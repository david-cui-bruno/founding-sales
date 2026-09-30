import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { lockSendGateForStopFact } from '@fss/domain/policy/sendGate.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { hourOf, jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import {
  fetchCalcomBookings,
  reconcileCalcomBookings,
  type CalcomBookingsClient,
  type ReconcileCounts,
} from '@fss/domain/meetings/reconcile.ts';
import { workspacesWithIntegration } from '@fss/domain/settings/integrations.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `calcom.reconcile` job and its source (slice M1): once an hour, Cal.com's bookings
 * in `[now − 7 d, now + 60 d]` compared with `meetings`, and every difference fed to the
 * webhook's own `applyEvent` as a synthesized event (`meetings/reconcile.ts`).
 *
 * ## When it runs
 *
 * Only in a worker that was given a Cal.com API key (the `calcom` entry's optional
 * `api_key`; `readCalcomReconcileClient`), and only for **the one workspace** with
 * `calendar_integration = calcom` — the webhook's rule: with two switched on, which one
 * the bookings belong to is not knowable, so neither is reconciled. Without a key the
 * source finds nothing and the handler is not registered: off, not an error.
 *
 * ## Coalesced
 *
 * The key is `calcom-reconcile:{workspace}:{hour}`, so a pass that runs every minute
 * materializes one job an hour, like the telephony sweep's quarter hour.
 *
 * ## Bounded
 *
 * At most ten pages of a hundred bookings and thirty seconds of fetching, inside a lease of
 * ninety; then one transaction that applies what was read. A request that fails throws
 * and the runner retries the job; nothing was applied, because nothing is applied until
 * the read is complete.
 */
export const CALCOM_RECONCILE_MAX_ATTEMPTS = 3;

export interface CalcomReconcileOptions {
  readonly client: CalcomBookingsClient;
  /** The line a run leaves: its counts, never a booking. */
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  readonly now?: (() => string) | undefined;
  readonly clock?: (() => number) | undefined;
  readonly maxPages?: number | undefined;
  readonly deadlineMs?: number | undefined;
}

export function calcomReconcileJobHandler(options: CalcomReconcileOptions): JobHandler {
  return {
    kind: 'calcom.reconcile',
    protection: 'business_uniqueness',
    maxAttempts: CALCOM_RECONCILE_MAX_ATTEMPTS,
    leaseSeconds: 90,
    handle: async input => {
      const workspaceId = input.scope.workspaceId;
      // The job was queued for the workspace that had the switch then. Cal.com's bookings
      // are the deployment's, not a workspace's, so they may only land in the one
      // workspace that has it on *now* — asked when the job runs and again just before
      // the snapshot is applied (review fold 1, finding 4).
      const stillRouted = async (): Promise<boolean> => {
        const enabled = await workspacesWithIntegration(input.session, { key: 'calendar_integration', value: 'calcom' });
        return enabled.length === 1 && enabled[0] === workspaceId;
      };
      const skipped = (stage: 'before_fetch' | 'before_apply'): void => {
        options.log?.('calcom_reconcile_skipped', { workspace_id: workspaceId, reason: 'routing_changed', stage });
      };
      if (!(await stillRouted())) {
        skipped('before_fetch');
        return;
      }
      const now = options.now?.() ?? new Date().toISOString();
      const fetched = await fetchCalcomBookings(options.client, {
        now,
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      // The workspace's send gate first, then the switch, in the transaction that applies
      // (review fold 2, finding 4): a write of `calendar_integration` takes the same gate
      // (`settings/store.ts`), so turning this workspace off either committed before this
      // read — and nothing is applied — or waits until this transaction ends.
      await lockSendGateForStopFact(repositoryContext(input.scope, input.session));
      if (!(await stillRouted())) {
        skipped('before_apply');
        return;
      }
      const counts: ReconcileCounts = await reconcileCalcomBookings(input.session, {
        workspaceId,
        bookings: fetched.bookings,
        now,
        truncated: fetched.truncated,
      });
      options.log?.('calcom_reconcile', {
        workspace_id: workspaceId,
        pages: fetched.pages,
        malformed: fetched.malformed,
        truncated: fetched.truncated,
        ...counts,
      });
    },
  };
}

export function calcomReconcileSource(options: { readonly enabled: boolean }): DueWorkSource {
  return {
    name: 'calcom-reconcile',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      if (!options.enabled) return [];
      const enabled = await workspacesWithIntegration(session, { key: 'calendar_integration', value: 'calcom' });
      if (enabled.length !== 1) return [];
      const { rows } = await session.query<{ id: string; slug: string }>('SELECT id, slug FROM workspaces WHERE id = $1', [enabled[0]]);
      const hour = hourOf(now);
      return rows.map(row => ({
        workspaceId: row.id,
        kind: 'calcom.reconcile' as const,
        idempotencyKey: jobIdempotencyKey.calcomReconcile(row.slug, hour),
        payload: { hour },
        maxAttempts: CALCOM_RECONCILE_MAX_ATTEMPTS,
      }));
    },
  };
}
