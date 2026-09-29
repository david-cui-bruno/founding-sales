/**
 * The research vocabulary.
 *
 * The same shape as `CrmResult` and `TodayResult`, and for the same reason: a refusal
 * is a value the command receipt can record, never an exception that would roll the
 * receipt back with the mutation.
 */

export const RESEARCH_REFUSAL_CODES = [
  'invalid_input',
  // The workspace turned research off.
  'research_disabled',
  // The three ceilings, each named separately so a person can see which one bound.
  'daily_firm_ceiling',
  'daily_cost_ceiling',
  'monthly_cost_ceiling',
  // The firm.
  'firm_unknown',
  'firm_merged',
  'firm_suppressed',
  'not_assigned',
  'admin_only',
  // A run for this firm is already open and younger than half an hour.
  'run_in_progress',
  // The firm publishes no website and nobody has added a link.
  'no_sources',
  // The page fetch or the extraction failed. The run records it and the job retries.
  'provider_failure',
  // The URL a person offered is not one research may read.
  'link_not_permitted',
  // The model named in the settings has no reviewed price row.
  'model_unpriced',
  /**
   * The money would not stretch to this call, and no ceiling on cents is what bound it.
   *
   * Two places answer it, and they are the same fact at two moments: the clearance,
   * when the firm already holds its three reservations for the business date, and
   * chunk 3, when the exact token count of the request does not fit the reservation
   * being held for it. Neither is a failure and neither costs anything.
   */
  'over_budget',
] as const;
export type ResearchRefusalCode = (typeof RESEARCH_REFUSAL_CODES)[number];

export type ResearchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ResearchRefusalCode };

export const accept = <T>(value: T): ResearchResult<T> => ({ ok: true, value });
export const refuse = <T>(reason: ResearchRefusalCode): ResearchResult<T> => ({ ok: false, reason });

/** The triggers `research_runs_trigger_known` admits. */
export const RESEARCH_TRIGGERS = ['firm_created', 'sweep', 'user_request', 'link_added'] as const;
export type ResearchTrigger = (typeof RESEARCH_TRIGGERS)[number];

export const RESEARCH_OUTCOMES = ['running', 'completed', 'refused', 'failed'] as const;
export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

/**
 * The provider key every page fetch records evidence under, and the one the ledger
 * counts. `evidence_items_provider_shape` and `provider_ledger_provider_key_shape`
 * accept the same shape, so the evidence and the money name the provider identically.
 */
export const COMPANY_PAGE_PROVIDER = 'company_page';

/** The extraction provider's ledger key. Separate, because it is the one that costs. */
export const EXTRACTION_PROVIDER = 'anthropic_extraction';
