import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertClosedCycle,
  insertOpenCycleWithAction,
  insertPerson,
  seedProspect,
} from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

describe('auditDomainInvariants', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('returns every malformed projection in stable order without throwing or mutating', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'audit');
    insertPerson(database.raw, 'person-without-prospect');
    const seeded = insertOpenCycleWithAction({ database: database.raw, prefix: 'audit', prospect });
    const overCapProspect = seedProspect(database.raw, 'over-cap-audit');
    const overCap = insertOpenCycleWithAction({
      database: database.raw, prefix: 'over-cap-audit', prospect: overCapProspect, stage: 'ready',
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
        version, created_at, updated_at
      ) VALUES ('forged-overcap-enrollment', ?, 'cadence-a-v1', 'active', ?,
        'cadence-a-v1-day-0', 1, 'inbound_over_cap_response',
        '["cadence-a-v1-day-0"]', 1, ?, ?)
    `).run(overCap.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const wonProspect = seedProspect(database.raw, 'won-audit');
    database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, closed_at, version, created_at, updated_at
      ) VALUES ('won-without-terms', ?, ?, ?, 'won', 'closed', NULL, ?, ?, 1, ?, ?)
    `).run(
      wonProspect.personId, wonProspect.prospectId, wonProspect.sourceEventId,
      '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z',
      '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z',
    );
    database.raw.pragma('ignore_check_constraints = ON');
    database.raw.exec('DROP TRIGGER protect_next_action_immutable_evidence');
    database.raw.exec('DROP TRIGGER protect_next_action_settlement');
    database.raw.exec('DROP TRIGGER protect_next_action_cadence_insert');
    database.raw.exec('DROP TRIGGER protect_activity_cadence_insert');
    database.raw.exec('DROP TRIGGER protect_design_partner_fitness_update');
    database.raw.exec('DROP TRIGGER protect_opt_out_tombstone_active_cadence');
    database.raw.prepare(`UPDATE next_actions SET work_intent = 'mystery' WHERE id = ?`)
      .run(seeded.actionId);
    database.raw.prepare(`
      UPDATE next_actions SET settlement_json = '{}' WHERE id = ?
    `).run(seeded.actionId);
    database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        cadence_enrollment_id, cadence_step_id, cadence_component_id,
        created_at, updated_at
      ) VALUES ('wrong-channel-action', ?, 'call', 'email', 'pending', ?,
        'America/New_York', 'forged-overcap-enrollment', 'cadence-a-v1-day-0',
        'cadence-a-v1-day-0-call', ?, ?)
    `).run(overCap.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
        cadence_step_id, cadence_component_id, kind, direction, channel,
        occurred_at, metadata_json, created_at
      ) VALUES ('wrong-channel-activity', ?, ?, ?, 'forged-overcap-enrollment',
        'cadence-a-v1-day-0', 'cadence-a-v1-day-0-call', 'call', 'outbound',
        'email', ?, '{}', ?)
    `).run(
      overCapProspect.personId, overCapProspect.prospectId, overCap.cycleId,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        created_at, updated_at
      ) VALUES ('opted-out-pending-outbound', ?, 'text', 'text', 'pending', ?,
        'America/New_York', ?, ?)
    `).run(seeded.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO sales_cycle_close_readiness (
        sales_cycle_id, pain_confirmed, decision_authority_confirmed,
        concrete_trial_identified, readiness_json, version, assessed_at, updated_at
      ) VALUES (?, 1, 1, 1, '{}', 1, ?, ?)
    `).run(seeded.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare('UPDATE sales_cycles SET design_partner_fitness = 5 WHERE id = ?')
      .run(seeded.cycleId);
    database.raw.prepare(`
      INSERT INTO opt_out_tombstones (
        id, person_id, requested_at, observed_channel, source_activity_id,
        evidence_ref, policy_version, created_at
      ) VALUES ('audit-tombstone', ?, ?, 'text', NULL, 'fixture', 'v1', ?)
    `).run(prospect.personId, '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z');
    database.raw.prepare(`
      INSERT INTO prioritization_rule_versions (
        id, version, content_hash, rules_json, created_at
      ) VALUES ('audit-rule', 1, 'audit-hash', '{}', ?)
    `).run('2026-08-30T12:00:00.000Z');
    database.raw.prepare(`
      INSERT INTO prioritization_evaluations (
        id, prospect_id, rule_version_id, evaluated_at, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence,
        priority, earliest_trigger_expires_at, verify_first, explanation_json, created_at
      ) VALUES ('audit-evaluation', ?, 'audit-rule', ?, 25, 'high', 30000, 'hot',
        'direct', 8, 'p0', NULL, 0, '[]', ?)
    `).run(prospect.prospectId, '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z');
    database.raw.prepare(`
      INSERT INTO prospect_priority_projection (
        prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence, priority,
        earliest_trigger_expires_at, verify_first, version, evaluated_at, updated_at
      ) VALUES (?, 'audit-rule', 'audit-evaluation', 25, 'high', 30000, 'hot',
        'direct', 8, 'p0', NULL, 0, 1, ?, ?)
    `).run(prospect.prospectId, '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z');
    database.raw.exec('DROP TRIGGER protect_priority_projection_fidelity_update');
    database.raw.prepare(`
      UPDATE prospect_priority_projection SET reachability = 'indirect' WHERE prospect_id = ?
    `).run(prospect.prospectId);

    const before = database.raw.prepare(`SELECT * FROM sales_cycles WHERE id = ?`).get(seeded.cycleId);
    const first = auditDomainInvariants({ database });
    const second = auditDomainInvariants({ database });

    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.recordId.localeCompare(right.recordId)
    )));
    expect(first.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      'action_work_intent_invalid',
      'action_cadence_binding_invalid',
      'action_settlement_invalid',
      'activity_cadence_binding_invalid',
      'close_readiness_invalid',
      'design_partner_fitness_invalid',
      'enrollment_over_cap_identity_invalid',
      'opted_out_open_workflow',
      'opted_out_pending_outbound',
      'p0_reachability_invalid',
      'stage_event_chain_invalid',
      'unreviewed_action_invalid',
      'won_terms_missing',
    ]));
    expect(first).toContainEqual(expect.objectContaining({
      kind: 'canonical_prospect_cardinality', recordId: 'person-without-prospect',
    }));
    expect(database.raw.prepare(`SELECT * FROM sales_cycles WHERE id = ?`).get(seeded.cycleId))
      .toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every(Object.isFrozen)).toBe(true);
  });

  it('reports a Won to Lost-Nurture StageEvent edge as corruption', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'won-to-lost-audit');
    const cycleId = insertClosedCycle({ database: database.raw, prefix: 'won-to-lost', prospect });
    const stages: ReadonlyArray<readonly [string | null, string]> = [
      [null, 'contacted'],
      ['contacted', 'interviewed'],
      ['interviewed', 'offered'],
      ['offered', 'won'],
      ['won', 'lost_nurture'],
    ] as const;
    for (const [index, [fromStage, toStage]] of stages.entries()) {
      database.raw.prepare(`
        INSERT INTO stage_events (
          id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
          confirmation_kind, transition_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'mechanical', ?, ?)
      `).run(
        `won-to-lost-event-${index + 1}`, cycleId, fromStage, toStage,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, index + 1, DOMAIN_TIMESTAMP,
      );
    }

    expect(auditDomainInvariants({ database })).toContainEqual(expect.objectContaining({
      kind: 'stage_event_chain_invalid', recordId: cycleId,
    }));
  });

  it('reports a direct Ready to Interviewed StageEvent edge as corruption', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'ready-to-interviewed-audit');
    const seeded = insertOpenCycleWithAction({
      database: database.raw, prefix: 'ready-to-interviewed', prospect, stage: 'interviewed',
    });
    const stages: ReadonlyArray<readonly [string | null, string]> = [
      [null, 'ready'], ['ready', 'interviewed'],
    ];
    for (const [index, [fromStage, toStage]] of stages.entries()) {
      database.raw.prepare(`
        INSERT INTO stage_events (
          id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
          confirmation_kind, transition_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'founder', ?, ?)
      `).run(
        `ready-to-interviewed-event-${index + 1}`, seeded.cycleId, fromStage, toStage,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, index + 1, DOMAIN_TIMESTAMP,
      );
    }
    expect(auditDomainInvariants({ database })).toContainEqual(expect.objectContaining({
      kind: 'stage_event_chain_invalid', recordId: seeded.cycleId,
    }));
  });
});
