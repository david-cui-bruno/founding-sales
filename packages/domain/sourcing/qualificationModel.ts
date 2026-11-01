/**
 * The model, route and price of prepared-prospect qualification (David, 1 November 2026).
 *
 * Qualification is the one model user that is paid through Google Vertex AI (GCP credits on
 * the "Framewise Health Main" billing account). Every other model user stays on Amazon
 * Bedrock and `research_settings.model_name` stays Claude Haiku 4.5, so this is a constant of
 * its own rather than a settings column: `research_settings_model_known` and the research
 * price table keep admitting exactly the model research extraction calls.
 *
 * A run records `QUALIFICATION_MODEL_NAME` as its `model_name`, so an earlier run made by
 * Claude is never reused as an interpretation by Gemini (`qualificationRun.ts` reuses only
 * the same model).
 */
export const QUALIFICATION_MODEL_NAME = 'gemini-3.8-flash';

/** `provider_reservations.provider_key`; the kind `google_vertex` is credit-funded (`settings/funding.ts`). */
export const QUALIFICATION_PROVIDER_KEY = 'google_vertex.sourcing_qualification';

interface GeminiPrice {
  /** Cents per million input (prompt) tokens. */
  readonly input: number;
  /** Cents per million output tokens; reasoning ("thinking") tokens are billed as output. */
  readonly output: number;
}

/**
 * Gemini 3.8 Flash, standard (pay-as-you-go) tier, `global` endpoint, 200K-input-token tier
 * and below, text. Read 1 November 2026 from Google's own price list:
 * https://cloud.google.com/vertex-ai/generative-ai/pricing (the Gemini 3 table,
 * "Gemini 3.8 Flash through December 31, 2026" and "Starting January 1, 2027"):
 *
 *   through 31 December 2026:   $0.75 input / $3.75 output (text, response and reasoning) per 1M tokens
 *   from 1 January 2027:        $1.50 input / $7.50 output per 1M tokens
 *
 * The page states that "text output (response and reasoning)" is one price, so thinking
 * tokens are output tokens here. Regional (non-global) endpoints cost 10% more; the worker
 * calls `global` only. Cached-input and Priority/Flex/Batch tiers are never requested.
 * Requests that return a non-200 answer are not charged.
 */
const GEMINI_3_8_FLASH_THROUGH_2026: GeminiPrice = Object.freeze({ input: 75, output: 375 });
const GEMINI_3_8_FLASH_FROM_2027: GeminiPrice = Object.freeze({ input: 150, output: 750 });

/** The first instant the standard price applies. UTC, so a Pacific-dated billing day is never under-counted. */
export const GEMINI_STANDARD_PRICE_FROM = '2027-01-01T00:00:00.000Z';

/** The date the table above was read. */
export const QUALIFICATION_PRICE_REVIEWED_ON = '2026-11-01';

export class UnpricedQualificationModelError extends Error {
  constructor(readonly modelName: string) {
    super(`no reviewed price for ${modelName}`);
    this.name = 'UnpricedQualificationModelError';
  }
}

export function isPricedQualificationModel(modelName: string): boolean {
  return modelName === QUALIFICATION_MODEL_NAME;
}

export interface QualificationUsage {
  readonly inputTokens: number;
  /** Candidate plus reasoning tokens: everything billed as output. */
  readonly outputTokens: number;
}

/**
 * What one call cost, in whole cents rounded **up** (a call that happened costs at least a
 * cent), at the price in force at `at`. Throws for a model nobody priced.
 */
export function qualificationCents(modelName: string, usage: QualificationUsage, at: string): number {
  if (!isPricedQualificationModel(modelName)) throw new UnpricedQualificationModelError(modelName);
  const price = Date.parse(at) < Date.parse(GEMINI_STANDARD_PRICE_FROM) ? GEMINI_3_8_FLASH_THROUGH_2026 : GEMINI_3_8_FLASH_FROM_2027;
  const nonNegative = (value: number): number => {
    // Not a count: a cost computed from it would be NaN, which no ceiling can compare.
    if (!Number.isFinite(value)) throw new RangeError('qualification token counts must be finite');
    return Math.max(0, Math.trunc(value));
  };
  const exact = (nonNegative(usage.inputTokens) * price.input + nonNegative(usage.outputTokens) * price.output) / 1_000_000;
  return exact === 0 ? 0 : Math.max(1, Math.ceil(exact));
}

/**
 * How far past the reservation instant a call's settlement can be priced. The reservation reads
 * the database clock; the adapter prices the answer at the worker's wall clock after count,
 * generate (20 s + 75 s timeouts) and the job lease (180 s), so an hour also absorbs clock skew.
 */
export const QUALIFICATION_CALL_WINDOW_MILLISECONDS = 3_600_000;

/**
 * What to reserve for a call starting at `at`: the highest price in force at any instant its
 * settlement can be priced, so a call crossing the 1 January 2027 price change is never
 * under-reserved. Settlement stays `qualificationCents` at the actual instant.
 */
export function qualificationReservationCents(modelName: string, usage: QualificationUsage, at: string): number {
  const latest = new Date(Date.parse(at) + QUALIFICATION_CALL_WINDOW_MILLISECONDS).toISOString();
  return Math.max(qualificationCents(modelName, usage, at), qualificationCents(modelName, usage, latest));
}
