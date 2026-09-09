import type { Generated } from 'kysely';
import type { DiscoveryAssessment, DiscoveryOverride } from '../../shared/contracts/discoveryContract';

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
export type QualificationGateReasonCode =
  | 'out_of_area'
  | 'no_relevant_decision_relationship'
  | 'institutional_outside_icp'
  | 'harmful_operator'
  | 'non_paying_operator'
  | 'unresolved_duplicate';
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
  dnc_listed: StoredBoolean;
  tcpa_flag: StoredBoolean;
  federal_status: 'unknown' | 'verified_clear' | 'listed';
  compliance_tcpa_flag: StoredBoolean | null;
  covered_area_code: string | null;
  compliance_source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
  scrubbed_at: string | null;
  compliance_expires_at: string | null;
  source_label: string | null;
  vendor_rank: number | null;
  phone_kind: 'mobile' | 'landline' | 'voip' | 'other' | null;
  ownership_state: 'verified_person' | 'vendor_candidate' | 'conflicting_identity' | 'unknown';
  evidence_observed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactComplianceAuditEventsTable = {
  id: string;
  contact_method_id: string;
  operation: 'intake_merge' | 'authoritative_correction' | 'legacy_backfill';
  old_evidence_json: string;
  new_evidence_json: string;
  source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
  evidence_timestamp: string | null;
  evidence_ref: string | null;
  policy_version: string;
  resulting_reason_code: string;
  resulting_call_reason_code: string | null;
  resulting_text_reason_code: string | null;
  created_at: string;
};

export type PersonOutboundJurisdictionsTable = {
  person_id: string;
  region_code: string;
  timezone: string;
  source: 'property_address' | 'residence_evidence' | 'manual_review';
  evidence_ref: string | null;
  effective_at: string;
  review_at: string | null;
  updated_at: string;
};

export type OutboundJurisdictionClearancesTable = {
  region_code: string;
  channel: 'call' | 'text';
  decision: 'unknown' | 'allowed' | 'blocked';
  registration_confirmed: StoredBoolean | null;
  state_dnc_subscription_confirmed: StoredBoolean | null;
  consent_rule_confirmed: StoredBoolean | null;
  source: string;
  effective_at: string;
  expires_at: string | null;
  updated_at: string;
};

export type OutboundJurisdictionAuditEventsTable = {
  id: string;
  subject_kind: 'person_jurisdiction' | 'state_clearance';
  subject_key: string;
  old_value_json: string | null;
  new_value_json: string;
  source: string;
  effective_at: string;
  created_at: string;
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
  channel: 'frbo' | 'registry' | 'rireig' | 'referral' | 'inbound_demo' | 'community' | 'custom'
    | 'parcel' | 'deed' | 'permit' | 'violation';
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
  segment: 'hot' | 'cold' | 'warm';
  qualification_state: 'unreviewed' | 'eligible' | 'disqualified' | 'merge_review';
  qualification_gate_reason: QualificationGateReasonCode | null;
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
  resurface_at: string | null;
  resurface_reason: 'snooze' | 'callback' | null;
  version: Generated<number>;
  created_at: string;
  updated_at: string;
};

export type NextActionsTable = {
  due_at: string;
  due_source: 'legacy_unscheduled' | 'recorded_callback' | 'founder_resurface' | 'playbook_v1' | 'internal_review';
  id: string;
  sales_cycle_id: string;
  action_type: string;
  channel: string | null;
  status: 'pending' | 'completed' | 'cancelled' | 'impossible';
  timezone: string;
  allowed_window: string | null;
  work_intent: 'internal_review' | 'inbound_response' | 'promised_follow_up' | 'discretionary_prospecting';
  inbound_sla_kind: 'inbound_demo_permitted_minutes' | 'direct_referral_elapsed' | null;
  inbound_sla_due_at: string | null;
  inbound_sla_source_event_id: string | null;
  inbound_sla_provenance_json: string | null;
  cadence_enrollment_id: string | null;
  cadence_step_id: string | null;
  cadence_component_id: string | null;
  completion_activity_id: string | null;
  settlement_json: string | null;
  version: Generated<number>;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
};

