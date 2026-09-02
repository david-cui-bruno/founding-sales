import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  DOMAIN_TIMESTAMP,
  insertClosedCycle,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('cadence relational ownership constraints', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let firstCycle: string;
  let secondCycle: string;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(): Promise<void> {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const first = seedProspect(database.raw, 'cadence-owner-first');
    const second = seedProspect(database.raw, 'cadence-owner-second');
    firstCycle = insertClosedCycle({ database: database.raw, prefix: 'cadence-owner-first', prospect: first });
    secondCycle = insertClosedCycle({ database: database.raw, prefix: 'cadence-owner-second', prospect: second });
    for (const suffix of ['a', 'b']) {
      database.raw.prepare(`
        INSERT INTO cadence_definitions (
          id, family, version, name, content_hash, attempt_cap,
          definition_json, created_at
        ) VALUES (?, ?, 1, ?, ?, 2, '{}', ?)
      `).run(`definition-${suffix}`, `family-${suffix}`, `Definition ${suffix}`, `hash-${suffix}`, DOMAIN_TIMESTAMP);
      database.raw.prepare(`
        INSERT INTO cadence_steps (
          id, cadence_definition_id, sequence, day_offset, label,
          breakup, step_json, created_at
        ) VALUES (?, ?, 0, 0, ?, 0, '{}', ?)
      `).run(`step-${suffix}`, `definition-${suffix}`, `Step ${suffix}`, DOMAIN_TIMESTAMP);
      database.raw.prepare(`
        INSERT INTO cadence_action_components (
          id, cadence_step_id, sequence, action_type, channel,
          outcome_graph_json, created_at
        ) VALUES (?, ?, 0, 'text', 'text', '{}', ?)
      `).run(`component-${suffix}`, `step-${suffix}`, DOMAIN_TIMESTAMP);
    }
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, stop_reason, created_at, updated_at
      ) VALUES ('enrollment-a', ?, 'definition-a', 'stopped', ?, 'step-a', 1,
                'test', ?, ?)
    `).run(firstCycle, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, stop_reason, created_at, updated_at
      ) VALUES ('enrollment-b', ?, 'definition-b', 'stopped', ?, 'step-b', 1,
                'test', ?, ?)
    `).run(secondCycle, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function insertAction(input: {
    id: string;
    cycleId: string;
    enrollmentId: string;
    stepId: string;
    componentId: string;
  }): void {
    database!.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, timezone,
        cadence_enrollment_id, cadence_step_id, cadence_component_id, created_at
      ) VALUES (?, ?, 'text', 'text', 'pending', 'America/New_York', ?, ?, ?, ?)
    `).run(
      input.id, input.cycleId, input.enrollmentId,
      input.stepId, input.componentId, DOMAIN_TIMESTAMP,
    );
  }

  it('rejects an enrollment current step from another definition on insert and owner move', async () => {
    await setup();
    expect(() => database!.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, stop_reason, created_at, updated_at
      ) VALUES ('wrong-step-enrollment', ?, 'definition-a', 'stopped', ?,
                'step-b', 0, 'test', ?, ?)
    `).run(firstCycle, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP)).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE cadence_enrollments SET cadence_definition_id = 'definition-b'
      WHERE id = 'enrollment-a'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE cadence_enrollments SET current_step_id = 'step-b'
      WHERE id = 'enrollment-a'
    `).run()).toThrow();
  });

  it('makes enrollment identity immutable and terminal status one-way', async () => {
    await setup();
    for (const assignment of [
      `sales_cycle_id = '${secondCycle}'`,
      "cadence_definition_id = 'definition-b'",
      "anchor_at = '2026-09-01T12:00:00.000Z'",
    ]) {
      expect(() => database!.raw.prepare(`
        UPDATE cadence_enrollments SET ${assignment} WHERE id = 'enrollment-a'
      `).run()).toThrow();
    }
    expect(() => database!.raw.prepare(`
        UPDATE cadence_enrollments
        SET status = 'completed', scheduled_step_count = 2,
            stop_reason = 'phase_completed', updated_at = '2026-09-01T12:00:00.000Z'
        WHERE id = 'enrollment-a'
      `).run()).toThrow();
  });

  it('rejects simultaneous enrollment owner moves even when the replacement graph is internally valid', async () => {
    await setup();
    insertAction({
      id: 'dependent-action', cycleId: firstCycle, enrollmentId: 'enrollment-a',
      stepId: 'step-a', componentId: 'component-a',
    });
    expect(() => database!.raw.prepare(`
      UPDATE cadence_enrollments
      SET sales_cycle_id = ?, cadence_definition_id = 'definition-b',
          current_step_id = 'step-b', anchor_at = '2026-09-01T12:00:00.000Z'
      WHERE id = 'enrollment-a'
    `).run(secondCycle)).toThrow();
  });

  it('rejects enrollment deletion and INSERT OR REPLACE identity bypasses', async () => {
    await setup();
    expect(() => database!.raw.prepare(`
      DELETE FROM cadence_enrollments WHERE id = 'enrollment-a'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      INSERT OR REPLACE INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, stop_reason, created_at, updated_at
      ) VALUES ('enrollment-a', ?, 'definition-b', 'stopped', ?, 'step-b', 1,
                'test', ?, ?)
    `).run(secondCycle, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP)).toThrow();
  });

  it('requires a next action enrollment to belong to its SalesCycle on insert and update', async () => {
    await setup();
    expect(() => insertAction({
      id: 'wrong-cycle-action', cycleId: firstCycle, enrollmentId: 'enrollment-b',
      stepId: 'step-b', componentId: 'component-b',
    })).toThrow();
    insertAction({
      id: 'valid-action', cycleId: firstCycle, enrollmentId: 'enrollment-a',
      stepId: 'step-a', componentId: 'component-a',
    });
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET cadence_enrollment_id = 'enrollment-b'
      WHERE id = 'valid-action'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET sales_cycle_id = ? WHERE id = 'valid-action'
    `).run(secondCycle)).toThrow();
  });

  it('requires the next-action step to belong to the enrollment definition and component to the step', async () => {
    await setup();
    expect(() => insertAction({
      id: 'wrong-definition-action', cycleId: firstCycle, enrollmentId: 'enrollment-a',
      stepId: 'step-b', componentId: 'component-b',
    })).toThrow();
    expect(() => insertAction({
      id: 'wrong-component-action', cycleId: firstCycle, enrollmentId: 'enrollment-a',
      stepId: 'step-a', componentId: 'component-b',
    })).toThrow();
    insertAction({
      id: 'move-action', cycleId: firstCycle, enrollmentId: 'enrollment-a',
      stepId: 'step-a', componentId: 'component-a',
    });
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET cadence_step_id = 'step-b', cadence_component_id = 'component-b'
      WHERE id = 'move-action'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET cadence_component_id = 'component-b'
      WHERE id = 'move-action'
    `).run()).toThrow();
  });

  it('requires exact cadence Activity ownership while preserving ordinary cycle-only evidence', async () => {
    await setup();
    const first = database!.raw.prepare<[], { person_id: string; prospect_id: string }>(`
      SELECT person_id, prospect_id FROM sales_cycles WHERE id = '${firstCycle}'
    `).get()!;
    const insert = (input: {
      id: string;
      cycle?: string | null;
      enrollment?: string | null;
      step?: string | null;
      component?: string | null;
      channel?: string;
    }) => database!.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
        cadence_step_id, cadence_component_id, kind, direction, channel, occurred_at,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'text', 'outbound', ?, ?, '{}', ?)
    `).run(
      input.id, first.person_id, first.prospect_id,
      input.cycle === undefined ? firstCycle : input.cycle,
      input.enrollment ?? null, input.step ?? null, input.component ?? null,
      input.channel ?? 'text', DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    expect(insert({ id: 'ordinary-cycle-activity' }).changes).toBe(1);
    expect(() => insert({ id: 'step-only-activity', step: 'step-a' })).toThrow();
    expect(() => insert({ id: 'component-only-activity', component: 'component-a' })).toThrow();
    expect(() => insert({
      id: 'missing-enrollment-activity', step: 'step-a', component: 'component-a',
    })).toThrow();
    expect(() => insert({
      id: 'missing-cycle-activity', cycle: null, enrollment: 'enrollment-a',
      step: 'step-a', component: 'component-a',
    })).toThrow();
    expect(() => insert({
      id: 'wrong-cycle-activity', cycle: firstCycle, enrollment: 'enrollment-b',
      step: 'step-b', component: 'component-b',
    })).toThrow();
    expect(() => insert({
      id: 'cross-step-activity', enrollment: 'enrollment-a',
      step: 'step-a', component: 'component-b',
    })).toThrow();
    expect(() => insert({
      id: 'wrong-channel-activity', enrollment: 'enrollment-a',
      step: 'step-a', component: 'component-a', channel: 'phone',
    })).toThrow();
    expect(insert({
      id: 'owned-activity', enrollment: 'enrollment-a',
      step: 'step-a', component: 'component-a',
    }).changes).toBe(1);
  });
});
