import { EXTRACTION_OUTPUT_SCHEMA, EXTRACTION_SYSTEM_TEXT } from './extractionPrompt.ts';
import { FACT_KEYS, FACT_KEY_DEFINITIONS } from './facts.ts';
import { MAX_BLOCKS, MAX_TEXT_CHARACTERS } from './pageText.ts';

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
 * cents.
 *
 * ## Cached input tokens
 *
 * Priced, at the published multipliers: a cache **write** is 1.25× the input price and
 * a cache **read** is 0.1×. `anthropicExtraction.ts` sends no `cache_control` — the
 * pages differ every run, so there is no prefix worth reusing and caching only bought a
 * 1.25× charge on the system text — so in this lane these two are always zero. They are
 * priced anyway, because the alternative is a `centsOf` that silently ignores a usage
 * category: if a later change re-enables caching, or a provider reports cached tokens
 * for its own reasons, the ledger must not read a write as free. A category nobody
 * prices is a category the ceilings cannot see.
 */

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/** A cache write costs 1.25× an input token; a cache read, 0.1×. Published multipliers. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

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
  /** `cache_creation_input_tokens`, charged at 1.25× input. */
  readonly cacheWriteTokens?: number | undefined;
  /** `cache_read_input_tokens`, charged at 0.1× input. */
  readonly cacheReadTokens?: number | undefined;
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
  const nonNegative = (value: number | undefined): number => Math.max(0, Math.trunc(value ?? 0));
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const exact =
    (input * price.input +
      output * price.output +
      cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * price.input * CACHE_READ_MULTIPLIER) /
    1_000_000;
  return exact === 0 ? 0 : Math.max(1, Math.ceil(exact));
}

/** The largest `max_tokens` `anthropicExtraction.ts` ever sends. */
export const MAX_EXTRACTION_OUTPUT_TOKENS = 600;

/**
 * Characters per token, for the bound.
 *
 * Two and a half, not four. Four is the figure for ordinary English prose, and this is
 * a bound rather than an estimate: what the extractor is actually sent is nav labels,
 * addresses, telephone numbers, product names and JSON punctuation, all of which
 * tokenize far worse than prose, and a bound that is too small is a ceiling that
 * authorized a call it had not priced. Two and a half is the conservative direction, and
 * being conservative here costs a fraction of a cent of headroom per run.
 */
const CHARACTERS_PER_TOKEN = 2.5;

const tokensFor = (characters: number): number => Math.ceil(characters / CHARACTERS_PER_TOKEN);

/**
 * What the request carries besides page text, **measured** rather than guessed.
 *
 * Every one of these is a constant string in this repository, so the bound is computed
 * from the strings themselves at module load. A round number here was the review's
 * finding and it was right: `PROMPT_OVERHEAD_TOKENS = 2_000` was a figure somebody
 * chose, and widening the system text or adding a fact key would have moved the real
 * request without moving the price. Now it cannot: adding a key to
 * `FACT_KEY_DEFINITIONS` lengthens the dictionary, which lengthens this, which raises
 * `worstCaseRunCents`, which is what a ceiling compares against.
 */
const FIXED_PROMPT_TOKENS = tokensFor(
  EXTRACTION_SYSTEM_TEXT.length +
    FACT_KEYS.map(key => `- ${key}: ${FACT_KEY_DEFINITIONS[key]}`).join('\n').length +
    JSON.stringify(EXTRACTION_OUTPUT_SCHEMA).length,
);

/**
 * What one page adds besides its text: a `[b12] ` marker on every block and a `SOURCE`
 * line carrying a URL, plus room for the firm's name.
 *
 * Eight tokens a block is generous for `[b100] ` — it is three or four — and three
 * hundred for the URL and the name is generous for a 500-character URL bound. Generous
 * on purpose: this is the term that is *not* a measured constant, because the URL and
 * the firm name are a firm's data rather than ours, so it is the one term where being
 * wrong has to cost headroom rather than correctness.
 */
const PER_PAGE_MARKER_TOKENS = MAX_BLOCKS * 8;
const PER_PAGE_TEXT_TOKENS = 300;

export interface WorstCaseInput {
  readonly modelName: string;
  readonly maxPagesPerFirm: number;
  readonly maxPageBytes: number;
}

/**
 * The most one run of one firm can cost, in whole cents.
 *
 * One message per run, so the input is bounded by the text of every page the run may
 * read. Three things make it a bound rather than an estimate:
 *
 *   * **`maxPagesPerFirm` is the total page count**, not the count of the firm's own
 *     pages. `researchUrlsForFirm` enforces the same number — added links, allow-listed
 *     paths and homepage-discovered links all spend from it — and the adapter enforces
 *     it again. When added links were appended *on top of* this figure, a firm with six
 *     links sent ten pages priced as four.
 *   * **Per page it is `MAX_TEXT_CHARACTERS`, not `max_page_bytes`.** A page is fetched
 *     as bytes and then parsed, and `parsePageText` drops every block past that
 *     character bound, so the extractor is never offered more however large the page
 *     was. Using the larger would give a worst case of about a dollar a run, which at
 *     the default fifty-cent daily ceiling would refuse every run there has ever been.
 *   * **The prompt's own size is measured, not guessed.** `FIXED_PROMPT_TOKENS` is the
 *     system text, the fact dictionary and the serialized output schema, counted at
 *     module load; each page adds `MAX_BLOCKS × 8` tokens of block markers and 300 for
 *     its `SOURCE` URL and the firm's name. Characters per token is 2.5. See
 *     `CHARACTERS_PER_TOKEN`.
 *
 * At the defaults — four pages, twelve thousand characters each — this is 3 cents, so
 * the fifty-cent daily ceiling is 16 runs and the ten-dollar monthly ceiling is 333.
 *
 * This is the number `claimResearchClearance` adds to today's spend before deciding,
 * which is why it must never be optimistic: a provider that reports less afterwards
 * frees budget for the next run, and one that could report more could not have been
 * authorized in the first place.
 */
export function worstCaseRunCents(input: WorstCaseInput): number {
  return centsOf(input.modelName, {
    inputTokens: worstCaseInputTokens(input),
    outputTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
  });
}

/** The input half of the bound, exported so a test can compare a real request with it. */
export function worstCaseInputTokens(input: Omit<WorstCaseInput, 'modelName'>): number {
  const pages = Math.max(1, Math.trunc(input.maxPagesPerFirm));
  const charactersPerPage = Math.min(Math.max(1024, Math.trunc(input.maxPageBytes)), MAX_TEXT_CHARACTERS);
  const perPage = tokensFor(charactersPerPage) + PER_PAGE_MARKER_TOKENS + PER_PAGE_TEXT_TOKENS;
  return FIXED_PROMPT_TOKENS + pages * perPage;
}

/**
 * Whether what a call actually reported is inside the bound the ceiling authorized.
 *
 * Used by the test that would otherwise be the only thing standing between a raised
 * price, a widened prompt or a re-enabled cache and a ceiling that quietly means
 * nothing. The ledger always records the **actual** figure — never truncated to the
 * bound, because a ledger that clipped its own numbers would hide exactly the overrun
 * this function exists to find.
 */
export function withinWorstCase(input: WorstCaseInput, usage: TokenUsage): boolean {
  return centsOf(input.modelName, usage) <= worstCaseRunCents(input);
}
