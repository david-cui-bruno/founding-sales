import type { ReplyClass, ReplyDisposition } from '../src/rules/replyClassification.ts';

/**
 * What the model layer is, and what it is allowed to be (specification 8.3, 12.4).
 *
 * The deterministic layer in `packages/domain/src/rules/replyClassification.ts`
 * decides first. This package is the second opinion that follows it, and every type
 * here is shaped by one sentence of 12.4:
 *
 *   "The LLM may label and prioritize ordinary work but cannot by itself release a
 *   message as automated, close an opportunity, create a suppression from ambiguous
 *   language, commit an extracted callback instant, or resume automation."
 *
 * So a `ModelSuggestion` carries a `class`, and nothing in this package ever writes
 * it to `mail_message_classifications.class` — the row the model layer writes always
 * says `uncertain`, and `mail_message_classifications_model_cannot_decide` in
 * migration 0009 refuses anything else. The suggested class is kept as a *signal*,
 * because "the model thought this was automated and the deterministic layer did not"
 * is information a person reading the card wants, and "the model decided" is not a
 * thing that can happen.
 *
 * The same rule governs `callbackProposal`: it is local wall-clock text and a zone,
 * as the model read them, and it becomes an instant only when a person confirms it
 * through `confirmReplyDisposition`, which calls G4's `createCallback`, which refuses
 * a non-user actor.
 */

/** The prompt this package sends. Bumped whenever a byte of the system prompt moves. */
export const CLASSIFIER_PROMPT_VERSION = 'g7b.replies.1';

/**
 * The two model ids David chooses between at launch, and the only two
 * `classifier_settings_model_known` accepts.
 *
 * Complete as written. Appending a date suffix to either — `claude-haiku-4-5-20251001`
 * and the like — is a refusal at the provider rather than a pin, and migration 0011
 * has a CHECK that says so, because the mistake is a remembered one.
 */
export const CLASSIFIER_MODELS = ['claude-opus-5', 'claude-haiku-4-5'] as const;
export type ClassifierModel = (typeof CLASSIFIER_MODELS)[number];

export const CLASSIFIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClassifierEffort = (typeof CLASSIFIER_EFFORTS)[number];

/**
 * What each model will accept, so the adapter never sends a parameter that is a 400.
 *
 * `output_config.effort` is not a parameter Claude Haiku 4.5 takes, and the
 * server-side `fallbacks` parameter is a Claude Opus 5 feature. Both facts belong in
 * one table rather than in an `if` inside the request builder, because the table is
 * what a reader checks when a third model is added.
 */
export interface ModelCapabilities {
  readonly effort: boolean;
  readonly serverSideFallbacks: boolean;
}

export const MODEL_CAPABILITIES: Readonly<Record<ClassifierModel, ModelCapabilities>> = Object.freeze({
  'claude-opus-5': { effort: true, serverSideFallbacks: true },
  'claude-haiku-4-5': { effort: false, serverSideFallbacks: false },
});

/** The beta flag the scalar `fallbacks: "default"` form requires. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The default configuration of a workspace that has never been configured. */
export interface ClassifierSettings {
  readonly enabled: boolean;
  readonly modelName: ClassifierModel;
  readonly effort: ClassifierEffort;
  readonly maxOutputTokens: number;
  readonly dailyCallCap: number;
  readonly updatedByUserId: string | null;
  readonly updatedAt: string | null;
}

export const DEFAULT_CLASSIFIER_SETTINGS: ClassifierSettings = Object.freeze({
  enabled: true,
  modelName: 'claude-opus-5',
  effort: 'low',
  maxOutputTokens: 512,
  dailyCallCap: 500,
  updatedByUserId: null,
  updatedAt: null,
});

/**
 * The strict schema the model answers in. Every field is required and nullable where
 * the answer may genuinely be "none", because an optional field is a field the model
 * may quietly omit and the code may quietly misread.
 */
export interface CallbackProposal {
  /** Local wall-clock text exactly as the message expressed it. Never an instant. */
  readonly localDateTime: string;
  /** An IANA zone, or null when the message named none. */
  readonly timeZone: string | null;
}

export interface ModelSuggestion {
  readonly class: ReplyClass;
  readonly disposition: ReplyDisposition | null;
  readonly confidence: number;
  /** A verbatim substring of the input, verified by the code before it is stored. */
  readonly supportingExcerpt: string | null;
  readonly callbackProposal: CallbackProposal | null;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

/** Why an attempt produced no usable suggestion, or that it produced one. */
export const CLASSIFIER_CALL_OUTCOMES = [
  'accepted',
  'refusal',
  'malformed',
  'schema_invalid',
  'excerpt_unverified',
  'provider_error',
  'disabled',
  'capped',
  'not_applicable',
] as const;
export type ClassifierCallOutcome = (typeof CLASSIFIER_CALL_OUTCOMES)[number];

/** The outcomes in which no request left the process. Mirrors the migration's CHECK. */
export const UNSENT_CALL_OUTCOMES: ReadonlySet<ClassifierCallOutcome> = new Set([
  'disabled',
  'capped',
  'not_applicable',
] as const);

/**
 * Everything one attempt records (13.4: "emails sent, skipped, held ... results by
 * sequence"; the brief: "model, prompt version, input token count, cached token
 * count, output tokens, latency, and the result").
 *
 * No prompt text, no message text and no excerpt: the dashboard needs counts, and an
 * operational record that quoted correspondence would be a second copy of it under a
 * different retention rule (10.3).
 */
export interface ClassifierCallRecord {
  readonly modelName: string;
  readonly promptVersion: string;
  readonly effort: ClassifierEffort | null;
  readonly requestSent: boolean;
  readonly outcome: ClassifierCallOutcome;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;
}

export const CLASSIFICATION_REFUSAL_CODES = [
  'admin_only',
  'not_assigned',
  'invalid_input',
  'message_unknown',
  'not_classified',
  'ambiguity_unresolved',
  'already_confirmed',
  'callback_required',
  'callback_not_permitted',
  'suppression_failed',
] as const;
export type ClassificationRefusalCode = (typeof CLASSIFICATION_REFUSAL_CODES)[number];

export type ClassificationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ClassificationRefusalCode };

export function acceptClassification<T>(value: T): ClassificationResult<T> {
  return { ok: true, value };
}

export function refuseClassification<T>(reason: ClassificationRefusalCode): ClassificationResult<T> {
  return { ok: false, reason };
}

export function isClassifierModel(value: string): value is ClassifierModel {
  return (CLASSIFIER_MODELS as readonly string[]).includes(value);
}

export function isClassifierEffort(value: string): value is ClassifierEffort {
  return (CLASSIFIER_EFFORTS as readonly string[]).includes(value);
}
