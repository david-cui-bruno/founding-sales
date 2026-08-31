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
  insertSourceEvent,
  seedProspect,
} from '../fixtures/domainRows';
import { serializeCanonical } from '../../src/main/domain/lifecycle/lifecycleValidation';
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
    database.raw.exec('DROP TRIGGER protect_projection_p0_override_update');
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

  it('accepts positive close-readiness projection versions and rejects deep SLA corruption', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'deep-action-audit');
    const seeded = insertOpenCycleWithAction({
      database: database.raw, prefix: 'deep-action-audit', prospect, stage: 'interviewed',
    });
    insertSourceEvent({
      database: database.raw, id: 'audit-demo-source', personId: prospect.personId,
      channel: 'inbound_demo',
    });
    const emptyDimension = { value: 'unknown', evidenceActivityIds: [] } as const;
    database.raw.prepare(`
      INSERT INTO sales_cycle_close_readiness (
        sales_cycle_id, pain_confirmed, decision_authority_confirmed,
        concrete_trial_identified, readiness_json, version, assessed_at, updated_at
      ) VALUES (?, 0, 0, 0, ?, 2, ?, ?)
    `).run(seeded.cycleId, serializeCanonical({
      version: 1, demonstratedPain: emptyDimension, activeTimeline: emptyDimension,
      decisionAuthority: emptyDimension, willingnessToTryOrPay: emptyDimension,
      concreteNextStep: emptyDimension,
    }), DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    expect(auditDomainInvariants({ database })).not.toContainEqual(
      expect.objectContaining({ kind: 'close_readiness_invalid', recordId: seeded.cycleId }),
    );

    database.raw.exec('DROP TRIGGER protect_next_action_immutable_evidence');
    database.raw.prepare(`
      UPDATE next_actions SET
        work_intent = 'inbound_response', sla_due_at = ?,
        inbound_sla_kind = 'inbound_demo_permitted_minutes',
        inbound_sla_due_at = ?, inbound_sla_source_event_id = ?,
        inbound_sla_provenance_json = ?
      WHERE id = ?
    `).run(
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, 'audit-demo-source',
      serializeCanonical({
        version: 1, sourceEventId: 'audit-demo-source',
        sourceObservedAt: '2026-08-29T12:00:00.000Z',
        calculation: 'permitted_minutes', minutes: 99,
        policyId: 'wrong-policy', computedDueAt: DOMAIN_TIMESTAMP,
      }),
      seeded.actionId,
    );
    expect(auditDomainInvariants({ database })).toContainEqual(
      expect.objectContaining({ kind: 'action_inbound_sla_invalid', recordId: seeded.actionId }),
    );
  });

  it('audits Won term metadata and an effective P0 override against Direct reachability', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'won-metadata-audit');
    database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, closed_at, version, created_at, updated_at
      ) VALUES ('won-metadata-cycle', ?, ?, ?, 'won', 'closed', NULL, ?, ?, 1, ?, ?)
    `).run(
      prospect.personId, prospect.prospectId, prospect.sourceEventId,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    database.raw.prepare(`
      INSERT INTO won_terms (
        sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
        projected_mrr_cents, projection_formula_version, manual_projection_reason,
        founding_customer, effective_at, created_at
      ) VALUES ('won-metadata-cycle', 2, 'per_door_monthly', 5000,
        10000, 'founder_terms_v1', NULL, 1, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.exec('DROP TRIGGER immutable_won_terms');
    database.raw.pragma('ignore_check_constraints = ON');
    database.raw.prepare(`
      UPDATE won_terms SET projection_formula_version = 'wrong', founding_customer = 3,
        effective_at = 'not-a-time', created_at = 'not-a-time'
      WHERE sales_cycle_id = 'won-metadata-cycle'
    `).run();

    database.raw.prepare(`
      INSERT INTO prioritization_rule_versions (
        id, version, content_hash, rules_json, created_at
      ) VALUES ('p0-audit-rule', 1, 'hash', '{}', ?)
    `).run(DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prioritization_evaluations (
        id, prospect_id, rule_version_id, evaluated_at, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence,
        priority, earliest_trigger_expires_at, verify_first, explanation_json, created_at
      ) VALUES ('p0-audit-eval', ?, 'p0-audit-rule', ?, 10, 'low', 0, 'cold',
        'direct', 1, 'p3', NULL, 0, '[]', ?)
    `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prospect_priority_projection (
        prospect_id, rule_version_id, evaluation_id, fit_points, fit_band,
        timing_millipoints, timing_band, reachability, data_confidence, priority,
        earliest_trigger_expires_at, verify_first, version, evaluated_at, updated_at
      ) VALUES (?, 'p0-audit-rule', 'p0-audit-eval', 10, 'low', 0, 'cold',
        'direct', 1, 'p3', NULL, 0, 1, ?, ?)
    `).run(prospect.prospectId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO priority_overrides (
        id, prospect_id, override_kind, priority, reason, expires_at, created_at
      ) VALUES ('p0-audit-override', ?, 'priority', 'p0', 'fixture',
        '2027-08-30T12:00:00.000Z', ?)
    `).run(prospect.prospectId, DOMAIN_TIMESTAMP);
    database.raw.exec('DROP TRIGGER protect_priority_projection_fidelity_update');
    database.raw.exec('DROP TRIGGER protect_projection_p0_override_update');
    database.raw.prepare(`
      UPDATE prospect_priority_projection SET reachability = 'indirect' WHERE prospect_id = ?
    `).run(prospect.prospectId);

    const violations = auditDomainInvariants({ database });
    expect(violations).toContainEqual(expect.objectContaining({
      kind: 'won_terms_invalid', recordId: 'won-metadata-cycle',
    }));
    expect(violations).toContainEqual(expect.objectContaining({
      kind: 'p0_override_reachability_invalid', recordId: 'p0-audit-override',
    }));
  });

  it('has no false positive for a canonical Unreviewed workflow and enforces exact nurture defaults', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const canonical = seedProspect(database.raw, 'canonical-audit');
    const workflow = insertOpenCycleWithAction({
      database: database.raw, prefix: 'canonical-audit', prospect: canonical,
    });
    database.raw.exec('DROP TRIGGER protect_next_action_immutable_evidence');
    database.raw.prepare(`
      UPDATE next_actions SET work_intent = 'internal_review' WHERE id = ?
    `).run(workflow.actionId);
    database.raw.prepare(`
      INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, transition_sequence, created_at
      ) VALUES ('canonical-stage', ?, NULL, 'unreviewed', ?, ?, 'mechanical', 1, ?)
    `).run(workflow.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    expect(auditDomainInvariants({ database })).toEqual([]);

    const unitOfWork = new DomainUnitOfWork(database);
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const nurture = seedProspect(database.raw, 'nurture-cardinality');
    const cycleId = insertClosedCycle({
      database: database.raw, prefix: 'nurture-cardinality', prospect: nurture,
    });
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
        version, stop_reason, created_at, updated_at
      ) VALUES ('nurture-a-enrollment', ?, 'cadence-a-v1', 'stopped', ?,
        'cadence-a-v1-day-0', 1, 'standard', NULL, 1, 'exhausted', ?, ?)
    `).run(cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO reactivation_rules (
        id, sales_cycle_id, rule_type, due_at, matcher_json, version, consumed_at, created_at
      ) VALUES ('partial-a-defaults', ?, 'seasonal:heating-oct1',
        '2026-10-01T13:00:00.000Z', NULL, 1, NULL, ?)
    `).run(cycleId, DOMAIN_TIMESTAMP);
    expect(auditDomainInvariants({ database })).toContainEqual(expect.objectContaining({
      kind: 'lost_nurture_reactivation_invalid', recordId: cycleId,
    }));
  });
});
