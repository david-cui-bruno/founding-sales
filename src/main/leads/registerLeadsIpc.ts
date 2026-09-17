import {
  leadsListRequestSchema,
  leadsListResponseSchema,
} from '../../shared/contracts/leadsContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { LeadsProvider } from './leadsService';

/**
 * Registers exactly the one strict saved-people read channel and returns
 * its idempotent unregister function.
 */
export function registerLeadsIpc(
  provider: LeadsProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  return registerValidatedIpc({
    channel: 'leads:list',
    requestSchema: leadsListRequestSchema,
    responseSchema: leadsListResponseSchema,
    handler: (request) => provider.list(request),
    isTrustedRendererUrl,
  });
}
