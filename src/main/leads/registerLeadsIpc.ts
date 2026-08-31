import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  leadBulkUpdateRequestSchema,
  leadFieldUpdateRequestSchema,
  leadsListRequestSchema,
  leadsListResponseSchema,
} from '../../shared/contracts/leadsContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LeadsProvider } from './leadsService';

/**
 * Registers exactly the three strict Leads channels and returns one
 * idempotent unregister function that removes all of them.
 */
export function registerLeadsIpc(
  provider: LeadsProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc({
      channel: 'leads:list',
      requestSchema: leadsListRequestSchema,
      responseSchema: leadsListResponseSchema,
      handler: (request) => provider.list(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'leads:update-field',
      requestSchema: leadFieldUpdateRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.updateField(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'leads:bulk-update',
      requestSchema: leadBulkUpdateRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.bulkUpdate(request),
      isTrustedRendererUrl,
    }),
  ];

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
