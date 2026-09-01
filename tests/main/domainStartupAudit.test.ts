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
    it('passes the exact schema-5 manifest against the live catalog', () => {
      const readiness = assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 5,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      });
      expect(readiness).toMatchObject({
        schemaVersion: 5, encrypted: true, ftsAvailable: true,
      });
    });

    it('rejects an open raw transaction, wrong pragma, and manifest drift', () => {
      database.raw.exec('BEGIN');
      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 5,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      })).toThrow(DomainStartupFatalError);
      database.raw.exec('ROLLBACK');

      database.raw.pragma('busy_timeout = 100');
      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 5,
        expectedManifest: DOMAIN_SCHEMA_MANIFEST,
      })).toThrow(DomainStartupFatalError);
      database.raw.pragma('busy_timeout = 5000');

      expect(() => assertDomainStorageReady({
        database,
        expectedBusyTimeoutMs: 5000,
        expectedSchemaVersion: 5,
        expectedManifest: {
          ...DOMAIN_SCHEMA_MANIFEST,
          tables: [...DOMAIN_SCHEMA_MANIFEST.tables, 'missing_table'],
        },
      })).toThrow(DomainStartupFatalError);
    });

    it('rejects a wrong schema version before repositories exist', () => {
      database.raw.prepare('UPDATE app_meta SET schema_version = 3 WHERE singleton = 1').run();
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
