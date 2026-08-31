import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import type { CadenceActionBinding } from '../../src/main/domain/lifecycle/lifecycleTypes';
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
      actions.settleAction({
        actionId: 'action', salesCycleId: 'cycle', expectedStatus: 'pending',
        expectedVersion: 2, expectedWorkIntent: 'inbound_response',
        expectedInboundSla: inboundSla, expectedCadence: NO_CADENCE,
        status: 'completed', completedAt: RESCHEDULED, completionActivityId: null,
        settlement: {
          version: 1, outcome: 'completed', reason: null, evidenceActivityId: null,
          plannerTransition: {
            definitionId: null, stepId: null, componentId: null, outcome: 'completed',
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
});
