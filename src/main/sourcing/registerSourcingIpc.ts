import {
  sourcingStatusSchema,
  type SourcingStatus,
} from '../../shared/contracts/sourcingContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';

export type SourcingProvider = {
  pollNow(): Promise<SourcingStatus>;
  status(): Promise<SourcingStatus>;
};

/**
 * Registers exactly the two strict sourcing channels and returns one
 * idempotent unregister function that removes both.
 */
export function registerSourcingIpc(
  provider: SourcingProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<undefined, SourcingStatus>({
      channel: 'sourcing:poll-now',
      requestSchema: null,
      responseSchema: sourcingStatusSchema,
      handler: () => provider.pollNow(),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<undefined, SourcingStatus>({
      channel: 'sourcing:status',
      requestSchema: null,
      responseSchema: sourcingStatusSchema,
      handler: () => provider.status(),
      isTrustedRendererUrl,
    }),
  ];

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
