import type {
  AnthropicMessageResponse,
  AnthropicMessagesTransport,
} from '@fss/domain/classification/anthropicClient.ts';
import type { ClassifierRequest } from '@fss/domain/classification/prompt.ts';
import {
  EXTRACTION_OUTPUT_SCHEMA,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_TEXT,
  extractionUserText,
} from '@fss/domain/research/extractionPrompt.ts';
import type {
  ExtractionAnswer,
  ExtractionProvider,
  ExtractionRequest,
  ProviderOutcome,
} from '@fss/domain/research/providers.ts';
import { MAX_EXTRACTION_OUTPUT_TOKENS, centsOf } from '@fss/domain/research/pricing.ts';
import { EXTRACTION_PROVIDER } from '@fss/domain/research/types.ts';

/**
 * The live extraction: one model call per run, over the transport the reply
 * classifier already loads.
 *
 * The same key, through the same seam, under the same rule: `loadAnthropicTransport`
 * takes `environmentClassifierSecrets`, hands the value to the SDK's constructor, and
 * the closure holds a client. Nothing in this file is a string that could be logged.
 * `bootstrap/main.ts` reuses `classifyWorkerOptions`' result rather than reading the
 * environment twice, so there is one transport and one place the key is read.
 *
 * ## The model never supplies a quote
 *
 * The request carries the blocks **by id**, and the answer is
 * `{ selections: [{ key, sourceReference, blockId }], questions, opening }` with no
 * text field at all. The quote is looked up locally by `validateFactSelections`, so a
 * model that paraphrases, drops a negation or invents a sentence cannot be believed
 * rather than being believed wrongly. That is the single rule that makes a "fact"
 * attributable to something the firm published.
 *
 * `questions` and `opening` are the exception, and the only text a model authors that
 * reaches a person. They are stored under `research_runs.brief` with
 * `generated: true` and the desktop labels them an AI suggestion.
 *
 * ## Strict JSON output, not tool use
 *
 * `output_config.format: { type: 'json_schema' }`, which is what the classifier's
 * `ClassifierRequest` already is. The transport's parameter type is that request
 * shape, so a tool-use request would have meant widening a type in the classifier's
 * own file — a file this lane does not own — for no gain: both are the same promise,
 * that the answer validates against a schema before anybody reads it.
 *
 * ## Every way the answer is useless
 *
 * A refusal, a missing text block, text that is not JSON, JSON the schema refuses,
 * or a thrown SDK error are one outcome: `provider_failure`, with the cents the call
 * cost still recorded. The run records it and the job retries under the ladder; the
 * pages the run already fetched stay.
 */

interface ParsedAnswer {
  readonly selections: readonly { readonly key: string; readonly sourceReference: string; readonly blockId: string }[];
  readonly questions: readonly [string, string] | null;
  readonly opening: string | null;
}

/** The first text block's text, or null. */
function textOf(response: AnthropicMessageResponse): string | null {
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return block.text;
    }
  }
  return null;
}

/**
 * Read the answer, or null.
 *
 * Shape-checked here rather than trusted: `output_config` is a promise the provider
 * makes and not one this code may rely on, and a malformed answer that reached
 * `validateFactSelections` would be refused there anyway — but with a less useful
 * reason than `provider_failure`.
 */
export function parseExtractionAnswer(text: string): ParsedAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawSelections = record['selections'];
  if (!Array.isArray(rawSelections)) return null;

  const selections: { key: string; sourceReference: string; blockId: string }[] = [];
  for (const entry of rawSelections) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const key = row['key'];
    const sourceReference = row['sourceReference'];
    const blockId = row['blockId'];
    if (typeof key !== 'string' || typeof sourceReference !== 'string' || typeof blockId !== 'string') continue;
    // An unknown key or an unknown block is *not* dropped here: it is passed on so
    // `validateFactSelections` counts it, which is where the drift the dashboard
    // would show becomes visible.
    selections.push({ key, sourceReference, blockId });
  }

  const rawQuestions = record['questions'];
  const questions =
    Array.isArray(rawQuestions) &&
    rawQuestions.length === 2 &&
    typeof rawQuestions[0] === 'string' &&
    typeof rawQuestions[1] === 'string' &&
    rawQuestions[0].trim() !== '' &&
    rawQuestions[1].trim() !== ''
      ? ([rawQuestions[0], rawQuestions[1]] as const)
      : null;
  const rawOpening = record['opening'];
  const opening = typeof rawOpening === 'string' && rawOpening.trim() !== '' ? rawOpening : null;
  return { selections, questions, opening };
}

export interface AnthropicExtractionOptions {
  readonly transport: AnthropicMessagesTransport;
}

