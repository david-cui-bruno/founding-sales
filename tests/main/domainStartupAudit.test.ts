import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import {
  DOMAIN_SCHEMA_MANIFEST,
  assertDomainStorageReady,
} from '../../src/main/domain/startup/storageReadiness';
import {
  DomainRuntimeBlockedError,
  DomainRuntimeUnavailableError,
  DomainStartupFatalError,
} from '../../src/main/domain/startup/domainStartupTypes';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { DOMAIN_TIMESTAMP } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const BOOT_AT = '2026-08-30T12:00:00.000Z';
const EXPECTED_MIGRATION_LEDGER = [
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
  '0016ContactPresentationEvidence', '0017DiscoveryAssessments', '0018PlaybookDueActions', '0019EmailDrafts', '0020PmAccounts', '0021DelegatedWork', '0022MailPersistence', '0023Campaigns', '0024RequestedFollowupAndPolicyReviews', '0025KnownCompanyResearchSettings', '0026LocalCompanyDrafts',
] as const;

describe('domain startup', () => {
  let database: AppDatabase;
  let temp: TempDatabase;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function buildRuntime() {
    let clockReads = 0;
    let idCounter = 0;
    const clock = {
      now: () => {
        clockReads += 1;
        return BOOT_AT;
      },
    };
    const ids = { next: () => `startup-id-${++idCounter}` };
    const runtime = new DomainRuntime({ database, clock, ids });
    return { runtime, clockReads: () => clockReads, idsUsed: () => idCounter };
  }

  describe('storage readiness gate', () => {
    it('passes only the exact schema-26 manifest and ordered migration ledger', () => {
      const readiness = assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 26,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      });
      expect(readiness).toMatchObject({
        schemaVersion: 26, encrypted: true, ftsAvailable: true,
      });
      expect(DOMAIN_SCHEMA_MANIFEST.tables).toEqual(expect.arrayContaining([
        'contact_compliance_audit_events',
        'person_outbound_jurisdictions',
        'outbound_jurisdiction_clearances',
        'outbound_jurisdiction_audit_events',
        'backup_receipts',
        'recovery_readiness',
        'restore_drill_receipts',
        'identity_repair_events',
      ]));
      expect(DOMAIN_SCHEMA_MANIFEST.indexes).toContain(
        'contact_compliance_audit_contact_idx',
      );
      expect(database.raw.prepare(
        'SELECT name FROM kysely_migration ORDER BY timestamp, name',
      ).all()).toEqual(EXPECTED_MIGRATION_LEDGER.map((name) => ({ name })));
    });

    it('rejects an open raw transaction, wrong pragma, and manifest drift', () => {
      database.raw.exec('BEGIN');
      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 26,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      })).toThrow(DomainStartupFatalError);
      database.raw.exec('ROLLBACK');

      database.raw.pragma('busy_timeout = 100');
      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 26,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      })).toThrow(DomainStartupFatalError);
      database.raw.pragma('busy_timeout = 5000');

      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 26,
        expectedManifest: {
          ...DOMAIN_SCHEMA_MANIFEST,
          tables: [...DOMAIN_SCHEMA_MANIFEST.tables, 'missing_table'],
        },
      })).toThrow(DomainStartupFatalError);
    });

    it.each([
      {
        objectType: 'legacy table',
        corrupt: (subject: AppDatabase) => subject.raw.exec(`
          DROP TABLE jobs;
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            idempotency_key TEXT
          );
          CREATE INDEX jobs_state_created_idx ON jobs(state, created_at);
          CREATE INDEX jobs_type_state_created_idx ON jobs(type, state, created_at, id);
          CREATE UNIQUE INDEX jobs_type_idempotency_idx
            ON jobs(type, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
        `),
      },
      {
        objectType: 'explicit index',
        corrupt: (subject: AppDatabase) => subject.raw.exec(`
          DROP INDEX jobs_state_created_idx;
          CREATE INDEX jobs_state_created_idx ON jobs(type);
        `),
      },
      {
        objectType: 'schema-16 contact table',
        corrupt: (subject: AppDatabase) => subject.raw.exec(
          'ALTER TABLE person_contact_methods DROP COLUMN evidence_observed_at',
        ),
      },
      {
        objectType: 'trigger',
        corrupt: (subject: AppDatabase) => subject.raw.exec(`
          DROP TRIGGER immutable_identity_repair_events;
          CREATE TRIGGER immutable_identity_repair_events
            BEFORE UPDATE ON identity_repair_events
            BEGIN
              SELECT 1;
            END;
        `),
      },
    ])('rejects same-name $objectType SQL corruption', ({ corrupt }) => {
      corrupt(database);

      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 26,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      })).toThrow(DomainStartupFatalError);
      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(/schema SQL fingerprint is not exact/);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it.each([15, 16, 18, 99])(
      'rejects schema version %i before repositories exist',
      (schemaVersion) => {
        database.raw.prepare(
          'UPDATE app_meta SET schema_version = ? WHERE singleton = 1',
        ).run(schemaVersion);
        const { runtime, clockReads, idsUsed } = buildRuntime();
        let caught: unknown;
        try {
          runtime.initialize();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(DomainStartupFatalError);
        expect(caught).toMatchObject({
          code: 'schema_not_ready',
          message: 'The workspace schema version is not exactly 26.',
        });
        expect(clockReads()).toBe(0);
        expect(idsUsed()).toBe(0);
      },
    );

    it.each([
      {
        name: 'missing',
        corrupt: (db: AppDatabase) => db.raw.prepare(
          "DELETE FROM kysely_migration WHERE name = '0016ContactPresentationEvidence'",
        ).run(),
      },
      {
        name: 'extra',
        corrupt: (db: AppDatabase) => db.raw.prepare(
          'INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)',
        ).run('0018Unexpected', '9999-12-31T23:59:59.999Z'),
      },
      {
        name: 'reordered',
        corrupt: (db: AppDatabase) => db.raw.prepare(
          "UPDATE kysely_migration SET timestamp = '9999-12-31T23:59:59.999Z' WHERE name = '0015RecoveryMetadata'",
        ).run(),
      },
    ])('rejects a $name migration ledger before composition', ({ corrupt }) => {
      corrupt(database);
      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it('rejects a duplicate-capable malformed migration ledger before composition', () => {
      database.raw.exec(`
        ALTER TABLE kysely_migration RENAME TO kysely_migration_original;
        CREATE TABLE kysely_migration (name TEXT NOT NULL, timestamp TEXT NOT NULL);
        INSERT INTO kysely_migration (name, timestamp)
          SELECT name, timestamp FROM kysely_migration_original;
        INSERT INTO kysely_migration (name, timestamp)
          SELECT name, timestamp FROM kysely_migration_original
          WHERE name = '0016ContactPresentationEvidence';
        DROP TABLE kysely_migration_original;
      `);

      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it.each([
      'immutable_backup_receipts',
      'immutable_backup_receipts_delete',
      'immutable_identity_repair_events',
      'immutable_identity_repair_events_delete',
      'immutable_restore_drill_receipts',
      'immutable_restore_drill_receipts_delete',
      'protect_restore_drill_backup_receipt',
    ])('requires the exact %s trigger before composition', (triggerName) => {
      expect(DOMAIN_SCHEMA_MANIFEST.triggers).toContain(triggerName);
      database.raw.exec(`DROP TRIGGER ${triggerName}`);

      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it('rejects rewritten immutable identity-repair trigger SQL before composition', () => {
      database.raw.exec(`
        DROP TRIGGER immutable_identity_repair_events;
        CREATE TRIGGER immutable_identity_repair_events
        BEFORE UPDATE ON identity_repair_events
        BEGIN
          SELECT RAISE(ABORT, 'forged trigger');
        END
      `);
      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it('rejects app_meta and migration-ledger disagreement before composition', () => {
      database.raw.prepare(
        'UPDATE app_meta SET schema_version = 15 WHERE singleton = 1',
      ).run();
      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });

    it.each([
      {
        name: 'missing',
        corrupt: (db: AppDatabase) => db.raw.exec('DROP TABLE backup_receipts'),
      },
      {
        name: 'extra',
        corrupt: (db: AppDatabase) => db.raw.exec(
          'CREATE TABLE unexpected_schema17_table (id TEXT PRIMARY KEY)',
        ),
      },
      {
        name: 'malformed',
        corrupt: (db: AppDatabase) => db.raw.exec(`
          DROP TABLE backup_receipts;
          CREATE TABLE backup_receipts (id TEXT PRIMARY KEY)
        `),
      },
    ])('rejects a $name schema-26 catalog before composition', ({ corrupt }) => {
      corrupt(database);
      const { runtime, clockReads, idsUsed } = buildRuntime();
      expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
      expect(clockReads()).toBe(0);
      expect(idsUsed()).toBe(0);
    });
  });

  describe('bootstrap', () => {
    it('installs exactly six cadences and founder-priority-v1 once, activating on null', () => {
      const { runtime } = buildRuntime();
      const report = runtime.initialize();
      expect(report.status).toBe('ready');
      expect(report.evaluatedAt).toBe(BOOT_AT);
      expect(report.activePrioritizationRuleVersionId).toBe('founder-priority-v1');
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM cadence_definitions',
      ).get()).toEqual({ count: BUILTIN_CADENCES.length });
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM prioritization_rule_versions',
      ).get()).toEqual({ count: 1 });
      expect(database.raw.prepare(`
        SELECT active_prioritization_rule_version_id AS id
        FROM workspace_settings WHERE singleton = 1
      `).get()).toEqual({ id: 'founder-priority-v1' });
      // Memoized report.
      expect(runtime.initialize()).toBe(report);
    });

    it('restart adds no definitions, rules, or duplicate jobs', () => {
      buildRuntime().runtime.initialize();
      const second = buildRuntime();
      const report = second.runtime.initialize();
      expect(report.status).toBe('ready');
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM cadence_definitions',
      ).get()).toEqual({ count: BUILTIN_CADENCES.length });
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM prioritization_rule_versions',
      ).get()).toEqual({ count: 1 });
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM jobs',
      ).get()).toEqual({ count: 0 });
    });

    it('a malformed active pointer target is fatal, never repaired to V1', () => {
      buildRuntime().runtime.initialize();
      // Corrupt the stored rule content behind the valid pointer, then
      // restore the load-bearing immutability trigger so only the rule row is
      // corrupt.
      const triggerSql = (database.raw.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'immutable_prioritization_rule_versions'
      `).get() as { sql: string }).sql;
      database.raw.exec('DROP TRIGGER immutable_prioritization_rule_versions');
      database.raw.prepare(`
        UPDATE prioritization_rule_versions SET rules_json = '{"forged":true}'
        WHERE id = 'founder-priority-v1'
      `).run();
      database.raw.exec(triggerSql);
      const { runtime } = buildRuntime();
      let caught: unknown;
      try {
        runtime.initialize();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainStartupFatalError);
      const code = (caught as DomainStartupFatalError).code;
      expect(['active_rule_invalid', 'catalog_conflict', 'bootstrap_failed']).toContain(code);
      // The pointer is untouched.
      expect(database.raw.prepare(`
        SELECT active_prioritization_rule_version_id AS id
        FROM workspace_settings WHERE singleton = 1
      `).get()).toEqual({ id: 'founder-priority-v1' });
    });

    it('recovers interrupted jobs with the injected asOf', () => {
      database.raw.prepare(`
        INSERT INTO jobs (
          id, type, state, progress_current, retry_count, payload_json,
          created_at, started_at, updated_at
        ) VALUES ('interrupted', 'sync', 'running', 0, 0, '{}', ?, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      const { runtime } = buildRuntime();
      const report = runtime.initialize();
      expect(report.interruptedJobsRecovered).toBe(1);
      expect(database.raw.prepare(`
        SELECT state, finished_at FROM jobs WHERE id = 'interrupted'
      `).get()).toEqual({ state: 'failed', finished_at: BOOT_AT });
    });

    it('typed domain corruption commits a blocked report exposing diagnostics only', () => {
      // A Person owning zero canonical Prospects violates the Task 6
      // cardinality invariant while remaining FK-clean.
      database.raw.prepare(`
        INSERT INTO persons (
          id, display_name, aliases_json, opted_out, never_record, version,
          created_at, updated_at
        ) VALUES ('blocked-person', 'No Prospect', '[]', 0, 0, 1, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      const { runtime } = buildRuntime();
      const report = runtime.initialize();
      expect(report.status).toBe('blocked');
      expect(report.blockingViolationCount).toBeGreaterThan(0);
      expect(runtime.getDiagnostics()).toBe(report);
      expect(() => runtime.getServices()).toThrow(DomainRuntimeBlockedError);
      // Installation evidence committed.
      expect(database.raw.prepare(
        'SELECT COUNT(*) AS count FROM cadence_definitions',
      ).get()).toEqual({ count: BUILTIN_CADENCES.length });
    });

    it('shutdown is idempotent, invalidates later calls, and never closes SQLite', () => {
      const { runtime } = buildRuntime();
      runtime.initialize();
      runtime.shutdown();
      runtime.shutdown();
      expect(() => runtime.getServices()).toThrow(DomainRuntimeUnavailableError);
      expect(() => runtime.initialize()).toThrow(DomainRuntimeUnavailableError);
      // The database is still open because Foundation owns it.
      expect(database.raw.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    });

    it('uninitialized diagnostics and services throw typed errors', () => {
      const { runtime } = buildRuntime();
      expect(() => runtime.getDiagnostics()).toThrow(DomainRuntimeUnavailableError);
      expect(() => runtime.getServices()).toThrow(DomainRuntimeUnavailableError);
    });
  });
});
