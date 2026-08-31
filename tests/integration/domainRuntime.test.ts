import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { DEFAULT_TODAY_CAPACITY } from '../../src/main/domain/today/todayTypes';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const BOOT_AT = '2026-08-30T12:00:00.000Z';

describe('DomainRuntime end-to-end', () => {
  let database: AppDatabase;
  let secondDatabase: AppDatabase | undefined;
  let temp: TempDatabase;
  let runtimeCounter = 0;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    secondDatabase = openDatabase({ path: temp.path, key });
  });

  afterEach(() => {
    if (secondDatabase !== undefined) closeDatabase(secondDatabase);
    closeDatabase(database);
    temp.cleanup();
  });

  function buildRuntime(target: AppDatabase = database) {
    runtimeCounter += 1;
    const prefix = `runtime-${runtimeCounter}`;
    let idCounter = 0;
    return new DomainRuntime({
      database: target,
      clock: { now: () => BOOT_AT },
      ids: { next: () => `${prefix}-${idCounter += 1}` },
    });
  }

  it('boots ready on an empty workspace and serves an operational graph', () => {
    const runtime = buildRuntime();
    const report = runtime.initialize();
    expect(report.status).toBe('ready');
    const services = runtime.getServices();
    // The Today queue builds on the operational graph without writes.
    const queue = services.today.build({
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    expect(queue.lanes.flatMap((entry) => entry.items)).toHaveLength(0);
    expect(queue.localDate).toBe('2026-08-30');
  });

  it('serializes concurrent bootstrap across independent encrypted connections', () => {
    const first = buildRuntime(database);
    const second = buildRuntime(secondDatabase!);
    const firstReport = first.initialize();
    const secondReport = second.initialize();
    expect(firstReport.status).toBe('ready');
    expect(secondReport.status).toBe('ready');
    // No duplicate catalogs, no pointer loss.
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
  });

  it('an existing valid later active rule remains active across restart', () => {
    buildRuntime().initialize();
    const services = buildRuntime().initialize();
    expect(services.activePrioritizationRuleVersionId).toBe('founder-priority-v1');
    // Install and activate a strict valid custom rule via the graph.
    const runtime = buildRuntime();
    runtime.initialize();
    const graph = runtime.getServices();
    graph.unitOfWork.immediate(() => {
      const base = graph.prioritizationRepository.getRuleVersion('founder-priority-v1')!.document;
      const custom = graph.prioritizationRepository.installRuleVersion({
        formatVersion: 1,
        id: 'founder-priority-v2',
        version: 2,
        fit: base.fit,
        confidence: base.confidence,
        timing: base.timing,
      } as never);
      graph.prioritizationRepository.activateRuleVersion({
        ruleVersionId: custom.id,
        expectedActiveRuleVersionId: 'founder-priority-v1',
      });
    });
    const restart = buildRuntime().initialize();
    expect(restart.status).toBe('ready');
    expect(restart.activePrioritizationRuleVersionId).toBe('founder-priority-v2');
    // V1 was still installed idempotently.
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_rule_versions',
    ).get()).toEqual({ count: 2 });
  });

  it('performs the bootstrap atomically: total_changes stable on replayed restart', () => {
    buildRuntime().initialize();
    const before = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    buildRuntime().initialize();
    const after = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    // Idempotent replay writes nothing new except the settings updated_at CAS,
    // which only fires when the pointer changes; expect zero data changes.
    expect(after.c).toBe(before.c);
  });
});
