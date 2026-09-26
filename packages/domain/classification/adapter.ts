import type { AnthropicMessageResponse, AnthropicMessagesTransport } from './anthropicClient.ts';
import { buildClassifierRequest, type ClassifierInput, type ClassifierRequest } from './prompt.ts';
import { excerptIsVerbatim, readModelSuggestion } from './schema.ts';
import {
  CLASSIFIER_PROMPT_VERSION,
  MODEL_CAPABILITIES,
  type ClassifierCallRecord,
  type ModelSuggestion,
} from './types.ts';
import type { ClassifierEffort, ClassifierModel } from '@fss/contracts';

/**
 * The adapter: one request, one answer, and every way the answer can be useless
 * (specification 12.4; Appendix G 34's second sentence, "Malformed output becomes
 * uncertain").
 *
 * The port is deliberately not "give me a classification". It is "give me a
 * suggestion or tell me why you could not", because the caller has to record the
 * second case: 13.4 shows drift, and drift is a rising count of refusals and schema
 * failures long before it is a wrong label.
 *
 * Five ways an answer fails, and every one of them leaves the message exactly as the
 * deterministic layer left it:
 *
 * | Outcome | What happened |
 * |---|---|
 * | `refusal` | `stop_reason === 'refusal'`. Checked **before** `content` is read. |
 * | `malformed` | No text block, or text that is not JSON. |
 * | `schema_invalid` | JSON that does not satisfy the strict schema. |
 * | `excerpt_unverified` | A quote that is not in the message. A fabricated citation discredits the answer that rests on it, so the whole suggestion goes. |
 * | `provider_error` | The SDK threw. |
 *
 * `excerpt_unverified` is the one that is a judgement rather than a mechanism, and
 * it is the conservative reading of the brief's "verbatim substring of the input,
 * verified by the code". The alternative — keep the label, drop the quote — puts a
 * disposition on a card with nothing behind it, from a model that has just been
 * caught inventing a sentence. See `docs/decisions/g7b-a-fabricated-quote-voids-the-answer.md`.
 */

export type ClassifierAttempt =
  | { readonly ok: true; readonly suggestion: ModelSuggestion; readonly call: ClassifierCallRecord }
  | { readonly ok: false; readonly call: ClassifierCallRecord };

/** The port the pipeline depends on. One method; the fake and the real one both fit. */
export interface ReplyClassifierPort {
  classify(input: ClassifierInput): Promise<ClassifierAttempt>;
}

export interface AnthropicClassifierOptions {
  readonly transport: AnthropicMessagesTransport;
  readonly model: ClassifierModel;
  readonly effort: ClassifierEffort;
  readonly maxOutputTokens: number;
  /** Injected so a test can assert latency without a real clock. */
  readonly now?: (() => number) | undefined;
}

/** The first text block's text, or null when the answer carried none. */
function textOf(response: AnthropicMessageResponse): string | null {
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return block.text;
    }
  }
  return null;
}

function usageOf(response: AnthropicMessageResponse): {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
} {
  const usage = response.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    // Both halves of the cache are counted: a write is what makes the next read
    // possible, and a dashboard that showed only reads would report a cold cache
    // as a broken one.
    cachedInputTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

/** How many of the input tokens were served from the cache. The harness asserts it. */
export function cacheReadTokens(response: AnthropicMessageResponse): number {
  return response.usage?.cache_read_input_tokens ?? 0;
}

export function anthropicReplyClassifier(options: AnthropicClassifierOptions): ReplyClassifierPort {
  const clock = options.now ?? ((): number => Date.now());
  const effort = MODEL_CAPABILITIES[options.model].effort ? options.effort : null;

  return {
    classify: async (input: ClassifierInput): Promise<ClassifierAttempt> => {
      const request: ClassifierRequest = buildClassifierRequest({
        model: options.model,
        effort: options.effort,
        maxOutputTokens: options.maxOutputTokens,
        message: input,
      });

      const base = {
        modelName: options.model,
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        effort,
        requestSent: true,
      } as const;

      const started = clock();
      let response: AnthropicMessageResponse;
      try {
        response = await options.transport.create(request);
      } catch {
        // The error is deliberately not carried into the record. An SDK error
        // message can quote a request body, and a request body is somebody's email.
        return {
          ok: false,
          call: {
            ...base,
            outcome: 'provider_error',
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            latencyMs: Math.max(0, Math.round(clock() - started)),
            stopReason: null,
            refusalCategory: null,
          },
        };
      }
      const latencyMs = Math.max(0, Math.round(clock() - started));
      const usage = usageOf(response);
      const stopReason = response.stop_reason ?? null;
      const spent = { ...usage, latencyMs, stopReason } as const;

      // Before `content`, always. A refusal is an HTTP 200 whose content is not the
      // answer, and reading it first is how a refusal becomes a label.
      if (stopReason === 'refusal') {
        return {
          ok: false,
          call: { ...base, ...spent, outcome: 'refusal', refusalCategory: response.stop_details?.category ?? null },
        };
      }

      const text = textOf(response);
      if (text === null) {
        return { ok: false, call: { ...base, ...spent, outcome: 'malformed', refusalCategory: null } };
      }

      const read = readModelSuggestion(text);
      if (!read.ok) {
        return { ok: false, call: { ...base, ...spent, outcome: read.failure, refusalCategory: null } };
      }

      const excerpt = read.suggestion.supportingExcerpt;
      if (excerpt !== null && !excerptIsVerbatim(excerpt, input.bodyText)) {
        return {
          ok: false,
          call: { ...base, ...spent, outcome: 'excerpt_unverified', refusalCategory: null },
        };
      }

      return {
        ok: true,
        // The model's own `model_version` and `prompt_version` are advisory: it is
        // being asked about a fact the caller already knows, and recording its
        // answer would be trusting it about the identity of the thing that produced
        // it. The response's `model` is the server's word, which is the one that
        // matters after a server-side fallback re-ran the request elsewhere.
        suggestion: {
          ...read.suggestion,
          modelVersion: response.model ?? options.model,
          promptVersion: CLASSIFIER_PROMPT_VERSION,
        },
        call: { ...base, ...spent, outcome: 'accepted', refusalCategory: null },
      };
    },
  };
}