export type CadenceEnrollmentsTable = {
  id: string;
  sales_cycle_id: string;
  cadence_definition_id: string;
  status: 'active' | 'completed' | 'stopped';
  anchor_at: string;
  current_step_id: string | null;
  scheduled_step_count: number;
  mode: 'standard' | 'inbound_over_cap_response';
  allowed_step_ids_json: string | null;
  version: Generated<number>;
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
  note_text: string | null;
  call_outcome:
    | 'no_answer'
    | 'voicemail'
    | 'spoke'
    | 'interview_booked'
    | 'not_interested'
    | 'opted_out'
    | null;
  callback_at: string | null;
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
  transition_sequence: number;
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

export type CycleReactivationReceiptsTable = {
  activation_key: string;
  activation_kind: 'rule' | 'inbound_response';
  person_id: string;
  source_cycle_id: string;
  reactivation_rule_id: string | null;
  source_event_id: string | null;
  new_cycle_id: string;
  command_json: string;
  result_json: string;
  created_at: string;
};

export type LifecycleReviewItemsTable = {
  id: string;
  activation_key: string;
  status: 'open' | 'resolved';
  person_id: string;
  prospect_id: string;
  source_cycle_id: string;
  reactivation_rule_id: string | null;
  source_event_id: string | null;
  reason: string;
  payload_json: string;
  resolution_json: string | null;
  resolved_at: string | null;
  version: Generated<number>;
  created_at: string;
  updated_at: string;
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
  version: Generated<number>;
  assessed_at: string;
  updated_at: string;
};

export type TriggerEventsTable = {
  id: string;
  prospect_id: string;
  source_event_id: string | null;
  reactivation_receipt_activation_key: string | null;
  reactivation_rule_id: string | null;
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
  decision_kind: 'evaluated' | 'not_prioritizable';
  evaluated_at: string;
  fit_points: number | null;
  fit_band: FitBand | null;
  timing_millipoints: number | null;
  timing_band: TimingBand | null;
  reachability: Reachability | null;
  data_confidence: number | null;
  priority: Priority | null;
  earliest_trigger_expires_at: string | null;
  verify_first: StoredBoolean | null;
  last_contact_activity_id: string | null;
  last_contact_at: string | null;
  qualification_json: string | null;
  command_json: string;
  input_snapshot_json: string;
  result_json: string;
  explanation_json: string;
  created_at: string;
};

export type ProspectPriorityProjectionTable = {
  prospect_id: string;
  rule_version_id: string;
  evaluation_id: string;
  decision_kind: Generated<'evaluated'>;
  fit_points: number;
  fit_band: FitBand;
  timing_millipoints: number;
  timing_band: TimingBand;
  reachability: Reachability;
  data_confidence: number;
  priority: Priority;
  earliest_trigger_expires_at: string | null;
  verify_first: StoredBoolean;
  last_contact_activity_id: string | null;
  last_contact_at: string | null;
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
  status: Generated<'active' | 'expired'>;
  expired_at: string | null;
};

export type PrioritizationPreferenceEventsTable = {
  id: string;
  control_id: string | null;
  controlled_prospect_id: string | null;
  action_kind:
    | 'acted_out_of_order'
    | 'snoozed'
    | 'dismissed'
    | 'reordered'
    | 'priority_overridden'
    | 'pinned';
  winner_prospect_id: string;
  winner_evaluation_id: string;
  winner_decision_kind: Generated<'evaluated'>;
  loser_prospect_id: string;
  loser_evaluation_id: string;
  loser_decision_kind: Generated<'evaluated'>;
  observed_at: string;
  context_json: string;
  created_at: string;
};

export type OptOutTombstonesTable = {
  id: string;
  person_id: string;
  requested_at: string;
  observed_channel: 'manual' | 'imessage' | 'gmail' | 'call' | 'identity_propagation';
  source_activity_id: string;
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

export type OptOutClosureReceiptsTable = {
  source_activity_id: string;
  operation_kind: 'apply' | 'propagate';
  person_id: string;
  tombstone_id: string;
  source_tombstone_id: string | null;
  closed_cycle_id: string | null;
  terminal_stage_event_id: string | null;
  command_json: string;
  result_json: string;
  created_at: string;
};

export type OptOutClosureReceiptHandlesTable = {
  source_activity_id: string;
  tombstone_id: string;
  handle_id: string;
  sequence: number;
};

export type BackupReceiptsTable = {
  id: string;
  backup_basename: string;
  kind: 'daily' | 'manual' | 'pre_release';
  schema_version: number;
  sha256: string;
  size_bytes: number;
  created_at: string;
  verified_at: string;
};

export type RecoveryReadinessTable = {
  singleton: number;
  recovery_setup_completed_at: string | null;
  last_restore_drill_at: string | null;
  last_restore_backup_sha256: string | null;
  updated_at: string;
};

export type IdentityRepairEventsTable = {
  id: string;
  manifest_sha256: string;
  candidate_id: string;
  canonical_person_id: string;
  created_person_ids_json: string;
  reassigned_source_event_ids_json: string;
  applied_at: string;
};

export type ReviewPositionTable = {
  singleton: number;
  position: number;
  updated_at: string;
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

export type DiscoveryAssessmentsTable = {
  id: string; person_id: string; prospect_id: string; sales_cycle_id: string;
  fingerprint: string; policy_version: DiscoveryAssessment['policyVersion']; rule_version_id: string;
  model_version: string | null; evaluated_at: string; expires_at: string; local_date: string;
  override_id: string | null; disposition: DiscoveryAssessment['disposition']; assessment_json: string;
};
export type DiscoveryCurrentTable = {
  prospect_id: string; assessment_id: string; version: number;
};
export type DiscoveryOverridesTable = {
  id: string; assessment_id: string; person_id: string; prospect_id: string; sales_cycle_id: string;
  fingerprint: string; decision: DiscoveryOverride['decision']; reason: string; created_at: string;
};
export type DiscoveryPreparationsTable = {
  id: string; assessment_id: string; person_id: string; prospect_id: string; sales_cycle_id: string;
  fingerprint: string; action_id: string; request_json: string; receipt_json: string;
};
export type DiscoveryScanStateTable = {
  singleton: 1; cursor: string | null; last_complete_scan_at: string | null; last_complete_local_date: string | null;
};

export type DomainTables = {
  discovery_assessments: DiscoveryAssessmentsTable;
  discovery_current: DiscoveryCurrentTable;
  discovery_overrides: DiscoveryOverridesTable;
  discovery_preparations: DiscoveryPreparationsTable;
  discovery_scan_state: DiscoveryScanStateTable;
  activities: ActivitiesTable;
  activity_amendments: ActivityAmendmentsTable;
  backup_receipts: BackupReceiptsTable;
  cadence_action_components: CadenceActionComponentsTable;
  cadence_definitions: CadenceDefinitionsTable;
  cadence_enrollments: CadenceEnrollmentsTable;
  cadence_steps: CadenceStepsTable;
  consent_policy_records: ConsentPolicyRecordsTable;
  cycle_reactivation_receipts: CycleReactivationReceiptsTable;
  identity_repair_events: IdentityRepairEventsTable;
  lifecycle_review_items: LifecycleReviewItemsTable;
  next_actions: NextActionsTable;
  opt_out_closure_receipt_handles: OptOutClosureReceiptHandlesTable;
  opt_out_closure_receipts: OptOutClosureReceiptsTable;
  opt_out_handles: OptOutHandlesTable;
  opt_out_tombstones: OptOutTombstonesTable;
  outbound_jurisdiction_audit_events: OutboundJurisdictionAuditEventsTable;
  outbound_jurisdiction_clearances: OutboundJurisdictionClearancesTable;
  organization_aliases: OrganizationAliasesTable;
  organizations: OrganizationsTable;
  persons: PersonsTable;
  person_contact_methods: PersonContactMethodsTable;
  person_outbound_jurisdictions: PersonOutboundJurisdictionsTable;
  contact_compliance_audit_events: ContactComplianceAuditEventsTable;
  prioritization_evaluations: PrioritizationEvaluationsTable;
  prioritization_preference_events: PrioritizationPreferenceEventsTable;
  prioritization_rule_versions: PrioritizationRuleVersionsTable;
  priority_overrides: PriorityOverridesTable;
  properties: PropertiesTable;
  prospects: ProspectsTable;
  prospect_organizations: ProspectOrganizationsTable;
  prospect_priority_projection: ProspectPriorityProjectionTable;
  prospect_properties: ProspectPropertiesTable;
  reactivation_rules: ReactivationRulesTable;
  recovery_readiness: RecoveryReadinessTable;
  review_position: ReviewPositionTable;
  sales_cycles: SalesCyclesTable;
  sales_cycle_close_readiness: SalesCycleCloseReadinessTable;
  source_events: SourceEventsTable;
  source_intake_receipts: SourceIntakeReceiptsTable;
  stage_events: StageEventsTable;
  trigger_events: TriggerEventsTable;
  workspace_settings: WorkspaceSettingsTable;
  won_terms: WonTermsTable;
};

/** Schema20 account storage. JSON columns are parsed by strict account contracts. */
export type PmAccountTables = {
  pm_accounts: { id: string; name: string; domain: string | null; version: number; created_at: string; updated_at: string };
  pm_account_commands: { command_id: string; account_id: string; fingerprint: string; result_json: string; account_version: number; created_at: string };
  pm_account_sources: { id: string; account_id: string; source_key: string; url: string; fetched_at: string; sha256: string; excerpt: string; permitted: 1; admitted_at: string };
  pm_account_claims: { id: string; account_id: string; claim_json: string; admitted_at: string };
  pm_account_claim_evidence: { account_id: string; claim_id: string; source_id: string };
  pm_account_routes: { id: string; account_id: string; version: number; person_id: string | null;
    channel: 'phone' | 'email' | 'linkedin'; value: string; purpose: 'business' | 'tenant_emergency' | 'unknown';
    verification: 'published' | 'confirmed' | 'unverified'; admitted_at: string };
  pm_account_route_evidence: { account_id: string; route_id: string; route_version: number; source_id: string };
  pm_account_links: { id: string; account_id: string; kind: 'organization' | 'person_role' | 'property';
    organization_id: string | null; person_id: string | null; property_id: string | null; relationship: string;
    role: string | null; authority: 'confirmed' | 'unconfirmed' | null; valid_from: string; valid_to: string | null; admitted_at: string };
  pm_account_link_evidence: { account_id: string; link_id: string; source_id: string; purpose: 'relationship' | 'authority' };
  pm_account_research_jobs: { id: string; account_id: string; command_id: string; fingerprint: string; limits_json: string;
    state: 'queued' | 'running' | 'completed' | 'parked'; attempt: number; claim_token: string | null;
    reserved_cost_micros: number; cost_micros: number | null; receipt_command_id: string | null; created_at: string; updated_at: string };
  pm_account_outbound_intents: { command_id: string; account_id: string; route_id: string; route_version: number;
    account_version: number; evidence_fingerprint: string; command_fingerprint: string; attempt_id: string;
    channel: 'call' | 'email'; canonical_target: string; context_revision: string; created_at: string };
  pm_account_outbound_results: { id: string; command_id: string; attempt_id: string; account_id: string;
    kind: 'dispatch' | 'call_outcome' | 'reconciliation'; outcome: string; result_json: string; created_at: string };
};

/** Schema21 local-only storage. JSON is admitted through strict feature schemas, never executed. */
export type DelegationTables = {
  meeting_first_call_settings: { singleton: number; new_call_slots: number | null; total_call_capacity: number | null; revision: number; updated_at: string };
  delegated_authorities: { account_id: string; workspace_id: string; owner: string; generation: number; state: string; aggregate_version: number; updated_at: string; };
  delegated_commands: { command_id: string; workspace_id: string; account_id: string; fingerprint: string; command_json: string; receipt_json: string; created_at: string; };
  delegated_applied_events: { id: string; workspace_id: string; account_id: string; stream: string; aggregate_version: number; authority_generation: number; fingerprint: string; event_json: string; applied_at: string; };
  delegated_event_cursors: { workspace_id: string; account_id: string; stream: string; aggregate_version: number; event_id: string; };
  delegated_approvals: { id: string; workspace_id: string; account_id: string; route_id: string; route_version: number; permission_evidence_id: string; fingerprint: string; snapshot_json: string; approved_at: string; };
  delegated_action_outcomes: { event_id: string; workspace_id: string; account_id: string; action_id: string; authority_generation: number; state: string; content_hash: string; target_hash: string; observed_at: string; evidence_ref: string; };
  delegated_manual_outcomes: { event_id: string; workspace_id: string; account_id: string; action_id: string; channel: string; outcome_json: string; observed_at: string; };
  delegated_threads: { workspace_id: string; account_id: string; id: string; provider: string; provider_thread_id: string; revision: number; context_revision: string; projection_json: string; updated_at: string; };
  delegated_meetings: { workspace_id: string; account_id: string; id: string; provider: string; provider_event_id: string; revision: number; state: string; projection_json: string; updated_at: string; };
  delegated_reconciliation: { id: string; workspace_id: string; account_id: string; action_id: string; event_id: string; evidence_ref: string; observed_at: string; };
  pm_account_route_policy_receipts: { id: string; account_id: string; route_id: string; route_version: number; canonical_target: string; evidence_fingerprint: string; revision: number; evidence_ref: string; provenance: string; observed_at: string; admitted_at: string; effective_at: string; expires_at: string; policy_json: string; receipt_fingerprint: string; };
  pm_account_route_policy_evidence: { account_id: string; route_id: string; route_version: number; receipt_id: string; source_id: string; };
  pm_account_suppression_tombstones: { id: string; account_id: string; observed_at: string; source: string; evidence_ref: string; admitted_at: string; };
  pm_handle_suppression_tombstones: { id: string; kind: string; normalized_value: string; observed_at: string; source: string; evidence_ref: string; admitted_at: string; };
  discovery_approved_budgets: { workspace_id: string; budget_id: string; ceiling_micros: number; approved_at: string; evidence_ref: string; };
  discovery_reservations: { workspace_id: string; budget_id: string; command_id: string; input_fingerprint: string; search_cost_micros: number; model_cost_micros: number; reserved_at: string; };
  discovery_receipts: { workspace_id: string; budget_id: string; command_id: string; candidates_json: string; cost_micros: number | null; completed_at: string; };
};
