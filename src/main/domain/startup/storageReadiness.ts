import { createHash } from 'node:crypto';

import { z } from 'zod';

import { checkFts5, type AppDatabase } from '../../db/database';
import { inspectDatabaseEncryption } from '../../db/databaseEncryption';
import { DomainStartupFatalError } from './domainStartupTypes';

export type DomainStorageReadiness = Readonly<{
  schemaVersion: 15;
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
 * The canonical load-bearing schema-15 manifest. Reads the live catalog from
 * sqlite_master with binary-name ordering; a missing, renamed, extra, or
 * malformed load-bearing object is fatal before composition.
 */
export const DOMAIN_SCHEMA_MANIFEST: DomainSchemaManifest = Object.freeze({
  tables: Object.freeze([
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
  ]),
  indexes: Object.freeze([
    'activities_person_occurred_idx',
    'activities_provider_idempotency_idx',
    'contact_compliance_audit_contact_idx',
    'jobs_state_created_idx',
    'jobs_type_idempotency_idx',
    'learning_evidence_learning_idx',
    'one_active_cadence_per_cycle',
    'one_open_cycle_per_person',
    'one_primary_contact_per_kind',
    'opt_out_handles_lookup_idx',
    'person_contact_methods_lookup_idx',
    'prospect_priority_priority_idx',
    'source_events_person_observed_idx',
    'stage_events_cycle_effective_idx',
    'trigger_events_prospect_effective_idx',
    'trigger_events_source_event_unique',
  ]),
  triggers: Object.freeze([
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
    'protect_next_action_immutable_evidence',
    'protect_next_action_inbound_sla_insert',
    'protect_next_action_inbound_sla_update',
    'protect_next_action_settlement',
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
  ]),
  catalogSha256: 'd888ea664cf61ff8e5404f3542f1d615d1c9b08ecf77612690236fd192e535a8',
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
  expectedSchemaVersion: 15;
  expectedManifest: DomainSchemaManifest;
}): DomainStorageReadiness {
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
      'schema_not_ready', 'The workspace schema version is not exactly 15.',
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
    DOMAIN_MIGRATION_LEDGER,
  )) {
    throw new DomainStartupFatalError(
      'schema_not_ready', 'The workspace migration ledger is not exactly schema 15.',
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
    schemaVersion: 15 as const,
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
