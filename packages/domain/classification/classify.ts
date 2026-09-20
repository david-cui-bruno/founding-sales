import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readMessage, readMessageBody } from '../mail/messages.ts';
import { applyModelSuggestion, authoredText, type ReplyClassification } from '../src/rules/replyClassification.ts';
import type { ReplyClassifierPort } from './adapter.ts';
import type { ClassifierInput } from './prompt.ts';
import {
  countCallsToday,
  listClassifications,
  recordClassifierCall,
  recordModelClassification,
  type ClassificationRow,
} from './store.ts';
import { readClassifierSettings } from './settings.ts';
import {
  CLASSIFIER_PROMPT_VERSION,
  MODEL_CAPABILITIES,
  type ClassifierCallOutcome,
  type ClassifierCallRecord,
  type ClassifierSettings,
} from './types.ts';

/**
 * The second opinion, for one message (specification 12.4, Appendix A's
 * "LLM classification may be queued", Appendix G 34 and 35).
 *
 * The order the brief states, and the order this function runs in:
 *
 * 1. **Deterministic first, and its result is final** for `bounce`, `opt_out` with
 *    explicit phrases, and header-proven `automated`. This function reads the
 *    deterministic row and stops if it is anything but `uncertain`. It does not
 *    re-run the rules and it does not look at the message: the row was written in
 *    the same transaction as the message's effects, and asking again could get a
 *    different answer from a body that has since been discarded.
 * 2. **The model, for the remainder**, once, with its outcome recorded whatever it
 *    was.
 * 3. **The conservative merge** — `applyModelSuggestion` in the deterministic rules
 *    file, which returns the class unchanged. "Any human or uncertain signal holds;
 *    `automated` from the model alone never releases" is not a branch here; it is
 *    the absence of a branch, and `mail_message_classifications_model_cannot_decide`
 *    is the database saying the same thing.
 *
 * **Nothing in this file applies an effect.** No hold opens, no suppression is
 * recorded, no opportunity changes mode, no today item moves. Every one of those
 * already happened in `applyClassificationEffects` when the message arrived, and the
 * model's job is to put a label on a card. That is the authority boundary, and the
 * test suite for it (`test/classification/authority.test.ts`) asserts the row counts
 * of all four tables are unchanged across a classification.
 */

/** Why no request was sent, or null when one was. */
export type SkipReason = Extract<ClassifierCallOutcome, 'disabled' | 'capped' | 'not_applicable'>;

export interface ClassifyReplyOutcome {
  readonly messageId: string;
  /** What the card will show after this call: deterministic, merged with the model. */
  readonly classification: ReplyClassification | null;
  readonly outcome: ClassifierCallOutcome;
  /** True when this call was the one that wrote the model row. */
  readonly recorded: boolean;
  readonly call: ClassifierCallRecord | null;
}

export interface ClassifyReplyDeps {
  readonly classifierFor: (settings: ClassifierSettings) => ReplyClassifierPort;
  /**
   * The process-level off switch (`FSS_CLASSIFIER=off`). Distinct from the
   * workspace's `enabled`: one is a deployment that has no key, the other is an
   * admin who turned it off. Either one means no request.
   */
  readonly processEnabled?: boolean | undefined;
}

function deterministicOf(rows: readonly ClassificationRow[]): ClassificationRow | undefined {
  return rows.find(row => row.layer === 'deterministic');
}

function asReplyClassification(messageId: string, row: ClassificationRow): ReplyClassification {
  return {
    class: row.class,
    suggestedDisposition: row.suggestedDisposition,
    signals: row.signals,
    requiresConfirmation: row.requiresConfirmation,
    messageId,
  };
}

/** An attempt that never left the process. Zero tokens, zero latency; the CHECK agrees. */
function unsentCall(settings: ClassifierSettings, outcome: SkipReason): ClassifierCallRecord {
  return {
    modelName: settings.modelName,
    promptVersion: CLASSIFIER_PROMPT_VERSION,
    effort: MODEL_CAPABILITIES[settings.modelName].effort ? settings.effort : null,
    requestSent: false,
    outcome,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    stopReason: null,
    refusalCategory: null,
  };
}

