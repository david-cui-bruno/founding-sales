import { z } from 'zod';

import { checkFts5, type AppDatabase } from '../../db/database';
import { inspectDatabaseEncryption } from '../../db/databaseEncryption';
import { DomainStartupFatalError } from './domainStartupTypes';

export type DomainStorageReadiness = Readonly<{
  schemaVersion: 5;
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
}>;

/**
 * The canonical load-bearing schema-5 manifest. Reads the live catalog from
 * sqlite_master with binary-name ordering; a missing, renamed, or extra
 * load-bearing object is fatal before composition.
 */
export const DOMAIN_SCHEMA_MANIFEST: DomainSchemaManifest = Object.freeze({
  tables: Object.freeze([
    'activities',
    'activity_amendments',
    'cadence_action_components',
    'cadence_definitions',
    'cadence_enrollments',
    'cadence_steps',
    'consent_policy_records',
    'cycle_reactivation_receipts',
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
    'person_contact_methods',
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
    'sales_cycle_close_readiness',
    'sales_cycles',
    'source_events',
    'source_intake_receipts',
    'stage_events',
    'transcript_utterances',
    'transcripts',
    'trigger_events',
    'won_terms',
    'workspace_settings',
  ]),
  indexes: Object.freeze([
    'activities_provider_idempotency_idx',
    'jobs_type_idempotency_idx',
    'learning_evidence_learning_idx',
    'one_active_cadence_per_cycle',
    'one_open_cycle_per_person',
    'trigger_events_source_event_unique',
  ]),
  triggers: Object.freeze([
    'immutable_activities',
    'immutable_learning_evidence',
    'immutable_learning_evidence_delete',
    'immutable_prioritization_evaluations',
    'immutable_prioritization_preference_events',
    'immutable_prioritization_rule_versions',
    'immutable_transcript_utterances',
    'immutable_transcript_utterances_delete',
    'immutable_transcripts',
    'immutable_transcripts_delete',
    'immutable_trigger_events',
    'protect_activity_transcript_attach',
    'protect_cycle_pointer_insert',
    'protect_cycle_pointer_update',
    'protect_learning_delete',
    'protect_learning_identity',
    'protect_p0_priority_override',
    'protect_priority_override_delete',
    'protect_priority_override_mutation',
    'protect_priority_projection_fidelity',
    'protect_priority_projection_fidelity_update',
    'protect_projection_p0_override_delete',
    'protect_projection_p0_override_update',
    'protect_trigger_event_ownership',
    'protect_trigger_event_receipt_proof',
  ]),
});

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
  expectedSchemaVersion: 5;
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
      'schema_not_ready', 'The workspace schema version is not exactly 5.',
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
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
    ORDER BY name COLLATE BINARY
  `).all() as { name: string; type: string }[];
  const liveTables = new Set(
    catalog.filter((entry) => entry.type === 'table').map((entry) => entry.name),
  );
  const liveIndexes = new Set(
    catalog.filter((entry) => entry.type === 'index').map((entry) => entry.name),
  );
  const liveTriggers = new Set(
    catalog.filter((entry) => entry.type === 'trigger').map((entry) => entry.name),
  );
  for (const table of input.expectedManifest.tables) {
    if (!liveTables.has(table)) {
      throw new DomainStartupFatalError(
        'manifest_mismatch', `Load-bearing table is missing: ${table}`,
      );
    }
  }
  for (const index of input.expectedManifest.indexes) {
    if (!liveIndexes.has(index)) {
      throw new DomainStartupFatalError(
        'manifest_mismatch', `Load-bearing index is missing: ${index}`,
      );
    }
  }
  for (const trigger of input.expectedManifest.triggers) {
    if (!liveTriggers.has(trigger)) {
      throw new DomainStartupFatalError(
        'manifest_mismatch', `Load-bearing trigger is missing: ${trigger}`,
      );
    }
  }

  return Object.freeze({
    schemaVersion: 5 as const,
    encrypted: true as const,
    cipherVersion: encryption.cipherVersion ?? 'unknown',
    ftsAvailable: true as const,
    tableCount: liveTables.size,
    indexCount: liveIndexes.size,
    triggerCount: liveTriggers.size,
  });
}
