import type { AppHealth } from './healthContract';
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

export interface CalliePreloadApi {
  health: {
    get(): Promise<AppHealth>;
  };
  appleSpike: AppleSpikePreloadApi;
}

declare global {
  interface Window {
    callie: CalliePreloadApi;
  }
}

export {};
