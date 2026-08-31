import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  DOMAIN_TIMESTAMP,
  insertCadenceDefinition,
  insertClosedCycle,
  insertOpenCycleWithAction,
  insertPerson,
  insertSourceEvent,
  seedProspect,
} from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const domainTables = [
  'activities',
  'activity_amendments',
  'cadence_action_components',
  'cadence_definitions',
  'cadence_enrollments',
  'cadence_steps',
  'consent_policy_records',
  'next_actions',
  'opt_out_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'persons',
  'person_contact_methods',
  'prioritization_evaluations',
  'prioritization_rule_versions',
  'priority_overrides',
  'properties',
  'prospects',
  'prospect_organizations',
  'prospect_priority_projection',
  'prospect_properties',
  'reactivation_rules',
  'sales_cycles',
  'sales_cycle_close_readiness',
  'source_events',
  'stage_events',
  'trigger_events',
  'workspace_settings',
  'won_terms',
] as const;

const requiredIndexes = [
  'activities_provider_idempotency_idx',
  'jobs_type_idempotency_idx',
  'one_active_cadence_per_cycle',
  'one_open_cycle_per_person',
] as const;

const requiredTriggers = [
  'immutable_activities',
  'immutable_activity_amendments',
  'immutable_consent_policy_records',
  'immutable_source_events',
  'immutable_stage_events',
  'immutable_trigger_events',
  'protect_current_action_delete',
  'protect_current_action_status',
  'protect_design_partner_fitness',
  'protect_opt_out_handle',
  'protect_opt_out_tombstone',
] as const;

const scenario = process.argv[2];
assert.ok(scenario, 'A domain-schema scenario is required.');

if (scenario === 'open-cycle-worker') {
  runOpenCycleWorker();
} else {
  void runScenario();
}

