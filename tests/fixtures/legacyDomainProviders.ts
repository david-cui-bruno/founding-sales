import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import type { FindContactInfoReceipt, FindContactInfoRequest } from '../../src/shared/contracts/enrichmentRequestContract';
import type { OutboundCapabilities } from '../../src/shared/contracts/outboundContract';

/**
 * Test-only providers over the domain facade methods whose renderer surfaces
 * (legacy Today queue, Pipeline, Inbox reviews, Friday, CSV person import,
 * Conversations, Learnings) were removed from the desktop. The domain methods
 * themselves stay until PR B excises them; these thin gates keep their direct
 * domain tests and person-seeding helpers runnable in the meantime. Nothing
 * here is registered over IPC.
 */
type DomainGate = Pick<FoundationRuntime, 'withDomain'>;
type Input<Method extends keyof FounderSalesDomain> =
  FounderSalesDomain[Method] extends (input: infer Request, ...rest: never[]) => unknown ? Request : never;

export function createTodayProvider(runtime: DomainGate) {
  return {
    get: () => runtime.withDomain((domain) => domain.getToday()),
    complete: (input: Input<'completePrimaryAction'>) => runtime.withDomain((domain) => domain.completePrimaryAction(input)),
    snooze: (input: Input<'snoozePrimaryAction'>) => runtime.withDomain((domain) => domain.snoozePrimaryAction(input)),
    pin: (input: Input<'pinWithinLane'>) => runtime.withDomain((domain) => domain.pinWithinLane(input)),
    logPastActivity: (input: Input<'logPastActivity'>) => runtime.withDomain((domain) => domain.logPastActivity(input)),
    addLeadNote: (input: Input<'addLeadNote'>) => runtime.withDomain((domain) => domain.addLeadNote(input)),
    logCallOutcome: (input: Input<'logCallOutcome'>) => runtime.withDomain((domain) => domain.logCallOutcome(input)),
    markActivityInError: (input: Input<'markActivityInError'>) => runtime.withDomain((domain) => domain.markActivityInError(input)),
    getLeadTriageSnapshot: (input: Input<'getLeadTriageSnapshot'>) => runtime.withDomain((domain) => domain.getLeadTriageSnapshot(input)),
    getTriageQueue: () => runtime.withDomain((domain) => domain.getTriageQueue()),
    setReviewPosition: (input: Input<'setReviewPosition'>) => runtime.withDomain((domain) => domain.setReviewPosition(input)),
  };
}
export type TodayProvider = ReturnType<typeof createTodayProvider>;

export function createPipelineProvider(runtime: DomainGate) {
  return { get: () => runtime.withDomain((domain) => domain.getPipelineProjection()) };
}
export type PipelineProvider = ReturnType<typeof createPipelineProvider>;

export function createReviewProvider(runtime: DomainGate) {
  return {
    list: (input: Input<'listReviewItems'>) => runtime.withDomain((domain) => domain.listReviewItems(input)),
    resolve: (input: Input<'resolveReviewItem'>) => runtime.withDomain((domain) => domain.resolveReviewItem(input)),
  };
}
export type ReviewProvider = ReturnType<typeof createReviewProvider>;

export function createFridayProvider(runtime: DomainGate) {
  return {
    getCurrent: (input?: Input<'getFridayReport'>) => runtime.withDomain((domain) => domain.getFridayReport(input)),
    getDrilldown: (input: Input<'getMetricDrilldown'>) => runtime.withDomain((domain) => domain.getMetricDrilldown(input)),
    createJob: (input: Input<'createJobRequest'>) => runtime.withDomain((domain) => domain.createJobRequest(input)),
    fillJob: (input: Input<'markJobFilled'>) => runtime.withDomain((domain) => domain.markJobFilled(input)),
    cancelJob: (input: Input<'cancelJobRequest'>) => runtime.withDomain((domain) => domain.cancelJobRequest(input)),
  };
}
export type FridayProvider = ReturnType<typeof createFridayProvider>;

export function createImportProvider(runtime: DomainGate) {
  return {
    preview: (input: Input<'previewLeadImport'>) => runtime.withDomain((domain) => domain.previewLeadImport(input)),
    remap: (input: Input<'remapLeadImport'>) => runtime.withDomain((domain) => domain.remapLeadImport(input)),
    commit: (input: Input<'commitLeadImport'>) => runtime.withDomain((domain) => domain.commitLeadImport(input)),
    status: (input: Input<'getImportJob'>) => runtime.withDomain((domain) => domain.getImportJob(input)),
  };
}
export type ImportProvider = ReturnType<typeof createImportProvider>;

