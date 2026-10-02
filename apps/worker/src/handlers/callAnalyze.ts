import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CALL_ANALYZE_JOB_MAX_ATTEMPTS, listOwedAnalyses } from '@fss/domain/calls/analysisPaid.ts';
import { messagesCallAnalyzer } from '@fss/domain/calls/analysisAdapter.ts';
import { DEFAULT_CALL_ANALYSIS_MODEL, isCallAnalysisModel } from '@fss/domain/calls/analysisModel.ts';
import { callAnalyzeJobHandler, type CallAnalyzeOptions } from '@fss/domain/calls/analysisHandler.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import { routeOfTransport } from '@fss/domain/classification/routedTransport.ts';
import type { ClassifyWorkerOptions } from './classify.ts';

/**
 * The `call.analyze` composition and its due-work source (slice 3a), the summary's shape
 * (`callSummarize.ts`): the classifier's Anthropic transport, so a worker with no key
 * registers no analysis handler and its source materializes nothing.
 *
 * The model is the deployment's (`FSS_CALL_ANALYSIS_MODEL`): Haiku 4.5 by default, Sonnet
 * 5.5 if set. Any other value is refused by name, never guessed at.
 */

export const CALL_ANALYSIS_MODEL_ENVIRONMENT_VARIABLE = 'FSS_CALL_ANALYSIS_MODEL';

export function readCallAnalysisComposition(
  classifier: ClassifyWorkerOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  log?: CallAnalyzeOptions['log'],
): { readonly options: CallAnalyzeOptions | null; readonly problem: string | null } {
  if (classifier === undefined) return { options: null, problem: 'anthropic:absent' };
  const chosen = (environment[CALL_ANALYSIS_MODEL_ENVIRONMENT_VARIABLE] ?? '').trim();
  const model = chosen === '' ? DEFAULT_CALL_ANALYSIS_MODEL : chosen;
  if (!isCallAnalysisModel(model)) return { options: null, problem: 'call_analysis:model_unknown' };
  return {
    options: {
      analyzer: messagesCallAnalyzer({ transport: classifier.transport }),
      model,
      // Slice BR1: the reservation's provider key, price and funding follow the model's route.
      route: routeOfTransport(classifier.transport),
      ...(log === undefined ? {} : { log }),
    },
    problem: null,
  };
}

export function callAnalyzeHandlers(options: CallAnalyzeOptions | undefined): readonly JobHandler[] {
  return options === undefined ? [] : [callAnalyzeJobHandler(options)];
}

/**
 * One `call.analyze` per transcribed call owed an analysis (`listOwedAnalyses`), under a
 * revision key once the call already has jobs: the first analysis of an `analysis`-path
 * call, or a version the switch held, once per change of the setting.
 */
export function callAnalysisSource(options: { readonly enabled: boolean }): DueWorkSource {
  return {
    name: 'call-analyze',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      if (!options.enabled) return [];
      return (await listOwedAnalyses(session)).map(owed => ({
        workspaceId: owed.workspaceId,
        kind: 'call.analyze' as const,
        idempotencyKey: jobIdempotencyKey.callAnalyze(owed.sessionId, owed.revision),
        payload: { callSessionId: owed.sessionId },
        maxAttempts: CALL_ANALYZE_JOB_MAX_ATTEMPTS,
      }));
    },
  };
}
