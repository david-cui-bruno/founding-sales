import { MAX_TEXT_CHARACTERS } from './pageText.ts';

/**
 * What a research run may cost, in whole cents (David's answer 8: a budget of $20–30
 * a month, with calls ahead of everything else).
 *
 * The ceiling has to be checked *before* the call, and the only number available
 * before a call is a worst case. So this file is two things: a reviewed price table,
 * and a worst case derived from the bounds the settings already enforce.
 *
 * ## A model with no row cannot run
 *
 * `research_settings_model_known` admits one model and `PRICE_CENTS_PER_MILLION` has
 * one row, and that is the same fact written twice on purpose. A model whose price
 * nobody has read off a price list cannot be priced, and a run that cannot be priced
 * cannot be cleared: `centsOf` throws for an unknown model rather than returning zero,
 * because a zero would silently spend a month's budget in an afternoon.
 *
 * Adding a model is therefore three edits — the CHECK, this table, and the contract's
 * enum — and that friction is the feature.
 *
 * ## Prices
 *
 * Read from Anthropic's published price list on **28 September 2026**. Claude Haiku
 * 4.5: $1.00 per million input tokens, $5.00 per million output tokens — 100 and 500
 * cents. Cache reads and writes are not priced separately here: this lane sends one
 * message per run with no cache_control, so every input token is an ordinary one, and
 * a worst case that ignored a *cheaper* tier would be the safe direction anyway.
 */

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/** Cents per million tokens. Reviewed 28 September 2026. */
export const PRICE_CENTS_PER_MILLION: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-haiku-4-5': Object.freeze({ input: 100, output: 500 }),
});

/** The date the table above was read. In the run record, so a stale price is findable. */
export const PRICE_TABLE_REVIEWED_ON = '2026-09-28';

export class UnpricedModelError extends Error {
  constructor(readonly modelName: string) {
    super(`no reviewed price for ${modelName}`);
    this.name = 'UnpricedModelError';
  }
}

export function isPricedModel(modelName: string): boolean {
  return Object.hasOwn(PRICE_CENTS_PER_MILLION, modelName);
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * What a call cost, rounded **up** to whole cents.
 *
 * Up, not to nearest: the ledger is what a ceiling is compared against, and a ledger
 * that rounded down would let a thousand half-cent calls cost nothing at all. A call
 * that happened costs at least one cent.
 */
export function centsOf(modelName: string, usage: TokenUsage): number {
  const price = PRICE_CENTS_PER_MILLION[modelName];
  if (price === undefined) throw new UnpricedModelError(modelName);
  const input = Math.max(0, Math.trunc(usage.inputTokens));
  const output = Math.max(0, Math.trunc(usage.outputTokens));
  const exact = (input * price.input + output * price.output) / 1_000_000;
  return exact === 0 ? 0 : Math.max(1, Math.ceil(exact));
}

/** The largest `max_tokens` `anthropicExtraction.ts` ever sends. */
export const MAX_EXTRACTION_OUTPUT_TOKENS = 600;

/**
 * Roughly four characters to a token. A deliberate under-estimate of tokens per
 * character would make the worst case too small, so this is the conservative
 * direction: markup and punctuation tokenize worse than prose, and what the extractor
 * is sent is *parsed block text*, which has had the markup taken out of it.
 */
const CHARACTERS_PER_TOKEN = 4;

/** What the prompt adds beyond the page text: the dictionary, the instructions, the schema. */
const PROMPT_OVERHEAD_TOKENS = 1_500;

export interface WorstCaseInput {
  readonly modelName: string;
  readonly maxPagesPerFirm: number;
  readonly maxPageBytes: number;
}

/**
 * The most one run of one firm can cost, in whole cents.
 *
 * One message per run, so the input is bounded by the text of every page the run may
 * read. The bound is **not** `max_page_bytes`: a page is fetched as bytes and then
 * parsed, and `parsePageText` drops every block past `MAX_TEXT_CHARACTERS`, so the
 * extractor is never offered more than that per page however large the page was. The
 * smaller of the two is therefore the true bound, and using the larger would produce a
 * worst case of about a dollar a run, which at the default fifty-cent daily ceiling
 * would refuse every run there has ever been.
 *
 * At the defaults — four pages, twelve thousand characters each — this is 2 cents, so
 * the fifty-cent daily ceiling is 25 runs and the ten-dollar monthly ceiling is 500.
 *
 * This is the number `claimResearchClearance` adds to today's spend before deciding,
 * which is why it must never be optimistic: a provider that reports less afterwards
 * frees budget for the next run, and one that could report more could not have been
 * authorized in the first place.
 */
export function worstCaseRunCents(input: WorstCaseInput): number {
  const pages = Math.max(1, Math.trunc(input.maxPagesPerFirm));
  const perPage = Math.min(Math.max(1024, Math.trunc(input.maxPageBytes)), MAX_TEXT_CHARACTERS);
  const inputTokens = PROMPT_OVERHEAD_TOKENS + Math.ceil((pages * perPage) / CHARACTERS_PER_TOKEN);
  return centsOf(input.modelName, { inputTokens, outputTokens: MAX_EXTRACTION_OUTPUT_TOKENS });
}
