import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../shared/contracts/commonContract';
import {
  resolveReviewRequestSchema,
  reviewListRequestSchema,
  reviewSnapshotSchema,
  type ResolveReviewRequest,
  type ReviewListRequest,
  type ReviewSnapshot,
} from '../../shared/contracts/reviewContract';
import type { IpcClient } from '../ipcClient';

const REVIEW_LIST_CHANNEL = 'review:list';
const REVIEW_RESOLVE_CHANNEL = 'review:resolve';

export type ReviewApi = {
  list(input: ReviewListRequest): Promise<ReviewSnapshot>;
  resolve(input: ResolveReviewRequest): Promise<MutationReceipt>;
};

/** Typed preload API: one review query and one discriminated resolution command. */
export const createReviewApi = (client: IpcClient): ReviewApi => ({
  list: (input) => client.request(
    REVIEW_LIST_CHANNEL, reviewListRequestSchema, reviewSnapshotSchema, input,
  ),
  resolve: (input) => client.request(
    REVIEW_RESOLVE_CHANNEL, resolveReviewRequestSchema, mutationReceiptSchema, input,
  ),
});
