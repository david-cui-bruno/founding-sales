import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The send gate: the lock that makes "no send after a stop commits" a property of the
 * database rather than of timing (specification 11.2, 7.3, 10.2, 12.6, Appendix A,
 * Appendix G 3 and 6; lane g77).
 *
 * 11.2 says the worker "re-reads inside the claiming transaction" before every
 * external action. A re-read is only half of that sentence. Under PostgreSQL's READ
 * COMMITTED, a reply's hold that commits *after* the re-read's statement and *before*
 * the claim commits is invisible to the re-read and does not stop the claim, and the
 * email then leaves after the reply linearized — Appendix G 3 exactly. Row locks cannot
 * close that window on their own: a hold and a suppression are INSERTs into tables the
 * dispatch reads by predicate, so there is no existing row for either side to lock.
 *
 * So both sides take one lock, per workspace:
 *
 *   * **the dispatch claim** holds it SHARED from before its re-check until the claim
 *     commits (`lockSendGateForDispatch`). Two claims never wait for each other;
 *   * **every writer of a stop fact** takes it EXCLUSIVE inside its own transaction,
 *     before it commits (`lockSendGateForStopFact`): a hold opening, a restrictive
 *     suppression event, an opportunity going manual or closing, an enrollment ending,
 *     a firm changing hands.
 *
 * The result is a total order between each claim and each stop. A stop that took the
 * gate first commits before the claim can read, and the re-check sees it. A claim that
 * took it first commits before the stop can, so the send linearizes before the stop —
 * the one ordering Appendix B already accepts, because `dispatching` is irreversible.
 * There is no third interleaving.
 *
 * ## Only restrictive writes take it
 *
 * Releasing a hold, correcting a suppression and reopening an opportunity make sending
 * *more* permissive. A claim racing one of those can only err towards not sending,
 * which is the safe direction, so they do not queue behind in-flight claims.
 *
 * ## Lock order: the gate first, then rows
 *
 * The claim takes nothing before the gate, then the fence and the enrollment
 * `FOR UPDATE`, then the day's send counter. A writer should take the gate before it
 * locks any of those rows; `applyClassificationEffects` and the direct-send counter take
 * it first thing for that reason. A writer that arrives already holding one of those
 * rows can deadlock with a claim, and PostgreSQL's detector aborts one of the two. That
 * is a retry, never a send: the claim transaction has written nothing irreversible
 * until it commits, and the provider call happens only after the commit.
 *
 * ## Autocommit callers get nothing
 *
 * A transaction advisory lock taken in autocommit mode is released when its own
 * statement ends. Every writer that matters runs in a transaction — API commands, and
 * every job handler except the `outbound_fence` one, which is the dispatch itself — and
 * the claim opens its own. `docs/decisions/g77-dispatch-rechecks-under-the-lock.md`.
 */

/** The lock's name. One per workspace: a single-owner product has nothing to shard. */
export function sendGateLockName(workspaceId: string): string {
  return `fss.send-gate:${workspaceId}`;
}

/**
 * Take the gate EXCLUSIVE for a write that can stop a send. Idempotent within a
 * transaction: a second call by the same transaction succeeds at once.
 */
export async function lockSendGateForStopFact(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    sendGateLockName(context.scope.workspaceId),
  ]);
}

/**
 * Take the gate SHARED for a dispatch claim. Held until the claim's transaction ends,
 * which is the whole of the window between the re-check and the claim.
 */
export async function lockSendGateForDispatch(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    sendGateLockName(context.scope.workspaceId),
  ]);
}
