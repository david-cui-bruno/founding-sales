import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  beginOutboundRequestSchema,
  cloudScoreOverrideRequestSchema,
  confirmTransitionRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
  type BeginOutboundRequest,
  type CloudScoreOverrideRequest,
  type ConfirmTransitionRequest,
  type LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';
import type { IpcClient } from '../ipcClient';

/**
 * Preload-side lead detail API: every request and response is
 * schema-validated on both sides of the bridge.
 */
export const createLeadDetailApi = (client: IpcClient) => ({
  get: (input: LeadDetailRequest) =>
    client.request(
      'lead-detail:get',
      leadDetailRequestSchema,
      leadDetailSchema,
      input,
    ),
  beginOutbound: (input: BeginOutboundRequest) =>
    client.request(
      'lead-detail:begin-outbound',
      beginOutboundRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  confirmTransition: (input: ConfirmTransitionRequest) =>
    client.request(
      'lead-detail:confirm-transition',
      confirmTransitionRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  overrideCloudScore: (input: CloudScoreOverrideRequest) =>
    client.request(
      'lead-detail:cloud-score-override',
      cloudScoreOverrideRequestSchema,
      mutationReceiptSchema,
      input,
    ),
});

export type LeadDetailApi = ReturnType<typeof createLeadDetailApi>;
