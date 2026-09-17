import type {
  LeadsListRequest,
  LeadsListResponse,
} from '../../shared/contracts/leadsContract';

/**
 * The renderer-facing saved-people surface: one strict paged read for the
 * company contact link. There are no person writes over IPC.
 */
export type LeadsProvider = {
  list(input: LeadsListRequest): Promise<LeadsListResponse>;
};

/** The domain facade method the saved-people slice consumes. */
export type LeadsDomainInvoker = {
  listLeadRows(input: LeadsListRequest): LeadsListResponse;
};
