import { repositoryContext } from '../db/workspaceScope.ts';
import type { JobHandler } from '../jobs/handlerRegistry.ts';
import type { JobChunk } from '../jobs/handlerRegistry.ts';
import {
  beginClassification,
  ensureClassificationCalling,
  estimateAbandonedAttempt,
  finishClassification,
  releaseUnsentAttempt,
  type ClassifierRequestPlan,
  type ClassifyReplyDeps,
} from './classify.ts';

/**
 * The `classify.reply` handler (Appendix C's table, extended; 12.4).
 *
 * | Work | Idempotency key | Effect protection |
 * |---|---|---|
 * | Reply classification | `classify-reply:{message}` | `mail_message_classifications_one_per_layer` |
 *
 * Appendix C does not name this job, because revision 3 describes the classification
 * and not the queue it runs on. Appendix A does say where it belongs — the "Record
 * uncertain or ambiguous reply" row's after-commit column is "LLM classification may
 * be queued" — so the row above is this lane's addition to the table, with the same
 * three columns and the same discipline. `docs/decisions/g7b-classify-is-a-job-kind.md`
 * says why it is a job at all rather than a step of `mail.sync`.
 *
 * `business_uniqueness` is honest: running twice writes one model row, because
 * `mail_message_classifications_one_per_layer` refuses the second, and chunk 1 checks
 * for the row before it spends money.
 *
 * ## Chunked, because the middle spends money (slice P1, fix round 2)
 *
 * The paid-call pattern, as research and transcription apply it (`classify.ts`):
 *
 *   * chunk 1 — `beginClassification`: the switch, the bounds, the month, and the
 *     attempt's reservation, committed. Nothing is sent;
 *   * chunk 2 — `ensureClassificationCalling`: the request built, the final pause read,
 *     and the attempt marked `calling`, committed. The request is kept in this process
 *     for chunk 3, so nothing that can block comes between that commit and the send;
 *   * chunk 3 — `finishClassification`: the request, then the record and the settlement
 *     by id. An ambiguous answer is estimated and, while the reply has fewer than two paid
 *     attempts, the cursor goes back to chunk 1 (`step: 'retry'`) for the bounded retry.
 *
 * A provider error no longer throws: its estimate commits with the chunk, so the money is
 * recorded whatever the handler's lease does next. A rollback of chunk 3 leaves the row
 * `calling` (committed by chunk 2); the next claim of this job estimates it, and so does the
 * sweep for a job that never comes back. `maxAttempts` is about a poison payload or a lost
 * lease, never about the provider.
 */
export const CLASSIFY_LEASE_SECONDS = 120;

export interface ClassifyHandlerOptions {
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}

type Step = 'reserved' | 'calling' | 'retry';

interface ClassifyProgress {
  readonly attempt: number;
  readonly step: Step;
  readonly fencing: string;
}

function parseProgress(progress: unknown): ClassifyProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const row = progress as Record<string, unknown>;
  const { attempt, step, fencing } = row;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return null;
  if (step !== 'reserved' && step !== 'calling' && step !== 'retry') return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { attempt, step, fencing };
}

/**
 * The requests chunk 2 built, for chunk 3 of the same claim, keyed by job, fencing token
 * and attempt. Process memory on purpose: the message's words never go into the job row.
 * A claim's chunks run in one process, so chunk 3 finds its request here; a later claim
 * of the job never does, and goes the estimate-and-retry way instead.
 */
const PLANS = new Map<string, ClassifierRequestPlan>();
const planKey = (jobId: string, fencing: string, attempt: number): string => `${jobId}:${fencing}:${String(attempt)}`;

export function classifyReplyHandler(deps: ClassifyReplyDeps, options: ClassifyHandlerOptions = {}): JobHandler {
  return {
    kind: 'classify.reply',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 2,
    leaseSeconds: options.leaseSeconds ?? CLASSIFY_LEASE_SECONDS,
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const messageId = input.job.payload['messageId'];
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new Error('a classify.reply payload names the message it is classifying');
      }
      const context = repositoryContext(input.scope, input.session);
      const fencing = input.job.fencingToken;
      const carried = parseProgress(input.job.payload['progress']);

      if (carried === null || carried.step === 'retry') {
        // Chunk 1.
        const begun = await beginClassification(context, deps, { messageId, retry: carried !== null });
        if (begun.kind === 'done') return;
        return { progress: { attempt: begun.attempt, step: 'reserved', fencing }, done: false };
      }

      if (carried.step === 'reserved') {
        // Chunk 2.
        const calling = await ensureClassificationCalling(context, deps, { messageId, attempt: carried.attempt });
        if (calling.kind === 'done') return { progress: { ...carried }, done: true };
        PLANS.set(planKey(input.job.id, fencing, calling.attempt), calling.plan);
        return { progress: { attempt: calling.attempt, step: 'calling', fencing }, done: false };
      }

      if (carried.fencing !== fencing) {
        // Marked `calling` under an earlier claim of this job: the request may have gone.
        await estimateAbandonedAttempt(context, { messageId, attempt: carried.attempt });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }

      // Chunk 3, from this claim's own cursor.
      const key = planKey(input.job.id, fencing, carried.attempt);
      const plan = PLANS.get(key);
      PLANS.delete(key);
      if (plan === undefined) {
        // This claim marked the attempt and does not hold its request, so it has not sent it.
        await releaseUnsentAttempt(context, { messageId, attempt: carried.attempt });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }
      const finished = await finishClassification(context, deps, { messageId, attempt: carried.attempt, plan });
      if (finished.kind === 'retry') return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      return { progress: { ...carried }, done: true };
    },
  };
}
