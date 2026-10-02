import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CALL_SUMMARIZE_JOB_MAX_ATTEMPTS, listOwedSummaries } from '@fss/domain/calls/summary.ts';
import { anthropicCallSummarizer } from '@fss/domain/calls/summaryAdapter.ts';
import { DEFAULT_CALL_SUMMARY_MODEL, isCallSummaryModel } from '@fss/domain/calls/summaryModel.ts';
import { callSummarizeJobHandler, type CallSummarizeOptions } from '@fss/domain/calls/summaryHandler.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import { routeOfTransport } from '@fss/domain/classification/routedTransport.ts';
import type { ClassifyWorkerOptions } from './classify.ts';

/**
 * The `call.summarize` composition and its due-work source (slice C3b).
 *
 * The summary uses the **same** Anthropic transport as the classifier and research — one
 * key read once per process, `maxRetries: 0` (`loadAnthropicTransport`) — so a worker with
 * no key registers no summary handler, and its source materializes nothing: a job no
 * handler here could claim would sit in the queue.
 *
 * The model is the deployment's (`FSS_CALL_SUMMARY_MODEL`): Haiku 4.5 by default, Sonnet
 * 5.5 if set. Any other value is refused by name, never guessed at.
 */

export const CALL_SUMMARY_MODEL_ENVIRONMENT_VARIABLE = 'FSS_CALL_SUMMARY_MODEL';

export function readCallSummaryComposition(
  classifier: ClassifyWorkerOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  log?: CallSummarizeOptions['log'],
): { readonly options: CallSummarizeOptions | null; readonly problem: string | null } {
  if (classifier === undefined) return { options: null, problem: 'anthropic:absent' };
  const chosen = (environment[CALL_SUMMARY_MODEL_ENVIRONMENT_VARIABLE] ?? '').trim();
  const model = chosen === '' ? DEFAULT_CALL_SUMMARY_MODEL : chosen;
  if (!isCallSummaryModel(model)) return { options: null, problem: 'call_summary:model_unknown' };
  return {
    options: {
      summarizer: anthropicCallSummarizer({ transport: classifier.transport }),
      model,
      // Slice BR1: the reservation's provider key, price and funding follow the model's route.
      route: routeOfTransport(classifier.transport),
      ...(log === undefined ? {} : { log }),
    },
    problem: null,
  };
}

export function callSummarizeHandlers(options: CallSummarizeOptions | undefined): readonly JobHandler[] {
  return options === undefined ? [] : [callSummarizeJobHandler(options)];
}

/**
 * One `call.summarize` per transcribed call owed a summary (`listOwedSummaries`), under a
 * revision key once the call already has jobs: the first summary, or one the switch held.
 */
export function callSummarySource(options: { readonly enabled: boolean }): DueWorkSource {
  return {
    name: 'call-summarize',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      if (!options.enabled) return [];
      return (await listOwedSummaries(session)).map(owed => ({
        workspaceId: owed.workspaceId,
        kind: 'call.summarize' as const,
        idempotencyKey: jobIdempotencyKey.callSummarize(owed.sessionId, owed.revision),
        payload: { callSessionId: owed.sessionId },
        maxAttempts: CALL_SUMMARIZE_JOB_MAX_ATTEMPTS,
      }));
    },
  };
}
