import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { CadenceEnrollmentRepository } from '../../src/main/domain/lifecycle/cadenceEnrollmentRepository';
import type { CadenceActionBinding } from '../../src/main/domain/lifecycle/lifecycleTypes';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const UPDATED = '2026-08-30T13:00:00.000Z';
const NO_CADENCE: CadenceActionBinding = {
  cadenceEnrollmentId: null, cadenceDefinitionId: null,
  cadenceStepId: null, cadenceComponentId: null,
};

describe('CadenceEnrollmentRepository', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let enrollments: CadenceEnrollmentRepository;

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
    unitOfWork = new DomainUnitOfWork(database);
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    enrollments = new CadenceEnrollmentRepository({ database, unitOfWork, cadences });
    const cycles = new SalesCycleRepository({ database, unitOfWork });
    const actions = new NextActionRepository({ database, unitOfWork });
    const prospect = seedProspect(database.raw, 'enrollment');
    unitOfWork.immediate(() => {
      cadences.installBuiltins();
      cycles.insertCycleWithDeferredAction({
        id: 'cycle', personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'seed-action', stageEnteredAt: DOMAIN_TIMESTAMP,
        createdAt: DOMAIN_TIMESTAMP,
      });
      actions.insertNextAction({
        id: 'seed-action', salesCycleId: 'cycle', actionType: 'review', channel: null,
        status: 'pending', dueAt: DOMAIN_TIMESTAMP, timezone: 'America/New_York',
        allowedWindow: null, slaDueAt: null, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
        cadence: NO_CADENCE, createdAt: DOMAIN_TIMESTAMP,
      });
    });
  }

  it('validates current step/count against the effective allowed plan and CAS-mutates it', async () => {
    await setup();
    const inserted = unitOfWork.immediate(() => enrollments.insertCadenceEnrollment({
      id: 'enrollment', salesCycleId: 'cycle', definitionId: 'cadence-c-v1',
      anchorAt: DOMAIN_TIMESTAMP, currentStepId: 'cadence-c-v1-day-0',
      scheduledStepCount: 1, status: 'active', mode: 'standard',
      allowedStepIds: null, createdAt: DOMAIN_TIMESTAMP,
    }));
    expect(inserted).toMatchObject({
      currentStepId: 'cadence-c-v1-day-0', scheduledStepCount: 1, version: 1,
    });

    const advanced = unitOfWork.immediate(() => enrollments.applyCadenceEnrollmentMutation({
      enrollmentId: 'enrollment', salesCycleId: 'cycle', expectedVersion: 1,
      expectedDefinitionId: 'cadence-c-v1', expectedCurrentStepId: 'cadence-c-v1-day-0',
      expectedScheduledStepCount: 1, expectedStatus: 'active', expectedMode: 'standard',
      expectedAllowedStepIds: null,
      mutation: {
        kind: 'advance_step', definitionId: 'cadence-c-v1',
        currentStepId: 'cadence-c-v1-day-1', scheduledStepCountDelta: 1,
        status: 'active', stopReason: null,
      },
      updatedAt: UPDATED,
    }));
    expect(advanced).toMatchObject({
      currentStepId: 'cadence-c-v1-day-1', scheduledStepCount: 2, version: 2,
    });
    expect(() => unitOfWork.immediate(() => enrollments.applyCadenceEnrollmentMutation({
      enrollmentId: 'enrollment', salesCycleId: 'cycle', expectedVersion: 1,
      expectedDefinitionId: 'cadence-c-v1', expectedCurrentStepId: 'cadence-c-v1-day-0',
      expectedScheduledStepCount: 1, expectedStatus: 'active', expectedMode: 'standard',
      expectedAllowedStepIds: null,
      mutation: {
        kind: 'retry', definitionId: 'cadence-c-v1',
        currentStepId: 'cadence-c-v1-day-0', scheduledStepCountDelta: 0,
        status: 'active', stopReason: null,
      }, updatedAt: UPDATED,
    }))).toThrow(StaleDomainWriteError);
  });

  it('permits over-cap mode only for built-in Warm C v1 first step with count one', async () => {
    await setup();
    const accepted = unitOfWork.immediate(() => enrollments.insertCadenceEnrollment({
      id: 'over-cap', salesCycleId: 'cycle', definitionId: 'cadence-c-v1',
      anchorAt: DOMAIN_TIMESTAMP, currentStepId: 'cadence-c-v1-day-0',
      scheduledStepCount: 1, status: 'active', mode: 'inbound_over_cap_response',
      allowedStepIds: ['cadence-c-v1-day-0'], createdAt: DOMAIN_TIMESTAMP,
    }));
    expect(accepted.allowedStepIds).toEqual(['cadence-c-v1-day-0']);
    expect(Object.isFrozen(accepted.allowedStepIds)).toBe(true);

    database!.raw.prepare(`
      UPDATE cadence_enrollments SET status = 'stopped', stop_reason = 'test'
      WHERE id = 'over-cap'
    `).run();
    expect(() => unitOfWork.immediate(() => enrollments.insertCadenceEnrollment({
      id: 'forged-over-cap', salesCycleId: 'cycle', definitionId: 'cadence-a-v1',
      anchorAt: DOMAIN_TIMESTAMP, currentStepId: 'cadence-a-v1-day-0',
      scheduledStepCount: 1, status: 'active', mode: 'inbound_over_cap_response',
      allowedStepIds: ['cadence-a-v1-day-0'], createdAt: DOMAIN_TIMESTAMP,
    }))).toThrow();
  });
});
