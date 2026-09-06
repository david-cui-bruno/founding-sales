import { z } from 'zod';
import { outboundReceiptSchema, outboundCapabilitiesSchema, type OutboundReceipt, type OutboundCapabilities } from '../../shared/contracts/outboundContract';
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
  beginOutbound: async (input: BeginOutboundRequest): Promise<OutboundReceipt> => {
    // Freeze the parsed identity across the asynchronous transport boundary.
    const request = beginOutboundRequestSchema.parse(input);
    const receipt = await client.request('lead-detail:begin-outbound', beginOutboundRequestSchema,
      outboundReceiptSchema, request);
    if (receipt.commandId !== request.commandId || receipt.channel !== request.channel) {
      throw new Error('Outbound receipt does not match the request.');
    }
    return { ...receipt, reasonCode: receipt.reasonCode };
  },
  getOutboundCapabilities: (): Promise<OutboundCapabilities> =>
    client.request('lead-detail:outbound-capabilities', z.object({}).strict(),
      outboundCapabilitiesSchema as z.ZodType<OutboundCapabilities>, {}),
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
