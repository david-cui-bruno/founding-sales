import { repositoryContext } from '../db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '../jobs/handlerRegistry.ts';
import type { ProviderErrorDetail } from '../classification/providerError.ts';
import {
  CALL_ANALYZE_JOB_MAX_ATTEMPTS,
  beginCallAnalysis,
  ensureCallAnalysisCalling,
  estimateAbandonedAnalysis,
  finishCallAnalysis,
  releaseUnsentAnalysis,
  type CallAnalysisDeps,
  type CallAnalysisPlan,
} from './analysisPaid.ts';

/**
 * The `call.analyze` job (slice 3a): one transcribed call's analysis version, chunked where
 * the money is, exactly the summary's shape (`summaryHandler.ts`), with the body in
 * `analysisPaid.ts`. Chunk 3 ends in `completeCallAnalysis`; there is no second completion
 * path.
 *
 * The log line is counts and words: never a transcript line, a quote or a proposal.
 */

export const CALL_ANALYZE_LEASE_SECONDS = 120;

function providerFields(provider: ProviderErrorDetail | undefined): Readonly<Record<string, string | number | null>> {
  if (provider === undefined) return {};
  return { provider_status: provider.status, provider_error_type: provider.type, provider_parameter: provider.parameter };
}

type Step = 'reserved' | 'calling' | 'retry';

interface AnalysisProgress {
  readonly analysisId: string;
  readonly attempt: number;
  readonly step: Step;
  readonly fencing: string;
}

export function parseAnalysisProgress(progress: unknown): AnalysisProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const { analysisId, attempt, step, fencing } = progress as Record<string, unknown>;
  if (typeof analysisId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(analysisId)) return null;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return null;
  if (step !== 'reserved' && step !== 'calling' && step !== 'retry') return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { analysisId, attempt, step, fencing };
}

/** Requests chunk 2 built, for chunk 3 of the same claim. Process memory only. */
const PLANS = new Map<string, CallAnalysisPlan>();
const planKey = (jobId: string, fencing: string, attempt: number): string => `${jobId}:${fencing}:${String(attempt)}`;

export interface CallAnalyzeOptions extends CallAnalysisDeps {
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  readonly leaseSeconds?: number | undefined;
}

export function callAnalyzeJobHandler(options: CallAnalyzeOptions): JobHandler {
  return {
    kind: 'call.analyze',
    protection: 'business_uniqueness',
    maxAttempts: CALL_ANALYZE_JOB_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? CALL_ANALYZE_LEASE_SECONDS,
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const sessionId = input.job.payload['callSessionId'];
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(sessionId)) {
        throw new Error('a call.analyze payload names a call session');
      }
      const requested = input.job.payload['reason'];
      const reason = requested === 'retry' || requested === 'reanalysis' ? requested : 'transcript';
      const context = repositoryContext(input.scope, input.session);
      const fencing = input.job.fencingToken;
      const log = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void => {
        options.log?.(event, { workspace_id: input.scope.workspaceId, call_session_id: sessionId, ...fields });
      };
      const carried = parseAnalysisProgress(input.job.payload['progress']);

      if (carried === null || carried.step === 'retry') {
        const begun = await beginCallAnalysis(context, options, { sessionId, reason });
        if (begun.kind === 'done') {
          log('call_analysis_skipped', { reason: begun.reason });
          return;
        }
        return { progress: { analysisId: begun.analysisId, attempt: begun.attempt, step: 'reserved', fencing }, done: false };
      }

      if (carried.step === 'reserved') {
        const calling = await ensureCallAnalysisCalling(context, { analysisId: carried.analysisId, attempt: carried.attempt }, options);
        if (calling.kind === 'done') {
          log('call_analysis_skipped', { reason: calling.reason });
          return { progress: { ...carried }, done: true };
        }
        if (calling.kind === 'retry') return { progress: { ...carried, step: 'retry', fencing }, done: false };
        PLANS.set(planKey(input.job.id, fencing, calling.attempt), calling.plan);
        return { progress: { ...carried, attempt: calling.attempt, step: 'calling', fencing }, done: false };
      }

      if (carried.fencing !== fencing) {
        await estimateAbandonedAnalysis(context, { analysisId: carried.analysisId, attempt: carried.attempt });
        return { progress: { ...carried, step: 'retry', fencing }, done: false };
      }

      const key = planKey(input.job.id, fencing, carried.attempt);
      const plan = PLANS.get(key);
      PLANS.delete(key);
      if (plan === undefined) {
        await releaseUnsentAnalysis(context, { analysisId: carried.analysisId, attempt: carried.attempt });
        return { progress: { ...carried, step: 'retry', fencing }, done: false };
      }
      const finished = await finishCallAnalysis(context, options, { analysisId: carried.analysisId, attempt: carried.attempt, plan });
      if (finished.kind === 'retry') {
        log('call_analysis_retry', { attempt: carried.attempt, outcome: finished.outcome, ...providerFields(finished.provider) });
        return { progress: { ...carried, step: 'retry', fencing }, done: false };
      }
      if (finished.kind === 'completed') {
        log('call_analysis', {
          attempt: carried.attempt,
          version: finished.version,
          model: plan.model,
          settled_cents: finished.settledCents,
          proposals: finished.proposals,
          dropped: finished.dropped,
        });
      } else {
        log('call_analysis_skipped', { reason: finished.outcome, failure: finished.failure ?? null, ...providerFields(finished.provider) });
      }
      return { progress: { ...carried }, done: true };
    },
  };
}
