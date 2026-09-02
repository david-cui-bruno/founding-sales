import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const LATER = '2026-08-30T13:00:00.000Z';

describe('SalesCycleRepository', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let cycles: SalesCycleRepository;
  let actions: NextActionRepository;

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
    cycles = new SalesCycleRepository({ database, unitOfWork });
    actions = new NextActionRepository({ database, unitOfWork });
    return seedProspect(database.raw, 'cycle-repository');
  }

  it('constructs the deferred cycle/action pair only in the exact write scope', async () => {
    const prospect = await setup();
    const cycleInput = {
      id: 'cycle-one',
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      stage: 'ready' as const,
      workflowStatus: 'active' as const,
      currentNextActionId: 'action-one',
      stageEnteredAt: DOMAIN_TIMESTAMP,
      createdAt: DOMAIN_TIMESTAMP,
    };

    expect(() => cycles.insertCycleWithDeferredAction(cycleInput)).toThrow();
    const result = unitOfWork.immediate(() => {
      const cycle = cycles.insertCycleWithDeferredAction(cycleInput);
      actions.insertNextAction({
        id: 'action-one', salesCycleId: cycle.id, actionType: 'review_lead', channel: null,
        status: 'pending', timezone: 'America/New_York',
        allowedWindow: null, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: {
          cadenceEnrollmentId: null, cadenceDefinitionId: null,
          cadenceStepId: null, cadenceComponentId: null,
        },
        createdAt: DOMAIN_TIMESTAMP,
      });
      cycles.assertCurrentActionPostcondition(cycle.id);
      return cycles.getById(cycle.id);
    });

    expect(result).toMatchObject({
      id: 'cycle-one', stage: 'ready', workflowStatus: 'active',
      currentNextActionId: 'action-one', version: 1,
    });
    expect(cycles.getOperationalCycleForPerson(prospect.personId)?.id).toBe('cycle-one');
  });

  it('CAS-compares version, stage, workflow, and current action before pointer replacement', async () => {
    const prospect = await setup();
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'cycle-one', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready',
        workflowStatus: 'active', currentNextActionId: 'action-one',
        stageEnteredAt: DOMAIN_TIMESTAMP, createdAt: DOMAIN_TIMESTAMP,
      });
      for (const id of ['action-one', 'action-two']) {
        actions.insertNextAction({
          id, salesCycleId: 'cycle-one', actionType: 'review_lead', channel: null,
          status: 'pending', timezone: 'America/New_York',
          allowedWindow: null, workIntent: 'internal_review',
          inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
          cadence: {
            cadenceEnrollmentId: null, cadenceDefinitionId: null,
            cadenceStepId: null, cadenceComponentId: null,
          }, createdAt: DOMAIN_TIMESTAMP,
        });
      }
    });

    const transitioned = unitOfWork.immediate(() => cycles.transitionOpenProjection({
      cycleId: 'cycle-one', expectedVersion: 1, expectedStage: 'ready',
      expectedWorkflowStatus: 'active', expectedCurrentActionId: 'action-one',
      nextStage: 'contacted', nextWorkflowStatus: 'active', nextActionId: 'action-two',
      stageEnteredAt: LATER,
    }));
    expect(transitioned).toMatchObject({
      stage: 'contacted', currentNextActionId: 'action-two', version: 2,
    });

    expect(() => unitOfWork.immediate(() => cycles.transitionOpenProjection({
      cycleId: 'cycle-one', expectedVersion: 1, expectedStage: 'ready',
      expectedWorkflowStatus: 'active', expectedCurrentActionId: 'action-one',
      nextStage: 'contacted', nextWorkflowStatus: 'active', nextActionId: 'action-two',
      stageEnteredAt: LATER,
    }))).toThrow(StaleDomainWriteError);
  });
});
