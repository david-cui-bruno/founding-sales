import { contextBridge, ipcRenderer } from 'electron';

import { appHealthSchema } from './shared/healthContract';
import {
  APPLE_SPIKE_IPC_CHANNELS,
  appleSpikeResultSchema,
  appleSpikeStatusSchema,
  scanTestMessagesInputSchema,
  sendTestMessageInputSchema,
  startCallObservationInputSchema,
  type AppleSpikeAction,
  type AppleSpikeResultFor,
} from './shared/appleSpikeContract';

const parseResult = <Action extends AppleSpikeAction['action']>(
  action: Action,
  value: unknown,
): AppleSpikeResultFor<Action> => {
  const result = appleSpikeResultSchema.parse(value);
  if (result.action !== action) {
    throw new Error('Apple feasibility result did not match the invoked action.');
  }
  return result as AppleSpikeResultFor<Action>;
};

contextBridge.exposeInMainWorld('callie', {
  health: {
    get: async () =>
      appHealthSchema.parse(await ipcRenderer.invoke('health:get')),
  },
  appleSpike: {
    getStatus: async () =>
      appleSpikeStatusSchema.parse(
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.status),
      ),
    probeCapabilities: async () =>
      parseResult(
        'probe_capabilities',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.probeCapabilities),
      ),
    requestContacts: async () =>
      parseResult(
        'request_contacts',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.requestContacts),
      ),
    promptAccessibility: async () =>
      parseResult(
        'prompt_accessibility',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.promptAccessibility),
      ),
    scanRecentNotes: async () =>
      parseResult(
        'scan_recent_notes',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.scanRecentNotes),
      ),
    scanTestMessages: async (input: unknown) => {
      const parsed = scanTestMessagesInputSchema.parse(input);
      return parseResult(
        'scan_test_messages',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.scanTestMessages, parsed),
      );
    },
    startCallObservation: async (input: unknown) => {
      const parsed = startCallObservationInputSchema.parse(input);
      return parseResult(
        'start_call_observation',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.startCallObservation, parsed),
      );
    },
    stopCallObservation: async () =>
      parseResult(
        'stop_call_observation',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.stopCallObservation),
      ),
    sendTestMessage: async (input: unknown) => {
      const parsed = sendTestMessageInputSchema.parse(input);
      return parseResult(
        'send_test_message',
        await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.sendTestMessage, parsed),
      );
    },
  },
});
