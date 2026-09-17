import { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { BackupService } from '../../src/main/backup/backupService';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, productionMigrations } from '../../src/main/db/migrate';
import { assertPrivateDirectory, type RetainedPrivateInput } from '../../src/main/db/readOnlyEncryptedDatabase';
import { applyWorkspaceKey, createRawDatabase, type RawDatabase } from '../../src/main/db/sqliteDriver';
import { assertDomainStorageReady, DOMAIN_MIGRATION_LEDGER, DOMAIN_SCHEMA_MANIFEST, SCHEMA25_MANIFEST } from '../../src/main/domain/startup/storageReadiness';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { seedDiscoveryOwner, DISCOVERY_NOW } from '../fixtures/discoveryDatabase';
import { seedLocalWorkspaceAcceptance } from '../fixtures/localWorkspaceAcceptance';
import { parseRecoveryKeyMaterial } from '../../src/main/security/recoveryKey';
import type { WorkspaceKey } from '../../src/main/security/workspaceKeyTypes';

export type FixtureProfile = 'bootstrap' | 'current' | 'historical' | 'through16';
type FixtureSchema = 15 | 16 | 17 | 19 | 20 | 21 | 22 | 23 | 25 | 27;
type BackupRow = { id: string; backup_basename: string; kind: string; schema_version: number; sha256: string; size_bytes: number; created_at: string; verified_at: string };
type DrillRow = { performed_at: string; backup_receipt_id: string; backup_sha256: string };
export type FixtureInspection = {
  schemaVersion: FixtureSchema; ledger: string[]; catalogSha256: string;
  sourceSha256: string; businessSha256: string;
  /** Fixed pre-selection business subset, only for through16 comparisons across16→17. */
  preserved16Sha256?: string;
  /** Fixed stable16 columns only. Excludes action state and discovery property hydration. */
  preservedActionIndependentSha256?: string;
  aggregateCounts: { people: number; prospects: number; sourceEvents: number };
  backupReceipts: BackupRow[]; drillReceipts: DrillRow[];
};
const fail = (): never => { throw new Error('PACKAGED_FIXTURE_DATABASE_FAILED'); };
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const absent = (path: string) => {
  try { fs.lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail();
};
const noSidecars = (path: string) => { for (const suffix of ['-wal', '-shm', '-journal']) absent(path + suffix); };
// Pinned from genuine encrypted23 before additive24 (118 tables,29 indexes,186 triggers).
const SCHEMA23_CATALOG = '53f24bedc785b09d913ee35d89fa7d07ebafa0ebea493efba1660234cc8fb89a';
const SCHEMA23_TABLES = Object.freeze([
  'activities',
  'activity_amendments',
  'app_meta',
  'backup_receipts',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'campaign_approvals',
  'campaign_caps',
  'campaign_command_receipts',
  'campaign_enrollments',
  'campaign_step_receipts',
  'campaign_versions',
  'cloud_entity_links',
  'consent_policy_records',
  'contact_compliance_audit_events',
  'cycle_reactivation_receipts',
  'delegated_action_outcomes',
  'delegated_applied_events',
  'delegated_approvals',
  'delegated_authorities',
  'delegated_commands',
  'delegated_event_cursors',
  'delegated_local_configuration',
  'delegated_mail_cursors',
  'delegated_manual_handoffs',
  'delegated_manual_outcomes',
  'delegated_meetings',
  'delegated_reconciliation',
  'delegated_reply_drafts',
  'delegated_threads',
  'delegated_transport_state',
  'discovery_approved_budgets',
  'discovery_assessments',
  'discovery_current',
  'discovery_overrides',
  'discovery_preparations',
  'discovery_receipts',
  'discovery_reservations',
  'discovery_scan_state',
  'email_drafts',
  'email_send_intents',
  'email_send_results',
  'foundation_fts_probe',
  'foundation_fts_probe_config',
  'foundation_fts_probe_content',
  'foundation_fts_probe_data',
  'foundation_fts_probe_docsize',
  'foundation_fts_probe_idx',
  'identity_repair_events',
  'jobs',
  'kysely_migration',
  'kysely_migration_lock',
  'learning_evidence',
  'learnings',
  'lifecycle_review_items',
  'manual_linkedin_draft_approvals',
  'manual_linkedin_drafts',
  'meeting_first_call_settings',
  'next_actions',
  'opt_out_closure_receipt_handles',
  'opt_out_closure_receipts',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'outbound_jurisdiction_audit_events',
  'outbound_jurisdiction_clearances',
  'person_contact_methods',
  'person_outbound_jurisdictions',
  'persons',
  'pm_account_claim_evidence',
  'pm_account_claims',
  'pm_account_commands',
  'pm_account_link_evidence',
  'pm_account_links',
  'pm_account_outbound_intents',
  'pm_account_outbound_results',
  'pm_account_research_jobs',
  'pm_account_route_evidence',
  'pm_account_route_policy_evidence',
  'pm_account_route_policy_receipts',
  'pm_account_routes',
  'pm_account_sources',
  'pm_account_suppression_tombstones',
  'pm_accounts',
  'pm_handle_suppression_tombstones',
  'prioritization_evaluations',
  'prioritization_preference_events',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'prospects',
  'reactivation_rules',
  'recovery_readiness',
  'restore_drill_receipts',
  'review_position',
  'sales_cycle_close_readiness',
  'sales_cycles',
  'source_events',
  'source_intake_receipts',
  'sourcing_cursor',
  'sourcing_enrichment_requests',
  'sourcing_outcome_outbox',
  'sourcing_processed_files',
  'sourcing_suppression_outbox',
  'stage_events',
  'transcript_utterances',
  'transcripts',
  'trigger_events',
  'won_terms',
  'workflow_transition_receipts',
  'workspace_settings',
  'workspace_workflow_state',
]);
const SCHEMA15_CATALOG = 'd888ea664cf61ff8e5404f3542f1d615d1c9b08ecf77612690236fd192e535a8';
const SCHEMA15_TABLES = Object.freeze([
  'activities',
  'activity_amendments',
  'app_meta',
  'backup_receipts',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'cloud_entity_links',
  'consent_policy_records',
  'contact_compliance_audit_events',
  'cycle_reactivation_receipts',
  'foundation_fts_probe',
  'foundation_fts_probe_config',
  'foundation_fts_probe_content',
  'foundation_fts_probe_data',
  'foundation_fts_probe_docsize',
  'foundation_fts_probe_idx',
  'identity_repair_events',
  'jobs',
  'kysely_migration',
  'kysely_migration_lock',
  'learning_evidence',
  'learnings',
  'lifecycle_review_items',
  'next_actions',
  'opt_out_closure_receipt_handles',
  'opt_out_closure_receipts',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'outbound_jurisdiction_audit_events',
  'outbound_jurisdiction_clearances',
  'person_contact_methods',
  'person_outbound_jurisdictions',
  'persons',
  'prioritization_evaluations',
  'prioritization_preference_events',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'prospects',
  'reactivation_rules',
  'recovery_readiness',
  'restore_drill_receipts',
  'review_position',
  'sales_cycle_close_readiness',
  'sales_cycles',
  'source_events',
  'source_intake_receipts',
  'sourcing_cursor',
  'sourcing_enrichment_requests',
  'sourcing_outcome_outbox',
  'sourcing_processed_files',
  'sourcing_suppression_outbox',
  'stage_events',
  'transcript_utterances',
  'transcripts',
  'trigger_events',
  'won_terms',
  'workspace_settings',
]);
// Fixed accepted schema16 catalog, independent of the current manifest.
const SCHEMA16_CATALOG = 'afd4740063c216a075d8e6f144c018ea242e01ade847260c14003a41893fee66';
const SCHEMA16_TABLES = Object.freeze([
  'activities',
  'activity_amendments',
  'app_meta',
  'backup_receipts',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'cloud_entity_links',
  'consent_policy_records',
  'contact_compliance_audit_events',
  'cycle_reactivation_receipts',
  'foundation_fts_probe',
  'foundation_fts_probe_config',
  'foundation_fts_probe_content',
  'foundation_fts_probe_data',
  'foundation_fts_probe_docsize',
  'foundation_fts_probe_idx',
  'identity_repair_events',
  'jobs',
  'kysely_migration',
  'kysely_migration_lock',
  'learning_evidence',
  'learnings',
  'lifecycle_review_items',
  'next_actions',
  'opt_out_closure_receipt_handles',
  'opt_out_closure_receipts',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'outbound_jurisdiction_audit_events',
  'outbound_jurisdiction_clearances',
  'person_contact_methods',
  'person_outbound_jurisdictions',
  'persons',
  'prioritization_evaluations',
  'prioritization_preference_events',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'prospects',
  'reactivation_rules',
  'recovery_readiness',
  'restore_drill_receipts',
  'review_position',
  'sales_cycle_close_readiness',
  'sales_cycles',
  'source_events',
  'source_intake_receipts',
  'sourcing_cursor',
  'sourcing_enrichment_requests',
  'sourcing_outcome_outbox',
  'sourcing_processed_files',
  'sourcing_suppression_outbox',
  'stage_events',
  'transcript_utterances',
  'transcripts',
  'trigger_events',
  'won_terms',
  'workspace_settings',
]);
// Fixed historical17 evidence from the accepted e87ecd5 schema, not today's manifest.
const SCHEMA17_CATALOG = 'aa9c8e771ceed6d559b1cc97a82252d9463c34d2936db1c2545f3d3ce4fe1fab';
const SCHEMA17_TABLES = Object.freeze([
    'activities',
    'activity_amendments',
    'app_meta',
    'backup_receipts',
    'cadence_action_components',
    'cadence_definitions',
    'cadence_enrollments',
    'cadence_steps',
    'cloud_entity_links',
    'consent_policy_records',
    'contact_compliance_audit_events',
    'cycle_reactivation_receipts',
    'discovery_assessments',
    'discovery_current',
    'discovery_overrides',
    'discovery_preparations',
    'discovery_scan_state',
    'foundation_fts_probe',
    'foundation_fts_probe_config',
    'foundation_fts_probe_content',
    'foundation_fts_probe_data',
    'foundation_fts_probe_docsize',
    'foundation_fts_probe_idx',
    'identity_repair_events',
    'jobs',
    'kysely_migration',
    'kysely_migration_lock',
    'learning_evidence',
    'learnings',
    'lifecycle_review_items',
    'next_actions',
    'opt_out_closure_receipt_handles',
    'opt_out_closure_receipts',
    'opt_out_handles',
    'opt_out_tombstones',
    'organization_aliases',
    'organizations',
    'outbound_jurisdiction_audit_events',
    'outbound_jurisdiction_clearances',
    'person_contact_methods',
    'person_outbound_jurisdictions',
    'persons',
    'prioritization_evaluations',
    'prioritization_preference_events',
    'prioritization_rule_versions',
    'priority_overrides',
    'properties',
    'prospect_organizations',
    'prospect_priority_projection',
    'prospect_properties',
    'prospects',
    'reactivation_rules',
    'recovery_readiness',
    'restore_drill_receipts',
    'review_position',
    'sales_cycle_close_readiness',
    'sales_cycles',
    'source_events',
    'source_intake_receipts',
    'sourcing_cursor',
    'sourcing_enrichment_requests',
    'sourcing_outcome_outbox',
    'sourcing_processed_files',
    'sourcing_suppression_outbox',
    'stage_events',
    'transcript_utterances',
    'transcripts',
    'trigger_events',
    'won_terms',
    'workspace_settings',
  ]);

// No jobs, assessment/projection refresh, property fact refresh or backup metadata.
// These named tables have identical columns in the pinned16 and current17 catalogs.
const PRESERVED16_TABLES = Object.freeze(['persons', 'prospects', 'source_events', 'source_intake_receipts',
  'person_contact_methods', 'sales_cycles', 'stage_events', 'next_actions', 'cadence_enrollments',
  'cadence_action_components', 'activities']);
// Bounded, named historical16 projection. Neither caller-selected SQL nor catalog-derived columns.
// No next_actions. Cycle pointer/version/update metadata intentionally changes during scheduling.
// Property door_count/updated_at may be hydrated from source facts by discovery after startup.
// Identity, source payloads, property linkage/address, contact evidence, lifecycle and history remain covered.
const ACTION_INDEPENDENT16_PROJECTIONS = Object.freeze([
  ['persons', `id, display_name, aliases_json, opted_out, opted_out_at, never_record, deleted_at, provenance_json,
    version, created_at, updated_at`],
  ['prospects', `id, person_id, original_source_event_id, segment, qualification_state, qualification_gate_reason,
    qualification_reason, last_contact_at, version, created_at, updated_at`],
  ['source_events', `id, person_id, prospect_id, sales_cycle_id, channel, observed_at, source_record_json, evidence_ref,
    referred_by_person_id, referrer_unknown_reason, created_at`],
  ['source_intake_receipts', `source_event_id, person_id, prospect_id, command_json, result_json, created_at`],
  ['person_contact_methods', `id, person_id, kind, normalized_value, raw_value, validation_state, reachability, is_primary,
    in_contacts, dnc_listed, tcpa_flag, federal_status, compliance_tcpa_flag, covered_area_code,
    compliance_source, scrubbed_at, compliance_expires_at, source_label, vendor_rank, phone_kind,
    ownership_state, evidence_observed_at, created_at, updated_at`],
  ['properties', `id, organization_id, address_line_1, address_line_2, locality, region, postal_code, country_code,
    property_type, maintenance_profile_json, source_record_json, verified_at, created_at`],
  ['prospect_properties', `prospect_id, property_id, relationship, created_at`],
  ['activities', `id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id, cadence_step_id, cadence_component_id,
    kind, direction, channel, occurred_at, duration_seconds, observed_outcome, adapter,
    provider_idempotency_key, provider_reference, consent_policy_record_id, recording_storage_ref,
    transcript_storage_ref, metadata_json, created_at, note_text, call_outcome, callback_at`],
  ['activity_amendments', `id, activity_id, amendment_kind, correction_json, reason, created_at`],
  ['stage_events', `id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at, confirmation_kind,
    transition_sequence, backfill_provenance_json, created_at`],
  ['cadence_definitions', `id, family, version, name, content_hash, attempt_cap, definition_json, created_at`],
  ['cadence_steps', `id, cadence_definition_id, sequence, day_offset, label, breakup, step_json, created_at`],
  ['cadence_action_components', `id, cadence_step_id, sequence, action_type, channel, condition_json, outcome_graph_json, template_json,
    created_at`],
  ['cadence_enrollments', `id, sales_cycle_id, cadence_definition_id, status, anchor_at, current_step_id, scheduled_step_count,
    mode, allowed_step_ids_json, version, stop_reason, created_at, updated_at`],
  ['sales_cycles', `id, person_id, prospect_id, entry_source_event_id, stage, workflow_status, stage_entered_at,
    design_partner_fitness, close_reason, close_notes, onboarding_stop_reason, closed_at, resurface_at,
    resurface_reason, created_at`],
] as const);

// Pinned before additive23, checked against genuine encrypted schema22 (root318/318).
const SCHEMA22_CATALOG = '13e641da99b4e61f4dd7a05a1d07bda21ac642dd3646d5ad35c0a582a7fb106e';
const SCHEMA22_TABLES = Object.freeze([
    'activities',
    'activity_amendments',
    'app_meta',
    'backup_receipts',
    'cadence_action_components',
    'cadence_definitions',
    'cadence_enrollments',
    'cadence_steps',
    'cloud_entity_links',
    'consent_policy_records',
    'contact_compliance_audit_events',
    'cycle_reactivation_receipts',
    'delegated_action_outcomes',
    'delegated_applied_events',
    'delegated_approvals',
    'delegated_authorities',
    'delegated_commands',
    'delegated_event_cursors',
    'delegated_mail_cursors',
    'delegated_manual_outcomes',
    'delegated_meetings',
    'delegated_reconciliation',
    'delegated_reply_drafts',
    'delegated_threads',
    'discovery_approved_budgets',
    'discovery_assessments',
    'discovery_current',
    'discovery_overrides',
    'discovery_preparations',
    'discovery_receipts',
    'discovery_reservations',
    'discovery_scan_state',
    'email_drafts',
    'email_send_intents',
    'email_send_results',
    'foundation_fts_probe',
    'foundation_fts_probe_config',
    'foundation_fts_probe_content',
    'foundation_fts_probe_data',
    'foundation_fts_probe_docsize',
    'foundation_fts_probe_idx',
    'identity_repair_events',
    'jobs',
    'kysely_migration',
    'kysely_migration_lock',
    'learning_evidence',
    'learnings',
    'lifecycle_review_items',
    'meeting_first_call_settings',
    'next_actions',
    'opt_out_closure_receipt_handles',
    'opt_out_closure_receipts',
    'opt_out_handles',
    'opt_out_tombstones',
    'organization_aliases',
    'organizations',
    'outbound_jurisdiction_audit_events',
    'outbound_jurisdiction_clearances',
    'person_contact_methods',
    'person_outbound_jurisdictions',
    'persons',
    'pm_account_claim_evidence',
    'pm_account_claims',
    'pm_account_commands',
    'pm_account_link_evidence',
    'pm_account_links',
    'pm_account_outbound_intents',
    'pm_account_outbound_results',
    'pm_account_research_jobs',
    'pm_account_route_evidence',
    'pm_account_route_policy_evidence',
    'pm_account_route_policy_receipts',
    'pm_account_routes',
    'pm_account_sources',
    'pm_account_suppression_tombstones',
    'pm_accounts',
    'pm_handle_suppression_tombstones',
    'prioritization_evaluations',
    'prioritization_preference_events',
    'prioritization_rule_versions',
    'priority_overrides',
    'properties',
    'prospect_organizations',
    'prospect_priority_projection',
    'prospect_properties',
    'prospects',
    'reactivation_rules',
    'recovery_readiness',
    'restore_drill_receipts',
    'review_position',
    'sales_cycle_close_readiness',
    'sales_cycles',
    'source_events',
    'source_intake_receipts',
    'sourcing_cursor',
    'sourcing_enrichment_requests',
    'sourcing_outcome_outbox',
    'sourcing_processed_files',
    'sourcing_suppression_outbox',
    'stage_events',
    'transcript_utterances',
    'transcripts',
    'trigger_events',
    'won_terms',
    'workspace_settings',
  ]);

// Independently pinned from actual encrypted schema21 before schema22 registration.
const SCHEMA21_CATALOG = 'fb0d87e7930b98b63c0cf896c7d6739a881c5044a11771bec8e211158bc26d29';
const SCHEMA21_TABLES = Object.freeze([
  'activities',
  'activity_amendments',
  'app_meta',
  'backup_receipts',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'cloud_entity_links',
  'consent_policy_records',
  'contact_compliance_audit_events',
  'cycle_reactivation_receipts',
  'delegated_action_outcomes',
  'delegated_applied_events',
  'delegated_approvals',
  'delegated_authorities',
  'delegated_commands',
  'delegated_event_cursors',
  'delegated_manual_outcomes',
  'delegated_meetings',
  'delegated_reconciliation',
  'delegated_threads',
  'discovery_approved_budgets',
  'discovery_assessments',
  'discovery_current',
  'discovery_overrides',
  'discovery_preparations',
  'discovery_receipts',
  'discovery_reservations',
  'discovery_scan_state',
  'email_drafts',
  'email_send_intents',
  'email_send_results',
  'foundation_fts_probe',
  'foundation_fts_probe_config',
  'foundation_fts_probe_content',
  'foundation_fts_probe_data',
  'foundation_fts_probe_docsize',
  'foundation_fts_probe_idx',
  'identity_repair_events',
  'jobs',
  'kysely_migration',
  'kysely_migration_lock',
  'learning_evidence',
  'learnings',
  'lifecycle_review_items',
  'meeting_first_call_settings',
  'next_actions',
  'opt_out_closure_receipt_handles',
  'opt_out_closure_receipts',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'outbound_jurisdiction_audit_events',
  'outbound_jurisdiction_clearances',
  'person_contact_methods',
  'person_outbound_jurisdictions',
  'persons',
  'pm_account_claim_evidence',
  'pm_account_claims',
  'pm_account_commands',
  'pm_account_link_evidence',
  'pm_account_links',
  'pm_account_outbound_intents',
  'pm_account_outbound_results',
  'pm_account_research_jobs',
  'pm_account_route_evidence',
  'pm_account_route_policy_evidence',
  'pm_account_route_policy_receipts',
  'pm_account_routes',
  'pm_account_sources',
  'pm_account_suppression_tombstones',
  'pm_accounts',
  'pm_handle_suppression_tombstones',
  'prioritization_evaluations',
  'prioritization_preference_events',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'prospects',
  'reactivation_rules',
  'recovery_readiness',
  'restore_drill_receipts',
  'review_position',
  'sales_cycle_close_readiness',
  'sales_cycles',
  'source_events',
  'source_intake_receipts',
  'sourcing_cursor',
  'sourcing_enrichment_requests',
  'sourcing_outcome_outbox',
  'sourcing_processed_files',
  'sourcing_suppression_outbox',
  'stage_events',
  'transcript_utterances',
  'transcripts',
  'trigger_events',
  'won_terms',
  'workspace_settings'
]);

// Independently pinned from actual pre-C1 schema20, never derived from current.
const SCHEMA20_CATALOG = 'eca0eb2a24dad403bd720853461426230e348476d091ab5d7d806669e49bb96d';
const SCHEMA20_TABLES = Object.freeze([
    'activities',
    'activity_amendments',
    'app_meta',
    'backup_receipts',
    'cadence_action_components',
    'cadence_definitions',
    'cadence_enrollments',
    'cadence_steps',
    'cloud_entity_links',
    'consent_policy_records',
    'contact_compliance_audit_events',
    'cycle_reactivation_receipts',
    'discovery_assessments',
    'discovery_current',
    'discovery_overrides',
    'discovery_preparations',
    'discovery_scan_state',
    'email_drafts',
    'email_send_intents',
    'email_send_results',
    'foundation_fts_probe',
    'foundation_fts_probe_config',
    'foundation_fts_probe_content',
    'foundation_fts_probe_data',
    'foundation_fts_probe_docsize',
    'foundation_fts_probe_idx',
    'identity_repair_events',
    'jobs',
    'kysely_migration',
    'kysely_migration_lock',
    'learning_evidence',
    'learnings',
    'lifecycle_review_items',
    'next_actions',
    'opt_out_closure_receipt_handles',
    'opt_out_closure_receipts',
    'opt_out_handles',
    'opt_out_tombstones',
    'organization_aliases',
    'organizations',
    'outbound_jurisdiction_audit_events',
    'outbound_jurisdiction_clearances',
    'person_contact_methods',
    'person_outbound_jurisdictions',
    'persons',
    'pm_account_claim_evidence',
    'pm_account_claims',
    'pm_account_commands',
    'pm_account_link_evidence',
    'pm_account_links',
    'pm_account_outbound_intents',
    'pm_account_outbound_results',
    'pm_account_research_jobs',
    'pm_account_route_evidence',
    'pm_account_routes',
    'pm_account_sources',
    'pm_accounts',
    'prioritization_evaluations',
    'prioritization_preference_events',
    'prioritization_rule_versions',
    'priority_overrides',
    'properties',
    'prospect_organizations',
    'prospect_priority_projection',
    'prospect_properties',
    'prospects',
    'reactivation_rules',
    'recovery_readiness',
    'restore_drill_receipts',
    'review_position',
    'sales_cycle_close_readiness',
    'sales_cycles',
    'source_events',
    'source_intake_receipts',
    'sourcing_cursor',
    'sourcing_enrichment_requests',
    'sourcing_outcome_outbox',
    'sourcing_processed_files',
    'sourcing_suppression_outbox',
    'stage_events',
    'transcript_utterances',
    'transcripts',
    'trigger_events',
    'won_terms',
    'workspace_settings',
  ]);

// Independently pinned schema19 manifest from the pre-B1 catalog. Never derive from current.
const SCHEMA19_CATALOG = 'a6108cfce2bc4242d0872e81cc2afc88634f6309c55605bd3fc995804fde9073';
const SCHEMA19_TABLES = Object.freeze([
    'activities',
    'activity_amendments',
    'app_meta',
    'backup_receipts',
    'cadence_action_components',
    'cadence_definitions',
    'cadence_enrollments',
    'cadence_steps',
    'cloud_entity_links',
    'consent_policy_records',
    'contact_compliance_audit_events',
    'cycle_reactivation_receipts',
    'discovery_assessments',
    'discovery_current',
    'discovery_overrides',
    'discovery_preparations',
    'discovery_scan_state',
    'email_drafts',
    'email_send_intents',
    'email_send_results',
    'foundation_fts_probe',
    'foundation_fts_probe_config',
    'foundation_fts_probe_content',
    'foundation_fts_probe_data',
    'foundation_fts_probe_docsize',
    'foundation_fts_probe_idx',
    'identity_repair_events',
    'jobs',
    'kysely_migration',
    'kysely_migration_lock',
    'learning_evidence',
    'learnings',
    'lifecycle_review_items',
    'next_actions',
    'opt_out_closure_receipt_handles',
    'opt_out_closure_receipts',
    'opt_out_handles',
    'opt_out_tombstones',
    'organization_aliases',
    'organizations',
    'outbound_jurisdiction_audit_events',
    'outbound_jurisdiction_clearances',
    'person_contact_methods',
    'person_outbound_jurisdictions',
    'persons',
    'prioritization_evaluations',
    'prioritization_preference_events',
    'prioritization_rule_versions',
    'priority_overrides',
    'properties',
    'prospect_organizations',
    'prospect_priority_projection',
    'prospect_properties',
    'prospects',
    'reactivation_rules',
    'recovery_readiness',
    'restore_drill_receipts',
    'review_position',
    'sales_cycle_close_readiness',
    'sales_cycles',
    'source_events',
    'source_intake_receipts',
    'sourcing_cursor',
    'sourcing_enrichment_requests',
    'sourcing_outcome_outbox',
    'sourcing_processed_files',
    'sourcing_suppression_outbox',
    'stage_events',
    'transcript_utterances',
    'transcripts',
    'trigger_events',
    'won_terms',
    'workspace_settings',
  ]);

const metadataTables = new Set(['app_meta', 'kysely_migration', 'kysely_migration_lock', 'backup_receipts', 'restore_drill_receipts', 'recovery_readiness']);

function inspectRows(raw: RawDatabase, expected: FixtureSchema, sourceSha256: string, through16: boolean): FixtureInspection {
  if (expected !== 15 && expected !== 16 && expected !== 17 && expected !== 19 && expected !== 20 && expected !== 21 && expected !== 22 && expected !== 23 && expected !== 25 && expected !== 27) fail();
  if (raw.pragma('integrity_check', { simple: true }) !== 'ok' || (raw.pragma('foreign_key_check') as unknown[]).length) fail();
  const meta = raw.prepare('SELECT singleton, schema_version FROM app_meta').all() as { singleton: number; schema_version: number }[];
  if (meta.length !== 1 || meta[0].singleton !== 1 || meta[0].schema_version !== expected) fail();
  const ledger = raw.prepare('SELECT name FROM kysely_migration ORDER BY timestamp, name').all() as { name: string }[];
  if (JSON.stringify(ledger.map(row => row.name)) !== JSON.stringify(DOMAIN_MIGRATION_LEDGER.slice(0, expected))) fail();
  const catalog = raw.prepare(`SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger') AND (type <> 'index' OR sql IS NOT NULL)
    ORDER BY name COLLATE BINARY`).all() as { name: string; type: string; sql: string | null }[];
  const fingerprint = catalog.map(row => [row.type, row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim()])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const catalogSha256 = hash(JSON.stringify(fingerprint));
  if (catalogSha256 !== (expected === 15 ? SCHEMA15_CATALOG : expected === 16 ? SCHEMA16_CATALOG : expected === 17 ? SCHEMA17_CATALOG : expected === 19 ? SCHEMA19_CATALOG : expected === 20 ? SCHEMA20_CATALOG : expected === 21 ? SCHEMA21_CATALOG : expected === 22 ? SCHEMA22_CATALOG : expected === 23 ? SCHEMA23_CATALOG : expected === 25 ? SCHEMA25_MANIFEST.catalogSha256 : DOMAIN_SCHEMA_MANIFEST.catalogSha256)) fail();
  // Catalog-validated, fixed tables only. Canonical row multisets, no business rows
  // escape. This is a same-schema digest, not a cross-migration equivalence claim.
  const business = createHash('sha256');
  for (const table of expected === 15 ? SCHEMA15_TABLES : expected === 16 ? SCHEMA16_TABLES : expected === 17 ? SCHEMA17_TABLES : expected === 19 ? SCHEMA19_TABLES : expected === 20 ? SCHEMA20_TABLES : expected === 21 ? SCHEMA21_TABLES : expected === 22 ? SCHEMA22_TABLES : expected === 23 ? SCHEMA23_TABLES : expected === 25 ? SCHEMA25_MANIFEST.tables : DOMAIN_SCHEMA_MANIFEST.tables) {
    if (metadataTables.has(table) || table.startsWith('foundation_fts_probe')) continue;
    const rows = raw.prepare(`SELECT * FROM "${table}"`).raw().all().map(row => JSON.stringify(row)).sort();
    business.update(JSON.stringify([table, rows]));
  }
  const preserved = createHash('sha256');
  if (through16) for (const table of PRESERVED16_TABLES) {
    const rows = raw.prepare(`SELECT * FROM "${table}"`).raw().all().map(row => JSON.stringify(row)).sort();
    preserved.update(JSON.stringify([table, rows]));
  }
  const independent = createHash('sha256');
  if (through16) for (const [table, columns] of ACTION_INDEPENDENT16_PROJECTIONS) {
    const rows = raw.prepare(`SELECT ${columns} FROM "${table}"`).raw().all().map(row => JSON.stringify(row)).sort();
    independent.update(JSON.stringify([table, columns, rows]));
  }
  return {
    ...(through16 ? { preserved16Sha256: preserved.digest('hex'), preservedActionIndependentSha256: independent.digest('hex') } : {}),
    schemaVersion: expected, ledger: ledger.map(row => row.name), catalogSha256, sourceSha256,
    businessSha256: business.digest('hex'),
    aggregateCounts: raw.prepare('SELECT (SELECT COUNT(*) FROM persons) AS people, (SELECT COUNT(*) FROM prospects) AS prospects, (SELECT COUNT(*) FROM source_events) AS sourceEvents').get() as FixtureInspection['aggregateCounts'],
    backupReceipts: raw.prepare('SELECT id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at FROM backup_receipts ORDER BY created_at, id').all() as BackupRow[],
    drillReceipts: raw.prepare('SELECT performed_at, backup_receipt_id, backup_sha256 FROM restore_drill_receipts ORDER BY performed_at, backup_sha256').all() as DrillRow[],
  };
}

/**
 * Test-runner only. No launcher, real-home discovery, key-store access, SQL API or
 * production bypass. Capture EVERY GUI child immediately after spawn and observe
 * its exit before offline work. Caller still proves descendant/graceful-Quit exit.
 * Existing current/bootstrap DBs may be 0600/0644 under owned 0700 ancestors.
 * All other inputs/artifacts stay 0600. Normal-close files need NO sidecars (64 MiB maximum).
 * The approved synthetic-only copy precedes cryptographic validation. SQLite opens
 * only that ciphertext copy for inspection. A leftover source sidecar is a hold.
 */
export function allocatePackagedFixtureDatabase(...unexpected: never[]) {
  if (unexpected.length) fail();
  let root: string;
  try {
    const parent = fs.realpathSync(tmpdir());
    const fromRepository = relative(process.cwd(), parent);
    if (!fromRepository.startsWith('..') && fromRepository !== '') fail();
    if (parent === fs.realpathSync(process.cwd())) fail();
    root = fs.mkdtempSync(join(parent, 'callie-packaged-fixture-'));
  } catch { return fail(); }
  const paths = Object.freeze({ root, bootstrap: join(root, 'bootstrap'), current: join(root, 'current'), historical: join(root, 'historical'), through16: join(root, 'through16'), exports: join(root, 'exports'), inspection: join(root, 'inspection') });
  const directories = new Map<string, fs.Stats>();
  const makeDirectory = (path: string) => {
    fs.mkdirSync(path, { mode: 0o700 }); assertPrivateDirectory(path); directories.set(path, fs.lstatSync(path));
  };
  try {
    directories.set(root, fs.lstatSync(root));
    assertPrivateDirectory(root);
    for (const path of [paths.bootstrap, paths.current, paths.exports, paths.inspection, join(paths.bootstrap, 'backups'), join(paths.current, 'backups')]) makeDirectory(path);
  } catch {
    try { fs.rmSync(root, { recursive: true, force: true }); } finally { fail(); }
  }
  let removed = false; let busy = false; let exited = true;
  let captured: ChildProcess | undefined;
  let envelopeCapture: { identity: fs.Stats; sha256: string } | undefined;
  const assertDirectory = (path: string) => {
    if (removed || !directories.has(path)) fail();
    assertPrivateDirectory(path);
    for (const [parent, identity] of directories) {
      if (path === parent || path.startsWith(parent + sep)) {
        if (!same(identity, fs.lstatSync(parent))) fail();
      }
    }
  };
  const profilePath = (profile: FixtureProfile) => {
    if (!['bootstrap', 'current', 'historical', 'through16'].includes(profile)) return fail();
    const path = paths[profile]; assertDirectory(path); return path;
  };
  const databasePath = (profile: FixtureProfile) => join(profilePath(profile), 'callie.sqlite3');
  const envelopePath = (profile: FixtureProfile) => join(profilePath(profile), 'callie.key-envelope.json');
  const retain = (path: string, maxSize = 64 * 1024 * 1024): RetainedPrivateInput => {
    // openDatabase only fixes its parent mode. This source-only exception is
    // derived from exact captured paths, never a public mode/role override.
    const ordinarySource = path === join(paths.current, 'callie.sqlite3')
      || path === join(paths.bootstrap, 'callie.sqlite3');
    const validate = (stat: fs.Stats) => {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || stat.nlink !== 1 || ((stat.mode & 0o777) !== 0o600 && (!ordinarySource || (stat.mode & 0o777) !== 0o644))
        || stat.size < 1 || stat.size > maxSize) fail();
      return stat;
    };
    assertDirectory(dirname(path));
    const original = validate(fs.lstatSync(path));
    const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      const identity = validate(fs.fstatSync(descriptor));
      if (!same(original, identity)) fail();
      const read = () => {
        const value = Buffer.alloc(identity.size);
        try {
          let offset = 0;
          while (offset < value.length) {
            const count = fs.readSync(descriptor, value, offset, value.length - offset, offset);
            if (!count) fail();
            offset += count;
          }
          return value;
        } catch (error) { value.fill(0); throw error; }
      };
      bytes = read(); const sha256 = hash(bytes); let closed = false;
      const input: RetainedPrivateInput = {
        path, descriptor, bytes, sha256,
        assertUnchanged() {
          assertDirectory(dirname(path));
          for (const now of [validate(fs.lstatSync(path)), validate(fs.fstatSync(descriptor))]) {
            if (!same(identity, now) || now.size !== identity.size || now.mtimeMs !== identity.mtimeMs || now.ctimeMs !== identity.ctimeMs) fail();
          }
          const current = read();
          try { if (hash(current) !== sha256) fail(); } finally { current.fill(0); }
        },
        close() { if (!closed) { closed = true; bytes!.fill(0); fs.closeSync(descriptor); } },
      };
      input.assertUnchanged(); return input;
    } catch (error) { bytes?.fill(0); fs.closeSync(descriptor); throw error; }
  };
  const run = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (removed || busy || !exited) return fail();
    busy = true;
    try { assertDirectory(root); return await operation(); }
    catch { return fail(); } finally { busy = false; }
  };
  const withMaterial = <T>(material: string, operation: (key: WorkspaceKey) => T | Promise<T>) => run(async () => {
    let key: WorkspaceKey | undefined;
    try { key = parseRecoveryKeyMaterial(material); return await operation(key); }
    finally { key?.bytes.fill(0); }
  });
  const inspect = (profile: FixtureProfile, path: string, key: WorkspaceKey, expected: FixtureSchema) => {
    if (expected === 16 && profile !== 'through16' || profile === 'through16' && expected === 15) fail();
    const sources: RetainedPrivateInput[] = [];
    let raw: RawDatabase | undefined; let temporary: string | undefined; let temporaryIdentity: fs.Stats | undefined;
    let failed = false; let result: FixtureInspection | undefined;
    const checkSources = () => {
      assertDirectory(dirname(path)); assertDirectory(paths.inspection);
      noSidecars(path); for (const source of sources) source.assertUnchanged();
    };
    try {
      noSidecars(path);
      sources.push(retain(path)); sources.push(retain(envelopePath(profile), 64 * 1024));
      checkSources();
      if (sources[0].bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail();
      temporary = fs.mkdtempSync(join(paths.inspection, 'read-'));
      assertPrivateDirectory(temporary); temporaryIdentity = fs.lstatSync(temporary);
      const copy = join(temporary, 'fixture.sqlite3');
      fs.writeFileSync(copy, sources[0].bytes, { flag: 'wx', mode: 0o600 });
      checkSources();
      if (hash(fs.readFileSync(copy)) !== sources[0].sha256) fail();
      raw = createRawDatabase(copy, { readonly: true, fileMustExist: true });
      raw.pragma('query_only = ON'); raw.pragma('temp_store = MEMORY');
      applyWorkspaceKey(raw, key.bytes);
      if (!raw.readonly || raw.pragma('query_only', { simple: true }) !== 1) fail();
      result = inspectRows(raw, expected, sources[0].sha256, profile === 'through16');
    } catch { failed = true; }
    finally {
      const attempt = (operation: () => void) => { try { operation(); } catch { failed = true; } };
      if (raw?.open) attempt(() => { raw!.close(); });
      if (raw?.open) attempt(() => { raw!.close(); });
      attempt(checkSources);
      for (const source of sources) attempt(() => source.close());
      if (temporary !== undefined && temporaryIdentity !== undefined && !raw?.open) attempt(() => {
        assertDirectory(paths.inspection);
        if (!same(fs.lstatSync(temporary!), temporaryIdentity!) || fs.lstatSync(temporary!).isSymbolicLink()) fail();
        // Includes only this copy's SQLite-created WAL/SHM, never source siblings.
        fs.rmSync(temporary!, { recursive: true });
      });
    }
    if (failed || result === undefined) return fail();
    return result;
  };
  const backupPath = (profile: FixtureProfile, basename: string) => {
    if (!/^(?:daily|manual|pre_release|pre-migration-schema-(?:15|16|17))-[0-9]{8}T[0-9]{9}Z\.sqlite3$/.test(basename)) return fail();
    const directory = join(profilePath(profile), 'backups'); assertDirectory(directory); return join(directory, basename);
  };
  return {
    paths,
    captureChild(child: ChildProcess): ChildProcess {
      if (!(child instanceof ChildProcess) || removed || busy || !exited || child === captured) return fail();
      captured = child; exited = false;
      // Same captured-instance exit/failed-spawn-close convention as the existing
      // environment helper. No PID polling, caller boolean, termination or launch.
      const onError = (): void => undefined;
      const onExit = () => {
        exited = true; child.removeListener('exit', onExit); child.removeListener('close', onExit); child.removeListener('error', onError);
      };
      child.once('exit', onExit); child.once('close', onExit); child.once('error', onError);
      if (child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null)) onExit();
      return child;
    },
    inspectStoppedProfile(profile: FixtureProfile, material: string, expected: FixtureSchema) {
      return withMaterial(material, key => inspect(profile, databasePath(profile), key, expected));
    },
    inspectStoppedBackup(profile: FixtureProfile, basename: string, material: string, expected: FixtureSchema) {
      return withMaterial(material, key => inspect(profile, backupPath(profile, basename), key, expected));
    },
    captureBootstrapEnvelope() {
      return run(() => {
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        try { envelopeCapture = { identity: fs.fstatSync(envelope.descriptor), sha256: envelope.sha256 }; }
        finally { envelope.close(); }
      });
    },
    createHistoricalProfile(material: string) {
      return withMaterial(material, async key => {
        if (!envelopeCapture) fail();
        absent(paths.historical);
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        let database: AppDatabase | undefined;
        try {
          if (!same(envelopeCapture.identity, fs.fstatSync(envelope.descriptor)) || envelopeCapture.sha256 !== envelope.sha256) fail();
          inspect('bootstrap', databasePath('bootstrap'), key, 27); // Proves supplied key matches bootstrap DB, NOT safeStorage.
          envelope.assertUnchanged();
          makeDirectory(paths.historical); makeDirectory(join(paths.historical, 'backups'));
          fs.writeFileSync(envelopePath('historical'), envelope.bytes, { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(databasePath('historical'), '', { flag: 'wx', mode: 0o600 });
          database = openDatabase({ path: databasePath('historical'), key });
          const migration = await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 15))(database, {
            workspaceKey: key, backupDirectory: join(paths.historical, 'backups'),
          });
          if (migration.fromVersion !== 0 || migration.toVersion !== 15) fail();
          closeDatabase(database); database = undefined;
          return inspect('historical', databasePath('historical'), key, 15);
        } finally {
          try { if (database) closeDatabase(database); }
          finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } }
        }
      });
    },
    createThrough16Profile(material: string) {
      return withMaterial(material, async key => {
        if (!envelopeCapture) fail();
        absent(paths.through16);
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        let database: AppDatabase | undefined;
        try {
          if (!same(envelopeCapture.identity, fs.fstatSync(envelope.descriptor)) || envelopeCapture.sha256 !== envelope.sha256) fail();
          inspect('bootstrap', databasePath('bootstrap'), key, 27); // Proves supplied key matches bootstrap DB, NOT safeStorage.
          envelope.assertUnchanged();
          makeDirectory(paths.through16); makeDirectory(join(paths.through16, 'backups'));
          fs.writeFileSync(envelopePath('through16'), envelope.bytes, { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(databasePath('through16'), '', { flag: 'wx', mode: 0o600 });
          database = openDatabase({ path: databasePath('through16'), key });
          const migration = await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 16))(database, {
            workspaceKey: key, backupDirectory: join(paths.through16, 'backups'),
          });
          if (migration.fromVersion !== 0 || migration.toVersion !== 16) fail();
          const services = createDomainServices({ database, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
          services.unitOfWork.immediate(() => {
            services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
            services.cadences.installBuiltins();
          });
          seedDiscoveryOwner({ services, database }, { prefix: 'through16-complete', units: 10, legacyUnreviewed: true });
          seedDiscoveryOwner({ services, database }, { prefix: 'through16-incomplete', units: null, legacyUnreviewed: true });
          closeDatabase(database); database = undefined;
          return inspect('through16', databasePath('through16'), key, 16);
        } finally {
          try { if (database) closeDatabase(database); }
          finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } }
        }
      });
    },
    createLocalWorkspaceProfile(material: string) {
      return withMaterial(material, async key => {
        if (!envelopeCapture) fail();
        absent(databasePath('current')); absent(envelopePath('current'));
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        let database: AppDatabase | undefined;
        try {
          if (!same(envelopeCapture.identity, fs.fstatSync(envelope.descriptor)) || envelopeCapture.sha256 !== envelope.sha256) fail();
          inspect('bootstrap', databasePath('bootstrap'), key, 27);
          envelope.assertUnchanged();
          fs.writeFileSync(envelopePath('current'), envelope.bytes, { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(databasePath('current'), '', { flag: 'wx', mode: 0o600 });
          database = openDatabase({ path: databasePath('current'), key });
          const migration = await createMigrationRunner(productionMigrations)(database, {
            workspaceKey: key, backupDirectory: join(paths.current, 'backups'),
          });
          if (migration.fromVersion !== 0 || migration.toVersion !== 27) fail();
          const seeded = seedLocalWorkspaceAcceptance(database);
          closeDatabase(database); database = undefined;
          return { ...seeded, inspection: inspect('current', databasePath('current'), key, 27) };
        } finally {
          try { if (database) closeDatabase(database); }
          finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } }
        }
      });
    },
    createManualBackup(material: string) {
      return withMaterial(material, async key => {
        const path = databasePath('current');
        const before = inspect('current', path, key, 27);
        if (before.aggregateCounts.people < 1) fail();
        const envelope = retain(envelopePath('current'), 64 * 1024);
        let database: AppDatabase | undefined; let service: BackupService | undefined;
        try {
          assertDirectory(join(paths.current, 'backups'));
          database = openDatabase({ path, key });
          assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 27, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
          const current = database;
          service = new BackupService({ databaseGate: { withDatabase: async operation => operation(current) },
            backupDirectory: join(paths.current, 'backups'), loadWorkspaceKey: async () => parseRecoveryKeyMaterial(material),
            clock: { now: () => new Date().toISOString() }, ids: { next: () => randomUUID() } });
          const backup = await service.createBackup('manual');
          await service.shutdown(); service = undefined;
          closeDatabase(database); database = undefined;
          const inspection = inspect('current', backupPath('current', backup.basename), key, 27);
          const after = inspect('current', path, key, 27);
          if (inspection.sourceSha256 !== backup.sha256 || inspection.businessSha256 !== before.businessSha256
            || after.businessSha256 !== before.businessSha256
            || !after.backupReceipts.some(row => row.backup_basename === backup.basename && row.sha256 === backup.sha256 && row.size_bytes === backup.sizeBytes)) fail();
          return { backup, inspection };
        } finally {
          try { await service?.shutdown(); }
          finally { try { if (database) closeDatabase(database); } finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } } }
        }
      });
    },
    async cleanup() {
      if (removed) return;
      return run(() => {
        assertDirectory(root);
        // Node recursive rm unlinks child symlinks, never traverses their targets.
        fs.rmSync(root, { recursive: true }); removed = true;
      });
    },
  };
}
