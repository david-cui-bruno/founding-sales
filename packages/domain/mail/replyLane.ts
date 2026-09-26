import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The reply lane, as a seam (specification 8.2, Appendix A "Record uncertain or
 * ambiguous reply").
 *
 * Appendix A puts the Today reply entry in the *same transaction* as the message, its
 * candidates and their holds. The Today lane owns `today_items` and exports
 * `promoteReply(context, { firmId, contactId?, messageId, receivedAt })` from
 * `@fss/domain/today`, which writes one item with `item_key` `reply-message:<id>`,
 * kind `reply`, `source_kind` `reply_message`, in lane 1.
 *
 * This lane calls it through a one-method port for one reason: G6's migration 0008
 * lands after this pull request, and a hard import would make the mail lane
 * unbuildable until it does. The port is not a hedge about whether the reply lane
 * exists — the recording fake in the tests asserts that the promotion happens inside
 * the importing transaction, with the message's own id and the instant it arrived,
 * which is the part Appendix A is actually about.
 *
 * `pendingReplyPromoter` is what the composition passes until `@fss/domain/today` is
 * on this branch. It is deliberately not silent about being a placeholder: it counts
 * what it was asked to promote, and the caller has already written the
 * `reply_lane_entry` row in `mail_message_effects`, so nothing is lost when the real
 * adapter replaces it — the reply is on the firm's card the next time Today is built,
 * and the effect row says it was due before then. See
 * `docs/decisions/g7-reply-lane-port.md`.
 */

export interface ReplyPromotion {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly messageId: string;
  /** The instant the message arrived, so the lane sorts by when the prospect wrote. */
  readonly receivedAt: string;
}

export interface ReplyPromoter {
  promoteReply(context: RepositoryContext, promotion: ReplyPromotion): Promise<void>;
}

/** The item key G6 builds. Written here so a test can assert on it without G6. */
export function replyItemKey(messageId: string): string {
  return `reply-message:${messageId}`;
}

/** Records what it was asked to promote. The tests' promoter. */
export function recordingReplyPromoter(): ReplyPromoter & { readonly promotions: readonly ReplyPromotion[] } {
  const promotions: ReplyPromotion[] = [];
  return {
    promotions,
    promoteReply: async (_context, promotion) => {
      await Promise.resolve();
      promotions.push(promotion);
    },
  };
}

export interface PendingReplyPromoter extends ReplyPromoter {
  /** How many promotions were deferred. An operator reads it in the sync report. */
  readonly deferred: number;
}

/**
 * The placeholder the composition passes until `@fss/domain/today` is on this branch.
 * One line changes when it is.
 */
export function pendingReplyPromoter(): PendingReplyPromoter {
  let deferred = 0;
  return {
    get deferred(): number {
      return deferred;
    },
    promoteReply: async () => {
      await Promise.resolve();
      deferred += 1;
    },
  };
}