export function createConversationsProvider(runtime: DomainGate) {
  return {
    list: (input: Input<'listConversations'>) => runtime.withDomain((domain) => domain.listConversations(input)),
    get: (input: Input<'getConversationDetail'>) => runtime.withDomain((domain) => domain.getConversationDetail(input)),
    attachTranscript: (input: Input<'attachTranscript'>) => runtime.withDomain((domain) => domain.attachTranscript(input)),
  };
}
export type ConversationsProvider = ReturnType<typeof createConversationsProvider>;

export function createLearningsProvider(runtime: DomainGate) {
  return {
    list: (input: Input<'listLearnings'>) => runtime.withDomain((domain) => domain.listLearnings(input)),
    capture: (input: Input<'captureLearning'>) => runtime.withDomain((domain) => domain.captureLearning(input)),
    addEvidence: (input: Input<'addLearningEvidence'>) => runtime.withDomain((domain) => domain.addLearningEvidence(input)),
    updateStatus: (input: Input<'updateLearningStatus'>) => runtime.withDomain((domain) => domain.updateLearningStatus(input)),
  };
}
export type LearningsProvider = ReturnType<typeof createLearningsProvider>;

/** The pre-removal Leads slice: the surviving list read plus the two removed person writes. */
export function createLegacyLeadsProvider(runtime: DomainGate) {
  return {
    list: (input: Input<'listLeadRows'>) => runtime.withDomain((domain) => domain.listLeadRows(input)),
    updateField: (input: Input<'updateLeadField'>) => runtime.withDomain((domain) => domain.updateLeadField(input)),
    bulkUpdate: (input: Input<'bulkUpdateLeads'>) => runtime.withDomain((domain) => domain.bulkUpdateLeads(input)),
  };
}
export type LegacyLeadsProvider = ReturnType<typeof createLegacyLeadsProvider>;

/** Upstream writer surface the removed Find contact info action used. */
export type EnrichmentRequester = {
  request(input: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
};

/** Fixed fail-closed status only. No probes, personal-data reads or enablement flags. */
export function unavailableOutboundCapabilities(): OutboundCapabilities {
  const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' } as const;
  return { phoneHandoff: { state: 'unavailable', reasonCode: 'phone_route_unverified' },
    callObservation: unavailable, recording: unavailable, messagesSend: unavailable,
    gmailSend: unavailable, managedAudioImport: unavailable, appleTranscriptExtraction: unavailable,
    localDrafts: true };
}

/** The pre-removal lead-detail slice composition: the surviving read plus the removed guarded commands. */
export function createLegacyLeadDetailProvider(
  runtime: DomainGate,
  enrichmentRequester?: EnrichmentRequester,
  outbound?: OutboundCommandServiceApi,
) {
  return {
    get: (input: Input<'getLeadDetail'>) => runtime.withDomain((domain) => domain.getLeadDetail(input)),
    beginOutbound: (input: Input<'recordOutboundRefusal'>) => outbound === undefined
      ? runtime.withDomain((domain) => domain.recordOutboundRefusal(input, input.channel === 'call' ? 'phone_route_unverified' : 'channel_unavailable'))
      : outbound.beginOutbound(input),
    getOutboundCapabilities: async () => outbound === undefined
      ? unavailableOutboundCapabilities() : outbound.getCapabilities(),
    confirmTransition: (input: Input<'confirmTransition'>) => runtime.withDomain((domain) => domain.confirmTransition(input)),
    dismissLead: (input: Input<'dismissLead'>) => runtime.withDomain((domain) => domain.dismissLead(input)),
    overrideCloudScore: (input: Input<'enqueueCloudScoreOverride'>) => runtime.withDomain((domain) => domain.enqueueCloudScoreOverride(input)),
    findContactInfo: async (input: FindContactInfoRequest): Promise<FindContactInfoReceipt> => (
      enrichmentRequester === undefined
        ? { written: false, refusalReason: 'credentials_unavailable' }
        : enrichmentRequester.request(input)
    ),
  };
}
export type LegacyLeadDetailProvider = ReturnType<typeof createLegacyLeadDetailProvider>;
