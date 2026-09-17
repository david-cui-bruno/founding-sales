import {
  leadDetailRequestSchema,
  leadDetailSchema,
} from '../../shared/contracts/leadDetailContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LeadDetailProvider } from './leadDetailService';

/**
 * Registers exactly the one strict saved-person read channel and returns
 * its idempotent unregister function.
 */
export function registerLeadDetailIpc(
  provider: LeadDetailProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  return registerValidatedIpc({
    channel: 'lead-detail:get',
    requestSchema: leadDetailRequestSchema,
    responseSchema: leadDetailSchema,
    handler: (request) => provider.get(request),
    isTrustedRendererUrl,
  });
}
