import type {
  LeadDetail,
  LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';

/**
 * The renderer-facing saved-person surface: one evidence-rich read for the
 * company contact link. Person commands no longer cross IPC.
 */
export type LeadDetailProvider = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
};

/** The domain facade method the saved-person slice consumes. */
export type LeadDetailDomainInvoker = {
  getLeadDetail(input: LeadDetailRequest): LeadDetail;
};
