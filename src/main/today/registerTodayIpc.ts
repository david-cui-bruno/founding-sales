import { leadTriageSnapshotRequestSchema, leadTriageSnapshotSchema, parseLeadTriageSnapshotResponse } from '../../shared/contracts/leadTriageReportContract';
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
  type TodaySnapshot,
  type TriageQueue,
} from '../../shared/contracts/todayContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { TodayProvider } from './todayService';

/**
 * Registers exactly the eleven strict Today channels and returns one
 * idempotent unregister function that removes all of them.
 */
export function registerTodayIpc(
  provider: TodayProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc({
      channel: 'today:get-lead-triage-snapshot',
      requestSchema: leadTriageSnapshotRequestSchema,
      responseSchema: leadTriageSnapshotSchema,
      handler: async (request) => parseLeadTriageSnapshotResponse(request, await provider.getLeadTriageSnapshot(request)),
      isTrustedRendererUrl,
    }),
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
    registerValidatedIpc({
      channel: 'today:add-note',
      requestSchema: addLeadNoteRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.addLeadNote(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:log-call-outcome',
      requestSchema: logCallOutcomeRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.logCallOutcome(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:mark-activity-in-error',
      requestSchema: markActivityInErrorRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.markActivityInError(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<undefined, TriageQueue>({
      channel: 'today:get-triage-queue',
      requestSchema: null,
      responseSchema: triageQueueSchema,
      handler: () => provider.getTriageQueue(),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc({
      channel: 'today:set-review-position',
      requestSchema: setReviewPositionRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.setReviewPosition(request),
      isTrustedRendererUrl,
    }),
  ];

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
