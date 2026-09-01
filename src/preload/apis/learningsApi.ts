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
import type { IpcClient } from '../ipcClient';

const LEARNINGS_LIST_CHANNEL = 'learnings:list';
const LEARNINGS_CAPTURE_CHANNEL = 'learnings:capture';
const LEARNINGS_ADD_EVIDENCE_CHANNEL = 'learnings:add-evidence';
const LEARNINGS_UPDATE_STATUS_CHANNEL = 'learnings:update-status';

export type LearningsApi = {
  list(input: LearningsListRequest): Promise<LearningsListResponse>;
  capture(input: CaptureLearningRequest): Promise<MutationReceipt>;
  addEvidence(input: AddEvidenceRequest): Promise<MutationReceipt>;
  updateStatus(input: UpdateLearningStatusRequest): Promise<MutationReceipt>;
};

/** Typed preload API: the learnings query plus founder-curation commands. */
export const createLearningsApi = (client: IpcClient): LearningsApi => ({
  list: (input) => client.request(
    LEARNINGS_LIST_CHANNEL,
    learningsListRequestSchema,
    learningsListResponseSchema,
    input,
  ),
  capture: (input) => client.request(
    LEARNINGS_CAPTURE_CHANNEL,
    captureLearningRequestSchema,
    mutationReceiptSchema,
    input,
  ),
  addEvidence: (input) => client.request(
    LEARNINGS_ADD_EVIDENCE_CHANNEL,
    addEvidenceRequestSchema,
    mutationReceiptSchema,
    input,
  ),
  updateStatus: (input) => client.request(
    LEARNINGS_UPDATE_STATUS_CHANNEL,
    updateLearningStatusRequestSchema,
    mutationReceiptSchema,
    input,
  ),
});
