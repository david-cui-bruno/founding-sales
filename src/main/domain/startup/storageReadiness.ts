import { createHash } from 'node:crypto';

import { z } from 'zod';

import { checkFts5, type AppDatabase } from '../../db/database';
import { inspectDatabaseEncryption } from '../../db/databaseEncryption';
import { DomainStartupFatalError } from './domainStartupTypes';

export type DomainStorageReadiness<Version extends 24 | 25 = 25> = Readonly<{
  schemaVersion: Version;
  encrypted: true;
  cipherVersion: string;
  ftsAvailable: true;
  tableCount: number;
  indexCount: number;
  triggerCount: number;
}>;

export type DomainSchemaManifest = Readonly<{
  tables: readonly string[];
  indexes: readonly string[];
  triggers: readonly string[];
  catalogSha256: string;
}>;

/**
 * The canonical load-bearing schema-25 manifest. Reads the live catalog from
 * sqlite_master with binary-name ordering; a missing, renamed, extra, or
 * malformed load-bearing object is fatal before composition.
 */
export const DOMAIN_SCHEMA_MANIFEST: DomainSchemaManifest = Object.freeze({
  tables: Object.freeze([
    'account_route_policy_import_reviews',
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
    'delegated_requested_followup_drafts',
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
  ]),
  indexes: Object.freeze([
    'activities_person_occurred_idx',
    'activities_provider_idempotency_idx',
    'campaign_one_nonterminal_account',
    'contact_compliance_audit_contact_idx',
    'delegated_receipt_once',
    'discovery_assessments_disposition_expires_idx',
    'discovery_assessments_prospect_evaluated_idx',
    'discovery_overrides_owner_created_idx',
    'email_draft_open_contact',
    'jobs_state_created_idx',
    'jobs_type_idempotency_idx',
    'jobs_type_state_created_idx',
    'learning_evidence_learning_idx',
    'next_actions_due_idx',
    'one_active_cadence_per_cycle',
    'one_open_cycle_per_person',
    'one_primary_contact_per_kind',
    'opt_out_handles_lookup_idx',
    'person_contact_methods_lookup_idx',
    'pm_account_command_once',
    'pm_account_route_policy_target',
    'pm_account_source_receipt_once',
    'pm_account_suppression_lookup',
    'pm_handle_suppression_lookup',
    'prospect_priority_priority_idx',
    'source_events_person_observed_idx',
    'stage_events_cycle_effective_idx',
    'trigger_events_prospect_effective_idx',
    'trigger_events_source_event_unique',
  ]),
  triggers: Object.freeze([
    'account_route_policy_import_reviews_no_delete',
    'account_route_policy_import_reviews_no_update',
    'campaign_approvals_no_delete',
    'campaign_approvals_no_update',
    'campaign_command_receipts_no_delete',
    'campaign_command_receipts_no_update',
    'campaign_step_receipts_no_delete',
    'campaign_step_receipts_no_update',
    'campaign_versions_no_delete',
    'campaign_versions_no_update',
    'delegated_action_outcomes_no_delete',
    'delegated_action_outcomes_no_update',
    'delegated_applied_events_no_delete',
    'delegated_applied_events_no_update',
    'delegated_approvals_no_delete',
    'delegated_approvals_no_update',
    'delegated_commands_no_delete',
    'delegated_commands_no_update',
    'delegated_manual_outcomes_no_delete',
    'delegated_manual_outcomes_no_update',
    'delegated_reconciliation_no_delete',
    'delegated_reconciliation_no_update',
    'discovery_approved_budgets_no_delete',
    'discovery_approved_budgets_no_update',
    'discovery_assessments_no_delete',
    'discovery_assessments_no_update',
    'discovery_assessments_owner_insert',
    'discovery_current_owner_insert',
    'discovery_current_owner_update',
    'discovery_overrides_no_delete',
    'discovery_overrides_no_update',
    'discovery_overrides_owner_insert',
    'discovery_preparations_no_delete',
    'discovery_preparations_no_update',
    'discovery_preparations_owner_insert',
    'discovery_receipts_ceiling_guard',
    'discovery_receipts_no_delete',
    'discovery_receipts_no_update',
    'discovery_reservations_budget_guard',
    'discovery_reservations_no_delete',
    'discovery_reservations_no_update',
    'email_send_intents_no_delete',
    'email_send_intents_no_update',
    'email_send_results_no_delete',
    'email_send_results_no_update',
    'immutable_activities',
    'immutable_activities_delete',
    'immutable_activity_amendments',
    'immutable_activity_amendments_delete',
    'immutable_backup_receipts',
    'immutable_backup_receipts_delete',
    'immutable_cadence_action_components',
    'immutable_cadence_action_components_delete',
    'immutable_cadence_definitions',
    'immutable_cadence_definitions_delete',
    'immutable_cadence_steps',
    'immutable_cadence_steps_delete',
    'immutable_consent_policy_records',
    'immutable_consent_policy_records_delete',
    'immutable_cycle_reactivation_receipts',
    'immutable_cycle_reactivation_receipts_delete',
    'immutable_identity_repair_events',
    'immutable_identity_repair_events_delete',
    'immutable_learning_evidence',
    'immutable_learning_evidence_delete',
    'immutable_opt_out_closure_receipt_handles',
    'immutable_opt_out_closure_receipt_handles_delete',
    'immutable_opt_out_closure_receipts',
    'immutable_opt_out_closure_receipts_delete',
    'immutable_prioritization_evaluations',
    'immutable_prioritization_evaluations_delete',
    'immutable_prioritization_preference_events',
    'immutable_prioritization_preference_events_delete',
    'immutable_prioritization_rule_versions',
    'immutable_prioritization_rule_versions_delete',
    'immutable_restore_drill_receipts',
    'immutable_restore_drill_receipts_delete',
    'immutable_source_events',
    'immutable_source_events_delete',
    'immutable_source_intake_receipts',
    'immutable_source_intake_receipts_delete',
    'immutable_stage_events',
    'immutable_stage_events_delete',
    'immutable_transcript_utterances',
    'immutable_transcript_utterances_delete',
    'immutable_transcripts',
    'immutable_transcripts_delete',
    'immutable_trigger_events',
    'immutable_trigger_events_delete',
    'immutable_won_terms',
    'immutable_won_terms_delete',
    'initialize_next_action_due',
    'initialize_unreviewed_action',
    'manual_linkedin_draft_approvals_no_delete',
    'manual_linkedin_draft_approvals_no_update',
    'pm_account_claim_evidence_no_delete',
    'pm_account_claim_evidence_no_update',
    'pm_account_claims_no_delete',
    'pm_account_claims_no_update',
    'pm_account_commands_no_delete',
    'pm_account_commands_no_update',
    'pm_account_link_evidence_no_delete',
    'pm_account_link_evidence_no_update',
    'pm_account_links_no_delete',
    'pm_account_links_no_update',
    'pm_account_outbound_intents_no_delete',
    'pm_account_outbound_intents_no_update',
    'pm_account_outbound_results_no_delete',
    'pm_account_outbound_results_no_update',
    'pm_account_route_evidence_no_delete',
    'pm_account_route_evidence_no_update',
    'pm_account_route_policy_evidence_no_delete',
    'pm_account_route_policy_evidence_no_update',
    'pm_account_route_policy_receipts_no_delete',
    'pm_account_route_policy_receipts_no_update',
    'pm_account_routes_no_delete',
    'pm_account_routes_no_update',
    'pm_account_sources_no_delete',
    'pm_account_sources_no_update',
    'pm_account_suppression_tombstones_no_delete',
    'pm_account_suppression_tombstones_no_update',
    'pm_handle_suppression_tombstones_no_delete',
    'pm_handle_suppression_tombstones_no_update',
    'protect_activity_cadence_insert',
    'protect_activity_cadence_update',
    'protect_activity_transcript_attach',
    'protect_cadence_enrollment_delete',
    'protect_cadence_enrollment_identity',
    'protect_cadence_enrollment_status',
    'protect_cadence_enrollment_step_insert',
    'protect_cadence_enrollment_step_update',
    'protect_current_action_delete',
    'protect_current_action_status',
    'protect_cycle_entry_source',
    'protect_cycle_pointer_insert',
    'protect_cycle_pointer_update',
    'protect_design_partner_fitness',
    'protect_design_partner_fitness_update',
    'protect_initial_action_status',
    'protect_learning_delete',
    'protect_learning_identity',
    'protect_lifecycle_review_item_delete',
    'protect_lifecycle_review_item_identity',
    'protect_lifecycle_review_item_resolution',
    'protect_next_action_cadence_insert',
    'protect_next_action_cadence_update',
    'protect_next_action_delete',
    'protect_next_action_due',
    'protect_next_action_immutable_evidence',
    'protect_next_action_inbound_sla_insert',
    'protect_next_action_inbound_sla_update',
    'protect_next_action_settlement',
    'protect_operational_action_pointer',
    'protect_opt_out_closure_receipt_handle_insert',
    'protect_opt_out_handle',
    'protect_opt_out_handle_update',
    'protect_opt_out_tombstone',
    'protect_opt_out_tombstone_active_cadence',
    'protect_opt_out_tombstone_update',
    'protect_opted_out_active_cadence',
    'protect_opted_out_active_cadence_update',
    'protect_opted_out_contact_method_insert',
    'protect_opted_out_contact_method_update',
    'protect_opted_out_next_action_insert',
    'protect_opted_out_next_action_update',
    'protect_opted_out_operational_cycle_insert',
    'protect_opted_out_operational_cycle_update',
    'protect_p0_priority_override',
    'protect_person_opt_out_insert',
    'protect_person_opt_out_reset',
    'protect_priority_override_delete',
    'protect_priority_override_mutation',
    'protect_priority_projection_fidelity',
    'protect_priority_projection_fidelity_update',
    'protect_priority_projection_owner',
    'protect_projection_p0_override_delete',
    'protect_projection_p0_override_update',
    'protect_prospect_original_source',
    'protect_reactivation_rule_delete',
    'protect_reactivation_rule_update',
    'protect_restore_drill_backup_receipt',
    'protect_settled_next_action_schedule',
    'protect_source_intake_receipt_prospect',
    'protect_trigger_event_ownership',
    'protect_trigger_event_receipt_proof',
    'synchronize_person_opt_out',
    'workflow_transition_receipts_no_delete',
    'workflow_transition_receipts_no_update',
  ]),
  // Generated from actual production migrations through 0025.
  catalogSha256: 'cfa91324a66ac5c9aaee193d167665fd25ed4d9654cadee75f962f620437f734',
});

