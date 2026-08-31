import type { CallieApi } from '../preload/createCallieApi';
import type {
  AppleSpikeResultFor,
  AppleSpikeObservationEvidence,
  AppleSpikeStatus,
  ScanTestMessagesInput,
  SendTestMessageInput,
  StartCallObservationInput,
} from './appleSpikeContract';

export interface AppleSpikePreloadApi {
  getStatus(): Promise<AppleSpikeStatus>;
  probeCapabilities(): Promise<AppleSpikeResultFor<'probe_capabilities'>>;
  requestContacts(): Promise<AppleSpikeResultFor<'request_contacts'>>;
  promptAccessibility(): Promise<AppleSpikeResultFor<'prompt_accessibility'>>;
  scanRecentNotes(): Promise<AppleSpikeResultFor<'scan_recent_notes'>>;
  scanTestMessages(input: ScanTestMessagesInput): Promise<AppleSpikeResultFor<'scan_test_messages'>>;
  startCallObservation(input: StartCallObservationInput): Promise<AppleSpikeResultFor<'start_call_observation'>>;
  stopCallObservation(): Promise<AppleSpikeResultFor<'stop_call_observation'>>;
  sendTestMessage(input: SendTestMessageInput): Promise<AppleSpikeResultFor<'send_test_message'>>;
  subscribeObservationEvidence(
    listener: (evidence: AppleSpikeObservationEvidence) => void,
  ): Promise<() => void>;
}

/**
 * The complete window bridge: the strict workflow API composed by
 * `createCallieApi` plus the Apple feasibility spike surface.
 */
export type CalliePreloadApi = CallieApi & {
  appleSpike: AppleSpikePreloadApi;
};

declare global {
  interface Window {
    callie: CalliePreloadApi;
  }
}

export {};