export async function classifyReplyWithModel(
  context: RepositoryContext,
  deps: ClassifyReplyDeps,
  input: { readonly messageId: string },
): Promise<ClassifyReplyOutcome> {
  const message = await readMessage(context, input.messageId);
  if (message === null) {
    return { messageId: input.messageId, classification: null, outcome: 'not_applicable', recorded: false, call: null };
  }

  const rows = await listClassifications(context, input.messageId);
  const deterministic = deterministicOf(rows);
  const settings = await readClassifierSettings(context);

  // The deterministic layer has already decided, or has not run at all. Either way
  // there is nothing to ask about, and the attempt is recorded as such rather than
  // silently not happening: a sudden run of `not_applicable` is a mail lane that has
  // stopped classifying, and that is worth seeing in the same place as the cost.
  if (deterministic === undefined || deterministic.class !== 'uncertain') {
    const call = unsentCall(settings, 'not_applicable');
    await recordClassifierCall(context, { messageId: input.messageId, call });
    return {
      messageId: input.messageId,
      classification: deterministic === undefined ? null : asReplyClassification(input.messageId, deterministic),
      outcome: 'not_applicable',
      recorded: false,
      call,
    };
  }

  // Already answered. A replayed job is the ordinary case, not an error.
  if (rows.some(row => row.layer === 'model')) {
    return {
      messageId: input.messageId,
      classification: asReplyClassification(input.messageId, deterministic),
      outcome: 'accepted',
      recorded: false,
      call: null,
    };
  }

  const merged = (suggestion: Parameters<typeof applyModelSuggestion>[1]): ReplyClassification =>
    applyModelSuggestion(asReplyClassification(input.messageId, deterministic), suggestion);

  const enabled = settings.enabled && deps.processEnabled !== false;
  if (!enabled) {
    // The brief: "a `FSS_CLASSIFIER=off` configuration makes every message
    // `uncertain` with no call". It already is `uncertain`; what this adds is the
    // record that nothing was asked.
    const call = unsentCall(settings, 'disabled');
    await recordClassifierCall(context, { messageId: input.messageId, call });
    return {
      messageId: input.messageId,
      classification: merged(null),
      outcome: 'disabled',
      recorded: false,
      call,
    };
  }

  if (settings.dailyCallCap === 0 || (await countCallsToday(context)) >= settings.dailyCallCap) {
    const call = unsentCall(settings, 'capped');
    await recordClassifierCall(context, { messageId: input.messageId, call });
    return { messageId: input.messageId, classification: merged(null), outcome: 'capped', recorded: false, call };
  }

  const body = await readMessageBody(context, input.messageId);
  const classifierInput: ClassifierInput = {
    subject: message.subject,
    from: message.headerFrom,
    // The authored text, not the raw body: the quote boundary and the signature
    // boundary are the deterministic layer's and the model is asked about the same
    // words a rule was asked about. It is also what `excerptIsVerbatim` checks
    // against, so a quote from a signature block cannot verify.
    bodyText: body === null ? '' : authoredText(body.text),
    truncated: body?.truncated ?? false,
    deterministicSignals: deterministic.signals.map(signal => signal.rule),
  };

  const attempt = await deps.classifierFor(settings).classify(classifierInput);
  await recordClassifierCall(context, { messageId: input.messageId, call: attempt.call });

  if (!attempt.ok) {
    // Appendix G 34: "Malformed output becomes uncertain." So does a refusal, a
    // schema failure, a fabricated quote and a provider error. The card keeps the
    // deterministic answer and says the model had nothing to add.
    return {
      messageId: input.messageId,
      classification: merged(null),
      outcome: attempt.call.outcome,
      recorded: false,
      call: attempt.call,
    };
  }

  const recorded = await recordModelClassification(context, {
    messageId: input.messageId,
    suggestion: attempt.suggestion,
    effort: attempt.call.effort,
    deterministicSignals: deterministic.signals,
  });

  return {
    messageId: input.messageId,
    classification: merged({
      class: attempt.suggestion.class,
      ...(attempt.suggestion.disposition === null ? {} : { disposition: attempt.suggestion.disposition }),
      confidence: attempt.suggestion.confidence,
    }),
    outcome: 'accepted',
    recorded,
    call: attempt.call,
  };
}