export const DOMAIN_MIGRATION_LEDGER = Object.freeze([
  '0001Foundation',
  '0002DomainFoundation',
  '0003Transcripts',
  '0004Learnings',
  '0005SourcingChannels',
  '0006SourcingState',
  '0007SourcingOutbox',
  '0008DedupeCloudPersons',
  '0009SourcingFileLedger',
  '0010NoDueDates',
  '0011ContactDncFlags',
  '0012UpstreamRequestState',
  '0013ContactComplianceEvidence',
  '0014OutboundJurisdictionClearance',
  '0015RecoveryMetadata',
  '0016ContactPresentationEvidence',
  '0017DiscoveryAssessments',
  '0018PlaybookDueActions',
  '0019EmailDrafts',
  '0020PmAccounts',
  '0021DelegatedWork', '0022MailPersistence', '0023Campaigns', '0024RequestedFollowupAndPolicyReviews', '0025KnownCompanyResearchSettings',
] as const);

const appMetaSchema = z.object({
  schema_version: z.number().int(),
}).passthrough();

/**
 * Pure-read pre-repository storage gate. Runs after migration and before
 * createDomainServices; every failure is fatal.
 */
export function assertDomainStorageReady(input: {
  database: AppDatabase;
  expectedBusyTimeoutMs: 5000;
  expectedSchemaVersion: 25;
  expectedManifest: DomainSchemaManifest;
}): DomainStorageReadiness {
  return assertExactStorageReady(input, DOMAIN_MIGRATION_LEDGER);
}

