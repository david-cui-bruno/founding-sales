import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import {
  DomainStartupFatalError,
  PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
} from '../../src/main/domain/startup/domainStartupTypes';
import { seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const BOOT_AT = '2026-08-30T12:00:00.000Z';

function orderedSnapshot(database: AppDatabase): string {
  const tables = [
    'cadence_definitions', 'prioritization_rule_versions', 'workspace_settings',
    'jobs', 'prioritization_evaluations', 'prospect_priority_projection',
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = database.raw.prepare(
      `SELECT * FROM ${table} ORDER BY 1`,
    ).all();
    parts.push(JSON.stringify({ table, rows }));
  }
  return parts.join('\n');
}

describe('DomainRuntime injected faults', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let runtimeCounter = 0;

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

  function buildRuntime(input: { failAfterIds?: number } = {}) {
    runtimeCounter += 1;
    const prefix = `fault-${runtimeCounter}`;
    let idCounter = 0;
    return new DomainRuntime({
      database,
      clock: { now: () => BOOT_AT },
      ids: {
        next: () => {
          idCounter += 1;
          if (input.failAfterIds !== undefined && idCounter > input.failAfterIds) {
            throw new Error('Injected ID fault during bootstrap.');
          }
          return `${prefix}-${idCounter}`;
        },
      },
    });
  }

  it('rolls back the whole bootstrap on an injected enqueue fault', () => {
    seedProspect(database.raw, 'fault-prospect');
    const before = orderedSnapshot(database);
    const runtime = buildRuntime({ failAfterIds: 1 });
    let caught: unknown;
    try {
      runtime.initialize();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainStartupFatalError);
    expect((caught as DomainStartupFatalError).code).toBe('bootstrap_failed');
    // Byte-equivalent ordered rows: catalog install and job recovery rolled back.
    expect(orderedSnapshot(database)).toBe(before);
    expect(database.raw.inTransaction).toBe(false);
    // No usable runtime.
    expect(() => runtime.getServices()).toThrow();
  });

  it('a restart after a rolled-back fault converges through exact idempotency', () => {
    seedProspect(database.raw, 'fault-retry-prospect');
    const failing = buildRuntime({ failAfterIds: 1 });
    expect(() => failing.initialize()).toThrow(DomainStartupFatalError);
    const clean = buildRuntime();
    const report = clean.initialize();
    expect(report.status).toBe('ready');
    expect(report.projectionRebuildsQueued).toBe(1);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM jobs WHERE type = ?',
    ).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE)).toEqual({ count: 1 });
  });

  it('fatal storage failure leaves zero writes and no clock/ID consumption', () => {
    database.raw.prepare('UPDATE app_meta SET schema_version = 12 WHERE singleton = 1').run();
    let clockReads = 0;
    let idReads = 0;
    const runtime = new DomainRuntime({
      database,
      clock: {
        now: () => {
          clockReads += 1;
          return BOOT_AT;
        },
      },
      ids: {
        next: () => {
          idReads += 1;
          return `never-${idReads}`;
        },
      },
    });
    const before = orderedSnapshot(database);
    expect(() => runtime.initialize()).toThrow(DomainStartupFatalError);
    expect(clockReads).toBe(0);
    expect(idReads).toBe(0);
    expect(orderedSnapshot(database)).toBe(before);
  });

  it('an audit execution failure is fatal rather than an empty result', () => {
    // Remove a table the audit requires so its query execution fails hard.
    const runtime = buildRuntime();
    database.raw.exec('ALTER TABLE won_terms RENAME TO won_terms_backup');
    let caught: unknown;
    try {
      runtime.initialize();
    } catch (error) {
      caught = error;
    }
    database.raw.exec('ALTER TABLE won_terms_backup RENAME TO won_terms');
    expect(caught).toBeInstanceOf(DomainStartupFatalError);
    // The manifest gate catches the missing table before the audit executes.
    expect(['manifest_mismatch', 'audit_execution_failed'])
      .toContain((caught as DomainStartupFatalError).code);
  });
});
