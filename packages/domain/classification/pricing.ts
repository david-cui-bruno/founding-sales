import type { ClassifierModel } from '@fss/contracts';
import { buildClassifierRequest } from './prompt.ts';
import { MODEL_CAPABILITIES, type ClassifierSettings } from './types.ts';
import type { ClassifierInput } from './prompt.ts';

/**
 * What one reply classification may cost, and what it did (slice P1, invariant I2).
 *
 * The classifier follows the paid-call pattern (`paidCall.ts`): each attempt reserves this
 * upper bound, computed from the exact request it will send, and is settled by id at the
 * cost its answer reports — or kept at the bound when nobody knows what was billed.
 *
 * Prices are Anthropic's first-party rates per million tokens, in cents (the claude-api
 * reference's model table, cached 25 September 2026, read 1 October 2026): Claude Opus 5
 * $5 / $25, Claude Haiku 4.5 $1 / $5. A cache write is 1.25× the input rate; reads are
 * cheaper, and are charged here at the write rate, because the adapter records the two
 * together and over-counting is the direction in which nothing is lost.
 */
export const CLASSIFIER_PRICE_CENTS_PER_MILLION: Readonly<Record<ClassifierModel, { readonly input: number; readonly output: number }>> =
  Object.freeze({
    'claude-opus-5': { input: 500, output: 2_500 },
    'claude-haiku-4-5': { input: 100, output: 500 },
    'claude-haiku-4-5-20251001': { input: 100, output: 500 },
  });

const CACHE_WRITE_MULTIPLIER = 1.25;

/** `provider_ledger.provider_key` for the reply classifier. */
export const CLASSIFIER_PROVIDER_KEY = 'anthropic_classifier';

/**
 * The most one request can cost, before it is sent.
 *
 * The input bound is the UTF-8 byte length of the serialized request — no tokenizer
 * produces more tokens than bytes — at the cache-write rate; the output bound is the
 * request's own `max_tokens`. A model with server-side fallbacks may be answered by a
 * second model after a refusal, so the bound is doubled for it.
 */
export function classifierCallCeilingCents(settings: ClassifierSettings, input: ClassifierInput): number {
  const price = CLASSIFIER_PRICE_CENTS_PER_MILLION[settings.modelName];
  const inputTokens = classifierInputTokenBound(settings, input);
  const one = (inputTokens * price.input * CACHE_WRITE_MULTIPLIER + settings.maxOutputTokens * price.output) / 1_000_000;
  const fallbacks = MODEL_CAPABILITIES[settings.modelName].serverSideFallbacks ? 2 : 1;
  return Math.ceil(one * fallbacks);
}

/** The input-token bound of one request: the UTF-8 byte length of the serialized request. */
export function classifierInputTokenBound(settings: ClassifierSettings, input: ClassifierInput): number {
  const request = buildClassifierRequest({
    model: settings.modelName,
    effort: settings.effort,
    maxOutputTokens: settings.maxOutputTokens,
    message: input,
  });
  return Math.max(1, Buffer.byteLength(JSON.stringify(request), 'utf8'));
}

/** What a request that was answered cost, from its reported usage, rounded up to a cent. */
export function classifierCallCents(
  modelName: ClassifierModel,
  usage: { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number },
): number {
  const price = CLASSIFIER_PRICE_CENTS_PER_MILLION[modelName];
  return Math.ceil(
    (usage.inputTokens * price.input +
      usage.cachedInputTokens * price.input * CACHE_WRITE_MULTIPLIER +
      usage.outputTokens * price.output) /
      1_000_000,
  );
}
