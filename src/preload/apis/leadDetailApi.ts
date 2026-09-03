import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  findContactInfoReceiptSchema,
  findContactInfoRequestSchema,
  type FindContactInfoRequest,
} from '../../shared/contracts/enrichmentRequestContract';
import {
  beginOutboundRequestSchema,
  cloudScoreOverrideRequestSchema,
  confirmTransitionRequestSchema,
  dismissLeadRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
  type BeginOutboundRequest,
  type CloudScoreOverrideRequest,
  type ConfirmTransitionRequest,
  type DismissLeadRequest,
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
  dismissLead: (input: DismissLeadRequest) =>
    client.request(
      'lead-detail:dismiss',
      dismissLeadRequestSchema,
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
  findContactInfo: (input: FindContactInfoRequest) =>
    client.request(
      'lead-detail:find-contact-info',
      findContactInfoRequestSchema,
      findContactInfoReceiptSchema,
      input,
    ),
});

export type LeadDetailApi = ReturnType<typeof createLeadDetailApi>;
