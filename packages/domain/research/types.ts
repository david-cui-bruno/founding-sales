import type { QueryResultRowLike } from '../db/queryable.ts';

/**
 * The research vocabulary (specification 1.1 invariant 8, 7.4, 15).
 *
 * The same two shapes G3a chose for the CRM, for the same two reasons: section 15
 * wants "stable refusal and hold reason codes", and a refusal has to be a *value*
 * because `runCommand` writes the command receipt in the same transaction as the
 * mutation — a command that threw would roll its own receipt back and the client's
 * retry would find the id free.
 *
 * The codes are deliberately a separate closed set from `CRM_REFUSAL_CODES`. Research
 * refuses for reasons the CRM has never heard of (a ceiling, a disabled provider, a
 * provider that refused) and it must never be able to answer with, say,
 * `opportunity_open_exists` — there is no research path that could produce one.
 */

export const RESEARCH_REFUSAL_CODES = [
  // Configuration and budget (7.4: "capped and audited")
  'research_disabled',
  'provider_unknown',
  'provider_disabled',
  'provider_ceiling_reached',
  'daily_ceiling_reached',
  'cost_ceiling_reached',
  // Provider outcomes
  'provider_refused',
  'source_blocked',
  'no_candidates',
  // Records
  'firm_unknown',
  'firm_merged',
  'firm_suppressed',
  'suggestion_unknown',
  'suggestion_already_reviewed',
  // The versioned policy (7.4, 9.1)
  'policy_missing',
  'policy_version_exists',
  'policy_not_stricter',
  // Authorization (5.2, Appendix G 7)
  'not_assigned',
  'admin_only',
  // Input
  'invalid_input',
] as const;
export type ResearchRefusalCode = (typeof RESEARCH_REFUSAL_CODES)[number];

export type ResearchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ResearchRefusalCode };

export function accept<T>(value: T): ResearchResult<T> {
  return { ok: true, value };
}

export function refuse<T>(reason: ResearchRefusalCode): ResearchResult<T> {
  return { ok: false, reason };
}

/** The three provider kinds a research path may call. Nothing else is approved. */
export const RESEARCH_PROVIDER_KINDS = ['discovery', 'page', 'extraction'] as const;
export type ResearchProviderKind = (typeof RESEARCH_PROVIDER_KINDS)[number];

/** What a suggestion is about (7.4). `duplicate_firm` is deliverable 4's merge hint. */
export const RESEARCH_SUGGESTION_KINDS = [
  'canonical_field',
  'contact',
  'phone_route',
  'email_route',
  'duplicate_firm',
] as const;
export type ResearchSuggestionKind = (typeof RESEARCH_SUGGESTION_KINDS)[number];

export const RESEARCH_SUGGESTION_STATES = ['proposed', 'applied', 'accepted', 'rejected', 'superseded'] as const;
export type ResearchSuggestionState = (typeof RESEARCH_SUGGESTION_STATES)[number];

/**
 * The canonical firm fields a *non-contact* high-confidence fact may fill when they
 * are empty (7.4). Deliberately short, and deliberately without a single field a
 * message, a note or a contact route could occupy: filling one of those without a
 * person is the thing section 7.4 forbids, and the way to make that impossible is
 * for the list not to contain them.
 */
export const FILLABLE_CANONICAL_FIELDS = ['website', 'address_line', 'locality', 'region_code', 'postal_code'] as const;
export type FillableCanonicalField = (typeof FILLABLE_CANONICAL_FIELDS)[number];

const FILLABLE = new Set<string>(FILLABLE_CANONICAL_FIELDS);

export function isFillableCanonicalField(value: string): value is FillableCanonicalField {
  return FILLABLE.has(value);
}

export interface ResearchSettingsRow extends QueryResultRowLike {
  readonly workspace_id: string;
  readonly enabled: boolean;
  readonly daily_page_ceiling: number;
  readonly daily_firm_ceiling: number;
  readonly daily_cost_ceiling_micros: string;
  readonly max_pages_per_firm: number;
  readonly max_page_bytes: number;
}

export interface ResearchProviderRow extends QueryResultRowLike {
  readonly provider_key: string;
  readonly kind: ResearchProviderKind;
  readonly display_name: string;
  readonly enabled: boolean;
  readonly cost_per_call_micros: string;
  readonly daily_call_ceiling: number;
  readonly terms_allow_retention: boolean;
  readonly retention_days: number | null;
}

export interface ResearchRoutePolicyRow extends QueryResultRowLike {
  readonly id: string;
  readonly version: string;
  readonly minimum_association_confidence: string;
  readonly require_technical_validation: boolean;
  readonly trusted_sources: readonly string[];
  readonly note: string | null;
  readonly effective_from: Date;
}

export interface ResearchPageRow extends QueryResultRowLike {
  readonly id: string;
  readonly provider_key: string;
  readonly query_hash: string;
  readonly page_hash: string;
  readonly outcome: 'running' | 'completed' | 'refused' | 'failed';
  readonly refusal_code: string | null;
  readonly candidate_count: number;
  readonly firms_created: number;
  readonly evidence_recorded: number;
  readonly cost_micros: string;
}

export interface ResearchFirmRunRow extends QueryResultRowLike {
  readonly id: string;
  readonly firm_id: string;
  readonly revision: number;
  readonly outcome: 'running' | 'completed' | 'refused' | 'failed';
  readonly refusal_code: string | null;
  readonly evidence_recorded: number;
  readonly suggestions_created: number;
  readonly routes_promoted: number;
  readonly cost_micros: string;
}

export interface ResearchSuggestionRow extends QueryResultRowLike {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly kind: ResearchSuggestionKind;
  readonly field_key: string | null;
  readonly proposed_value: string;
  readonly confidence: string | null;
  readonly provider_key: string;
  readonly evidence_id: string | null;
  readonly duplicate_firm_id: string | null;
  readonly dedupe_key: string;
  readonly state: ResearchSuggestionState;
}

/** `numeric` arrives as a string from `pg`; this is the one place that is undone. */
export function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
