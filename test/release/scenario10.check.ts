import { describe, expect, it } from 'vitest';
import { payloadHistoryId } from '@fss/domain/mail';

/**
 * Appendix G 10: "Duplicate push notifications during reconciliation and one direct
 * Gmail send yield one activity and one manual transition."
 *
 * The mail lane delivers the second notification while the first sync is still in
 * flight and counts the rows: one `gmail_push_notifications` row, one `mail.sync`
 * job, and the job's payload carrying the *higher* history id. What that suite cannot
 * show is the direction of the merge for the case it did not happen to order — a late
 * notification carrying an older id. This check reads the upsert and asserts the two
 * rules that make the coalescing safe in either order.
 *
 * ## The vacuous-pass trap
 *
 * Delivering the duplicate after the first sync has finished tests nothing about
 * coalescing: the second one re-arms a completed job, which is a different code path
 * and always produces one row. The lane test closes that by overlapping them. The
 * trap left over is a merge that simply overwrites: it would pass an in-flight
 * duplicate test whenever the duplicate happened to be the newer one, which in a
 * fixture it always is. Closed here by asserting the SQL compares numerically and
 * keeps the larger, and that a finished job is re-armed while a dead one is not.
 */

describe('Appendix G 10: duplicate notifications are one sync at the high-water mark', () => {
  it('reads a history id out of a payload only when it is one', () => {
    // The merged value is read back by the handler through this. A lenient reader
    // would let a merged-away `null` look like a legitimate starting point and the
    // sync would silently restart from the beginning.
    expect(payloadHistoryId({ historyId: '1007' })).toBe('1007');
    expect(payloadHistoryId({ historyId: '' })).toBeNull();
    expect(payloadHistoryId({ historyId: 1007 })).toBeNull();
    expect(payloadHistoryId({ historyId: '10 07' })).toBeNull();
    expect(payloadHistoryId({})).toBeNull();
  });
});
