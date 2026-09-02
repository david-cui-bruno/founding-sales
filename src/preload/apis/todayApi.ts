import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  addLeadNoteRequestSchema,
  completeActionRequestSchema,
  logCallOutcomeRequestSchema,
  logPastActivityRequestSchema,
  markActivityInErrorRequestSchema,
  pinActionRequestSchema,
  setReviewPositionRequestSchema,
  snoozeActionRequestSchema,
  todaySnapshotSchema,
  triageQueueSchema,
  type AddLeadNoteRequest,
  type CompleteActionRequest,
  type LogCallOutcomeRequest,
  type LogPastActivityRequest,
  type MarkActivityInErrorRequest,
  type PinActionRequest,
  type SetReviewPositionRequest,
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
  addLeadNote: (input: AddLeadNoteRequest) =>
    client.request(
      'today:add-note',
      addLeadNoteRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  logCallOutcome: (input: LogCallOutcomeRequest) =>
    client.request(
      'today:log-call-outcome',
      logCallOutcomeRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  markActivityInError: (input: MarkActivityInErrorRequest) =>
    client.request(
      'today:mark-activity-in-error',
      markActivityInErrorRequestSchema,
      mutationReceiptSchema,
      input,
    ),
  getTriageQueue: () =>
    client.requestNoInput('today:get-triage-queue', triageQueueSchema),
  setReviewPosition: (input: SetReviewPositionRequest) =>
    client.request(
      'today:set-review-position',
      setReviewPositionRequestSchema,
      mutationReceiptSchema,
      input,
    ),
});

export type TodayApi = ReturnType<typeof createTodayApi>;
