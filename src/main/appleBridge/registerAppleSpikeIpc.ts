import { ipcMain, type WebContents } from 'electron';

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
  type AppleSpikeResult,
} from '../../shared/appleSpikeContract';
import { validateSender } from '../ipc/validateSender';
import { isTrustedRendererUrl as defaultIsTrustedRendererUrl } from '../navigationPolicy';
import type { AppleSpikeServiceApi } from './appleSpikeService';

export { APPLE_SPIKE_IPC_CHANNELS } from '../../shared/appleSpikeContract';

type InvokeEvent = Parameters<typeof validateSender>[0];

const parseResult = (
  expectedAction: AppleSpikeAction['action'],
  result: unknown,
): AppleSpikeResult => {
  const parsed = appleSpikeResultSchema.parse(result);
  if (parsed.action !== expectedAction) {
    throw new Error('Apple feasibility result did not match the requested action.');
  }
  return parsed;
};

export function registerAppleSpikeIpc(
  service: AppleSpikeServiceApi,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const isTrustedUrl = isTrustedRendererUrl ?? defaultIsTrustedRendererUrl;
  const validate = (event: InvokeEvent, args: unknown[], expectedCount: number): void => {
    validateSender(event, isTrustedUrl);
    if (args.length !== expectedCount) {
      throw new Error('Apple feasibility IPC received an invalid number of arguments.');
    }
  };

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.status, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return appleSpikeStatusSchema.parse(service.getStatus());
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.probeCapabilities, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return parseResult(
      'probe_capabilities',
      await service.runReadOnlyCheck({ action: 'probe_capabilities' }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.requestContacts, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return parseResult(
      'request_contacts',
      await service.requestPermission({ action: 'request_contacts' }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.promptAccessibility, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return parseResult(
      'prompt_accessibility',
      await service.requestPermission({ action: 'prompt_accessibility' }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.scanRecentNotes, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return parseResult(
      'scan_recent_notes',
      await service.runReadOnlyCheck({ action: 'scan_recent_notes' }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.scanTestMessages, async (event, ...args: unknown[]) => {
    validate(event, args, 1);
    const input = scanTestMessagesInputSchema.parse(args[0]);
    return parseResult(
      'scan_test_messages',
      await service.runReadOnlyCheck({ action: 'scan_test_messages', ...input }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.startCallObservation, async (event, ...args: unknown[]) => {
    validate(event, args, 1);
    const input = startCallObservationInputSchema.parse(args[0]);
    return parseResult(
      'start_call_observation',
      await service.authorizeManualAction({ action: 'start_call_observation', ...input }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.stopCallObservation, async (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return parseResult(
      'stop_call_observation',
      await service.authorizeManualAction({ action: 'stop_call_observation' }),
    );
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.sendTestMessage, async (event, ...args: unknown[]) => {
    validate(event, args, 1);
    const input = sendTestMessageInputSchema.parse(args[0]);
    return parseResult(
      'send_test_message',
      await service.authorizeManualAction({ action: 'send_test_message', ...input }),
    );
  });

  type RendererObservationSubscription = {
    unsubscribeObservation(): void;
    onDestroyed(): void;
    onNavigation(): void;
  };
  const observationSubscriptions = new Map<WebContents, RendererObservationSubscription>();

  const removeObservationSubscription = (sender: WebContents): void => {
    const subscription = observationSubscriptions.get(sender);
    if (subscription === undefined) return;
    observationSubscriptions.delete(sender);
    sender.removeListener('destroyed', subscription.onDestroyed);
    sender.removeListener('did-start-navigation', subscription.onNavigation);
    subscription.unsubscribeObservation();
  };

  const registerObservationSubscription = (sender: WebContents): void => {
    if (observationSubscriptions.has(sender)) return;
    if (sender.isDestroyed()) {
      throw new Error('Apple observation subscription is unavailable.');
    }
    const onDestroyed = (): void => removeObservationSubscription(sender);
    const onNavigation = (): void => removeObservationSubscription(sender);
    const subscription: RendererObservationSubscription = {
      unsubscribeObservation: () => undefined,
      onDestroyed,
      onNavigation,
    };
    observationSubscriptions.set(sender, subscription);
    sender.once('destroyed', onDestroyed);
    sender.once('did-start-navigation', onNavigation);
    try {
      subscription.unsubscribeObservation = service.subscribeObservation((evidence) => {
        const parsed = appleSpikeObservationEvidenceSchema.safeParse(evidence);
        if (!parsed.success) return;
        let deliveryTrusted = false;
        try {
          deliveryTrusted = !sender.isDestroyed() && isTrustedUrl(sender.getURL());
        } catch {
          deliveryTrusted = false;
        }
        if (!deliveryTrusted) {
          removeObservationSubscription(sender);
          return;
        }
        try {
          sender.send(APPLE_SPIKE_IPC_CHANNELS.observationEvidence, parsed.data);
        } catch {
          removeObservationSubscription(sender);
        }
      });
    } catch {
      removeObservationSubscription(sender);
      throw new Error('Apple observation subscription is unavailable.');
    }
  };

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.observationSubscribe, async (
    event,
    ...args: unknown[]
  ) => {
    validate(event, args, 0);
    try {
      const status = appleSpikeStatusSchema.parse(service.getStatus());
      if (!status.enabled || status.bridge.state !== 'ready') {
        throw new Error('not ready');
      }
      registerObservationSubscription(event.sender);
      return appleSpikeObservationSubscriptionAckSchema.parse({ subscribed: true });
    } catch {
      throw new Error('Apple observation subscription is unavailable.');
    }
  });

  ipcMain.handle(APPLE_SPIKE_IPC_CHANNELS.observationUnsubscribe, async (
    event,
    ...args: unknown[]
  ) => {
    validate(event, args, 0);
    removeObservationSubscription(event.sender);
  });

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    for (const channel of Object.values(APPLE_SPIKE_IPC_CHANNELS)) {
      if (channel === APPLE_SPIKE_IPC_CHANNELS.observationEvidence) continue;
      ipcMain.removeHandler(channel);
    }
    for (const sender of [...observationSubscriptions.keys()]) {
      removeObservationSubscription(sender);
    }
    service.dispose();
  };
}
