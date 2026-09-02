import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  DismissLeadRequest,
  LeadDetail,
  LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';

/**
 * The renderer-facing lead detail surface. One evidence-rich read plus the
 * guarded commands; all writes return MutationReceipts.
 */
export type LeadDetailProvider = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<MutationReceipt>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
  dismissLead(input: DismissLeadRequest): Promise<MutationReceipt>;
  overrideCloudScore(input: CloudScoreOverrideRequest): Promise<MutationReceipt>;
};

/** The domain facade methods the lead detail slice consumes. */
export type LeadDetailDomainInvoker = {
  getLeadDetail(input: LeadDetailRequest): LeadDetail;
  beginOutbound(input: BeginOutboundRequest): MutationReceipt;
  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt;
  dismissLead(input: DismissLeadRequest): MutationReceipt;
  enqueueCloudScoreOverride(input: CloudScoreOverrideRequest): MutationReceipt;
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
    dismissLead: async (input) => domain.dismissLead(input),
    overrideCloudScore: async (input) => domain.enqueueCloudScoreOverride(input),
  };
}
