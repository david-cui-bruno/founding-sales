import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The CRM commands' shared vocabulary (specification 7.2, 7.3, 8.1, 15).
 *
 * Section 15 asks for "stable refusal and hold reason codes". These are the CRM's;
 * a command never invents a string outside this set, and a caller may switch on the
 * code while the message stays a matter for a person.
 *
 * A command answers `CrmResult`. It does not throw for a refusal: a refusal is an
 * ordinary outcome that the command middleware records in its receipt, and throwing
 * would roll the receipt back with the mutation.
 */

export const CRM_REFUSAL_CODES = [
  // Records
  'firm_unknown',
  'firm_merged',
  'contact_unknown',
  'contact_merged',
  'route_unknown',
  'route_retired',
  'evidence_unknown',
  // Authorization (Appendix G 7)
  'not_assigned',
  'admin_only',
  'assignee_unknown',
  // Pipeline
  'stage_unknown',
  'stage_retired',
  // Stage administration (8.1: "rename, reorder, add, or retire *nonterminal* stages")
  'stage_key_exists',
  'stage_terminal',
  'stage_last_active',
  'opportunity_unknown',
  'opportunity_closed',
  'opportunity_open_exists',
  'opportunity_not_closed',
  'lost_reason_required',
  // Zone (section 9.2)
  'zone_unresolved',
  // Merges
  'merge_same_record',
  'merge_cross_firm',
  'merge_conflicts',
  'merge_already_performed',
  // Input
  'invalid_input',
] as const;
export type CrmRefusalCode = (typeof CRM_REFUSAL_CODES)[number];

/** A canonical value the two records disagree about, shown for resolution (7.2). */
export interface MergeConflict {
  readonly field: string;
  readonly source: string | null;
  readonly target: string | null;
}

export type CrmResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: CrmRefusalCode;
      /** Present only for `merge_conflicts`: the fields a person has to decide. */
      readonly conflicts?: readonly MergeConflict[];
    };

export function accept<T>(value: T): CrmResult<T> {
  return { ok: true, value };
}

export function refuse<T>(reason: CrmRefusalCode): CrmResult<T> {
  return { ok: false, reason };
}

export function refuseWithConflicts<T>(conflicts: readonly MergeConflict[]): CrmResult<T> {
  return { ok: false, reason: 'merge_conflicts', conflicts };
}

/** The four eligibility states of a route (7.2, 9.1). */
export const ROUTE_ELIGIBILITIES = ['candidate', 'usable', 'invalid', 'retired'] as const;
export type RouteEligibility = (typeof ROUTE_ELIGIBILITIES)[number];

export const ROUTE_KINDS = ['phone', 'email'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export const TECHNICAL_VALIDATIONS = ['unknown', 'passed', 'failed'] as const;
export type TechnicalValidation = (typeof TECHNICAL_VALIDATIONS)[number];

export const ROUTE_SOURCES = ['research_provider', 'salesperson', 'import', 'website', 'reply'] as const;
export type RouteSource = (typeof ROUTE_SOURCES)[number];

export const CONTROL_MODES = ['automated', 'manual'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** A firm as the repositories read it back. Column names, because that is what it is. */
export interface FirmRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly assigned_user_id: string | null;
  readonly website: string | null;
  readonly address_line: string | null;
  readonly locality: string | null;
  readonly region_code: string | null;
  readonly postal_code: string | null;
  readonly country_code: string;
  readonly time_zone: string | null;
  readonly time_zone_confidence: 'high' | 'medium' | null;
  readonly time_zone_source: string | null;
  readonly time_zone_rule_version: string | null;
  readonly time_zone_unresolved_reason: string | null;
  readonly status: 'active' | 'merged';
  readonly merged_into_firm_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly [column: string]: unknown;
}

export interface ContactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly firm_id: string;
  readonly full_name: string;
  readonly title: string | null;
  readonly linkedin_url: string | null;
  readonly status: 'active' | 'inactive' | 'merged';
  readonly is_primary: boolean;
  readonly merged_into_contact_id: string | null;
  readonly [column: string]: unknown;
}

export interface OpportunityRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly firm_id: string;
  readonly stage_id: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly control_mode: ControlMode;
  readonly control_mode_reason: string | null;
  readonly close_reason: string | null;
  readonly [column: string]: unknown;
}

export interface RouteRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly source: RouteSource;
  readonly association_confidence: string | null;
  readonly technical_validation: TechnicalValidation;
  readonly eligibility: RouteEligibility;
  readonly eligibility_policy_version: string | null;
  readonly version: number;
  readonly [column: string]: unknown;
}

export interface PipelineStageRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly key: string;
  readonly display_name: string;
  readonly position: number;
  readonly terminal_kind: 'won' | 'lost' | null;
  readonly retired: boolean;
  readonly [column: string]: unknown;
}

/** The actor's user id, or null when the scope is the worker's or the scheduler's. */
export function actorUserId(context: RepositoryContext): string | null {
  return context.scope.actor.kind === 'user' ? context.scope.actor.userId : null;
}

/** `audit_events.actor_kind` for this scope. */
export function actorKind(context: RepositoryContext): 'user' | 'admin' | 'system' | 'worker' {
  const actor = context.scope.actor;
  if (actor.kind === 'user') return actor.role === 'admin' ? 'admin' : 'user';
  return actor.component === 'worker' ? 'worker' : 'system';
}
