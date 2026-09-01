import {
  setHmacSaltRequestSchema,
  sourcingStatusSchema,
  type SetHmacSaltRequest,
} from '../../shared/contracts/sourcingContract';
import type { IpcClient } from '../ipcClient';

/** Preload-side sourcing API: every channel is schema-validated. */
export const createSourcingApi = (client: IpcClient) => ({
  pollNow: () => client.requestNoInput('sourcing:poll-now', sourcingStatusSchema),
  status: () => client.requestNoInput('sourcing:status', sourcingStatusSchema),
  setHmacSalt: (input: SetHmacSaltRequest) =>
    client.request(
      'sourcing:set-hmac-salt',
      setHmacSaltRequestSchema,
      sourcingStatusSchema,
      input,
    ),
});

export type SourcingApi = ReturnType<typeof createSourcingApi>;
