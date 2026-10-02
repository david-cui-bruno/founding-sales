import { repositoryContext } from '../db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '../jobs/handlerRegistry.ts';
import {
  CALL_SUMMARIZE_JOB_MAX_ATTEMPTS,
  beginCallSummary,
  ensureCallSummaryCalling,
  estimateAbandonedSummary,
  finishCallSummary,
  releaseUnsentSummary,
  type CallSummaryDeps,
  type CallSummaryPlan,
} from './summary.ts';
import type { ProviderErrorDetail } from './summaryAdapter.ts';

/**
 * The `call.summarize` job (slice C3b): one transcribed call's summary and suggested next
 * steps, chunked where the money is — exactly the classifier's shape (`classification/
 * handler.ts`), with the body in `summary.ts`:
 *
 *   * chunk 1 — `beginCallSummary`: the switch, the caps, the month, the reservation;
 *   * chunk 2 — `ensureCallSummaryCalling`: the final switch read and `calling`, committed.
 *     The request it built stays in this process for chunk 3, so nothing that can block
 *     comes between that commit and the send;
 *   * chunk 3 — `finishCallSummary`: the request, the settlement by id, the summary. An
 *     unusable or ambiguous answer sends the cursor back to chunk 1 (`step: 'retry'`) for
 *     the one more paid attempt the lifetime cap allows.
 *
 * A claim that finds its cursor at `calling` under another claim's fencing token estimates
 * that attempt (the request may have gone) and retries through chunk 1; a claim that marked
 * the attempt but no longer holds its request releases it as not sent.
 *
 * The log line is counts and words: never a transcript line, a summary or a quote.
 */

export const CALL_SUMMARIZE_LEASE_SECONDS = 120;

/** The API's own words about a request it refused or failed: status, type, message. Never transcript text. */
function providerFields(provider: ProviderErrorDetail | undefined): Readonly<Record<string, string | number | null>> {
  if (provider === undefined) return {};
  return { provider_status: provider.status, provider_error_type: provider.type, provider_parameter: provider.parameter };
}

type Step = 'reserved' | 'calling' | 'retry';

interface SummaryProgress {
  readonly attempt: number;
  readonly step: Step;
  readonly fencing: string;
}

export function parseSummaryProgress(progress: unknown): SummaryProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const { attempt, step, fencing } = progress as Record<string, unknown>;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return null;
  if (step !== 'reserved' && step !== 'calling' && step !== 'retry') return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { attempt, step, fencing };
}

/** Requests chunk 2 built, for chunk 3 of the same claim. Process memory: the words never go into the job row. */
const PLANS = new Map<string, CallSummaryPlan>();
const planKey = (jobId: string, fencing: string, attempt: number): string => `${jobId}:${fencing}:${String(attempt)}`;

export interface CallSummarizeOptions extends CallSummaryDeps {
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  readonly leaseSeconds?: number | undefined;
}

export function callSummarizeJobHandler(options: CallSummarizeOptions): JobHandler {
  return {
    kind: 'call.summarize',
    protection: 'business_uniqueness',
    maxAttempts: CALL_SUMMARIZE_JOB_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? CALL_SUMMARIZE_LEASE_SECONDS,
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const sessionId = input.job.payload['callSessionId'];
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(sessionId)) {
        throw new Error('a call.summarize payload names a call session');
      }
      const context = repositoryContext(input.scope, input.session);
      const fencing = input.job.fencingToken;
      const log = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void => {
        options.log?.(event, { workspace_id: input.scope.workspaceId, call_session_id: sessionId, ...fields });
      };
      const carried = parseSummaryProgress(input.job.payload['progress']);

      if (carried === null || carried.step === 'retry') {
        const begun = await beginCallSummary(context, options, { sessionId, retry: carried !== null });
        if (begun.kind === 'done') {
          log('call_summary_skipped', { reason: begun.reason });
          return;
        }
        return { progress: { attempt: begun.attempt, step: 'reserved', fencing }, done: false };
      }

      if (carried.step === 'reserved') {
        const calling = await ensureCallSummaryCalling(context, { sessionId, attempt: carried.attempt }, options);
        if (calling.kind === 'done') {
          log('call_summary_skipped', { reason: calling.reason });
          return { progress: { ...carried }, done: true };
        }
        // Reserved for the other transport and released: back to chunk 1 (slice BR1).
        if (calling.kind === 'retry') return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
        PLANS.set(planKey(input.job.id, fencing, calling.attempt), calling.plan);
        return { progress: { attempt: calling.attempt, step: 'calling', fencing }, done: false };
      }

      if (carried.fencing !== fencing) {
        await estimateAbandonedSummary(context, { sessionId, attempt: carried.attempt });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }

      const key = planKey(input.job.id, fencing, carried.attempt);
      const plan = PLANS.get(key);
      PLANS.delete(key);
      if (plan === undefined) {
        await releaseUnsentSummary(context, { sessionId, attempt: carried.attempt });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }
      const finished = await finishCallSummary(context, options, { sessionId, attempt: carried.attempt, plan });
      if (finished.kind === 'retry') {
        log('call_summary_retry', { attempt: carried.attempt, outcome: finished.outcome, ...providerFields(finished.provider) });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }
      if (finished.kind === 'summarized') {
        log('call_summary', {
          attempt: carried.attempt,
          model: plan.model,
          settled_cents: finished.settledCents,
          next_steps: finished.nextSteps,
          commitments: finished.commitments,
          dropped_commitments: finished.droppedCommitments,
        });
      } else {
        log('call_summary_skipped', { reason: finished.outcome, ...providerFields(finished.provider) });
      }
      return { progress: { ...carried }, done: true };
    },
  };
}
