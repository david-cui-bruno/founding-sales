import type { Generated } from 'kysely';

export type StoredBoolean = 0 | 1;
export type LifecycleStage =
  | 'unreviewed'
  | 'ready'
  | 'contacted'
  | 'interviewed'
  | 'offered'
  | 'won'
  | 'lost_nurture';
export type WorkflowStatus = 'active' | 'onboarding' | 'closed';
export type FitBand = 'low' | 'medium' | 'high';
export type TimingBand = 'cold' | 'warm' | 'hot';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
export type Reachability = 'direct' | 'indirect' | 'none';
export type ReactivationRuleType =
  | 'seasonal:heating-oct1'
  | 'new-frbo-listing'
  | 'lead-cert-expiry-window'
  | 'manual';

export type PersonsTable = {
  id: string;
  display_name: string;
  aliases_json: string;
  opted_out: Generated<StoredBoolean>;
  opted_out_at: string | null;
  never_record: Generated<StoredBoolean>;
  deleted_at: string | null;
  provenance_json: string | null;
  version: Generated<number>;
  created_at: string;
  updated_at: string;
};

export type PersonContactMethodsTable = {
  id: string;
  person_id: string;
  kind: 'phone' | 'email';
  normalized_value: string;
  raw_value: string | null;
  validation_state: 'unverified' | 'valid' | 'invalid';
  reachability: Reachability;
  is_primary: StoredBoolean;
  in_contacts: StoredBoolean | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationsTable = {
  id: string;
  canonical_name: string;
  source_record_json: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationAliasesTable = {
  id: string;
  organization_id: string;
  alias: string;
  created_at: string;
};

export type PropertiesTable = {
  id: string;
  organization_id: string | null;
  address_line_1: string;
  address_line_2: string | null;
  locality: string;
  region: string;
  postal_code: string | null;
  country_code: string;
  door_count: number | null;
  property_type: string | null;
  maintenance_profile_json: string | null;
  source_record_json: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SourceEventsTable = {
  id: string;
  person_id: string;
  prospect_id: string | null;
  sales_cycle_id: string | null;
  channel: 'frbo' | 'registry' | 'rireig' | 'referral' | 'inbound_demo' | 'community' | 'custom';
  observed_at: string;
  source_record_json: string;
  evidence_ref: string | null;
  referred_by_person_id: string | null;
  referrer_unknown_reason: string | null;
  created_at: string;
};

export type SourceIntakeReceiptsTable = {
  source_event_id: string;
  person_id: string;
  prospect_id: string;
  command_json: string;
  result_json: string;
  created_at: string;
};

export type ProspectsTable = {
  id: string;
  person_id: string;
  original_source_event_id: string;
  segment: 'hot_frbo' | 'cold_registry' | 'warm';
  qualification_state: 'unreviewed' | 'eligible' | 'disqualified' | 'merge_review';
  qualification_reason: string | null;
  last_contact_at: string | null;
  version: Generated<number>;
  created_at: string;
  updated_at: string;
};

export type ProspectOrganizationsTable = {
  prospect_id: string;
  organization_id: string;
  relationship: string | null;
  created_at: string;
};

export type ProspectPropertiesTable = {
  prospect_id: string;
  property_id: string;
  relationship: string | null;
  created_at: string;
};

export type CadenceDefinitionsTable = {
  id: string;
  family: string;
  version: number;
  name: string;
  content_hash: string;
  attempt_cap: number;
  definition_json: string;
  created_at: string;
};

export type CadenceStepsTable = {
  id: string;
  cadence_definition_id: string;
  sequence: number;
  day_offset: number;
  label: string;
  breakup: StoredBoolean;
  step_json: string;
  created_at: string;
};

export type CadenceActionComponentsTable = {
  id: string;
  cadence_step_id: string;
  sequence: number;
  action_type: string;
  channel: string | null;
  condition_json: string | null;
  outcome_graph_json: string;
  template_json: string | null;
  created_at: string;
};

export type SalesCyclesTable = {
  id: string;
  person_id: string;
  prospect_id: string;
  entry_source_event_id: string;
  stage: LifecycleStage;
  workflow_status: WorkflowStatus;
  current_next_action_id: string | null;
  stage_entered_at: string;
  design_partner_fitness: number | null;
  close_reason: string | null;
  close_notes: string | null;
  onboarding_stop_reason: string | null;
  closed_at: string | null;
  version: Generated<number>;
  created_at: string;
  updated_at: string;
};

export type NextActionsTable = {
  id: string;
  sales_cycle_id: string;
  action_type: string;
  channel: string | null;
  status: 'pending' | 'completed' | 'cancelled' | 'impossible';
  due_at: string;
  timezone: string;
  allowed_window: string | null;
  cadence_enrollment_id: string | null;
  cadence_step_id: string | null;
  cadence_component_id: string | null;
  completion_activity_id: string | null;
  created_at: string;
  completed_at: string | null;
};

export type CadenceEnrollmentsTable = {
  id: string;
  sales_cycle_id: string;
  cadence_definition_id: string;
  status: 'active' | 'completed' | 'stopped';
  anchor_at: string;
  current_step_id: string | null;
  scheduled_step_count: number;
  stop_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivitiesTable = {
  id: string;
  person_id: string;
  prospect_id: string | null;
  sales_cycle_id: string | null;
  cadence_enrollment_id: string | null;
  cadence_step_id: string | null;
  cadence_component_id: string | null;
  kind: string;
  direction: 'inbound' | 'outbound' | 'internal';
  channel: string;
  occurred_at: string;
  duration_seconds: number | null;
  observed_outcome: string | null;
  adapter: string | null;
  provider_idempotency_key: string | null;
  provider_reference: string | null;
  consent_policy_record_id: string | null;
  recording_storage_ref: string | null;
  transcript_storage_ref: string | null;
  metadata_json: string;
  created_at: string;
};

export type ActivityAmendmentsTable = {
  id: string;
  activity_id: string;
  amendment_kind: string;
  correction_json: string;
  reason: string;
  created_at: string;
};

export type StageEventsTable = {
  id: string;
  sales_cycle_id: string;
  from_stage: LifecycleStage | null;
  to_stage: LifecycleStage;
  effective_at: string;
  confirmed_at: string;
  confirmation_kind: 'mechanical' | 'founder' | 'backfill';
  backfill_provenance_json: string | null;
  created_at: string;
};

export type ConsentPolicyRecordsTable = {
  id: string;
  person_id: string;
  activity_id: string | null;
  policy_kind: 'recording' | 'cloud_processing' | 'outbound';
  policy_version: string;
  effective_at: string;
  decision: 'granted' | 'denied' | 'not_required' | 'unknown';
  evidence_json: string;
  created_at: string;
};

export type ReactivationRulesTable = {
  id: string;
  sales_cycle_id: string;
  rule_type: ReactivationRuleType;
  due_at: string | null;
  matcher_json: string | null;
  version: number;
  consumed_at: string | null;
  created_at: string;
};

export type WonTermsTable = {
  sales_cycle_id: string;
  doors_committed: number;
  billing_model: 'per_door_monthly' | 'flat_monthly' | 'manual_projected_monthly';
  unit_rate_cents: number;
  projected_mrr_cents: number;
  projection_formula_version: string;
  manual_projection_reason: string | null;
  founding_customer: StoredBoolean;
  effective_at: string;
  created_at: string;
};

export type SalesCycleCloseReadinessTable = {
  sales_cycle_id: string;
  pain_confirmed: StoredBoolean;
  decision_authority_confirmed: StoredBoolean;
  concrete_trial_identified: StoredBoolean;
  readiness_json: string;
  assessed_at: string;
  updated_at: string;
};

export type TriggerEventsTable = {
  id: string;
  prospect_id: string;
  source_event_id: string;
  trigger_type: string;
  effective_at: string;
  expires_at: string | null;
  strength_multiplier: number;
  verification_state: 'verified' | 'unverified';
  evidence_json: string;
  created_at: string;
};

export type PrioritizationRuleVersionsTable = {
  id: string;
  version: number;
  content_hash: string;
  rules_json: string;
  created_at: string;
};

export type PrioritizationEvaluationsTable = {
  id: string;
  prospect_id: string;
  rule_version_id: string;
  evaluated_at: string;
  fit_points: number;
  fit_band: FitBand;
  timing_millipoints: number;
  timing_band: TimingBand;
  reachability: Reachability;
  data_confidence: number;
  priority: Priority;
  earliest_trigger_expires_at: string | null;
  verify_first: StoredBoolean;
  explanation_json: string;
  created_at: string;
};

export type ProspectPriorityProjectionTable = {
  prospect_id: string;
  rule_version_id: string;
  evaluation_id: string;
  fit_points: number;
  fit_band: FitBand;
  timing_millipoints: number;
  timing_band: TimingBand;
  reachability: Reachability;
  data_confidence: number;
  priority: Priority;
  earliest_trigger_expires_at: string | null;
  verify_first: StoredBoolean;
  version: Generated<number>;
  evaluated_at: string;
  updated_at: string;
};

export type PriorityOverridesTable = {
  id: string;
  prospect_id: string;
  override_kind: 'priority' | 'pin_to_top' | 'snooze' | 'dismiss';
  priority: Priority | null;
  reason: string;
  expires_at: string;
  created_at: string;
};

export type OptOutTombstonesTable = {
  id: string;
  person_id: string;
  requested_at: string;
  observed_channel: string;
  source_activity_id: string | null;
  evidence_ref: string | null;
  policy_version: string;
  created_at: string;
};

export type OptOutHandlesTable = {
  id: string;
  tombstone_id: string;
  kind: 'phone' | 'email';
  normalized_value: string;
  created_at: string;
};

export type WorkspaceSettingsTable = {
  singleton: number;
  timezone: string;
  daily_dial_capacity: number;
  daily_conversation_target: number;
  exploration_slots: number;
  resurface_suppression_days: number;
  active_prioritization_rule_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainTables = {
  activities: ActivitiesTable;
  activity_amendments: ActivityAmendmentsTable;
  cadence_action_components: CadenceActionComponentsTable;
  cadence_definitions: CadenceDefinitionsTable;
  cadence_enrollments: CadenceEnrollmentsTable;
  cadence_steps: CadenceStepsTable;
  consent_policy_records: ConsentPolicyRecordsTable;
  next_actions: NextActionsTable;
  opt_out_handles: OptOutHandlesTable;
  opt_out_tombstones: OptOutTombstonesTable;
  organization_aliases: OrganizationAliasesTable;
  organizations: OrganizationsTable;
  persons: PersonsTable;
  person_contact_methods: PersonContactMethodsTable;
  prioritization_evaluations: PrioritizationEvaluationsTable;
  prioritization_rule_versions: PrioritizationRuleVersionsTable;
  priority_overrides: PriorityOverridesTable;
  properties: PropertiesTable;
  prospects: ProspectsTable;
  prospect_organizations: ProspectOrganizationsTable;
  prospect_priority_projection: ProspectPriorityProjectionTable;
  prospect_properties: ProspectPropertiesTable;
  reactivation_rules: ReactivationRulesTable;
  sales_cycles: SalesCyclesTable;
  sales_cycle_close_readiness: SalesCycleCloseReadinessTable;
  source_events: SourceEventsTable;
  source_intake_receipts: SourceIntakeReceiptsTable;
  stage_events: StageEventsTable;
  trigger_events: TriggerEventsTable;
  workspace_settings: WorkspaceSettingsTable;
  won_terms: WonTermsTable;
};
