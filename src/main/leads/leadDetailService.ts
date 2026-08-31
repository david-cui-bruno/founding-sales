import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  BeginOutboundRequest,
  ConfirmTransitionRequest,
  LeadDetail,
  LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';

/**
 * The renderer-facing lead detail surface. One evidence-rich read plus the
 * two guarded commands; both writes return MutationReceipts.
 */
export type LeadDetailProvider = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<MutationReceipt>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
};

/** The domain facade methods the lead detail slice consumes. */
export type LeadDetailDomainInvoker = {
  getLeadDetail(input: LeadDetailRequest): LeadDetail;
  beginOutbound(input: BeginOutboundRequest): MutationReceipt;
  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt;
};

/**
 * Thin delegate from the lead detail IPC surface to the domain facade. All
 * business rules, SQL, and DTO mapping live behind the facade, not here.
 */
export function createLeadDetailService(
  domain: LeadDetailDomainInvoker,
): LeadDetailProvider {
  return {
    get: async (input) => domain.getLeadDetail(input),
    beginOutbound: async (input) => domain.beginOutbound(input),
    confirmTransition: async (input) => domain.confirmTransition(input),
  };
}
