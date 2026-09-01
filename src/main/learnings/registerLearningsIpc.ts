import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../shared/contracts/commonContract';
import {
  addEvidenceRequestSchema,
  captureLearningRequestSchema,
  learningsListRequestSchema,
  learningsListResponseSchema,
  updateLearningStatusRequestSchema,
  type AddEvidenceRequest,
  type CaptureLearningRequest,
  type LearningsListRequest,
  type LearningsListResponse,
  type UpdateLearningStatusRequest,
} from '../../shared/contracts/learningsContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LearningsProvider } from './learningsService';

export const LEARNINGS_LIST_CHANNEL = 'learnings:list';
export const LEARNINGS_CAPTURE_CHANNEL = 'learnings:capture';
export const LEARNINGS_ADD_EVIDENCE_CHANNEL = 'learnings:add-evidence';
export const LEARNINGS_UPDATE_STATUS_CHANNEL = 'learnings:update-status';

/**
 * Registers exactly the four learnings channels. Requests and responses are
 * re-validated against the strict contracts on both sides of the boundary.
 */
export function registerLearningsIpc(
  provider: LearningsProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<LearningsListRequest, LearningsListResponse>({
      channel: LEARNINGS_LIST_CHANNEL,
      requestSchema: learningsListRequestSchema,
      responseSchema: learningsListResponseSchema,
      handler: (request) => provider.list(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<CaptureLearningRequest, MutationReceipt>({
      channel: LEARNINGS_CAPTURE_CHANNEL,
      requestSchema: captureLearningRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.capture(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<AddEvidenceRequest, MutationReceipt>({
      channel: LEARNINGS_ADD_EVIDENCE_CHANNEL,
      requestSchema: addEvidenceRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.addEvidence(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<UpdateLearningStatusRequest, MutationReceipt>({
      channel: LEARNINGS_UPDATE_STATUS_CHANNEL,
      requestSchema: updateLearningStatusRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.updateStatus(request),
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
