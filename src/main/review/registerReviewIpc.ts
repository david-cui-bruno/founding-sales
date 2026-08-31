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
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { ReviewProvider } from './reviewService';

export const REVIEW_LIST_CHANNEL = 'review:list';
export const REVIEW_RESOLVE_CHANNEL = 'review:resolve';

/**
 * Registers exactly `review:list` and `review:resolve`. Requests are parsed
 * against the strict discriminated contracts before the provider runs, so a
 * cross-kind resolution payload never reaches the domain.
 */
export function registerReviewIpc(
  provider: ReviewProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<ReviewListRequest, ReviewSnapshot>({
      channel: REVIEW_LIST_CHANNEL,
      requestSchema: reviewListRequestSchema,
      responseSchema: reviewSnapshotSchema,
      handler: (request) => provider.list(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<ResolveReviewRequest, MutationReceipt>({
      channel: REVIEW_RESOLVE_CHANNEL,
      requestSchema: resolveReviewRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.resolve(request),
      isTrustedRendererUrl,
    }),
  ];

  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
