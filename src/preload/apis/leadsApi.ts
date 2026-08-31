import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  leadBulkUpdateRequestSchema,
  leadFieldUpdateRequestSchema,
  leadsListRequestSchema,
  leadsListResponseSchema,
  type LeadBulkUpdateRequest,
  type LeadFieldUpdateRequest,
  type LeadsListRequest,
} from '../../shared/contracts/leadsContract';
import type { IpcClient } from '../ipcClient';

/** Preload-side Leads API: every request and response is schema-validated. */
export const createLeadsApi = (client: IpcClient) => ({
  list: (input: LeadsListRequest) =>
    client.request(
      'leads:list',
      leadsListRequestSchema,
      leadsListResponseSchema,
      input,
    ),
  updateField: (input: LeadFieldUpdateRequest) =>
    client.request(
      'leads:update-field',
      leadFieldUpdateRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  bulkUpdate: (input: LeadBulkUpdateRequest) =>
    client.request(
      'leads:bulk-update',
      leadBulkUpdateRequestSchema,
      mutationReceiptSchema,
      input,
    ),
});

export type LeadsApi = ReturnType<typeof createLeadsApi>;
