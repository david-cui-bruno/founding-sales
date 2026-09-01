import {
  sourcingStatusSchema,
} from '../../shared/contracts/sourcingContract';
import type { IpcClient } from '../ipcClient';

/** Preload-side sourcing API: both channels are schema-validated, no input. */
export const createSourcingApi = (client: IpcClient) => ({
  pollNow: () => client.requestNoInput('sourcing:poll-now', sourcingStatusSchema),
  status: () => client.requestNoInput('sourcing:status', sourcingStatusSchema),
});

export type SourcingApi = ReturnType<typeof createSourcingApi>;
