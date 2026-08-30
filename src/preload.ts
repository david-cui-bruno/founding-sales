import { contextBridge, ipcRenderer } from 'electron';

import { appHealthSchema } from './shared/healthContract';
import {
  APPLE_SPIKE_IPC_CHANNELS,
  appleSpikeObservationEvidenceSchema,
  appleSpikeObservationSubscriptionAckSchema,
  appleSpikeResultSchema,
  appleSpikeStatusSchema,
  scanTestMessagesInputSchema,
  sendTestMessageInputSchema,
  startCallObservationInputSchema,
  type AppleSpikeAction,
  type AppleSpikeObservationEvidence,
  type AppleSpikeResultFor,
} from './shared/appleSpikeContract';

type ObservationRegistration = {
  active: boolean;
  wrapped(event: unknown, payload: unknown): void;
};

const observationRegistrations = new Set<ObservationRegistration>();
let observationSubscriptionAcknowledged = false;
let observationSubscriptionPromise: Promise<void> | undefined;
let observationUnsubscribePromise: Promise<void> | undefined;

const invokeObservationUnsubscribe = (force = false): Promise<void> => {
  if (!force && !observationSubscriptionAcknowledged) {
    return observationUnsubscribePromise ?? Promise.resolve();
  }
  if (observationUnsubscribePromise !== undefined) {
    return observationUnsubscribePromise;
  }
  observationSubscriptionAcknowledged = false;
  const pending = ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe)
    .then((): undefined => undefined)
    .catch((): undefined => undefined)
    .finally(() => {
      if (observationUnsubscribePromise === pending) {
        observationUnsubscribePromise = undefined;
      }
    });
  observationUnsubscribePromise = pending;
  return pending;
};

const removeObservationRegistration = (registration: ObservationRegistration): void => {
  if (!registration.active) return;
  registration.active = false;
  observationRegistrations.delete(registration);
  ipcRenderer.removeListener(
    APPLE_SPIKE_IPC_CHANNELS.observationEvidence,
    registration.wrapped,
  );
  if (observationRegistrations.size !== 0) return;
  void invokeObservationUnsubscribe();
};

const ensureObservationSubscription = (): Promise<void> => {
  if (observationSubscriptionAcknowledged) return Promise.resolve();
  if (observationSubscriptionPromise !== undefined) {
    return observationSubscriptionPromise;
  }

  const pending = (async () => {
    if (observationUnsubscribePromise !== undefined) {
      await observationUnsubscribePromise;
    }
    let rawAck: unknown;
    try {
      rawAck = await ipcRenderer.invoke(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe);
    } catch {
      throw new Error('Apple observation subscription is unavailable.');
    }
    const ack = appleSpikeObservationSubscriptionAckSchema.safeParse(rawAck);
    if (!ack.success) {
      await invokeObservationUnsubscribe(true);
      throw new Error('Apple observation subscription is unavailable.');
    }
    observationSubscriptionAcknowledged = true;
  })().finally(() => {
    if (observationSubscriptionPromise === pending) {
      observationSubscriptionPromise = undefined;
    }
  });
  observationSubscriptionPromise = pending;
  return pending;
};

const subscribeObservationEvidence = async (
  listener: (evidence: AppleSpikeObservationEvidence) => void,
): Promise<() => void> => {
  if (typeof listener !== 'function') {
    throw new Error('Apple observation listener must be a function.');
  }
  const registration: ObservationRegistration = {
    active: true,
    wrapped: (_event, payload) => {
      if (!registration.active) return;
      const parsed = appleSpikeObservationEvidenceSchema.safeParse(payload);
      if (!parsed.success) return;
      try {
        listener(parsed.data);
      } catch {
        // Renderer listeners cannot escape the narrow preload boundary.
      }
    },
  };
  observationRegistrations.add(registration);
  ipcRenderer.on(
    APPLE_SPIKE_IPC_CHANNELS.observationEvidence,
    registration.wrapped,
  );
  try {
    await ensureObservationSubscription();
  } catch {
    removeObservationRegistration(registration);
    throw new Error('Apple observation subscription is unavailable.');
  }
  return () => removeObservationRegistration(registration);
};

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
    subscribeObservationEvidence,
  },
});
