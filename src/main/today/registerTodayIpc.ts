import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  completeActionRequestSchema,
  logPastActivityRequestSchema,
  pinActionRequestSchema,
  snoozeActionRequestSchema,
  todaySnapshotSchema,
  type TodaySnapshot,
} from '../../shared/contracts/todayContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { TodayProvider } from './todayService';

/**
 * Registers exactly the five strict Today channels and returns one
 * idempotent unregister function that removes all of them.
 */
export function registerTodayIpc(
  provider: TodayProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<undefined, TodaySnapshot>({
      channel: 'today:get',
      requestSchema: null,
      responseSchema: todaySnapshotSchema,
      handler: () => provider.get(),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:complete',
      requestSchema: completeActionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.complete(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:snooze',
      requestSchema: snoozeActionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.snooze(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:pin',
      requestSchema: pinActionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.pin(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:log-activity',
      requestSchema: logPastActivityRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.logPastActivity(request),
      isTrustedRendererUrl,
    }),
  ];

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
