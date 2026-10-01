import type { Queryable } from '../db/queryable.ts';

/**
 * The calendar routing lock: one per deployment (Cal.com slice M1, review fold 3).
 *
 * Cal.com's deliveries and its bookings name no workspace. They land in **the one
 * workspace** whose `calendar_integration` is `calcom`, and with two switched on, in
 * neither. That predicate spans every workspace, so a workspace's own send gate cannot
 * hold it still: an administrator enabling workspace B takes only B's gate, and a
 * reconcile of A that checked "A alone is on" under A's gate would import into A after
 * B's switch committed.
 *
 * So the predicate has a lock of its own, across the deployment:
 *
 *   * **readers** take it SHARED before the workspace's send gate, decide the routing
 *     under it, and apply under it: the webhook (`apps/api/src/routes/calcom.ts`) and
 *     the reconciliation's final check and apply (`calcomReconcile.ts`). Two readers
 *     never wait for each other, so webhooks do not serialize on it;
 *   * **every write of `calendar_integration`**, in any workspace, takes it EXCLUSIVE
 *     before that workspace's send gate (`settings/store.ts`), so a switch either
 *     commits before a reader decides or waits until the reader has applied.
 *
 * Lock order, everywhere: this lock, then the workspace's send gate, then rows.
 * Nothing takes it after the gate. A transaction advisory lock: held to the end of the
 * caller's transaction, and worthless in autocommit.
 */
export const CALENDAR_ROUTING_LOCK_NAME = 'fss.calendar-routing';

/** Hold the routing still for a reader until its transaction ends. */
export async function lockCalendarRoutingForRead(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [CALENDAR_ROUTING_LOCK_NAME]);
}

/** Take the routing for a write of `calendar_integration`, before the workspace's gate. */
export async function lockCalendarRoutingForWrite(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CALENDAR_ROUTING_LOCK_NAME]);
}
