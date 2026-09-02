import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import type { CadenceActionBinding, InboundSla } from '../../src/main/domain/lifecycle/lifecycleTypes';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NONE_SLA: Extract<InboundSla, { kind: 'none' }> = {
  kind: 'none', dueAt: null, sourceEventId: null, provenance: null,
};

describe('installed-component next-action binding', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let actions: NextActionRepository;
  let cycles: SalesCycleRepository;
  let cadence: CadenceActionBinding;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(): Promise<ReturnType<typeof seedProspect>> {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    actions = new NextActionRepository({ database, unitOfWork });
    cycles = new SalesCycleRepository({ database, unitOfWork });
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const prospect = seedProspect(database.raw, 'action-binding');
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    const step = definition.steps[0]!;
    const component = step.components[0]!;
    cadence = {
      cadenceEnrollmentId: 'binding-enrollment', cadenceDefinitionId: definition.id,
      cadenceStepId: step.id, cadenceComponentId: component.id,
    };
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'binding-cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'seed-action', stageEnteredAt: DOMAIN_TIMESTAMP,
        createdAt: DOMAIN_TIMESTAMP,
      });
      database!.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, created_at, updated_at
        ) VALUES ('binding-enrollment', 'binding-cycle', ?, 'active', ?, ?, 1,
          'standard', NULL, 1, ?, ?)
      `).run(definition.id, DOMAIN_TIMESTAMP, step.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      actions.insertNextAction({
        id: 'seed-action', salesCycleId: 'binding-cycle', actionType: 'review', channel: null,
        status: 'pending', timezone: 'America/New_York',
        allowedWindow: null, workIntent: 'internal_review',
        inboundSla: NONE_SLA,
        cadence: {
          cadenceEnrollmentId: null, cadenceDefinitionId: null,
          cadenceStepId: null, cadenceComponentId: null,
        }, createdAt: DOMAIN_TIMESTAMP,
      });
    });
    return prospect;
  }

  it('rejects a text action masquerading as the installed call component on insert', async () => {
    await setup();
    expect(() => insertAction('text', 'phone')).toThrow();
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions WHERE id = 'binding-action'
    `).get()).toEqual({ count: 0 });
  });

  it('rejects a raw pending masquerade on reread', async () => {
    await setup();
    insertRawAction('text', 'phone');
    expect(() => actions.getById('binding-action')).toThrow();
  });

  it('rejects a raw pending masquerade on reschedule without changing its due time', async () => {
    await setup();
    insertRawAction('text', 'phone');
    expect(() => unitOfWork.immediate(() => actions.reschedulePendingAction({
      actionId: 'binding-action', salesCycleId: 'binding-cycle', expectedStatus: 'pending',
      expectedVersion: 1,
      expectedWorkIntent: 'discretionary_prospecting', expectedInboundSla: NONE_SLA,
      expectedCadence: cadence, updatedAt: DOMAIN_TIMESTAMP,
      timezone: 'America/New_York', allowedWindow: 'afternoon',
      cadence,
    }))).toThrow();
    expect(database!.raw.prepare(`
      SELECT allowed_window FROM next_actions WHERE id = 'binding-action'
    `).get()).toEqual({ allowed_window: 'afternoon' });
  });

  it('reports a raw pending masquerade in the invariant audit', async () => {
    await setup();
    insertRawAction('text', 'phone');
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP }))
      .toContainEqual(expect.objectContaining({
        kind: 'action_cadence_binding_invalid', recordId: 'binding-action',
      }));
  });

  it.each([
    { label: 'standard component', actionType: 'call', channel: 'phone' },
    { label: 'resolver branch', actionType: 'resolve_contact_method', channel: null },
  ])('accepts and reschedules a canonical $label binding', async ({ actionType, channel }) => {
    await setup();
    const inserted = insertAction(actionType, channel);
    expect(inserted).toMatchObject({ actionType, channel, cadence });
    expect(actions.getById('binding-action')).toMatchObject({ actionType, channel, cadence });

    const rescheduled = unitOfWork.immediate(() => actions.reschedulePendingAction({
      actionId: 'binding-action', salesCycleId: 'binding-cycle', expectedStatus: 'pending',
      expectedVersion: 1,
      expectedWorkIntent: 'discretionary_prospecting', expectedInboundSla: NONE_SLA,
      expectedCadence: cadence, updatedAt: DOMAIN_TIMESTAMP,
      timezone: 'America/New_York', allowedWindow: 'afternoon',
      cadence,
    }));
    expect(rescheduled).toMatchObject({ version: 2, actionType, channel, cadence });
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP }))
      .not.toContainEqual(expect.objectContaining({
        kind: 'action_cadence_binding_invalid', recordId: 'binding-action',
      }));
  });

  function insertAction(actionType: string, channel: string | null) {
    return unitOfWork.immediate(() => actions.insertNextAction({
      id: 'binding-action', salesCycleId: 'binding-cycle', actionType, channel,
      status: 'pending', timezone: 'America/New_York',
      allowedWindow: 'afternoon',
      workIntent: 'discretionary_prospecting', inboundSla: NONE_SLA,
      cadence, createdAt: DOMAIN_TIMESTAMP,
    }));
  }

  function insertRawAction(actionType: string, channel: string | null): void {
    database!.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, timezone,
        allowed_window, work_intent, cadence_enrollment_id, cadence_step_id,
        cadence_component_id, version, created_at, updated_at
      ) VALUES ('binding-action', 'binding-cycle', ?, ?, 'pending',
        'America/New_York', 'afternoon', 'discretionary_prospecting', ?, ?, ?, 1, ?, ?)
    `).run(
      actionType, channel, cadence.cadenceEnrollmentId,
      cadence.cadenceStepId, cadence.cadenceComponentId,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
  }
});
