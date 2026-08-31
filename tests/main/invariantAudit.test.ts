import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { insertOpenCycleWithAction, insertPerson, seedProspect } from '../fixtures/domainRows';
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
    database.raw.exec('DROP TRIGGER protect_design_partner_fitness_update');
    database.raw.prepare(`UPDATE next_actions SET work_intent = 'mystery' WHERE id = ?`)
      .run(seeded.actionId);
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
      'design_partner_fitness_invalid',
      'opted_out_open_workflow',
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
});
