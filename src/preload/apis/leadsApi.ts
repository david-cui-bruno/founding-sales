import {
  leadsListRequestSchema,
  leadsListResponseSchema,
  type LeadsListRequest,
} from '../../shared/contracts/leadsContract';
import type { IpcClient } from '../ipcClient';

/**
 * Preload-side saved-people read used by the company contact link: the
 * request and the whole strict page are schema-validated.
 */
export const createLeadsApi = (client: IpcClient) => ({
  list: (input: LeadsListRequest) =>
    client.request(
      'leads:list',
      leadsListRequestSchema,
      leadsListResponseSchema,
      input,
    ),
});

export type LeadsApi = ReturnType<typeof createLeadsApi>;
