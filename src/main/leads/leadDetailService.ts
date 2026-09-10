import type { OutboundCapabilities, OutboundReceipt, OutboundReason } from '../../shared/contracts/outboundContract';
import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  FindContactInfoReceipt,
  FindContactInfoRequest,
} from '../../shared/contracts/enrichmentRequestContract';
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
 * guarded commands; outbound execution returns a truthful receipt, not a communication Activity.
 */
export type LeadDetailProvider = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<OutboundReceipt>;
  getOutboundCapabilities(): Promise<OutboundCapabilities>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
  dismissLead(input: DismissLeadRequest): Promise<MutationReceipt>;
  overrideCloudScore(input: CloudScoreOverrideRequest): Promise<MutationReceipt>;
  findContactInfo(input: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
};

/** Upstream writer surface for the Find contact info action. */
export type EnrichmentRequester = {
  request(input: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
};

/** The domain facade methods the lead detail slice consumes. */
export type LeadDetailDomainInvoker = {
  getLeadDetail(input: LeadDetailRequest): LeadDetail;
  recordOutboundRefusal(input: BeginOutboundRequest, reason: OutboundReason): OutboundReceipt;
  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt;
  dismissLead(input: DismissLeadRequest): MutationReceipt;
  enqueueCloudScoreOverride(input: CloudScoreOverrideRequest): MutationReceipt;
};

/** Fixed fail-closed status only. No probes, personal-data reads or enablement flags. */
export function unavailableOutboundCapabilities(): OutboundCapabilities {
  const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' } as const;
  return { phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
    callObservation: unavailable, recording: unavailable, messagesSend: unavailable,
    gmailSend: unavailable, managedAudioImport: unavailable, appleTranscriptExtraction: unavailable,
    localDrafts: true };
}
