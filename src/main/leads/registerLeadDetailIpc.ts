import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  beginOutboundRequestSchema,
  cloudScoreOverrideRequestSchema,
  confirmTransitionRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
} from '../../shared/contracts/leadDetailContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LeadDetailProvider } from './leadDetailService';

/**
 * Registers exactly the four strict lead-detail channels and returns one
 * idempotent unregister function that removes all of them.
 */
export function registerLeadDetailIpc(
  provider: LeadDetailProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc({
      channel: 'lead-detail:get',
      requestSchema: leadDetailRequestSchema,
      responseSchema: leadDetailSchema,
      handler: (request) => provider.get(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'lead-detail:begin-outbound',
      requestSchema: beginOutboundRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.beginOutbound(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'lead-detail:confirm-transition',
      requestSchema: confirmTransitionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.confirmTransition(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'lead-detail:cloud-score-override',
      requestSchema: cloudScoreOverrideRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.overrideCloudScore(request),
      isTrustedRendererUrl,
    }),
  ];

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
