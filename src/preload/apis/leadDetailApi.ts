import {
  leadDetailRequestSchema,
  leadDetailSchema,
  type LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';
import type { IpcClient } from '../ipcClient';

/**
 * Preload-side saved-person read used by the company contact link: the
 * request and the evidence-rich detail are schema-validated on both sides
 * of the bridge.
 */
export const createLeadDetailApi = (client: IpcClient) => ({
  get: (input: LeadDetailRequest) =>
    client.request(
      'lead-detail:get',
      leadDetailRequestSchema,
      leadDetailSchema,
      input,
    ),
});

export type LeadDetailApi = ReturnType<typeof createLeadDetailApi>;
