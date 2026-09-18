import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import type { FindContactInfoReceipt, FindContactInfoRequest } from '../../src/shared/contracts/enrichmentRequestContract';
import type { OutboundCapabilities } from '../../src/shared/contracts/outboundContract';

/**
 * Test-only providers over the domain facade methods whose renderer surfaces
 * (legacy Today queue, Friday, CSV person import, Leads, lead detail) were
 * removed from the desktop. D11 step 4 excised the Pipeline, Inbox review,
 * Conversations and Learnings facades and deleted their providers. These thin
 * gates keep the remaining direct domain tests and person-seeding helpers
 * runnable. Nothing here is registered over IPC.
 */
type DomainGate = Pick<FoundationRuntime, 'withDomain'>;
type Input<Method extends keyof FounderSalesDomain> =
  FounderSalesDomain[Method] extends (input: infer Request, ...rest: never[]) => unknown ? Request : never;

export function createTodayProvider(runtime: DomainGate) {
  return {
    get: () => runtime.withDomain((domain) => domain.getToday()),
    complete: (input: Input<'completePrimaryAction'>) => runtime.withDomain((domain) => domain.completePrimaryAction(input)),
    snooze: (input: Input<'snoozePrimaryAction'>) => runtime.withDomain((domain) => domain.snoozePrimaryAction(input)),
    logPastActivity: (input: Input<'logPastActivity'>) => runtime.withDomain((domain) => domain.logPastActivity(input)),
    addLeadNote: (input: Input<'addLeadNote'>) => runtime.withDomain((domain) => domain.addLeadNote(input)),
    logCallOutcome: (input: Input<'logCallOutcome'>) => runtime.withDomain((domain) => domain.logCallOutcome(input)),
    markActivityInError: (input: Input<'markActivityInError'>) => runtime.withDomain((domain) => domain.markActivityInError(input)),
  };
}
export type TodayProvider = ReturnType<typeof createTodayProvider>;

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
    findContactInfo: async (input: FindContactInfoRequest): Promise<FindContactInfoReceipt> => (
      enrichmentRequester === undefined
        ? { written: false, refusalReason: 'credentials_unavailable' }
        : enrichmentRequester.request(input)
    ),
  };
}
export type LegacyLeadDetailProvider = ReturnType<typeof createLegacyLeadDetailProvider>;
