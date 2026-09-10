import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  AddEvidenceRequest,
  CaptureLearningRequest,
  LearningsListRequest,
  LearningsListResponse,
  UpdateLearningStatusRequest,
} from '../../shared/contracts/learningsContract';

/**
 * Narrow surface the learnings IPC registrar depends on. The final
 * composition owner injects a delegate backed by the encrypted domain.
 */
export type LearningsProvider = {
  list(input: LearningsListRequest): Promise<LearningsListResponse>;
  capture(input: CaptureLearningRequest): Promise<MutationReceipt>;
  addEvidence(input: AddEvidenceRequest): Promise<MutationReceipt>;
  updateStatus(input: UpdateLearningStatusRequest): Promise<MutationReceipt>;
};

/**
 * The learnings query and founder-curation commands exposed by the encrypted
 * founder-sales domain.
 */
export type LearningsCommandSource = {
  listLearnings(
    input: LearningsListRequest,
  ): LearningsListResponse | Promise<LearningsListResponse>;
  captureLearning(
    input: CaptureLearningRequest,
  ): MutationReceipt | Promise<MutationReceipt>;
  addLearningEvidence(
    input: AddEvidenceRequest,
  ): MutationReceipt | Promise<MutationReceipt>;
  updateLearningStatus(
    input: UpdateLearningStatusRequest,
  ): MutationReceipt | Promise<MutationReceipt>;
};
