import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { MailboxStatus, MailboxSyncState } from './types.ts';

/**
 * Proven mailbox coverage, as the send path asks about it (specification 12.3, 12.6,
 * 4.2, Appendix G 4; lane g77).
 *
 * 12.6: "While a mailbox grant is revoked or coverage unhealthy, every automated step
 * kind for that owner is held." Until lane g77 the send path read *unhealthy* as
 * `sync_state <> 'ready'`, and `ready` is a state the mailbox enters once and stays in:
 * a Gmail history read that is rate limited for an hour leaves it `ready`, and
 * `recordSyncError` even moves `last_synced_at` forward as it fails. A reply that
 * arrived in that hour was unread and unmatched, and nothing stopped the next email to
 * the person who wrote it.
 *
 * ## Which column is the proof
 *
 * `mailboxes` already carries two instants and they mean different things:
 *
 *   * `last_synced_at` is the **last attempt**. Every sync that reached Gmail writes
 *     it, the rate-limited failure included (`recordSyncError`). It says the worker is
 *     trying, never that it succeeded, and nothing on the send path may read it.
 *   * `coverage_watermark_at` is the **last success**, in 12.3's own words: "the
 *     instant through which every relevant message is known processed". It moves only
 *     when a sync finished the history it asked for (a capped run leaves it) or a
 *     recovery finished its whole interval, and it moves in the same statement as the
 *     cursor (`advanceCursor`). A rate-limited run does not touch it.
 *
 * So no migration: the distinct last-success time exists, and this file is what makes
 * the send path read it instead of the state.
 *
 * ## The window
 *
 * `COVERAGE_FRESHNESS_SECONDS` is fifteen minutes. The one-minute mailbox check
 * (`MAILBOX_CHECK_INTERVAL_SECONDS`) asks for a sync of every `ready` mailbox on every
 * scheduler pass, and a check with nothing new still raises the watermark to the moment
 * it read, so a healthy mailbox's watermark is never more than a couple of minutes old.
 * Three missed checks is already an alarm (13.3). Fifteen minutes is five times that:
 * enough to absorb a backlog drained over several capped passes, or a short Gmail 429,
 * without holding sends on a mailbox that is merely busy — and it is the longest a
 * prospect's reply can sit unread before FSS stops writing to them.
 *
 * `COVERAGE_CLOCK_SKEW_SECONDS` bounds the other side. A watermark in the future is a
 * claim the database clock cannot corroborate (the mail lane writes a Gmail internal
 * date or a host instant there), and one far enough ahead would read as fresh for as
 * long as it stayed ahead, whatever the sync was doing. A few seconds of skew between
 * hosts is normal; five minutes is not.
 *
 * The age is measured on the database's `clock_timestamp()`, not on a caller's clock:
 * freshness is about real elapsed time since the proof, and a test or a drill that
 * pins the sending window's clock to a Wednesday morning is not saying anything about
 * how long ago the mailbox was read.
 */

export const COVERAGE_FRESHNESS_SECONDS = 15 * 60;
export const COVERAGE_CLOCK_SKEW_SECONDS = 5 * 60;

export interface MailboxCoverage {
  readonly mailboxId: string;
  readonly ownerUserId: string;
  readonly status: MailboxStatus;
  readonly syncState: MailboxSyncState;
  /** The last success: 12.3's watermark. Null until a baseline completes. */
  readonly coverageWatermarkAt: string | null;
  /** The last attempt, successful or not. Reported, never trusted. */
  readonly lastAttemptAt: string | null;
  /** Seconds between the watermark and the database clock now; negative when ahead. */
  readonly ageSeconds: number | null;
  readonly fresh: boolean;
}

interface CoverageDbRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly status: MailboxStatus;
  readonly sync_state: MailboxSyncState;
  readonly coverage_watermark_at: Date | null;
  readonly last_synced_at: Date | null;
  readonly age_seconds: number | null;
  readonly [column: string]: unknown;
}

/** Whether a watermark this old proves coverage now. */
export function coverageIsFresh(ageSeconds: number | null): boolean {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return false;
  return ageSeconds >= -COVERAGE_CLOCK_SKEW_SECONDS && ageSeconds <= COVERAGE_FRESHNESS_SECONDS;
}

/** One mailbox's coverage, by id or by owner (12.1: one per owner). */
export async function readMailboxCoverage(
  context: RepositoryContext,
  selector: { readonly mailboxId: string } | { readonly ownerUserId: string },
): Promise<MailboxCoverage | null> {
  const byId = 'mailboxId' in selector;
  const { rows } = await context.db.query<CoverageDbRow>(
    `SELECT id, owner_user_id, status, sync_state, coverage_watermark_at, last_synced_at,
            extract(epoch FROM (clock_timestamp() - coverage_watermark_at))::float8 AS age_seconds
       FROM mailboxes
      WHERE workspace_id = $1 AND ${byId ? 'id' : 'owner_user_id'} = $2`,
    [context.scope.workspaceId, byId ? selector.mailboxId : selector.ownerUserId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const ageSeconds = row.age_seconds === null ? null : Number(row.age_seconds);
  return {
    mailboxId: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    syncState: row.sync_state,
    coverageWatermarkAt: row.coverage_watermark_at?.toISOString() ?? null,
    lastAttemptAt: row.last_synced_at?.toISOString() ?? null,
    ageSeconds,
    fresh: coverageIsFresh(ageSeconds),
  };
}

/**
 * The one decision: may this mailbox's owner have automated email right now?
 *
 * Null means yes. Otherwise the section 15 reason the work holds for: a missing or
 * disconnected mailbox is `mailbox_disconnected`, and a mailbox whose coverage is
 * unproved — still in its baseline, recovering, or proved too long ago — is
 * `coverage_incomplete`.
 */
export function coverageRefusal(
  coverage: MailboxCoverage | null,
): { readonly reason: 'mailbox_disconnected' | 'coverage_incomplete'; readonly detail: string } | null {
  if (coverage === null) return { reason: 'mailbox_disconnected', detail: 'no_mailbox' };
  if (coverage.status !== 'connected') return { reason: 'mailbox_disconnected', detail: coverage.status };
  if (coverage.syncState !== 'ready') return { reason: 'coverage_incomplete', detail: coverage.syncState };
  if (!coverage.fresh) {
    return {
      reason: 'coverage_incomplete',
      detail: coverage.ageSeconds === null ? 'no_watermark' : `stale:${String(Math.round(coverage.ageSeconds))}s`,
    };
  }
  return null;
}