// Re-exported so nothing that used to import them from here has to move. The strings
// themselves are in the domain package because `pricing.ts` measures them: see
// `research/extractionPrompt.ts`.
export { EXTRACTION_OUTPUT_SCHEMA, EXTRACTION_PROMPT_VERSION, EXTRACTION_SYSTEM_TEXT, extractionUserText };

export function anthropicExtraction(options: AnthropicExtractionOptions): ExtractionProvider {
  /**
   * Exactly what `extract` would send, so a count is a count of the real request.
   *
   * The model and the output bound come from the request, which carries the
   * **reservation's** snapshot of them. The adapter used to hold a model of its own,
   * fixed at composition, and the caller compared token counts with whatever the
   * settings said at the time: two numbers that could disagree with the cents being
   * held. Now there is one source, and it is the row that authorized the money.
   */
  const requestFor = (input: ExtractionRequest): ClassifierRequest => ({
    model: input.modelName,
    max_tokens: Math.min(Math.max(1, Math.trunc(input.maxOutputTokens)), MAX_EXTRACTION_OUTPUT_TOKENS),
    // No `cache_control`. Prompt caching pays 1.25× on the write and 0.1× on a
    // read, so it only saves money when the same prefix is sent again — and it is
    // not: every run's message is a different firm's pages, and the only constant
    // part is the system text, which is far too small to be worth a cache write.
    // Caching here was a 25% surcharge on the one thing that repeats and no
    // saving at all on the rest, and it made the priced worst case wrong.
    system: [{ type: 'text', text: EXTRACTION_SYSTEM_TEXT }],
    messages: [{ role: 'user', content: extractionUserText(input) }],
    // No `effort`: Claude Haiku 4.5 returns a 400 for it (`MODEL_CAPABILITIES`),
    // and there is no thinking to ask for. Temperature is left at the model
    // default, which for a schema-constrained extraction is the same answer.
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA } },
  });

  return {
    providerKey: EXTRACTION_PROVIDER,
    /**
     * The provider's own count of the request `extract` would send.
     *
     * Built from the same function, so what is counted and what is sent cannot drift:
     * the whole value of an exact count is that it is a count of *this* request.
     */
    countInputTokens: async (input: ExtractionRequest): Promise<number> =>
      await options.transport.countTokens(requestFor(input)),
    extract: async (input: ExtractionRequest): Promise<ProviderOutcome<ExtractionAnswer>> => {
      let response: AnthropicMessageResponse;
      try {
        response = await options.transport.create(requestFor(input));
      } catch {
        // The error is deliberately not carried out of here. An SDK error message can
        // quote a request body, and a request body is a firm's published pages plus
        // the prompt — nothing secret, but nothing a ledger row needs either.
        //
        // `costEstimated` is what stops that zero being believed. The request may have
        // reached the model and been billed; what came back was a broken socket, not an
        // invoice. The caller records the run's reservation instead.
        return { ok: false, failureCode: 'provider_error', costCents: 0, costEstimated: true };
      }

      // A response with no usage at all — or without its input or output count (slice P1)
      // — is the same situation as a throw: the call happened, and nobody said what it
      // cost. A missing count is never read as zero tokens.
      const costEstimated =
        response.usage === undefined ||
        response.usage === null ||
        typeof response.usage.input_tokens !== 'number' ||
        typeof response.usage.output_tokens !== 'number';
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      // Read even though this request enables no caching: a category nobody reads is a
      // category the ceilings cannot see, and a cache write is *dearer* than an
      // ordinary input token. If a later change re-enables caching, or the provider
      // reports these for its own reasons, the ledger already counts them.
      const cacheWriteTokens = response.usage?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = response.usage?.cache_read_input_tokens ?? 0;
      // Priced whatever happened next: a refusal and a malformed answer both cost the
      // tokens they burned, and a ledger that only counted successes would be a budget
      // that a broken model could walk straight through.
      const costCents = centsOf(input.modelName, {
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
      });

      const estimated = costEstimated ? { costEstimated: true } : {};
      if (response.stop_reason === 'refusal') {
        return { ok: false, failureCode: 'model_refusal', costCents, ...estimated };
      }
      const text = textOf(response);
      if (text === null) return { ok: false, failureCode: 'no_answer', costCents, ...estimated };
      const parsed = parseExtractionAnswer(text);
      if (parsed === null) return { ok: false, failureCode: 'malformed_answer', costCents, ...estimated };

      return {
        ok: true,
        value: {
          selections: parsed.selections,
          questions: parsed.questions,
          opening: parsed.opening,
          modelName: input.modelName,
          inputTokens,
          outputTokens,
        },
        costCents,
        ...estimated,
      };
    },
  };
}
