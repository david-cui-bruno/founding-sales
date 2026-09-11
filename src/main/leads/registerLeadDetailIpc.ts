import { z } from 'zod';
import { outboundReceiptSchema, outboundCapabilitiesSchema } from '../../shared/contracts/outboundContract';
import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  findContactInfoReceiptSchema,
  findContactInfoRequestSchema,
} from '../../shared/contracts/enrichmentRequestContract';
import {
  beginOutboundRequestSchema,
  cloudScoreOverrideRequestSchema,
  confirmTransitionRequestSchema,
  dismissLeadRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
} from '../../shared/contracts/leadDetailContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LeadDetailProvider } from './leadDetailService';

/**
 * Registers exactly the seven strict lead-detail channels and returns one
 * idempotent unregister function that removes all of them.
 */
export function registerLeadDetailIpc(
  provider: LeadDetailProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const registrations = [
    () => registerValidatedIpc({
      channel: 'lead-detail:get',
      requestSchema: leadDetailRequestSchema,
      responseSchema: leadDetailSchema,
      handler: (request) => provider.get(request),
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:begin-outbound',
      requestSchema: beginOutboundRequestSchema,
      responseSchema: outboundReceiptSchema,
      handler: async (request) => {
        const receipt = outboundReceiptSchema.parse(await provider.beginOutbound(request));
        if (receipt.commandId !== request.commandId || receipt.channel !== request.channel) {
          throw new Error('Outbound receipt does not match the request.');
        }
        return receipt;
      },
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:outbound-capabilities',
      requestSchema: z.object({}).strict(),
      responseSchema: outboundCapabilitiesSchema,
      handler: () => provider.getOutboundCapabilities(),
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:confirm-transition',
      requestSchema: confirmTransitionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.confirmTransition(request),
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:dismiss',
      requestSchema: dismissLeadRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.dismissLead(request),
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:cloud-score-override',
      requestSchema: cloudScoreOverrideRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.overrideCloudScore(request),
      isTrustedRendererUrl,
    }),
    () => registerValidatedIpc({
      channel: 'lead-detail:find-contact-info',
      requestSchema: findContactInfoRequestSchema,
      responseSchema: findContactInfoReceiptSchema,
      handler: (request) => provider.findContactInfo(request),
      isTrustedRendererUrl,
    }),
  ];

  const unregisters: (() => void)[] = [];
  const cleanup = (): unknown[] => {
    const errors: unknown[] = [];
    for (const unregister of unregisters.splice(0).reverse()) {
      try { unregister(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  try {
    for (const register of registrations) unregisters.push(register());
  } catch (error) {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError([error, ...errors], 'Lead detail IPC registration and rollback failed.', { cause: error });
    throw error;
  }
  return () => {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError(errors, 'Lead detail IPC cleanup failed.');
  };
}
