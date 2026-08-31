import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import type {
  ActionSettlement, CadenceActionBinding,
} from '../../src/main/domain/lifecycle/lifecycleTypes';
import { serializeCanonical } from '../../src/main/domain/lifecycle/lifecycleValidation';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertPerson,
  insertSourceEvent,
  seedProspect,
} from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const DUE = '2026-08-30T12:15:00.000Z';
const RESCHEDULED = '2026-08-30T13:15:00.000Z';
const NO_CADENCE: CadenceActionBinding = {
  cadenceEnrollmentId: null, cadenceDefinitionId: null,
  cadenceStepId: null, cadenceComponentId: null,
};

describe('authoritative next-action persistence', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let actions: NextActionRepository;
  let cycles: SalesCycleRepository;
  let events: EventRepository;

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
    events = new EventRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
      ids: { next: () => 'unexpected-generated-event-id' },
    });
    const prospect = seedProspect(database.raw, 'next-action');
    insertSourceEvent({
      database: database.raw, id: 'demo-source', personId: prospect.personId,
      channel: 'inbound_demo',
    });
    return prospect;
  }

  it('stores immutable inbound SLA provenance and CAS-reschedules the same pending action', async () => {
    const prospect = await setup();
    const inboundSla = {
      kind: 'inbound_demo_permitted_minutes' as const,
      dueAt: DUE,
      sourceEventId: 'demo-source',
      provenance: {
        version: 1 as const, sourceEventId: 'demo-source', sourceObservedAt: DOMAIN_TIMESTAMP,
        calculation: 'permitted_minutes' as const, minutes: 15 as const,
        policyId: 'founder_text_v1', computedDueAt: DUE,
      },
    };
    const initial = unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'action', stageEnteredAt: DOMAIN_TIMESTAMP, createdAt: DOMAIN_TIMESTAMP,
      });
      return actions.insertNextAction({
        id: 'action', salesCycleId: 'cycle', actionType: 'text', channel: 'text',
        status: 'pending', dueAt: DUE, timezone: 'America/New_York',
        allowedWindow: '[09:00,20:00)', slaDueAt: DUE, workIntent: 'inbound_response',
        inboundSla, cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
    });
    expect(initial).toMatchObject({ workIntent: 'inbound_response', inboundSla, version: 1 });

    const rescheduled = unitOfWork.immediate(() => actions.reschedulePendingAction({
      actionId: 'action', salesCycleId: 'cycle', expectedStatus: 'pending',
      expectedVersion: 1, expectedDueAt: DUE, expectedWorkIntent: 'inbound_response',
      expectedInboundSla: inboundSla, expectedCadence: NO_CADENCE,
      dueAt: RESCHEDULED, updatedAt: DOMAIN_TIMESTAMP,
      timezone: 'America/New_York', allowedWindow: '[13:00,17:00)',
      slaDueAt: DUE, cadence: NO_CADENCE,
    }));
    expect(rescheduled).toMatchObject({
      id: 'action', status: 'pending', dueAt: RESCHEDULED,
      workIntent: 'inbound_response', inboundSla, version: 2, updatedAt: DOMAIN_TIMESTAMP,
    });

    expect(() => unitOfWork.immediate(() => actions.reschedulePendingAction({
      actionId: 'action', salesCycleId: 'cycle', expectedStatus: 'pending',
      expectedVersion: 1, expectedDueAt: DUE, expectedWorkIntent: 'inbound_response',
      expectedInboundSla: inboundSla, expectedCadence: NO_CADENCE,
      dueAt: RESCHEDULED, updatedAt: DOMAIN_TIMESTAMP,
      timezone: 'America/New_York', allowedWindow: '[13:00,17:00)',
      slaDueAt: DUE, cadence: NO_CADENCE,
    }))).toThrow(StaleDomainWriteError);
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET work_intent = 'discretionary_prospecting' WHERE id = 'action'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET action_type = 'call', channel = 'phone' WHERE id = 'action'
    `).run()).toThrow();

    unitOfWork.immediate(() => {
      actions.insertNextAction({
        id: 'replacement', salesCycleId: 'cycle', actionType: 'follow_up', channel: null,
        status: 'pending', dueAt: RESCHEDULED, timezone: 'America/New_York',
        allowedWindow: null, slaDueAt: null, workIntent: 'promised_follow_up',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: RESCHEDULED,
      });
      cycles.replaceCurrentAction({
        cycleId: 'cycle', expectedVersion: 1, expectedStage: 'ready',
        expectedWorkflowStatus: 'active', expectedCurrentActionId: 'action',
        nextActionId: 'replacement', updatedAt: RESCHEDULED,
      });
      expect(() => database!.raw.prepare(`
        UPDATE next_actions
        SET status = 'completed', completed_at = ?, settlement_json = ?,
          due_at = '2026-09-01T12:00:00.000Z'
        WHERE id = 'action'
      `).run(RESCHEDULED, JSON.stringify({
        version: 1, outcome: 'reviewed_ready', reason: null, evidenceActivityId: null,
        plannerTransition: {
          definitionId: null, stepId: null, componentId: null,
          attempt: null, outcome: 'reviewed_ready',
        }, cadence: NO_CADENCE, workIntent: 'inbound_response', inboundSla,
      }))).toThrow();
      actions.settleAction({
        actionId: 'action', salesCycleId: 'cycle', expectedStatus: 'pending',
        expectedVersion: 2, expectedWorkIntent: 'inbound_response',
        expectedInboundSla: inboundSla, expectedCadence: NO_CADENCE,
        status: 'completed', completedAt: RESCHEDULED, completionActivityId: null,
        settlement: {
          version: 1, outcome: 'reviewed_ready', reason: null, evidenceActivityId: null,
          plannerTransition: {
            definitionId: null, stepId: null, componentId: null,
            attempt: null, outcome: 'reviewed_ready',
          }, cadence: NO_CADENCE, workIntent: 'inbound_response', inboundSla,
        },
      });
    });
    expect(() => database!.raw.prepare(`
      UPDATE next_actions SET status = 'impossible' WHERE id = 'action'
    `).run()).toThrow();
    for (const mutation of [
      `UPDATE next_actions SET due_at = '2026-09-01T12:00:00.000Z' WHERE id = 'action'`,
      `UPDATE next_actions SET timezone = 'UTC' WHERE id = 'action'`,
      `UPDATE next_actions SET allowed_window = '[17:00,20:00)' WHERE id = 'action'`,
      `UPDATE next_actions SET sla_due_at = '2026-09-01T12:00:00.000Z' WHERE id = 'action'`,
      `UPDATE next_actions SET created_at = '2026-08-29T12:00:00.000Z' WHERE id = 'action'`,
    ]) {
      expect(() => database!.raw.exec(mutation)).toThrow();
    }
    expect(() => database!.raw.exec(`
      INSERT OR REPLACE INTO next_actions
      SELECT * FROM next_actions WHERE id = 'action'
    `)).toThrow();
  });

  it('rejects partial and cross-Person inbound SLA evidence before durable action creation', async () => {
    const prospect = await setup();
    insertPerson(database!.raw, 'other-person');
    insertSourceEvent({
      database: database!.raw, id: 'other-demo', personId: 'other-person', channel: 'inbound_demo',
    });
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'seed-action', stageEnteredAt: DOMAIN_TIMESTAMP, createdAt: DOMAIN_TIMESTAMP,
      });
      actions.insertNextAction({
        id: 'seed-action', salesCycleId: 'cycle', actionType: 'review', channel: null,
        status: 'pending', dueAt: DUE, timezone: 'America/New_York', allowedWindow: null,
        slaDueAt: null, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
    });

    expect(() => unitOfWork.immediate(() => actions.insertNextAction({
      id: 'bad-action', salesCycleId: 'cycle', actionType: 'text', channel: 'text',
      status: 'pending', dueAt: DUE, timezone: 'America/New_York', allowedWindow: null,
      slaDueAt: DUE, workIntent: 'inbound_response', cadence: NO_CADENCE,
      inboundSla: {
        kind: 'inbound_demo_permitted_minutes', dueAt: DUE, sourceEventId: 'other-demo',
        provenance: {
          version: 1, sourceEventId: 'other-demo', sourceObservedAt: DOMAIN_TIMESTAMP,
          calculation: 'permitted_minutes', minutes: 15,
          policyId: 'founder_text_v1', computedDueAt: DUE,
        },
      }, createdAt: DOMAIN_TIMESTAMP,
    }))).toThrow();
    expect(actions.getById('bad-action')).toBeNull();
  });

  it.each([
    {
      label: 'completed opted-out', status: 'completed' as const,
      actionChannel: 'text', activityKind: 'text' as const, activityChannel: 'text',
      activityOutcome: 'opted_out', settlementOutcome: 'opted_out' as const,
      reason: 'person_wide_opt_out',
    },
    {
      label: 'mismatched Activity', status: 'completed' as const,
      actionChannel: 'text', activityKind: 'text' as const, activityChannel: 'text',
      activityOutcome: 'answered', settlementOutcome: 'accepted' as const,
      reason: null,
    },
    {
      label: 'invalid impossible reason', status: 'impossible' as const,
      actionChannel: null, activityKind: 'system' as const, activityChannel: 'internal',
      activityOutcome: 'marked_impossible', settlementOutcome: 'marked_impossible' as const,
      reason: 'invented_impossible_reason',
    },
  ])('rejects $label at direct repository settlement', async (testCase) => {
    const prospect = await setup();
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'validation-cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'validation-action', stageEnteredAt: DOMAIN_TIMESTAMP,
        createdAt: DOMAIN_TIMESTAMP,
      });
      actions.insertNextAction({
        id: 'validation-action', salesCycleId: 'validation-cycle', actionType: 'text',
        channel: testCase.actionChannel, status: 'pending', dueAt: DUE,
        timezone: 'America/New_York', allowedWindow: null, slaDueAt: null,
        workIntent: 'promised_follow_up',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
      events.appendActivity({
        id: 'validation-activity', personId: prospect.personId,
        prospectId: prospect.prospectId, salesCycleId: 'validation-cycle',
        kind: testCase.activityKind, direction: 'outbound', channel: testCase.activityChannel,
        occurredAt: DOMAIN_TIMESTAMP, observedOutcome: testCase.activityOutcome, metadata: {},
      });
      actions.insertNextAction({
        id: 'validation-replacement', salesCycleId: 'validation-cycle',
        actionType: 'review', channel: null, status: 'pending', dueAt: DUE,
        timezone: 'America/New_York', allowedWindow: null, slaDueAt: null,
        workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
      cycles.replaceCurrentAction({
        cycleId: 'validation-cycle', expectedVersion: 1, expectedStage: 'ready',
        expectedWorkflowStatus: 'active', expectedCurrentActionId: 'validation-action',
        nextActionId: 'validation-replacement', updatedAt: DOMAIN_TIMESTAMP,
      });
    });

    expect(() => unitOfWork.immediate(() => actions.settleAction({
      actionId: 'validation-action', salesCycleId: 'validation-cycle',
      expectedStatus: 'pending', expectedVersion: 1,
      expectedWorkIntent: 'promised_follow_up',
      expectedInboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      expectedCadence: NO_CADENCE, status: testCase.status,
      completedAt: DOMAIN_TIMESTAMP, completionActivityId: 'validation-activity',
      settlement: {
        version: 1, outcome: testCase.settlementOutcome,
        reason: testCase.reason, evidenceActivityId: 'validation-activity',
        plannerTransition: {
          definitionId: null, stepId: null, componentId: null,
          attempt: null, outcome: testCase.settlementOutcome,
        },
        cadence: NO_CADENCE, workIntent: 'promised_follow_up',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      },
    } as never))).toThrow();
    expect(actions.getById('validation-action')).toMatchObject({ status: 'pending' });
  });

  it('rejects a forged effective-plan attempt before repository persistence', async () => {
    const prospect = await setup();
    const cadences = new CadenceRepository({
      database: database!, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    const step = definition.steps[0]!;
    const component = step.components[0]!;
    const cadence: CadenceActionBinding = {
      cadenceEnrollmentId: 'attempt-enrollment', cadenceDefinitionId: definition.id,
      cadenceStepId: step.id, cadenceComponentId: component.id,
    };
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'attempt-cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'attempt-action', stageEnteredAt: DOMAIN_TIMESTAMP,
        createdAt: DOMAIN_TIMESTAMP,
      });
      database!.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, created_at, updated_at
        ) VALUES ('attempt-enrollment', 'attempt-cycle', ?, 'active', ?, ?, 1,
          'standard', NULL, 1, ?, ?)
      `).run(definition.id, DOMAIN_TIMESTAMP, step.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      actions.insertNextAction({
        id: 'attempt-action', salesCycleId: 'attempt-cycle', actionType: component.actionType,
        channel: component.channel, status: 'pending', dueAt: DUE,
        timezone: 'America/New_York', allowedWindow: 'afternoon', slaDueAt: null,
        workIntent: 'discretionary_prospecting',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence, createdAt: DOMAIN_TIMESTAMP,
      });
      events.appendActivity({
        id: 'attempt-activity', personId: prospect.personId,
        prospectId: prospect.prospectId, salesCycleId: 'attempt-cycle',
        cadenceEnrollmentId: 'attempt-enrollment', cadenceStepId: step.id,
        cadenceComponentId: component.id, kind: 'call', direction: 'outbound',
        channel: component.channel, occurredAt: DOMAIN_TIMESTAMP,
        observedOutcome: 'answered', metadata: {},
      });
      actions.insertNextAction({
        id: 'attempt-replacement', salesCycleId: 'attempt-cycle', actionType: 'review',
        channel: null, status: 'pending', dueAt: DUE, timezone: 'America/New_York',
        allowedWindow: null, slaDueAt: null, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
      cycles.replaceCurrentAction({
        cycleId: 'attempt-cycle', expectedVersion: 1, expectedStage: 'ready',
        expectedWorkflowStatus: 'active', expectedCurrentActionId: 'attempt-action',
        nextActionId: 'attempt-replacement', updatedAt: DOMAIN_TIMESTAMP,
      });
    });

    expect(() => unitOfWork.immediate(() => actions.settleAction({
      actionId: 'attempt-action', salesCycleId: 'attempt-cycle',
      expectedStatus: 'pending', expectedVersion: 1,
      expectedWorkIntent: 'discretionary_prospecting',
      expectedInboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      expectedCadence: cadence, status: 'completed', completedAt: DOMAIN_TIMESTAMP,
      completionActivityId: 'attempt-activity', settlement: {
        version: 1, outcome: 'answered', reason: null,
        evidenceActivityId: 'attempt-activity', plannerTransition: {
          definitionId: definition.id, stepId: step.id,
          componentId: component.id, attempt: 2, outcome: 'answered',
        }, cadence, workIntent: 'discretionary_prospecting',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      },
    }))).toThrow();
    expect(actions.getById('attempt-action')).toMatchObject({ status: 'pending' });
  });

  it('rejects a raw completed opt-out settlement on repository read', async () => {
    const prospect = await setup();
    const settlement: ActionSettlement = {
      version: 1, outcome: 'opted_out', reason: 'person_wide_opt_out',
      evidenceActivityId: 'raw-optout-activity', plannerTransition: {
        definitionId: null, stepId: null, componentId: null,
        attempt: null, outcome: 'opted_out',
      }, cadence: NO_CADENCE, workIntent: 'promised_follow_up',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
    };
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'raw-cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'raw-current', stageEnteredAt: DOMAIN_TIMESTAMP,
        createdAt: DOMAIN_TIMESTAMP,
      });
      actions.insertNextAction({
        id: 'raw-current', salesCycleId: 'raw-cycle', actionType: 'review', channel: null,
        status: 'pending', dueAt: DUE, timezone: 'America/New_York', allowedWindow: null,
        slaDueAt: null, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
      events.appendActivity({
        id: 'raw-optout-activity', personId: prospect.personId,
        prospectId: prospect.prospectId, salesCycleId: 'raw-cycle',
        kind: 'text', direction: 'inbound', channel: 'text', occurredAt: DOMAIN_TIMESTAMP,
        observedOutcome: 'opted_out', metadata: {},
      });
    });
    database!.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        work_intent, completion_activity_id, settlement_json,
        version, created_at, completed_at, updated_at
      ) VALUES ('raw-corrupt-settlement', 'raw-cycle', 'text', 'text', 'completed', ?,
        'America/New_York', 'promised_follow_up', 'raw-optout-activity', ?, 2, ?, ?, ?)
    `).run(DUE, serializeCanonical(settlement), DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);

    expect(() => actions.getById('raw-corrupt-settlement')).toThrow();
  });
});
