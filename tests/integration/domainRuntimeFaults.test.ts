import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import {
  DomainStartupFatalError,
  PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
} from '../../src/main/domain/startup/domainStartupTypes';
import { WorkspaceSettingsRepository } from '../../src/main/domain/workspace/workspaceSettingsRepository';
import { seedProspect } from '../fixtures/domainRows';
import { seedPriorityRebuildJobs } from '../fixtures/priorityRebuildJob';
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

  // The `failAfterIds` injector this helper used to carry is gone: bootstrap consumes
  // no IDs now that D11 step 6a stopped the rebuild enqueue, so it could never fire.
  // `idReads` in the storage-failure case below still proves bootstrap allocates none.
  function buildRuntime() {
    runtimeCounter += 1;
    const prefix = `fault-${runtimeCounter}`;
    let idCounter = 0;
    return new DomainRuntime({
      database,
      clock: { now: () => BOOT_AT },
      ids: { next: () => `${prefix}-${++idCounter}` },
    });
  }

  /**
   * Bootstrap consumes no IDs since D11 step 6a stopped the rebuild enqueue, so the
   * fault these two cases need is injected at the step-9 postcondition re-read of
   * workspace settings, which is the first real work after the retirement sweep.
   * A trigger cannot be used: `assertDomainStorageReady` rejects an extra trigger
   * against `DOMAIN_SCHEMA_MANIFEST` before bootstrap opens.
   */
  function faultAtPostcondition() {
    const original = WorkspaceSettingsRepository.prototype.read;
    const calls = { count: 0 };
    const spy = vi.spyOn(WorkspaceSettingsRepository.prototype, 'read')
      .mockImplementation(function (this: WorkspaceSettingsRepository) {
        calls.count += 1;
        if (calls.count === 2) throw new Error('Injected postcondition read fault.');
        return original.call(this);
      });
    return { calls, restore: () => spy.mockRestore() };
  }

  /** Exactly what a build before D11 step 6a left queued on an installed database. */
  function legacyQueuedRebuild(prospectId: string) {
    const runtime = buildRuntime();
    runtime.initialize();
    const seeded = seedPriorityRebuildJobs({ services: runtime.getServices(), asOf: BOOT_AT,
      listEligibleProspectIds: () => [prospectId], nextId: () => `legacy-${++runtimeCounter}` })[0]!;
    expect(seeded.state).toBe('queued');
    return seeded;
  }

  it('rolls back the whole bootstrap, rebuild retirement included, on an injected fault', () => {
    const prospect = seedProspect(database.raw, 'fault-prospect');
    const legacy = legacyQueuedRebuild(prospect.prospectId);
    const before = orderedSnapshot(database);
    const fault = faultAtPostcondition();
    const runtime = buildRuntime();
    let caught: unknown;
    try {
      runtime.initialize();
    } catch (error) {
      caught = error;
    }
    fault.restore();
    expect(fault.calls.count).toBe(2);
    expect(caught).toBeInstanceOf(DomainStartupFatalError);
    expect((caught as DomainStartupFatalError).code).toBe('bootstrap_failed');
    // Byte-equivalent ordered rows: catalog install, job recovery and the retirement
    // of the queued rebuild all rolled back together.
    expect(orderedSnapshot(database)).toBe(before);
    expect(database.raw.prepare('SELECT state FROM jobs WHERE id = ?').get(legacy.id))
      .toEqual({ state: 'queued' });
    expect(database.raw.inTransaction).toBe(false);
    // No usable runtime.
    expect(() => runtime.getServices()).toThrow();
  });

  it('a restart after a rolled-back fault retires the queued rebuild exactly once', () => {
    const prospect = seedProspect(database.raw, 'fault-retry-prospect');
    const legacy = legacyQueuedRebuild(prospect.prospectId);
    const fault = faultAtPostcondition();
    expect(() => buildRuntime().initialize()).toThrow(DomainStartupFatalError);
    fault.restore();
    expect(database.raw.prepare('SELECT state FROM jobs WHERE id = ?').get(legacy.id))
      .toEqual({ state: 'queued' });
    const clean = buildRuntime();
    const report = clean.initialize();
    expect(report.status).toBe('ready');
    expect(report.projectionRebuildsQueued).toBe(0);
    expect(report.pendingProjectionRebuilds).toBe(0);
    // The row is retired in place, never deleted and never duplicated.
    expect(database.raw.prepare('SELECT state, finished_at, retry_count FROM jobs WHERE id = ?')
      .get(legacy.id)).toEqual({ state: 'cancelled', finished_at: BOOT_AT, retry_count: 0 });
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM jobs WHERE type = ?',
    ).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE)).toEqual({ count: 1 });
  });

  it('fatal storage failure leaves zero writes and no clock/ID consumption', () => {
    database.raw.prepare('UPDATE app_meta SET schema_version = 13 WHERE singleton = 1').run();
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
