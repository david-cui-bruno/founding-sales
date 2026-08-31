import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  completeActionRequestSchema,
  logPastActivityRequestSchema,
  pinActionRequestSchema,
  snoozeActionRequestSchema,
  todaySnapshotSchema,
  type CompleteActionRequest,
  type LogPastActivityRequest,
  type PinActionRequest,
  type SnoozeActionRequest,
} from '../../shared/contracts/todayContract';
import type { IpcClient } from '../ipcClient';

/** Preload-side Today API: every request and response is schema-validated. */
export const createTodayApi = (client: IpcClient) => ({
  get: () => client.requestNoInput('today:get', todaySnapshotSchema),
  complete: (input: CompleteActionRequest) =>
    client.request(
      'today:complete',
      completeActionRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  snooze: (input: SnoozeActionRequest) =>
    client.request(
      'today:snooze',
      snoozeActionRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  pin: (input: PinActionRequest) =>
    client.request(
      'today:pin',
      pinActionRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  logPastActivity: (input: LogPastActivityRequest) =>
    client.request(
      'today:log-activity',
      logPastActivityRequestSchema,
      mutationReceiptSchema,
      input,
    ),
});

export type TodayApi = ReturnType<typeof createTodayApi>;