async function runScenario(): Promise<void> {
  const workspace = createTempDatabase();
  const key = createTestWorkspaceKey();
  let database: AppDatabase | undefined;
  try {
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`,
      workspaceKey: key,
    });
    runDatabaseScenario(database, scenario, workspace.path);
  } finally {
    if (database !== undefined) {
      closeDatabase(database);
    }
    key.bytes.fill(0);
    workspace.cleanup();
  }
}

function runDatabaseScenario(
  database: AppDatabase,
  name: string,
  databasePath: string,
): void {
  const raw = database.raw;
  switch (name) {
    case 'manifest': {
      assert.deepEqual(
        raw.prepare<[], { schema_version: number }>(
          'SELECT schema_version FROM app_meta WHERE singleton = 1',
        ).get(),
        { schema_version: 2 },
      );
      const actualTables = raw.prepare<string[], { name: string }>(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${domainTables.map(() => '?').join(',')})
        ORDER BY name
      `).all(...domainTables).map(({ name: table }) => table);
      assert.deepEqual(actualTables, [...domainTables].sort());
      assertObjectsExist(raw, 'index', requiredIndexes);
      assertObjectsExist(raw, 'trigger', requiredTriggers);
      return;
    }
    case 'duplicate-prospect': {
      const prospect = seedProspect(raw, 'duplicate-prospect');
      assert.throws(() => raw.prepare(`
        INSERT INTO prospects (
          id, person_id, original_source_event_id, segment, qualification_state,
          version, created_at, updated_at
        ) VALUES ('second-prospect', ?, ?, 'warm', 'eligible', 1, ?, ?)
      `).run(prospect.personId, prospect.sourceEventId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'duplicate-open-cycle': {
      const prospect = seedProspect(raw, 'duplicate-cycle');
      insertOpenCycleWithAction({ database: raw, prefix: 'first', prospect });
      assert.throws(() => insertOpenCycleWithAction({
        database: raw,
        prefix: 'second',
        prospect,
      }));
      return;
    }
    case 'mismatched-prospect-person': {
      const first = seedProspect(raw, 'mismatch-prospect-first');
      const second = seedProspect(raw, 'mismatch-prospect-second');
      assertDeferredConstraint(raw, () => {
        raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage,
            workflow_status, current_next_action_id, stage_entered_at,
            version, created_at, updated_at
          ) VALUES ('mismatch-cycle', ?, ?, ?, 'ready', 'active',
                    'mismatch-action', ?, 1, ?, ?)
        `).run(
          first.personId,
          second.prospectId,
          first.sourceEventId,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
        );
        insertRawAction(raw, 'mismatch-action', 'mismatch-cycle');
      });
      return;
    }
    case 'mismatched-source-person': {
      const first = seedProspect(raw, 'mismatch-source-first');
      const second = seedProspect(raw, 'mismatch-source-second');
      assertDeferredConstraint(raw, () => {
        raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage,
            workflow_status, current_next_action_id, stage_entered_at,
            version, created_at, updated_at
          ) VALUES ('mismatch-source-cycle', ?, ?, ?, 'ready', 'active',
                    'mismatch-source-action', ?, 1, ?, ?)
        `).run(
          first.personId,
          first.prospectId,
          second.sourceEventId,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
        );
        insertRawAction(raw, 'mismatch-source-action', 'mismatch-source-cycle');
      });
      return;
    }
    case 'source-event-mismatched-prospect-person': {
      const first = seedProspect(raw, 'source-owner-first');
      const second = seedProspect(raw, 'source-owner-second');
      assert.throws(() => raw.prepare(`
        INSERT INTO source_events (
          id, person_id, prospect_id, channel, observed_at,
          source_record_json, created_at
        ) VALUES ('mismatched-prospect-source', ?, ?, 'custom', ?, '{}', ?)
      `).run(
        first.personId,
        second.prospectId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      ));
      return;
    }
    case 'source-event-mismatched-cycle-person': {
      const first = seedProspect(raw, 'source-cycle-owner-first');
      const second = seedProspect(raw, 'source-cycle-owner-second');
      const secondCycle = insertOpenCycleWithAction({
        database: raw,
        prefix: 'source-cycle-owner-second',
        prospect: second,
      });
      assert.throws(() => raw.prepare(`
        INSERT INTO source_events (
          id, person_id, sales_cycle_id, channel, observed_at,
          source_record_json, created_at
        ) VALUES ('mismatched-cycle-source', ?, ?, 'custom', ?, '{}', ?)
      `).run(
        first.personId,
        secondCycle.cycleId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      ));
      return;
    }
    case 'open-without-current-action': {
      const prospect = seedProspect(raw, 'open-null');
      assert.throws(() => raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES ('open-null-cycle', ?, ?, ?, 'ready', 'active', NULL, ?, 1, ?, ?)
      `).run(
        prospect.personId,
        prospect.prospectId,
        prospect.sourceEventId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      ));
      return;
    }
    case 'closed-with-current-action': {
      const prospect = seedProspect(raw, 'closed-current');
      assert.throws(() => raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES ('closed-current-cycle', ?, ?, ?, 'lost_nurture', 'closed',
                  'closed-current-action', ?, 1, ?, ?)
      `).run(
        prospect.personId,
        prospect.prospectId,
        prospect.sourceEventId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      ));
      return;
    }
    case 'current-action-owned-by-another-cycle': {
      const first = seedProspect(raw, 'owner-first');
      const second = seedProspect(raw, 'owner-second');
      const open = insertOpenCycleWithAction({ database: raw, prefix: 'owner-open', prospect: first });
      const closedCycleId = insertClosedCycle({ database: raw, prefix: 'owner-closed', prospect: second });
      insertRawAction(raw, 'other-cycle-action', closedCycleId);
      assertDeferredConstraint(raw, () => {
        raw.prepare(
          'UPDATE sales_cycles SET current_next_action_id = ? WHERE id = ?',
        ).run('other-cycle-action', open.cycleId);
      });
      return;
    }
    case 'complete-referenced-action': {
      const prospect = seedProspect(raw, 'complete-current');
      const current = insertOpenCycleWithAction({ database: raw, prefix: 'complete-current', prospect });
      assert.throws(() => raw.prepare(`
        UPDATE next_actions
        SET status = 'completed', completed_at = ?
        WHERE id = ?
      `).run(DOMAIN_TIMESTAMP, current.actionId));
      return;
    }
    case 'delete-referenced-action': {
      const prospect = seedProspect(raw, 'delete-current');
      const current = insertOpenCycleWithAction({ database: raw, prefix: 'delete-current', prospect });
      assert.throws(() => raw.prepare('DELETE FROM next_actions WHERE id = ?').run(current.actionId));
      return;
    }
    case 'pointer-move-before-completion': {
      const prospect = seedProspect(raw, 'pointer-move');
      const current = insertOpenCycleWithAction({ database: raw, prefix: 'pointer-move', prospect });
      raw.exec('BEGIN IMMEDIATE');
      try {
        insertRawAction(raw, 'replacement-action', current.cycleId);
        raw.prepare('UPDATE sales_cycles SET current_next_action_id = ? WHERE id = ?')
          .run('replacement-action', current.cycleId);
        raw.prepare(`
          UPDATE next_actions SET status = 'completed', completed_at = ? WHERE id = ?
        `).run(DOMAIN_TIMESTAMP, current.actionId);
        raw.exec('COMMIT');
      } catch (error) {
        if (raw.inTransaction) raw.exec('ROLLBACK');
        throw error;
      }
      assert.deepEqual(
        raw.prepare<[], { current_next_action_id: string }>(
          `SELECT current_next_action_id FROM sales_cycles WHERE id = '${current.cycleId}'`,
        ).get(),
        { current_next_action_id: 'replacement-action' },
      );
      return;
    }
    case 'cyclic-deferred-construction': {
      const prospect = seedProspect(raw, 'cyclic');
      const created = insertOpenCycleWithAction({ database: raw, prefix: 'cyclic', prospect });
      assert.deepEqual(
        raw.prepare<[], { current_next_action_id: string }>(
          `SELECT current_next_action_id FROM sales_cycles WHERE id = '${created.cycleId}'`,
        ).get(),
        { current_next_action_id: created.actionId },
      );
      return;
    }
    case 'p0-without-direct-reachability': {
      const prospect = seedProspect(raw, 'p0-indirect');
      insertPrioritizationRule(raw, 'p0-rule');
      assert.throws(() => raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, evaluated_at, fit_points, fit_band,
          timing_millipoints, timing_band, reachability, data_confidence,
          priority, verify_first, explanation_json, created_at
        ) VALUES ('invalid-p0-evaluation', ?, 'p0-rule', ?, 25, 'high',
                  30000, 'hot', 'indirect', 8, 'p0', 0, '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, evaluated_at, fit_points, fit_band,
          timing_millipoints, timing_band, reachability, data_confidence,
          priority, verify_first, explanation_json, created_at
        ) VALUES ('valid-p1-evaluation', ?, 'p0-rule', ?, 25, 'high',
                  30000, 'hot', 'indirect', 8, 'p1', 0, '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT INTO prospect_priority_projection (
          prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
          timing_millipoints, timing_band, reachability, data_confidence,
          priority, verify_first, version, evaluated_at, updated_at
        ) VALUES (?, 'p0-rule', 'valid-p1-evaluation', 25, 'high', 30000, 'hot',
                  'indirect', 8, 'p0', 0, 1, ?, ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'duplicate-active-cadence': {
      const prospect = seedProspect(raw, 'active-cadence');
      const cycle = insertOpenCycleWithAction({ database: raw, prefix: 'active-cadence', prospect });
      insertCadenceDefinition(raw, 'cadence-one');
      raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          scheduled_step_count, created_at, updated_at
        ) VALUES ('enrollment-one', ?, 'cadence-one', 'active', ?, 0, ?, ?)
      `).run(cycle.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          scheduled_step_count, created_at, updated_at
        ) VALUES ('enrollment-two', ?, 'cadence-one', 'active', ?, 0, ?, ?)
      `).run(cycle.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'duplicate-provider-activity': {
      const prospect = seedProspect(raw, 'provider-event');
      insertRawActivity(raw, 'provider-first', prospect.personId, 'messages', 'provider-1');
      assert.throws(() => insertRawActivity(
        raw,
        'provider-second',
        prospect.personId,
        'messages',
        'provider-1',
      ));
      return;
    }
    case 'immutable-source': {
      const prospect = seedProspect(raw, 'immutable-source');
      assertImmutable(
        raw,
        'source_events',
        prospect.sourceEventId,
        "channel = 'frbo'",
      );
      return;
    }
    case 'immutable-activity': {
      const prospect = seedProspect(raw, 'immutable-activity');
      insertRawActivity(raw, 'immutable-activity-row', prospect.personId, null, null);
      assertImmutable(raw, 'activities', 'immutable-activity-row', "kind = 'note'");
      return;
    }
    case 'immutable-stage': {
      const prospect = seedProspect(raw, 'immutable-stage');
      const cycle = insertOpenCycleWithAction({ database: raw, prefix: 'immutable-stage', prospect });
      insertStageEvent(raw, 'immutable-stage-event', cycle.cycleId, 'unreviewed', 'ready');
      assertImmutable(raw, 'stage_events', 'immutable-stage-event', "to_stage = 'contacted'");
      return;
    }
    case 'immutable-trigger': {
      const prospect = seedProspect(raw, 'immutable-trigger');
      raw.prepare(`
        INSERT INTO trigger_events (
          id, prospect_id, source_event_id, trigger_type, effective_at,
          strength_multiplier, verification_state, evidence_json, created_at
        ) VALUES ('immutable-trigger-row', ?, ?, 'direct_referral', ?, 1.0,
                  'verified', '{}', ?)
      `).run(prospect.prospectId, prospect.sourceEventId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assertImmutable(
        raw,
        'trigger_events',
        'immutable-trigger-row',
        "trigger_type = 'live_vacancy'",
      );
      return;
    }
    case 'immutable-consent': {
      const prospect = seedProspect(raw, 'immutable-consent');
      raw.prepare(`
        INSERT INTO consent_policy_records (
          id, person_id, policy_kind, policy_version, effective_at,
          decision, evidence_json, created_at
        ) VALUES ('immutable-consent-row', ?, 'recording', 'v1', ?,
                  'granted', '{}', ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assertImmutable(
        raw,
        'consent_policy_records',
        'immutable-consent-row',
        "decision = 'denied'",
      );
      return;
    }
    case 'self-referral': {
      insertPerson(raw, 'self-referral-person');
      assert.throws(() => insertSourceEvent({
        database: raw,
        id: 'self-referral-source',
        personId: 'self-referral-person',
        channel: 'referral',
        referredByPersonId: 'self-referral-person',
      }));
      return;
    }
    case 'referral-without-referrer': {
      insertPerson(raw, 'missing-referrer-person');
      assert.throws(() => insertSourceEvent({
        database: raw,
        id: 'missing-referrer-source',
        personId: 'missing-referrer-person',
        channel: 'referral',
      }));
      return;
    }
    case 'undeletable-opt-out': {
      const prospect = seedProspect(raw, 'opt-out');
      raw.prepare(`
        INSERT INTO opt_out_tombstones (
          id, person_id, requested_at, observed_channel, policy_version, created_at
        ) VALUES ('opt-out-tombstone', ?, ?, 'text', 'v1', ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO opt_out_handles (
          id, tombstone_id, kind, normalized_value, created_at
        ) VALUES ('opt-out-handle', 'opt-out-tombstone', 'phone', '+14015550100', ?)
      `).run(DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(
        "DELETE FROM opt_out_handles WHERE id = 'opt-out-handle'",
      ).run());
      assert.throws(() => raw.prepare(
        "DELETE FROM opt_out_tombstones WHERE id = 'opt-out-tombstone'",
      ).run());
      return;
    }
    case 'fitness-before-interviewed': {
      const prospect = seedProspect(raw, 'fitness-before');
      const cycle = insertOpenCycleWithAction({ database: raw, prefix: 'fitness-before', prospect });
      assert.throws(() => raw.prepare(`
        UPDATE sales_cycles SET design_partner_fitness = 4 WHERE id = ?
      `).run(cycle.cycleId));
      return;
    }
    case 'fitness-after-stage-history': {
      const prospect = seedProspect(raw, 'fitness-history');
      const cycle = insertOpenCycleWithAction({ database: raw, prefix: 'fitness-history', prospect });
      insertStageEvent(raw, 'fitness-interviewed-event', cycle.cycleId, 'ready', 'interviewed');
      raw.prepare(`
        UPDATE sales_cycles SET design_partner_fitness = 5 WHERE id = ?
      `).run(cycle.cycleId);
      assert.deepEqual(
        raw.prepare<[], { design_partner_fitness: number }>(
          `SELECT design_partner_fitness FROM sales_cycles WHERE id = '${cycle.cycleId}'`,
        ).get(),
        { design_partner_fitness: 5 },
      );
      return;
    }
    case 'open-cycle-race': {
      const prospect = seedProspect(raw, 'race');
      closeDatabase(database);
      runOpenCycleRace(databasePath, prospect);
      return;
    }
    default:
      assert.fail(`Unknown domain-schema scenario: ${name}`);
  }
}

function assertObjectsExist(
  database: AppDatabase['raw'],
  type: 'index' | 'trigger',
  names: readonly string[],
): void {
  const actual = database.prepare<string[], { name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = ? AND name IN (${names.map(() => '?').join(',')})
    ORDER BY name
  `).all(type, ...names).map(({ name }) => name);
  assert.deepEqual(actual, [...names].sort());
}

function assertDeferredConstraint(
  database: AppDatabase['raw'],
  operation: () => void,
): void {
  let rejected = false;
  database.exec('BEGIN IMMEDIATE');
  try {
    try {
      operation();
      database.exec('COMMIT');
    } catch {
      rejected = true;
    }
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
  }
  assert.equal(rejected, true);
}

function insertRawAction(
  database: AppDatabase['raw'],
  actionId: string,
  cycleId: string,
): void {
  database.prepare(`
    INSERT INTO next_actions (
      id, sales_cycle_id, action_type, channel, status, due_at,
      timezone, created_at
    ) VALUES (?, ?, 'call', 'phone', 'pending', ?, 'America/New_York', ?)
  `).run(actionId, cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
}

function insertRawActivity(
  database: AppDatabase['raw'],
  id: string,
  personId: string,
  adapter: string | null,
  providerIdempotencyKey: string | null,
): void {
  database.prepare(`
    INSERT INTO activities (
      id, person_id, kind, direction, channel, occurred_at, adapter,
      provider_idempotency_key, metadata_json, created_at
    ) VALUES (?, ?, 'system', 'internal', 'system', ?, ?, ?, '{}', ?)
  `).run(
    id,
    personId,
    DOMAIN_TIMESTAMP,
    adapter,
    providerIdempotencyKey,
    DOMAIN_TIMESTAMP,
  );
}

function insertStageEvent(
  database: AppDatabase['raw'],
  id: string,
  cycleId: string,
  fromStage: string,
  toStage: string,
): void {
  database.prepare(`
    INSERT INTO stage_events (
      id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
      confirmation_kind, backfill_provenance_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'founder', NULL, ?)
  `).run(
    id,
    cycleId,
    fromStage,
    toStage,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertPrioritizationRule(
  database: AppDatabase['raw'],
  id: string,
): void {
  database.prepare(`
    INSERT INTO prioritization_rule_versions (
      id, version, content_hash, rules_json, active, created_at
    ) VALUES (?, 1, ?, '{}', 1, ?)
  `).run(id, `hash-${id}`, DOMAIN_TIMESTAMP);
}

function assertImmutable(
  database: AppDatabase['raw'],
  table: string,
  id: string,
  update: string,
): void {
  assert.throws(() => database.prepare(
    `UPDATE ${table} SET ${update} WHERE id = ?`,
  ).run(id));
  assert.throws(() => database.prepare(
    `DELETE FROM ${table} WHERE id = ?`,
  ).run(id));
}

function runOpenCycleRace(
  databasePath: string,
  prospect: { personId: string; prospectId: string; sourceEventId: string },
): void {
  const goPath = `${databasePath}.race-go`;
  const resultPaths = [
    `${databasePath}.race-result-one`,
    `${databasePath}.race-result-two`,
  ];
  for (const [index, resultPath] of resultPaths.entries()) {
    spawn(
      process.execPath,
      [
        __filename,
        'open-cycle-worker',
        databasePath,
        goPath,
        resultPath,
        `race-worker-${index}`,
        prospect.personId,
        prospect.prospectId,
        prospect.sourceEventId,
      ],
      { stdio: 'ignore' },
    );
  }
  const readyPaths = resultPaths.map((path) => `${path}.ready`);
  waitForPaths(readyPaths);
  writeFileSync(goPath, 'go', { flag: 'wx' });
  waitForPaths(resultPaths);
  const results = resultPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as {
    committed: boolean;
  });
  assert.equal(results.filter(({ committed }) => committed).length, 1);
  const reopened = openDatabase({ path: databasePath, key: createTestWorkspaceKey() });
  try {
    assert.deepEqual(
      reopened.raw.prepare<[string], { count: number }>(`
        SELECT COUNT(*) AS count FROM sales_cycles
        WHERE person_id = ? AND workflow_status IN ('active','onboarding')
      `).get(prospect.personId),
      { count: 1 },
    );
  } finally {
    closeDatabase(reopened);
  }
  for (const path of [goPath, ...resultPaths, ...readyPaths]) rmSync(path, { force: true });
}

function runOpenCycleWorker(): void {
  const [databasePath, goPath, resultPath, prefix, personId, prospectId, sourceEventId]
    = process.argv.slice(3);
  assert.ok(databasePath && goPath && resultPath && prefix && personId && prospectId && sourceEventId);
  const readyPath = `${resultPath}.ready`;
  writeFileSync(readyPath, 'ready', { flag: 'wx' });
  waitForPaths([goPath]);
  const database = openDatabase({ path: databasePath, key: createTestWorkspaceKey() });
  let committed = false;
  try {
    insertOpenCycleWithAction({
      database: database.raw,
      prefix,
      prospect: { personId, prospectId, sourceEventId },
    });
    committed = true;
  } catch {
    committed = false;
  } finally {
    closeDatabase(database);
  }
  writeFileSync(resultPath, JSON.stringify({ committed }), { flag: 'wx' });
}

function waitForPaths(paths: readonly string[]): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  while (!paths.every((path) => existsSync(path))) {
    assert.ok(Date.now() <= deadline, `Timed out waiting for ${paths.join(', ')}`);
    Atomics.wait(sleeper, 0, 0, 10);
  }
}
