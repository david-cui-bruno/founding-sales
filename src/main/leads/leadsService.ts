import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  LeadBulkUpdateRequest,
  LeadFieldUpdateRequest,
  LeadsListRequest,
  LeadsListResponse,
} from '../../shared/contracts/leadsContract';

/**
 * The renderer-facing Leads surface. Reads return whole strict pages and
 * writes return MutationReceipts; there is deliberately no general patch
 * object beyond the two allowed field updates.
 */
export type LeadsProvider = {
  list(input: LeadsListRequest): Promise<LeadsListResponse>;
  updateField(input: LeadFieldUpdateRequest): Promise<MutationReceipt>;
  bulkUpdate(input: LeadBulkUpdateRequest): Promise<MutationReceipt>;
};

/** The domain facade methods the Leads slice consumes. */
export type LeadsDomainInvoker = {
  listLeadRows(input: LeadsListRequest): LeadsListResponse;
  updateLeadField(input: LeadFieldUpdateRequest): MutationReceipt;
  bulkUpdateLeads(input: LeadBulkUpdateRequest): MutationReceipt;
};
