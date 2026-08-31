import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  ResolveReviewRequest,
  ReviewListRequest,
  ReviewSnapshot,
} from '../../shared/contracts/reviewContract';

/**
 * Narrow surface the review IPC registrar depends on. The final composition
 * owner injects a delegate backed by the encrypted domain.
 */
export type ReviewProvider = {
  list(input: ReviewListRequest): Promise<ReviewSnapshot>;
  resolve(input: ResolveReviewRequest): Promise<MutationReceipt>;
};

/**
 * The review query and kind-discriminated resolution commands exposed by the
 * encrypted founder-sales domain. Queue shaping and CAS rules all live there.
 */
export type ReviewCommandSource = {
  listReviewItems(input: ReviewListRequest): ReviewSnapshot | Promise<ReviewSnapshot>;
  resolveReviewItem(input: ResolveReviewRequest): MutationReceipt | Promise<MutationReceipt>;
};

/** Thin delegate. No business rules and no SQL belong in this module. */
export const createReviewService = (
  source: ReviewCommandSource,
): ReviewProvider => ({
  list: async (input) => source.listReviewItems(input),
  resolve: async (input) => source.resolveReviewItem(input),
});
