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
  insertProspect,
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
  'cycle_reactivation_receipts',
  'learning_evidence',
  'learnings',
  'lifecycle_review_items',
  'next_actions',
  'opt_out_handles',
  'opt_out_closure_receipts',
  'opt_out_closure_receipt_handles',
  'opt_out_tombstones',
  'organization_aliases',
  'organizations',
  'persons',
  'person_contact_methods',
  'prioritization_evaluations',
  'prioritization_preference_events',
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
  'source_intake_receipts',
  'stage_events',
  'transcript_utterances',
  'transcripts',
  'trigger_events',
  'workspace_settings',
  'won_terms',
] as const;

const requiredIndexes = [
  'activities_provider_idempotency_idx',
  'jobs_type_idempotency_idx',
  'learning_evidence_learning_idx',
  'one_active_cadence_per_cycle',
  'one_open_cycle_per_person',
] as const;

const requiredTriggers = [
  'immutable_activities',
  'immutable_activities_delete',
  'immutable_activity_amendments',
  'immutable_activity_amendments_delete',
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
  'immutable_learning_evidence',
  'immutable_learning_evidence_delete',
  'immutable_transcript_utterances',
  'immutable_transcript_utterances_delete',
  'immutable_transcripts',
  'immutable_transcripts_delete',
  'protect_activity_transcript_attach',
  'protect_learning_delete',
  'protect_learning_identity',
  'immutable_opt_out_closure_receipts',
  'immutable_opt_out_closure_receipts_delete',
  'immutable_opt_out_closure_receipt_handles',
  'immutable_opt_out_closure_receipt_handles_delete',
  'protect_opt_out_closure_receipt_handle_insert',
  'immutable_won_terms',
  'immutable_won_terms_delete',
  'immutable_prioritization_evaluations',
  'immutable_prioritization_evaluations_delete',
  'immutable_prioritization_rule_versions',
  'immutable_prioritization_rule_versions_delete',
  'immutable_prioritization_preference_events',
  'immutable_prioritization_preference_events_delete',
  'protect_trigger_event_receipt_proof',
  'immutable_source_events',
  'immutable_source_events_delete',
  'immutable_source_intake_receipts',
  'immutable_source_intake_receipts_delete',
  'immutable_stage_events',
  'immutable_stage_events_delete',
  'immutable_trigger_events',
  'immutable_trigger_events_delete',
  'protect_cycle_entry_source',
  'protect_cycle_pointer_insert',
  'protect_cycle_pointer_update',
  'protect_current_action_delete',
  'protect_current_action_status',
  'protect_cadence_enrollment_step_insert',
  'protect_cadence_enrollment_step_update',
  'protect_cadence_enrollment_identity',
  'protect_cadence_enrollment_status',
  'protect_cadence_enrollment_delete',
  'protect_activity_cadence_insert',
  'protect_activity_cadence_update',
  'protect_design_partner_fitness',
  'protect_design_partner_fitness_update',
  'protect_initial_action_status',
  'protect_lifecycle_review_item_delete',
  'protect_lifecycle_review_item_identity',
  'protect_lifecycle_review_item_resolution',
  'protect_next_action_cadence_insert',
  'protect_next_action_cadence_update',
  'protect_next_action_immutable_evidence',
  'protect_next_action_inbound_sla_insert',
  'protect_next_action_inbound_sla_update',
  'protect_next_action_settlement',
  'protect_settled_next_action_schedule',
  'protect_next_action_delete',
  'protect_opt_out_handle',
  'protect_opt_out_handle_update',
  'protect_opted_out_contact_method_insert',
  'protect_opted_out_contact_method_update',
  'protect_opted_out_next_action_insert',
  'protect_opted_out_next_action_update',
  'protect_opted_out_operational_cycle_insert',
  'protect_opted_out_operational_cycle_update',
  'protect_opt_out_tombstone_active_cadence',
  'protect_opt_out_tombstone',
  'protect_opt_out_tombstone_update',
  'protect_opted_out_active_cadence',
  'protect_opted_out_active_cadence_update',
  'protect_p0_priority_override',
  'protect_priority_override_mutation',
  'protect_priority_override_delete',
  'protect_person_opt_out_insert',
  'protect_person_opt_out_reset',
  'protect_priority_projection_fidelity',
  'protect_priority_projection_fidelity_update',
  'protect_priority_projection_owner',
  'protect_projection_p0_override_delete',
  'protect_projection_p0_override_update',
  'protect_prospect_original_source',
  'protect_reactivation_rule_delete',
  'protect_reactivation_rule_update',
  'protect_source_intake_receipt_prospect',
  'protect_trigger_event_ownership',
  'synchronize_person_opt_out',
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
        { schema_version: 9 },
      );
      const actualTables = raw.prepare<string[], { name: string }>(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${domainTables.map(() => '?').join(',')})
        ORDER BY name
      `).all(...domainTables).map(({ name: table }) => table);
      assert.deepEqual(actualTables, [...domainTables].sort());
      assertObjectsExist(raw, 'index', requiredIndexes);
      assertObjectsExist(raw, 'trigger', requiredTriggers);
      assert.equal(
        raw.prepare<[], { count: number }>(`
          SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type = 'index' AND name = 'one_active_prioritization_rule'
        `).get()?.count,
        0,
      );
      const ruleColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(prioritization_rule_versions)',
      ).all().map(({ name }) => name);
      assert.equal(ruleColumns.includes('active'), false);
      const workspaceColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(workspace_settings)',
      ).all().map(({ name }) => name);
      assert.equal(workspaceColumns.includes('active_prioritization_rule_version_id'), true);
      const receiptColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(source_intake_receipts)',
      ).all().map(({ name }) => name);
      assert.deepEqual(receiptColumns, [
        'source_event_id', 'person_id', 'prospect_id',
        'command_json', 'result_json', 'created_at',
      ]);
      const stageEventColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(stage_events)',
      ).all().map(({ name }) => name);
      assert.equal(stageEventColumns.includes('transition_sequence'), true);
      const nextActionColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(next_actions)',
      ).all().map(({ name }) => name);
      for (const column of [
        'work_intent', 'sla_due_at', 'inbound_sla_kind', 'inbound_sla_due_at',
        'inbound_sla_source_event_id', 'inbound_sla_provenance_json',
        'settlement_json', 'version', 'updated_at',
      ]) {
        assert.equal(nextActionColumns.includes(column), true, `missing next_actions.${column}`);
      }
      const enrollmentColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(cadence_enrollments)',
      ).all().map(({ name }) => name);
      for (const column of ['mode', 'allowed_step_ids_json', 'version']) {
        assert.equal(enrollmentColumns.includes(column), true, `missing cadence_enrollments.${column}`);
      }
      const readinessColumns = raw.prepare<[], { name: string }>(
        'PRAGMA table_info(sales_cycle_close_readiness)',
      ).all().map(({ name }) => name);
      assert.equal(readinessColumns.includes('version'), true);
      const actualTriggers = raw.prepare<[], { name: string }>(`
        SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
      `).all().map(({ name }) => name);
      assert.deepEqual(actualTriggers, [...requiredTriggers].sort());
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
          UPDATE next_actions
          SET status = 'completed', completed_at = ?, settlement_json = '{}'
          WHERE id = ?
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
    case 'completed-action-before-cycle': {
      const prospect = seedProspect(raw, 'completed-before-cycle');
      assertDeferredConstraint(raw, () => {
        raw.prepare(`
          INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status, due_at,
            timezone, created_at, completed_at
          ) VALUES ('completed-before-cycle-action', 'completed-before-cycle-cycle',
                    'call', 'phone', 'completed', ?, 'America/New_York', ?, ?)
        `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage,
            workflow_status, current_next_action_id, stage_entered_at,
            version, created_at, updated_at
          ) VALUES ('completed-before-cycle-cycle', ?, ?, ?, 'ready', 'active',
                    'completed-before-cycle-action', ?, 1, ?, ?)
        `).run(
          prospect.personId,
          prospect.prospectId,
          prospect.sourceEventId,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
          DOMAIN_TIMESTAMP,
        );
      });
      return;
    }
    case 'lifecycle-retention-immutability': {
      const prospect = seedProspect(raw, 'lifecycle-retention');
      const closedCycleId = insertClosedCycle({
        database: raw, prefix: 'lifecycle-retention', prospect,
      });
      insertRawAction(raw, 'retained-action', closedCycleId);
      assert.throws(() => raw.prepare(`
        DELETE FROM next_actions WHERE id = 'retained-action'
      `).run());
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at,
          timezone, created_at
        ) VALUES ('retained-action', ?, 'call', 'phone', 'pending', ?,
          'America/New_York', ?)
      `).run(closedCycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));

      raw.prepare(`
        INSERT INTO won_terms (
          sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
          projected_mrr_cents, projection_formula_version, manual_projection_reason,
          founding_customer, effective_at, created_at
        ) VALUES (?, 12, 'per_door_monthly', 2500, 30000, 'v1', NULL, 1, ?, ?)
      `).run(closedCycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        UPDATE won_terms SET doors_committed = 13 WHERE sales_cycle_id = ?
      `).run(closedCycleId));
      assert.throws(() => raw.prepare(`
        DELETE FROM won_terms WHERE sales_cycle_id = ?
      `).run(closedCycleId));
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO won_terms (
          sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
          projected_mrr_cents, projection_formula_version, manual_projection_reason,
          founding_customer, effective_at, created_at
        ) VALUES (?, 12, 'per_door_monthly', 2500, 30000, 'v1', NULL, 1, ?, ?)
      `).run(closedCycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));

      const open = insertOpenCycleWithAction({
        database: raw, prefix: 'immutable-enrollment-plan',
        prospect: seedProspect(raw, 'immutable-enrollment-plan'),
      });
      insertCadenceDefinition(raw, 'immutable-enrollment-definition');
      insertCadenceEnrollment(
        raw, 'immutable-enrollment', open.cycleId, 'immutable-enrollment-definition',
      );
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments SET mode = 'inbound_over_cap_response'
        WHERE id = 'immutable-enrollment'
      `).run());
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments SET allowed_step_ids_json = '["forged-step"]'
        WHERE id = 'immutable-enrollment'
      `).run());
      raw.prepare(`
        UPDATE cadence_enrollments
        SET status = 'stopped', stop_reason = 'test'
        WHERE id = 'immutable-enrollment'
      `).run();
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments
        SET status = 'active', stop_reason = NULL
        WHERE id = 'immutable-enrollment'
      `).run());
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments
        SET status = 'completed'
        WHERE id = 'immutable-enrollment'
      `).run());
      return;
    }
    case 'p0-without-direct-reachability': {
      const prospect = seedProspect(raw, 'p0-indirect');
      insertPrioritizationRule(raw, 'p0-rule');
      assert.throws(() => raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, decision_kind, evaluated_at,
          fit_points, fit_band, timing_millipoints, timing_band, reachability,
          data_confidence, priority, verify_first, command_json,
          input_snapshot_json, result_json, explanation_json, created_at
        ) VALUES ('invalid-p0-evaluation', ?, 'p0-rule', 'evaluated', ?, 25, 'high',
                  30000, 'hot', 'indirect', 8, 'p0', 0, '{}', '{}', '{}', '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, decision_kind, evaluated_at,
          fit_points, fit_band, timing_millipoints, timing_band, reachability,
          data_confidence, priority, verify_first, command_json,
          input_snapshot_json, result_json, explanation_json, created_at
        ) VALUES ('valid-p1-evaluation', ?, 'p0-rule', 'evaluated', ?, 25, 'high',
                  30000, 'hot', 'indirect', 8, 'p1', 0, '{}', '{}', '{}', '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT INTO prospect_priority_projection (
          prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
          timing_millipoints, timing_band, reachability, data_confidence,
          priority, verify_first, version, evaluated_at, updated_at
        ) VALUES (?, 'p0-rule', 'valid-p1-evaluation', 25, 'high', 30000, 'hot',
                  'indirect', 8, 'p0', 0, 1, ?, ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      assert.throws(() => raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, decision_kind, evaluated_at,
          fit_points, fit_band, timing_millipoints, timing_band, reachability,
          data_confidence, priority, verify_first, command_json,
          input_snapshot_json, result_json, qualification_json, explanation_json,
          created_at
        ) VALUES ('invalid-gated-with-axes', ?, 'p0-rule', 'not_prioritizable', ?,
                  25, 'high', 30000, 'hot', 'indirect', 8, 'p1', 0, '{}', '{}',
                  '{}', '{}', '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      raw.prepare(`
        INSERT INTO prioritization_evaluations (
          id, prospect_id, rule_version_id, decision_kind, evaluated_at,
          command_json, input_snapshot_json, result_json, qualification_json,
          explanation_json, created_at
        ) VALUES ('valid-gated-evaluation', ?, 'p0-rule', 'not_prioritizable', ?,
                  '{}', '{}', '{}', '{}', '[]', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT INTO prospect_priority_projection (
          prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
          timing_millipoints, timing_band, reachability, data_confidence,
          priority, verify_first, version, evaluated_at, updated_at
        ) VALUES (?, 'p0-rule', 'valid-gated-evaluation', 25, 'high', 30000, 'hot',
                  'indirect', 8, 'p1', 0, 1, ?, ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'priority-projection-fidelity': {
      const first = seedProspect(raw, 'projection-first');
      const second = seedProspect(raw, 'projection-second');
      insertPrioritizationRule(raw, 'projection-rule');
      insertPrioritizationEvaluation(raw, {
        id: 'projection-evaluation',
        prospectId: first.prospectId,
        ruleId: 'projection-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      assert.throws(() => insertPriorityProjection(raw, {
        prospectId: second.prospectId,
        evaluationId: 'projection-evaluation',
        ruleId: 'projection-rule',
        reachability: 'direct',
        priority: 'p1',
      }));
      assert.throws(() => insertPriorityProjection(raw, {
        prospectId: first.prospectId,
        evaluationId: 'projection-evaluation',
        ruleId: 'projection-rule',
        reachability: 'direct',
        priority: 'p2',
      }));
      insertPriorityProjection(raw, {
        prospectId: first.prospectId,
        evaluationId: 'projection-evaluation',
        ruleId: 'projection-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      assert.throws(() => raw.prepare(`
        UPDATE prospect_priority_projection
        SET fit_points = 24
        WHERE prospect_id = ?
      `).run(first.prospectId));
      insertPrioritizationEvaluation(raw, {
        id: 'projection-second-evaluation',
        prospectId: second.prospectId,
        ruleId: 'projection-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      assert.throws(() => raw.prepare(`
        UPDATE prospect_priority_projection
        SET prospect_id = ?, evaluation_id = 'projection-second-evaluation'
        WHERE prospect_id = ?
      `).run(second.prospectId, first.prospectId));
      return;
    }
    case 'priority-override-p0-gate': {
      const missing = seedProspect(raw, 'override-missing');
      const indirect = seedProspect(raw, 'override-indirect');
      const direct = seedProspect(raw, 'override-direct');
      insertPrioritizationRule(raw, 'override-rule');
      insertPrioritizationEvaluation(raw, {
        id: 'override-indirect-evaluation',
        prospectId: indirect.prospectId,
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      insertPriorityProjection(raw, {
        prospectId: indirect.prospectId,
        evaluationId: 'override-indirect-evaluation',
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      insertPrioritizationEvaluation(raw, {
        id: 'override-direct-evaluation',
        prospectId: direct.prospectId,
        ruleId: 'override-rule',
        reachability: 'direct',
        priority: 'p0',
      });
      insertPriorityProjection(raw, {
        prospectId: direct.prospectId,
        evaluationId: 'override-direct-evaluation',
        ruleId: 'override-rule',
        reachability: 'direct',
        priority: 'p0',
      });
      assert.throws(() => insertPriorityOverride(raw, 'override-missing-p0', missing.prospectId, 'p0'));
      assert.throws(() => insertPriorityOverride(raw, 'override-indirect-p0', indirect.prospectId, 'p0'));
      insertPriorityOverride(raw, 'override-direct-p0', direct.prospectId, 'p0');
      insertPrioritizationEvaluation(raw, {
        id: 'override-direct-replace-indirect-evaluation',
        prospectId: direct.prospectId,
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      assert.throws(() => replacePriorityProjection(raw, {
        prospectId: direct.prospectId,
        evaluationId: 'override-direct-replace-indirect-evaluation',
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      }));
      assert.throws(() => raw.prepare(`
        UPDATE priority_overrides SET prospect_id = ? WHERE id = 'override-direct-p0'
      `).run(indirect.prospectId));
      insertPriorityOverride(raw, 'override-indirect-p1', indirect.prospectId, 'p1');
      assert.throws(() => raw.prepare(`
        UPDATE priority_overrides SET priority = 'p0' WHERE id = 'override-indirect-p1'
      `).run());
      insertPrioritizationEvaluation(raw, {
        id: 'override-direct-now-indirect-evaluation',
        prospectId: direct.prospectId,
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      assert.throws(() => raw.prepare(`
        UPDATE prospect_priority_projection
        SET evaluation_id = 'override-direct-now-indirect-evaluation',
            reachability = 'indirect', priority = 'p1'
        WHERE prospect_id = ?
      `).run(direct.prospectId));
      assert.throws(() => raw.prepare(`
        DELETE FROM prospect_priority_projection WHERE prospect_id = ?
      `).run(direct.prospectId));

      insertPriorityOverride(
        raw,
        'override-missing-expired-p0',
        missing.prospectId,
        'p0',
        '2000-01-01T00:00:00.000Z',
        'expired',
      );
      assert.throws(() => insertPriorityOverride(
        raw,
        'override-missing-active-p0',
        missing.prospectId,
        'p0',
        '2000-01-01T00:00:00.000Z',
      ));
      assert.throws(() => raw.prepare(`
        UPDATE priority_overrides
        SET expires_at = '9999-12-31T23:59:59.999Z'
        WHERE id = 'override-missing-expired-p0'
      `).run());
      insertPriorityOverride(
        raw,
        'override-indirect-expired-p0',
        indirect.prospectId,
        'p0',
        '2000-01-01T00:00:00.000Z',
        'expired',
      );
      assert.throws(() => raw.prepare(`
        UPDATE priority_overrides
        SET expires_at = '9999-12-31T23:59:59.999Z'
        WHERE id = 'override-indirect-expired-p0'
      `).run());

      const expired = seedProspect(raw, 'override-expired');
      insertPrioritizationEvaluation(raw, {
        id: 'override-expired-direct-evaluation',
        prospectId: expired.prospectId,
        ruleId: 'override-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      insertPriorityProjection(raw, {
        prospectId: expired.prospectId,
        evaluationId: 'override-expired-direct-evaluation',
        ruleId: 'override-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      insertPriorityOverride(
        raw,
        'override-expired-p0',
        expired.prospectId,
        'p0',
        '2000-01-01T00:00:00.000Z',
        'expired',
      );
      insertPrioritizationEvaluation(raw, {
        id: 'override-expired-indirect-evaluation',
        prospectId: expired.prospectId,
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      replacePriorityProjection(raw, {
        prospectId: expired.prospectId,
        evaluationId: 'override-expired-indirect-evaluation',
        ruleId: 'override-rule',
        reachability: 'indirect',
        priority: 'p1',
      });
      raw.prepare(`
        UPDATE prospect_priority_projection
        SET evaluation_id = 'override-expired-direct-evaluation',
            reachability = 'direct'
        WHERE prospect_id = ?
      `).run(expired.prospectId);
      raw.prepare(`
        DELETE FROM prospect_priority_projection WHERE prospect_id = ?
      `).run(expired.prospectId);
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
    case 'opt-out-synchronizes-person': {
      const prospect = seedProspect(raw, 'opt-out-sync');
      insertOptOutTombstone(raw, 'opt-out-sync-tombstone', prospect.personId);
      assert.deepEqual(
        raw.prepare<[string], { opted_out: number; opted_out_at: string | null }>(`
          SELECT opted_out, opted_out_at FROM persons WHERE id = ?
        `).get(prospect.personId),
        { opted_out: 1, opted_out_at: DOMAIN_TIMESTAMP },
      );
      return;
    }
    case 'opt-out-rejects-active-cadence': {
      const prospect = seedProspect(raw, 'opt-out-active');
      const cycle = insertOpenCycleWithAction({ database: raw, prefix: 'opt-out-active', prospect });
      insertCadenceDefinition(raw, 'opt-out-active-cadence');
      insertCadenceEnrollment(raw, 'opt-out-active-enrollment', cycle.cycleId, 'opt-out-active-cadence');
      assert.throws(() => insertOptOutTombstone(
        raw,
        'opt-out-active-tombstone',
        prospect.personId,
      ));
      return;
    }
    case 'opt-out-rejects-open-workflow-or-pending-outbound': {
      const openProspect = seedProspect(raw, 'opt-out-open-workflow');
      insertOpenCycleWithAction({ database: raw, prefix: 'opt-out-open-workflow', prospect: openProspect });
      assert.throws(() => insertOptOutTombstone(
        raw,
        'opt-out-open-workflow-tombstone',
        openProspect.personId,
      ));

      const pendingProspect = seedProspect(raw, 'opt-out-pending-outbound');
      const closedCycleId = insertClosedCycle({
        database: raw, prefix: 'opt-out-pending-outbound', prospect: pendingProspect,
      });
      insertRawAction(raw, 'opt-out-stale-outbound', closedCycleId);
      assert.throws(() => insertOptOutTombstone(
        raw,
        'opt-out-pending-outbound-tombstone',
        pendingProspect.personId,
      ));
      return;
    }
    case 'opt-out-tombstone-cadence-guard': {
      const prospect = seedProspect(raw, 'opt-out-tombstone-guard');
      const cycleId = insertClosedCycle({
        database: raw,
        prefix: 'opt-out-tombstone-guard',
        prospect,
      });
      insertCadenceDefinition(raw, 'opt-out-tombstone-cadence');
      insertOptOutTombstone(raw, 'opt-out-tombstone-guard-row', prospect.personId);
      raw.exec('DROP TRIGGER IF EXISTS protect_person_opt_out_reset');
      raw.prepare(`
        UPDATE persons SET opted_out = 0, opted_out_at = NULL WHERE id = ?
      `).run(prospect.personId);
      assert.throws(() => insertCadenceEnrollment(
        raw,
        'opt-out-tombstone-enrollment',
        cycleId,
        'opt-out-tombstone-cadence',
      ));
      return;
    }
    case 'opt-out-cadence-status-reactivation': {
      const prospect = seedProspect(raw, 'cadence-status-reactivation');
      const cycleId = insertClosedCycle({
        database: raw,
        prefix: 'cadence-status-reactivation',
        prospect,
      });
      insertCadenceDefinition(raw, 'cadence-status-reactivation-definition');
      raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          scheduled_step_count, stop_reason, created_at, updated_at
        ) VALUES ('cadence-status-reactivation-enrollment', ?,
                  'cadence-status-reactivation-definition', 'stopped', ?, 0,
                  'paused', ?, ?)
      `).run(cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      insertOptOutTombstone(raw, 'cadence-status-reactivation-tombstone', prospect.personId);
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments SET status = 'active', stop_reason = NULL
        WHERE id = 'cadence-status-reactivation-enrollment'
      `).run());
      return;
    }
    case 'opt-out-cadence-cycle-move': {
      const eligible = seedProspect(raw, 'cadence-move-eligible');
      const blocked = seedProspect(raw, 'cadence-move-blocked');
      const eligibleCycle = insertOpenCycleWithAction({
        database: raw,
        prefix: 'cadence-move-eligible',
        prospect: eligible,
      });
      const blockedCycleId = insertClosedCycle({
        database: raw,
        prefix: 'cadence-move-blocked',
        prospect: blocked,
      });
      insertCadenceDefinition(raw, 'cadence-move-definition');
      insertOptOutTombstone(raw, 'cadence-move-blocked-tombstone', blocked.personId);
      insertCadenceEnrollment(
        raw,
        'cadence-move-enrollment',
        eligibleCycle.cycleId,
        'cadence-move-definition',
      );
      assert.throws(() => raw.prepare(`
        UPDATE cadence_enrollments SET sales_cycle_id = ? WHERE id = 'cadence-move-enrollment'
      `).run(blockedCycleId));
      return;
    }
    case 'opt-out-person-projection-requires-tombstone': {
      assert.throws(() => raw.prepare(`
        INSERT INTO persons (
          id, display_name, aliases_json, opted_out, opted_out_at, never_record,
          version, created_at, updated_at
        ) VALUES ('projection-only-insert', 'Projection only insert', '[]', 1, ?,
                  0, 1, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      const prospect = seedProspect(raw, 'projection-only-update');
      assert.throws(() => raw.prepare(`
        UPDATE persons SET opted_out = 1, opted_out_at = ? WHERE id = ?
      `).run(DOMAIN_TIMESTAMP, prospect.personId));
      return;
    }
    case 'opt-out-contact-guard-projection-only': {
      const prospect = seedProspect(raw, 'projection-only-contact');
      raw.exec('DROP TRIGGER protect_person_opt_out_reset');
      raw.prepare(`
        UPDATE persons SET opted_out = 1, opted_out_at = ? WHERE id = ?
      `).run(DOMAIN_TIMESTAMP, prospect.personId);
      assert.throws(() => raw.prepare(`
        INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES ('projection-only-contact-method', ?, 'phone', '+14015550999',
                  'valid', 'direct', 0, ?, ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'opt-out-person-reset': {
      const prospect = seedProspect(raw, 'opt-out-person-reset');
      insertOptOutTombstone(raw, 'opt-out-person-reset-row', prospect.personId);
      assert.throws(() => raw.prepare(`
        UPDATE persons SET opted_out = 0, opted_out_at = NULL WHERE id = ?
      `).run(prospect.personId));
      assert.throws(() => raw.prepare(`
        UPDATE persons SET opted_out_at = '2026-09-01T12:00:00.000Z' WHERE id = ?
      `).run(prospect.personId));
      assert.throws(() => raw.prepare(`
        UPDATE persons SET opted_out = 1, opted_out_at = NULL WHERE id = ?
      `).run(prospect.personId));
      return;
    }
    case 'opt-out-rejects-invalid-row': {
      const prospect = seedProspect(raw, 'opt-out-invalid');
      insertRawActivity(raw, 'opt-out-invalid-evidence', prospect.personId, null, null);
      const insert = raw.prepare(`
        INSERT INTO opt_out_tombstones (
          id, person_id, requested_at, observed_channel, source_activity_id,
          policy_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      assert.throws(() => insert.run(
        'missing-activity', prospect.personId, DOMAIN_TIMESTAMP, 'manual',
        null, 'founder_opt_out_v1', DOMAIN_TIMESTAMP,
      ));
      assert.throws(() => insert.run(
        'bad-channel', prospect.personId, DOMAIN_TIMESTAMP, 'text',
        'opt-out-invalid-evidence', 'founder_opt_out_v1', DOMAIN_TIMESTAMP,
      ));
      assert.throws(() => insert.run(
        'bad-time', prospect.personId, '2026-08-30 12:00:00', 'manual',
        'opt-out-invalid-evidence', 'founder_opt_out_v1', DOMAIN_TIMESTAMP,
      ));
      assert.throws(() => insert.run(
        'blank-policy', prospect.personId, DOMAIN_TIMESTAMP, 'manual',
        'opt-out-invalid-evidence', '   ', DOMAIN_TIMESTAMP,
      ));
      const other = seedProspect(raw, 'opt-out-invalid-other');
      assert.throws(() => insert.run(
        'wrong-owner', other.personId, DOMAIN_TIMESTAMP, 'manual',
        'opt-out-invalid-evidence', 'founder_opt_out_v1', DOMAIN_TIMESTAMP,
      ));
      insertOptOutTombstone(raw, 'invalid-handle-tombstone', other.personId);
      assert.throws(() => raw.prepare(`
        INSERT INTO opt_out_handles (
          id, tombstone_id, kind, normalized_value, created_at
        ) VALUES ('invalid-handle-time', 'invalid-handle-tombstone', 'phone',
                  '+14015550100', 'not-a-time')
      `).run());
      return;
    }
    case 'opt-out-guards-cycle-action-contact': {
      const blocked = seedProspect(raw, 'opt-out-guard-blocked');
      insertOptOutTombstone(raw, 'opt-out-guard-tombstone', blocked.personId);
      const clean = seedProspect(raw, 'opt-out-guard-clean');
      const closedCycleId = insertClosedCycle({
        database: raw, prefix: 'opt-out-guard-clean', prospect: clean,
      });
      assert.throws(() => raw.prepare(`
        UPDATE sales_cycles SET person_id = ? WHERE id = ?
      `).run(blocked.personId, closedCycleId));
      assert.throws(() => raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone, created_at
        ) VALUES ('blocked-action', ?, 'call', 'phone', 'pending', ?,
                  'America/New_York', ?)
      `).run(
        insertClosedCycle({ database: raw, prefix: 'opt-out-guard-blocked', prospect: blocked }),
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      ));
      raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone, created_at
        ) VALUES ('blocked-internal', ?, 'internal_review', NULL, 'pending', ?,
                  'America/New_York', ?)
      `).run(
        insertClosedCycle({ database: raw, prefix: 'opt-out-guard-internal', prospect: blocked }),
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      assert.throws(() => raw.prepare(`
        INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES ('unretained-contact', ?, 'phone', '+14015550999', 'valid',
                  'direct', 0, ?, ?)
      `).run(blocked.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      raw.prepare(`
        INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
        VALUES ('retained-handle', 'opt-out-guard-tombstone', 'phone', '+14015550999', ?)
      `).run(DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES ('retained-contact', ?, 'phone', '+14015550999', 'valid',
                  'direct', 0, ?, ?)
      `).run(blocked.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      return;
    }
    case 'replace-opt-out-retention': {
      const first = seedProspect(raw, 'opt-out-replace-first');
      const second = seedProspect(raw, 'opt-out-replace-second');
      insertOptOutTombstone(raw, 'opt-out-replace-tombstone', first.personId);
      raw.prepare(`
        INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
        VALUES ('opt-out-replace-handle', 'opt-out-replace-tombstone', 'phone',
                '+14015550100', ?)
      `).run(DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO opt_out_tombstones (
          id, person_id, requested_at, observed_channel, source_activity_id,
          policy_version, created_at
        ) SELECT id, person_id, requested_at, observed_channel, source_activity_id,
                 policy_version, created_at
          FROM opt_out_tombstones WHERE id = 'opt-out-replace-tombstone'
      `).run());
      const secondEvidence = 'opt-out-replace-second-opt-out-evidence';
      insertRawActivity(raw, secondEvidence, second.personId, null, null);
      insertOptOutTombstone(raw, 'opt-out-replace-second-tombstone', second.personId);
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO opt_out_tombstones (
          id, person_id, requested_at, observed_channel, source_activity_id,
          policy_version, created_at
        ) VALUES ('replacement-id', ?, ?, 'manual', ?, 'founder_opt_out_v1', ?)
      `).run(second.personId, DOMAIN_TIMESTAMP, secondEvidence, DOMAIN_TIMESTAMP));
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO opt_out_handles (
          id, tombstone_id, kind, normalized_value, created_at
        ) VALUES ('replacement-handle-id', 'opt-out-replace-tombstone', 'phone',
                  '+14015550100', ?)
      `).run(DOMAIN_TIMESTAMP));
      return;
    }
    case 'opt-out-closure-receipt-retention': {
      const prospect = seedProspect(raw, 'closure-receipt');
      insertOptOutTombstone(raw, 'closure-receipt-tombstone', prospect.personId);
      raw.prepare(`
        INSERT INTO opt_out_closure_receipts (
          source_activity_id, operation_kind, person_id, tombstone_id,
          source_tombstone_id, closed_cycle_id, terminal_stage_event_id,
          command_json, result_json, created_at
        ) VALUES ('closure-receipt-tombstone-activity', 'apply', ?,
                  'closure-receipt-tombstone', NULL, NULL, NULL, '{}',
                  '{"handles":[{"id":"closure-receipt-member-handle"}]}', ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO opt_out_handles (
          id, tombstone_id, kind, normalized_value, created_at
        ) VALUES ('closure-receipt-member-handle', 'closure-receipt-tombstone',
                  'phone', '+14015550100', ?)
      `).run(DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO opt_out_closure_receipt_handles (
          source_activity_id, tombstone_id, handle_id, sequence
        ) VALUES ('closure-receipt-tombstone-activity', 'closure-receipt-tombstone',
                  'closure-receipt-member-handle', 0)
      `).run();
      raw.prepare(`
        INSERT INTO opt_out_handles (
          id, tombstone_id, kind, normalized_value, created_at
        ) VALUES ('closure-receipt-late-handle', 'closure-receipt-tombstone',
                  'email', 'later@example.com', ?)
      `).run(DOMAIN_TIMESTAMP);
      assert.throws(() => raw.prepare(`
        INSERT INTO opt_out_closure_receipt_handles (
          source_activity_id, tombstone_id, handle_id, sequence
        ) VALUES ('closure-receipt-tombstone-activity', 'closure-receipt-tombstone',
                  'closure-receipt-late-handle', 1)
      `).run());
      assertImmutable(raw, 'opt_out_closure_receipts', 'closure-receipt-tombstone-activity',
        "command_json = '{\"changed\":true}'", 'source_activity_id');
      assertImmutable(raw, 'opt_out_closure_receipt_handles',
        'closure-receipt-tombstone-activity', 'sequence = 1', 'source_activity_id');
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO opt_out_closure_receipt_handles (
          source_activity_id, tombstone_id, handle_id, sequence
        ) VALUES ('closure-receipt-tombstone-activity', 'closure-receipt-tombstone',
                  'closure-receipt-member-handle', 0)
      `).run());
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO opt_out_closure_receipts (
          source_activity_id, operation_kind, person_id, tombstone_id,
          source_tombstone_id, closed_cycle_id, terminal_stage_event_id,
          command_json, result_json, created_at
        ) VALUES ('closure-receipt-tombstone-activity', 'apply', ?,
                  'closure-receipt-tombstone', NULL, NULL, NULL, '{}', '{}', ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP));
      const other = seedProspect(raw, 'closure-receipt-other');
      assert.throws(() => raw.prepare(`
        INSERT INTO opt_out_closure_receipts (
          source_activity_id, operation_kind, person_id, tombstone_id,
          source_tombstone_id, closed_cycle_id, terminal_stage_event_id,
          command_json, result_json, created_at
        ) VALUES ('closure-receipt-tombstone-activity', 'apply', ?,
                  'closure-receipt-tombstone', NULL, NULL, NULL, '{}', '{}', ?)
      `).run(other.personId, DOMAIN_TIMESTAMP));
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
    case 'activity-evidence-ownership': {
      const first = seedProspect(raw, 'activity-owner-first');
      const second = seedProspect(raw, 'activity-owner-second');
      const secondCycle = insertClosedCycle({
        database: raw,
        prefix: 'activity-owner-second',
        prospect: second,
      });
      assert.throws(() => insertOwnedActivity(raw, {
        id: 'activity-wrong-prospect',
        personId: first.personId,
        prospectId: second.prospectId,
      }));
      assert.throws(() => insertOwnedActivity(raw, {
        id: 'activity-wrong-cycle',
        personId: first.personId,
        salesCycleId: secondCycle,
      }));
      insertRawActivity(raw, 'activity-owner-second-evidence', second.personId, null, null);
      assert.throws(() => raw.prepare(`
        INSERT INTO opt_out_tombstones (
          id, person_id, requested_at, observed_channel, source_activity_id,
          policy_version, created_at
        ) VALUES ('opt-out-wrong-activity', ?, ?, 'text',
                  'activity-owner-second-evidence', 'v1', ?)
      `).run(first.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      return;
    }
    case 'consent-activity-ownership': {
      const first = seedProspect(raw, 'consent-owner-first');
      const second = seedProspect(raw, 'consent-owner-second');
      insertRawActivity(raw, 'consent-owner-activity', first.personId, null, null);
      assert.throws(() => insertConsentRecord(raw, {
        id: 'consent-wrong-activity',
        personId: second.personId,
        activityId: 'consent-owner-activity',
      }));
      insertConsentRecord(raw, {
        id: 'consent-owner-record',
        personId: second.personId,
      });
      assert.throws(() => insertOwnedActivity(raw, {
        id: 'activity-wrong-consent',
        personId: first.personId,
        consentPolicyRecordId: 'consent-owner-record',
      }));
      return;
    }
    case 'deferred-media-consent-cycle': {
      const prospect = seedProspect(raw, 'deferred-media');
      raw.exec('BEGIN IMMEDIATE');
      raw.prepare(`
        INSERT INTO consent_policy_records (
          id, person_id, activity_id, policy_kind, policy_version, effective_at,
          decision, evidence_json, created_at
        ) VALUES (
          'deferred-media-consent', ?, 'deferred-media-activity', 'recording',
          'v1', ?, 'granted', '{}', ?
        )
      `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO activities (
          id, person_id, prospect_id, kind, direction, channel, occurred_at,
          consent_policy_record_id, recording_storage_ref, metadata_json, created_at
        ) VALUES (
          'deferred-media-activity', ?, ?, 'call', 'outbound', 'phone', ?,
          'deferred-media-consent', 'media/recording.enc', '{}', ?
        )
      `).run(prospect.personId, prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      raw.exec('COMMIT');
      assert.deepEqual(raw.prepare(`
        SELECT activity_id FROM consent_policy_records
        WHERE id = 'deferred-media-consent'
      `).get(), { activity_id: 'deferred-media-activity' });

      const other = seedProspect(raw, 'deferred-media-other');
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw.prepare(`
          INSERT INTO consent_policy_records (
            id, person_id, activity_id, policy_kind, policy_version, effective_at,
            decision, evidence_json, created_at
          ) VALUES (
            'deferred-mismatch-consent', ?, 'deferred-mismatch-activity',
            'recording', 'v1', ?, 'granted', '{}', ?
          )
        `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        raw.prepare(`
          INSERT INTO activities (
            id, person_id, prospect_id, kind, direction, channel, occurred_at,
            consent_policy_record_id, recording_storage_ref, metadata_json, created_at
          ) VALUES (
            'deferred-mismatch-activity', ?, ?, 'call', 'outbound', 'phone', ?,
            'deferred-mismatch-consent', 'media/mismatch.enc', '{}', ?
          )
        `).run(other.personId, other.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        assert.throws(() => raw.exec('COMMIT'));
      } finally {
        if (raw.inTransaction) raw.exec('ROLLBACK');
      }
      return;
    }
    case 'trigger-source-ownership': {
      const first = seedProspect(raw, 'trigger-owner-first');
      const second = seedProspect(raw, 'trigger-owner-second');
      insertSourceEvent({
        database: raw,
        id: 'trigger-owner-first-referral',
        personId: first.personId,
        channel: 'referral',
        referrerUnknownReason: 'fixture',
      });
      insertSourceEvent({
        database: raw,
        id: 'trigger-owner-second-referral',
        personId: second.personId,
        channel: 'referral',
        referrerUnknownReason: 'fixture',
      });
      assert.throws(() => insertTriggerEvent(raw, {
        id: 'trigger-wrong-source',
        prospectId: first.prospectId,
        sourceEventId: 'trigger-owner-second-referral',
      }));
      assert.throws(() => insertTriggerEvent(raw, {
        id: 'trigger-wrong-channel',
        prospectId: first.prospectId,
        sourceEventId: first.sourceEventId,
      }));
      insertTriggerEvent(raw, {
        id: 'trigger-valid-source',
        prospectId: first.prospectId,
        sourceEventId: 'trigger-owner-first-referral',
      });
      assert.throws(() => raw.prepare(`
        UPDATE trigger_events SET source_event_id = ? WHERE id = 'trigger-valid-source'
      `).run('trigger-owner-second-referral'));
      return;
    }
    case 'completion-activity-ownership': {
      const first = seedProspect(raw, 'completion-owner-first');
      const second = seedProspect(raw, 'completion-owner-second');
      const firstCycle = insertClosedCycle({
        database: raw,
        prefix: 'completion-owner-first',
        prospect: first,
      });
      const secondCycle = insertClosedCycle({
        database: raw,
        prefix: 'completion-owner-second',
        prospect: second,
      });
      insertOwnedActivity(raw, {
        id: 'completion-owner-activity',
        personId: second.personId,
        prospectId: second.prospectId,
        salesCycleId: secondCycle,
      });
      assert.throws(() => raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          completion_activity_id, created_at, completed_at
        ) VALUES ('completion-wrong-insert', ?, 'call', 'phone', 'completed', ?,
                  'America/New_York', 'completion-owner-activity', ?, ?)
      `).run(firstCycle, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP));
      insertRawAction(raw, 'completion-wrong-update', firstCycle);
      assert.throws(() => raw.prepare(`
        UPDATE next_actions
        SET status = 'completed', completion_activity_id = 'completion-owner-activity',
            completed_at = ?
        WHERE id = 'completion-wrong-update'
      `).run(DOMAIN_TIMESTAMP));
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
    case 'replace-immutable-source': {
      const prospect = seedProspect(raw, 'replace-immutable-source');
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO source_events (
          id, person_id, channel, observed_at, source_record_json, created_at
        ) VALUES (?, ?, 'frbo', '2026-09-01T12:00:00.000Z', '{}', ?)
      `).run(
        prospect.sourceEventId,
        prospect.personId,
        DOMAIN_TIMESTAMP,
      ));
      assert.deepEqual(
        raw.prepare<[string], { channel: string; observed_at: string }>(`
          SELECT channel, observed_at FROM source_events WHERE id = ?
        `).get(prospect.sourceEventId),
        { channel: 'custom', observed_at: DOMAIN_TIMESTAMP },
      );
      return;
    }
    case 'immutable-source-intake-receipt': {
      const prospect = seedProspect(raw, 'immutable-intake-receipt');
      insertSourceIntakeReceipt(raw, prospect, 'original-command');
      assert.throws(() => raw.prepare(`
        UPDATE source_intake_receipts SET command_json = '{"changed":true}'
        WHERE source_event_id = ?
      `).run(prospect.sourceEventId));
      assert.throws(() => raw.prepare(`
        DELETE FROM source_intake_receipts WHERE source_event_id = ?
      `).run(prospect.sourceEventId));
      return;
    }
    case 'replace-immutable-source-intake-receipt': {
      const prospect = seedProspect(raw, 'replace-intake-receipt');
      insertSourceIntakeReceipt(raw, prospect, 'original-command');
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO source_intake_receipts (
          source_event_id, person_id, prospect_id,
          command_json, result_json, created_at
        ) VALUES (?, ?, ?, '{"replacement":true}', '{"replacement":true}', ?)
      `).run(
        prospect.sourceEventId, prospect.personId, prospect.prospectId, DOMAIN_TIMESTAMP,
      ));
      assert.deepEqual(raw.prepare(`
        SELECT command_json FROM source_intake_receipts WHERE source_event_id = ?
      `).get(prospect.sourceEventId), {
        command_json: JSON.stringify({
          formatVersion: 1,
          command: { marker: 'original-command' },
        }),
      });
      return;
    }
    case 'source-intake-receipt-ownership': {
      const prospect = seedProspect(raw, 'intake-receipt-owner');
      assertDeferredConstraint(raw, () => {
        raw.prepare(`
          INSERT INTO source_intake_receipts (
            source_event_id, person_id, prospect_id,
            command_json, result_json, created_at
          ) VALUES (?, 'ghost-person', ?, '{}', '{}', ?)
        `).run(prospect.sourceEventId, prospect.prospectId, DOMAIN_TIMESTAMP);
      });
      assertDeferredConstraint(raw, () => {
        raw.prepare(`
          INSERT INTO source_intake_receipts (
            source_event_id, person_id, prospect_id,
            command_json, result_json, created_at
          ) VALUES (?, ?, 'ghost-prospect', '{}', '{}', ?)
        `).run(prospect.sourceEventId, prospect.personId, DOMAIN_TIMESTAMP);
      });
      return;
    }
    case 'source-intake-receipt-source-prospect': {
      const prospect = seedProspect(raw, 'intake-source-prospect');
      raw.prepare(`
        INSERT INTO source_events (
          id, person_id, prospect_id, channel, observed_at, source_record_json, created_at
        ) VALUES ('attached-source', ?, ?, 'custom', ?, '{}', ?)
      `).run(
        prospect.personId, prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      assert.throws(() => raw.prepare(`
        INSERT INTO source_intake_receipts (
          source_event_id, person_id, prospect_id,
          command_json, result_json, created_at
        ) VALUES ('attached-source', ?, 'ghost-prospect', '{}', '{}', ?)
      `).run(prospect.personId, DOMAIN_TIMESTAMP));
      return;
    }
    case 'deferred-source-intake-receipt': {
      insertPerson(raw, 'deferred-intake-person');
      insertSourceEvent({
        database: raw,
        id: 'deferred-intake-source',
        personId: 'deferred-intake-person',
      });
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw.prepare(`
          INSERT INTO source_intake_receipts (
            source_event_id, person_id, prospect_id,
            command_json, result_json, created_at
          ) VALUES (
            'deferred-intake-source', 'deferred-intake-person',
            'deferred-intake-prospect', '{}', '{}', ?
          )
        `).run(DOMAIN_TIMESTAMP);
        insertProspect({
          database: raw,
          id: 'deferred-intake-prospect',
          personId: 'deferred-intake-person',
          sourceEventId: 'deferred-intake-source',
        });
        raw.exec('COMMIT');
      } catch (error) {
        if (raw.inTransaction) raw.exec('ROLLBACK');
        throw error;
      }
      assert.deepEqual(raw.prepare(`
        SELECT person_id, prospect_id FROM source_intake_receipts
        WHERE source_event_id = 'deferred-intake-source'
      `).get(), {
        person_id: 'deferred-intake-person',
        prospect_id: 'deferred-intake-prospect',
      });
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
      insertSourceEvent({
        database: raw,
        id: 'immutable-trigger-referral',
        personId: prospect.personId,
        channel: 'referral',
        referrerUnknownReason: 'fixture',
      });
      raw.prepare(`
        INSERT INTO trigger_events (
          id, prospect_id, source_event_id, trigger_type, effective_at,
          strength_multiplier, verification_state, evidence_json, created_at
        ) VALUES ('immutable-trigger-row', ?, 'immutable-trigger-referral',
                  'direct_referral', ?, 1.0, 'verified', '{}', ?)
      `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      assertImmutable(
        raw,
        'trigger_events',
        'immutable-trigger-row',
        "trigger_type = 'live_vacancy'",
      );
      return;
    }
    case 'replace-immutable-unique-trigger': {
      const prospect = seedProspect(raw, 'replace-immutable-unique-trigger');
      insertSourceEvent({
        database: raw,
        id: 'replace-trigger-referral',
        personId: prospect.personId,
        channel: 'referral',
        referrerUnknownReason: 'fixture',
      });
      insertTriggerEvent(raw, {
        id: 'replace-trigger-original',
        prospectId: prospect.prospectId,
        sourceEventId: 'replace-trigger-referral',
      });
      assert.throws(() => raw.prepare(`
        INSERT OR REPLACE INTO trigger_events (
          id, prospect_id, source_event_id, trigger_type, effective_at,
          strength_multiplier, verification_state, evidence_json, created_at
        ) VALUES ('replace-trigger-new-id', ?, 'replace-trigger-referral',
                  'direct_referral', ?, 1.0, 'verified', '{}', ?)
      `).run(
        prospect.prospectId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      ));
      assert.deepEqual(
        raw.prepare<[], { id: string; trigger_type: string }>(`
          SELECT id, trigger_type FROM trigger_events
          WHERE source_event_id = 'replace-trigger-referral'
        `).get(),
        { id: 'replace-trigger-original', trigger_type: 'direct_referral' },
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
    case 'immutable-acquisition-attribution': {
      const prospect = seedProspect(raw, 'immutable-attribution');
      insertSourceEvent({
        database: raw,
        id: 'immutable-attribution-second-source',
        personId: prospect.personId,
      });
      assert.throws(() => raw.prepare(`
        UPDATE prospects SET original_source_event_id = ? WHERE id = ?
      `).run('immutable-attribution-second-source', prospect.prospectId));
      const cycle = insertOpenCycleWithAction({
        database: raw,
        prefix: 'immutable-attribution',
        prospect,
      });
      assert.throws(() => raw.prepare(`
        UPDATE sales_cycles SET entry_source_event_id = ? WHERE id = ?
      `).run('immutable-attribution-second-source', cycle.cycleId));
      return;
    }
    case 'immutable-domain-history': {
      const prospect = seedProspect(raw, 'immutable-history');
      insertRawActivity(raw, 'immutable-history-activity', prospect.personId, null, null);
      raw.prepare(`
        INSERT INTO activity_amendments (
          id, activity_id, amendment_kind, correction_json, reason, created_at
        ) VALUES ('immutable-history-amendment', 'immutable-history-activity',
                  'outcome', '{}', 'correction', ?)
      `).run(DOMAIN_TIMESTAMP);
      assertImmutable(
        raw,
        'activity_amendments',
        'immutable-history-amendment',
        "reason = 'rewritten'",
      );
      insertCadenceDefinition(raw, 'immutable-history-cadence');
      raw.prepare(`
        INSERT INTO cadence_steps (
          id, cadence_definition_id, sequence, day_offset, label, breakup,
          step_json, created_at
        ) VALUES ('immutable-history-step', 'immutable-history-cadence', 0, 0,
                  'First', 0, '{}', ?)
      `).run(DOMAIN_TIMESTAMP);
      raw.prepare(`
        INSERT INTO cadence_action_components (
          id, cadence_step_id, sequence, action_type, channel,
          outcome_graph_json, created_at
        ) VALUES ('immutable-history-component', 'immutable-history-step', 0,
                  'call', 'phone', '{}', ?)
      `).run(DOMAIN_TIMESTAMP);
      assertImmutable(
        raw,
        'cadence_action_components',
        'immutable-history-component',
        "action_type = 'text'",
      );
      assertImmutable(
        raw,
        'cadence_steps',
        'immutable-history-step',
        "label = 'Changed'",
      );
      assert.throws(() => raw.prepare(`
        UPDATE cadence_definitions SET name = 'Changed' WHERE id = 'immutable-history-cadence'
      `).run());
      insertPrioritizationRule(raw, 'immutable-history-rule');
      insertPrioritizationEvaluation(raw, {
        id: 'immutable-history-evaluation',
        prospectId: prospect.prospectId,
        ruleId: 'immutable-history-rule',
        reachability: 'direct',
        priority: 'p1',
      });
      assertImmutable(
        raw,
        'prioritization_evaluations',
        'immutable-history-evaluation',
        'fit_points = 24',
      );
      assert.throws(() => raw.prepare(`
        UPDATE prioritization_rule_versions SET rules_json = '{"changed":true}'
        WHERE id = 'immutable-history-rule'
      `).run());
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
      insertOptOutTombstone(raw, 'opt-out-tombstone', prospect.personId);
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
      assert.throws(() => raw.prepare(
        "UPDATE opt_out_handles SET normalized_value = '+14015550101' WHERE id = 'opt-out-handle'",
      ).run());
      assert.throws(() => raw.prepare(
        "UPDATE opt_out_tombstones SET evidence_ref = 'changed' WHERE id = 'opt-out-tombstone'",
      ).run());
      return;
    }
    case 'exact-reactivation-types': {
      const prospect = seedProspect(raw, 'reactivation-types');
      const cycleId = insertClosedCycle({ database: raw, prefix: 'reactivation-types', prospect });
      const exactTypes = [
        'seasonal:heating-oct1',
        'new-frbo-listing',
        'lead-cert-expiry-window',
        'manual',
      ] as const;
      for (const [index, ruleType] of exactTypes.entries()) {
        insertReactivationRule(raw, {
          id: `reactivation-exact-${index}`,
          cycleId,
          ruleType,
          dueAt: ruleType === 'manual' ? DOMAIN_TIMESTAMP : null,
        });
      }
      for (const [index, invalidType] of [
        'seasonal_heating_oct1',
        'new_frbo_listing',
        'lead_cert_expiry_window',
        'inbound_response',
        'never',
        'custom',
      ].entries()) {
        assert.throws(() => insertReactivationRule(raw, {
          id: `reactivation-invalid-${index}`,
          cycleId,
          ruleType: invalidType,
          dueAt: DOMAIN_TIMESTAMP,
        }));
      }
      return;
    }
    case 'reactivation-consumption': {
      const prospect = seedProspect(raw, 'reactivation-consumption');
      const cycleId = insertClosedCycle({
        database: raw,
        prefix: 'reactivation-consumption',
        prospect,
      });
      insertReactivationRule(raw, {
        id: 'reactivation-consumption-rule',
        cycleId,
        ruleType: 'manual',
        dueAt: DOMAIN_TIMESTAMP,
      });
      const consumedAt = '2026-09-01T12:00:00.000Z';
      raw.prepare(`
        UPDATE reactivation_rules SET consumed_at = ?
        WHERE id = 'reactivation-consumption-rule'
      `).run(consumedAt);
      raw.prepare(`
        UPDATE reactivation_rules SET consumed_at = ?
        WHERE id = 'reactivation-consumption-rule'
      `).run(consumedAt);
      assert.throws(() => raw.prepare(`
        UPDATE reactivation_rules SET consumed_at = NULL
        WHERE id = 'reactivation-consumption-rule'
      `).run());
      assert.throws(() => raw.prepare(`
        UPDATE reactivation_rules SET consumed_at = '2026-09-02T12:00:00.000Z'
        WHERE id = 'reactivation-consumption-rule'
      `).run());
      assert.throws(() => raw.prepare(`
        UPDATE reactivation_rules SET due_at = '2026-10-01T12:00:00.000Z'
        WHERE id = 'reactivation-consumption-rule'
      `).run());
      assert.throws(() => raw.prepare(`
        DELETE FROM reactivation_rules WHERE id = 'reactivation-consumption-rule'
      `).run());
      return;
    }
    case 'lost-other-requires-notes': {
      const prospect = seedProspect(raw, 'lost-other-notes');
      assert.throws(() => insertLostOtherCycle(raw, 'lost-other-null', prospect, null));
      assert.throws(() => insertLostOtherCycle(raw, 'lost-other-blank', prospect, '   '));
      insertLostOtherCycle(raw, 'lost-other-valid', prospect, 'Founder chose to wait.');
      return;
    }
    case 'mutable-rule-activation-pointer': {
      insertPrioritizationRule(raw, 'activation-rule-one');
      insertPrioritizationRule(raw, 'activation-rule-two', 2);
      raw.prepare(`
        UPDATE workspace_settings
        SET active_prioritization_rule_version_id = 'activation-rule-one'
        WHERE singleton = 1
      `).run();
      raw.prepare(`
        UPDATE workspace_settings
        SET active_prioritization_rule_version_id = 'activation-rule-two'
        WHERE singleton = 1
      `).run();
      assert.deepEqual(
        raw.prepare<[], { active_prioritization_rule_version_id: string }>(`
          SELECT active_prioritization_rule_version_id FROM workspace_settings
          WHERE singleton = 1
        `).get(),
        { active_prioritization_rule_version_id: 'activation-rule-two' },
      );
      assert.throws(() => raw.prepare(`
        UPDATE prioritization_rule_versions SET rules_json = '{"changed":true}'
        WHERE id = 'activation-rule-one'
      `).run());
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
      confirmation_kind, backfill_provenance_json, transition_sequence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'founder', NULL,
              (SELECT COALESCE(MAX(transition_sequence), 0) + 1
               FROM stage_events WHERE sales_cycle_id = ?), ?)
  `).run(
    id,
    cycleId,
    fromStage,
    toStage,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    cycleId,
    DOMAIN_TIMESTAMP,
  );
}

function insertPrioritizationRule(
  database: AppDatabase['raw'],
  id: string,
  version = 1,
): void {
  database.prepare(`
    INSERT INTO prioritization_rule_versions (
      id, version, content_hash, rules_json, created_at
    ) VALUES (?, ?, ?, '{}', ?)
  `).run(id, version, `hash-${id}`, DOMAIN_TIMESTAMP);
}

function insertPrioritizationEvaluation(
  database: AppDatabase['raw'],
  input: {
    id: string;
    prospectId: string;
    ruleId: string;
    reachability: 'direct' | 'indirect';
    priority: 'p0' | 'p1';
  },
): void {
  database.prepare(`
    INSERT INTO prioritization_evaluations (
      id, prospect_id, rule_version_id, decision_kind, evaluated_at, fit_points,
      fit_band, timing_millipoints, timing_band, reachability, data_confidence,
      priority, earliest_trigger_expires_at, verify_first,
      last_contact_activity_id, last_contact_at, qualification_json,
      command_json, input_snapshot_json, result_json, explanation_json,
      created_at
    ) VALUES (?, ?, ?, 'evaluated', ?, 25, 'high', 30000, 'hot', ?, 8, ?, NULL,
              0, NULL, NULL, NULL, '{}', '{}', '{}', '[]', ?)
  `).run(
    input.id,
    input.prospectId,
    input.ruleId,
    DOMAIN_TIMESTAMP,
    input.reachability,
    input.priority,
    DOMAIN_TIMESTAMP,
  );
}

function insertPriorityProjection(
  database: AppDatabase['raw'],
  input: {
    prospectId: string;
    evaluationId: string;
    ruleId: string;
    reachability: 'direct' | 'indirect';
    priority: 'p0' | 'p1' | 'p2';
  },
): void {
  database.prepare(`
    INSERT INTO prospect_priority_projection (
      prospect_id, rule_version_id, evaluation_id, decision_kind, fit_points,
      fit_band, timing_millipoints, timing_band, reachability, data_confidence,
      priority, earliest_trigger_expires_at, verify_first,
      last_contact_activity_id, last_contact_at, version, evaluated_at, updated_at
    ) VALUES (?, ?, ?, 'evaluated', 25, 'high', 30000, 'hot', ?, 8, ?, NULL, 0,
              NULL, NULL, 1, ?, ?)
  `).run(
    input.prospectId,
    input.ruleId,
    input.evaluationId,
    input.reachability,
    input.priority,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function replacePriorityProjection(
  database: AppDatabase['raw'],
  input: {
    prospectId: string;
    evaluationId: string;
    ruleId: string;
    reachability: 'direct' | 'indirect';
    priority: 'p0' | 'p1' | 'p2';
  },
): void {
  database.prepare(`
    INSERT OR REPLACE INTO prospect_priority_projection (
      prospect_id, rule_version_id, evaluation_id, decision_kind, fit_points,
      fit_band, timing_millipoints, timing_band, reachability, data_confidence,
      priority, earliest_trigger_expires_at, verify_first,
      last_contact_activity_id, last_contact_at, version, evaluated_at, updated_at
    ) VALUES (?, ?, ?, 'evaluated', 25, 'high', 30000, 'hot', ?, 8, ?, NULL, 0,
              NULL, NULL, 1, ?, ?)
  `).run(
    input.prospectId,
    input.ruleId,
    input.evaluationId,
    input.reachability,
    input.priority,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertPriorityOverride(
  database: AppDatabase['raw'],
  id: string,
  prospectId: string,
  priority: 'p0' | 'p1',
  expiresAt = '9999-12-31T23:59:59.999Z',
  status: 'active' | 'expired' = 'active',
): void {
  database.prepare(`
    INSERT INTO priority_overrides (
      id, prospect_id, override_kind, priority, reason, expires_at, created_at,
      status, expired_at
    ) VALUES (?, ?, 'priority', ?, 'Founder decision', ?, ?, ?, ?)
  `).run(
    id, prospectId, priority, expiresAt, DOMAIN_TIMESTAMP, status,
    status === 'expired' ? expiresAt : null,
  );
}

function insertCadenceEnrollment(
  database: AppDatabase['raw'],
  id: string,
  cycleId: string,
  cadenceDefinitionId: string,
): void {
  database.prepare(`
    INSERT INTO cadence_enrollments (
      id, sales_cycle_id, cadence_definition_id, status, anchor_at,
      scheduled_step_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, 0, ?, ?)
  `).run(
    id,
    cycleId,
    cadenceDefinitionId,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertOptOutTombstone(
  database: AppDatabase['raw'],
  id: string,
  personId: string,
): void {
  const activityId = `${id}-activity`;
  insertRawActivity(database, activityId, personId, null, null);
  database.prepare(`
    INSERT INTO opt_out_tombstones (
      id, person_id, requested_at, observed_channel, source_activity_id,
      policy_version, created_at
    ) VALUES (?, ?, ?, 'manual', ?, 'founder_opt_out_v1', ?)
  `).run(id, personId, DOMAIN_TIMESTAMP, activityId, DOMAIN_TIMESTAMP);
}

function insertSourceIntakeReceipt(
  database: AppDatabase['raw'],
  prospect: { sourceEventId: string; personId: string; prospectId: string },
  marker: string,
): void {
  database.prepare(`
    INSERT INTO source_intake_receipts (
      source_event_id, person_id, prospect_id, command_json, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    prospect.sourceEventId,
    prospect.personId,
    prospect.prospectId,
    JSON.stringify({ formatVersion: 1, command: { marker } }),
    JSON.stringify({ formatVersion: 1, result: { marker } }),
    DOMAIN_TIMESTAMP,
  );
}

function insertOwnedActivity(
  database: AppDatabase['raw'],
  input: {
    id: string;
    personId: string;
    prospectId?: string;
    salesCycleId?: string;
    consentPolicyRecordId?: string;
  },
): void {
  database.prepare(`
    INSERT INTO activities (
      id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
      occurred_at, consent_policy_record_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'system', 'internal', 'system', ?, ?, '{}', ?)
  `).run(
    input.id,
    input.personId,
    input.prospectId ?? null,
    input.salesCycleId ?? null,
    DOMAIN_TIMESTAMP,
    input.consentPolicyRecordId ?? null,
    DOMAIN_TIMESTAMP,
  );
}

function insertConsentRecord(
  database: AppDatabase['raw'],
  input: { id: string; personId: string; activityId?: string },
): void {
  database.prepare(`
    INSERT INTO consent_policy_records (
      id, person_id, activity_id, policy_kind, policy_version, effective_at,
      decision, evidence_json, created_at
    ) VALUES (?, ?, ?, 'outbound', 'v1', ?, 'granted', '{}', ?)
  `).run(
    input.id,
    input.personId,
    input.activityId ?? null,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertTriggerEvent(
  database: AppDatabase['raw'],
  input: { id: string; prospectId: string; sourceEventId: string },
): void {
  database.prepare(`
    INSERT INTO trigger_events (
      id, prospect_id, source_event_id, trigger_type, effective_at,
      strength_multiplier, verification_state, evidence_json, created_at
    ) VALUES (?, ?, ?, 'direct_referral', ?, 1.0, 'verified', '{}', ?)
  `).run(
    input.id,
    input.prospectId,
    input.sourceEventId,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function insertReactivationRule(
  database: AppDatabase['raw'],
  input: {
    id: string;
    cycleId: string;
    ruleType: string;
    dueAt: string | null;
  },
): void {
  database.prepare(`
    INSERT INTO reactivation_rules (
      id, sales_cycle_id, rule_type, due_at, matcher_json, version, created_at
    ) VALUES (?, ?, ?, ?, NULL, 1, ?)
  `).run(input.id, input.cycleId, input.ruleType, input.dueAt, DOMAIN_TIMESTAMP);
}

function insertLostOtherCycle(
  database: AppDatabase['raw'],
  id: string,
  prospect: { personId: string; prospectId: string; sourceEventId: string },
  closeNotes: string | null,
): void {
  database.prepare(`
    INSERT INTO sales_cycles (
      id, person_id, prospect_id, entry_source_event_id, stage,
      workflow_status, current_next_action_id, stage_entered_at,
      close_reason, close_notes, closed_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'lost_nurture', 'closed', NULL, ?,
              'other', ?, ?, 1, ?, ?)
  `).run(
    id,
    prospect.personId,
    prospect.prospectId,
    prospect.sourceEventId,
    DOMAIN_TIMESTAMP,
    closeNotes,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
    DOMAIN_TIMESTAMP,
  );
}

function assertImmutable(
  database: AppDatabase['raw'],
  table: string,
  id: string,
  update: string,
  idColumn = 'id',
): void {
  assert.throws(() => database.prepare(
    `UPDATE ${table} SET ${update} WHERE ${idColumn} = ?`,
  ).run(id));
  assert.throws(() => database.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
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