/** Backup-only compatibility. Never migrates or admits a schema-24 app runtime. */
export function assertPreReleaseStorageReady(database: AppDatabase): DomainStorageReadiness<24 | 25> {
  const row = appMetaSchema.safeParse(database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get());
  if (!row.success || (row.data.schema_version !== 24 && row.data.schema_version !== 25)) {
    throw new DomainStartupFatalError('schema_not_ready', 'Unsupported pre-release backup schema.');
  }
  const version = row.data.schema_version;
  // Migration 25 adds columns only. Schema-24 object names are identical but
  // its exact SQL fingerprint and full ordered ledger remain independently pinned.
  const manifest = version === 24 ? { ...DOMAIN_SCHEMA_MANIFEST,
    catalogSha256: '540015183cea4abf0ec50df42e643d5d7e6901a3dfd6a3a9a5c538ae80661a6b',
  } : DOMAIN_SCHEMA_MANIFEST;
  return assertExactStorageReady({ database, expectedBusyTimeoutMs: 5000,
    expectedSchemaVersion: version, expectedManifest: manifest },
  version === 24 ? DOMAIN_MIGRATION_LEDGER.slice(0, 24) : DOMAIN_MIGRATION_LEDGER);
}

function assertExactStorageReady<Version extends 24 | 25>(input: {
  database: AppDatabase;
  expectedBusyTimeoutMs: 5000;
  expectedSchemaVersion: Version;
  expectedManifest: DomainSchemaManifest;
}, expectedLedger: readonly string[]): DomainStorageReadiness<Version> {
  const { database } = input;
  if (database.raw.inTransaction) {
    throw new DomainStartupFatalError(
      'pragma_not_ready', 'Domain startup rejects an open raw transaction.',
    );
  }

  const encryption = inspectDatabaseEncryption(database);
  if (!encryption.encrypted) {
    throw new DomainStartupFatalError(
      'storage_not_encrypted', 'The workspace database is not encrypted.',
    );
  }

  const metadataRow = database.raw.prepare(
    'SELECT schema_version FROM app_meta WHERE singleton = 1',
  ).get();
  const metadata = appMetaSchema.safeParse(metadataRow);
  if (!metadata.success || metadata.data.schema_version !== input.expectedSchemaVersion) {
    throw new DomainStartupFatalError(
      'schema_not_ready', `The workspace schema version is not exactly ${input.expectedSchemaVersion}.`,
    );
  }

  let migrationLedger: { name: string }[];
  try {
    migrationLedger = database.raw.prepare<[], { name: string }>(`
      SELECT name FROM kysely_migration ORDER BY timestamp, name
    `).all();
  } catch {
    throw new DomainStartupFatalError(
      'schema_not_ready', 'The workspace migration ledger is unavailable.',
    );
  }
  if (!sameValues(
    migrationLedger.map(({ name }) => name),
    expectedLedger,
  )) {
    throw new DomainStartupFatalError(
      'schema_not_ready', `The workspace migration ledger is not exactly schema ${input.expectedSchemaVersion}.`,
    );
  }

  const pragmaChecks: readonly [string, unknown][] = [
    ['foreign_keys', 1],
    ['recursive_triggers', 1],
  ];
  for (const [name, expected] of pragmaChecks) {
    if (database.raw.pragma(name, { simple: true }) !== expected) {
      throw new DomainStartupFatalError(
        'pragma_not_ready', `PRAGMA ${name} is not in the production state.`,
      );
    }
  }
  if (database.raw.pragma('journal_mode', { simple: true }) !== 'wal') {
    throw new DomainStartupFatalError(
      'pragma_not_ready', 'The workspace journal mode is not WAL.',
    );
  }
  if (database.raw.pragma('busy_timeout', { simple: true }) !== input.expectedBusyTimeoutMs) {
    throw new DomainStartupFatalError(
      'pragma_not_ready', 'The busy timeout is not the production policy.',
    );
  }

  const foreignKeyRows = database.raw.pragma('foreign_key_check') as unknown[];
  if (Array.isArray(foreignKeyRows) && foreignKeyRows.length > 0) {
    throw new DomainStartupFatalError(
      'foreign_key_violation', 'PRAGMA foreign_key_check reported violations.',
    );
  }

  if (!checkFts5(database)) {
    throw new DomainStartupFatalError('fts_unavailable', 'FTS5 is unavailable.');
  }

  const catalog = database.raw.prepare(`
    SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND (type <> 'index' OR sql IS NOT NULL)
    ORDER BY name COLLATE BINARY
  `).all() as { name: string; type: string; sql: string | null }[];
  const liveTables = new Set(
    catalog.filter((entry) => entry.type === 'table').map((entry) => entry.name),
  );
  const liveIndexes = new Set(
    catalog.filter((entry) => entry.type === 'index').map((entry) => entry.name),
  );
  const liveTriggers = new Set(
    catalog.filter((entry) => entry.type === 'trigger').map((entry) => entry.name),
  );
  if (
    !sameValues([...liveTables].sort(), input.expectedManifest.tables)
    || !sameValues([...liveIndexes].sort(), input.expectedManifest.indexes)
    || !sameValues([...liveTriggers].sort(), input.expectedManifest.triggers)
  ) {
    throw new DomainStartupFatalError(
      'manifest_mismatch', 'The load-bearing schema catalog is not exact.',
    );
  }
  const catalogSha256 = createHash('sha256')
    .update(JSON.stringify(catalog.map(({ name, type, sql }) => [
      type,
      name,
      normalizeSql(sql ?? ''),
    ]).sort(compareCatalogEntries)))
    .digest('hex');
  if (catalogSha256 !== input.expectedManifest.catalogSha256) {
    throw new DomainStartupFatalError(
      'manifest_mismatch', `The load-bearing schema SQL fingerprint is not exact: ${catalogSha256}`,
    );
  }

  return Object.freeze({
    schemaVersion: input.expectedSchemaVersion,
    encrypted: true as const,
    cipherVersion: encryption.cipherVersion ?? 'unknown',
    ftsAvailable: true as const,
    tableCount: liveTables.size,
    indexCount: liveIndexes.size,
    triggerCount: liveTriggers.size,
  });
}

function sameValues(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compareCatalogEntries(left: string[], right: string[]): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return 0;
}
