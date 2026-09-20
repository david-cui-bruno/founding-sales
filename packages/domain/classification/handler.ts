import { repositoryContext } from '../db/workspaceScope.ts';
import type { JobHandler } from '../jobs/handlerRegistry.ts';
import { classifyReplyWithModel, type ClassifyReplyDeps } from './classify.ts';

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
 * `mail_message_classifications_one_per_layer` refuses the second, and
 * `classifyReplyWithModel` checks for the row before it spends money. A worker whose
 * lease was stolen has the whole transaction rolled back with its failed completion,
 * which is the shape G5's runner gives this protection — so a stolen lease costs one
 * wasted request and never a duplicate row.
 *
 * ## Why the retry ladder is short
 *
 * Two attempts, not four. A refusal, a schema failure and a fabricated quote are all
 * recorded as outcomes rather than thrown, so the handler *succeeds* on all of them:
 * the message keeps its deterministic classification and the card says the model had
 * nothing to add. The only thing left to throw on is a provider error, and the second
 * attempt is the one that distinguishes a blip from an outage. A four-attempt ladder
 * would spend four times the money to reach the same conclusion, and a dead
 * `classify.reply` job blocks nothing — the reply is already on the card and already
 * holding the firm.
 */
export const CLASSIFY_LEASE_SECONDS = 120;

export interface ClassifyHandlerOptions {
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}

export function classifyReplyHandler(deps: ClassifyReplyDeps, options: ClassifyHandlerOptions = {}): JobHandler {
  return {
    kind: 'classify.reply',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 2,
    leaseSeconds: options.leaseSeconds ?? CLASSIFY_LEASE_SECONDS,
    handle: async input => {
      const messageId = input.job.payload['messageId'];
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new Error('a classify.reply payload names the message it is classifying');
      }
      const context = repositoryContext(input.scope, input.session);
      const report = await classifyReplyWithModel(context, deps, { messageId });
      if (report.outcome === 'provider_error') {
        // The one retryable outcome. Everything else is a recorded result.
        throw new Error('the classification provider did not answer');
      }
    },
  };
}
