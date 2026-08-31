import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { canonicalJson } from '../../src/main/domain/cadence/cadenceTypes';
import { resolveNativeBinding } from '../../src/main/db/sqliteDriver';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { OperationalCycleExistsError, StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { spawnActionCompletionWorker, spawnDomainWriteWorker } from '../support/domainWriteWorker';

describe('concurrent SalesCycle invariant', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('serializes independent encrypted connections so one Person gets one open cycle', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'race');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`)
      .run(prospect.prospectId);
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const ids = { next: () => 'must-not-be-consumed' };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const readyPath = `${workspace.path}.cycle-ready`;
    const worker = spawnDomainWriteWorker({
      databasePath: workspace.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceEventId: prospect.sourceEventId, cycleId: 'worker-cycle',
      actionId: 'worker-action', eventId: 'worker-event', timestamp: DOMAIN_TIMESTAMP,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    expect(() => service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    })).toThrow(OperationalCycleExistsError);
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(database.raw.prepare(`
      SELECT id, current_next_action_id FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).all(prospect.personId)).toEqual([
      { id: 'worker-cycle', current_next_action_id: 'worker-action' },
    ]);
  }, 10_000);

  it('allows one exact current-action CAS winner without an orphan replacement', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'action-race');
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    let consumedIds = 0;
    const ids = { next: () => {
      consumedIds += 1;
      return `loser-id-${consumedIds}`;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'post_interview')!;
    const step = definition.steps[1]!;
    const component = step.components[0]!;
    const cycleId = 'action-race-cycle';
    const enrollmentId = 'action-race-enrollment';
    const actionId = 'action-race-current';
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'interviewed', 'active', ?, ?, 1, ?, ?)
      `).run(
        cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
        actionId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          stop_reason, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, 2, 'standard', NULL, NULL, 1, ?, ?)
      `).run(
        enrollmentId, cycleId, definition.id, DOMAIN_TIMESTAMP, step.id,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          allowed_window, work_intent, cadence_enrollment_id, cadence_step_id,
          cadence_component_id, version, created_at, updated_at
        ) VALUES (?, ?, 'call', 'phone', 'pending', ?, 'America/New_York',
          'afternoon', 'promised_follow_up', ?, ?, ?, 1, ?, ?)
      `).run(
        actionId, cycleId, DOMAIN_TIMESTAMP, enrollmentId, step.id, component.id,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    unitOfWork.immediate(() => events.appendActivity({
      id: 'action-race-activity', personId: prospect.personId,
      prospectId: prospect.prospectId, salesCycleId: cycleId,
      cadenceEnrollmentId: enrollmentId, cadenceStepId: step.id,
      cadenceComponentId: component.id, kind: 'call', direction: 'outbound',
      channel: 'phone', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'answered', metadata: {},
    }));
    const readyPath = `${workspace.path}.action-ready`;
    const worker = spawnActionCompletionWorker({
      databasePath: workspace.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath, cycleId, enrollmentId,
      actionId, replacementActionId: 'worker-confirm-offer',
      activityId: 'action-race-activity', timestamp: DOMAIN_TIMESTAMP,
      settlementJson: canonicalJson({
        version: 1,
        outcome: 'answered',
        reason: null,
        evidenceActivityId: 'action-race-activity',
        plannerTransition: {
          definitionId: definition.id, stepId: step.id,
          componentId: component.id, outcome: 'answered',
        },
        cadence: {
          cadenceEnrollmentId: enrollmentId, cadenceDefinitionId: definition.id,
          cadenceStepId: step.id, cadenceComponentId: component.id,
        },
        workIntent: 'promised_follow_up',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      }),
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    expect(() => service.completeCurrentAction({
      cycleId, expectedCycleVersion: 1, expectedCurrentActionId: actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'answered', activityId: 'action-race-activity', impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    })).toThrow(StaleDomainWriteError);
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(consumedIds).toBe(0);
    expect(database.raw.prepare(`
      SELECT current_next_action_id, version FROM sales_cycles WHERE id = ?
    `).get(cycleId)).toEqual({ current_next_action_id: 'worker-confirm-offer', version: 2 });
    expect(database.raw.prepare(`
      SELECT id, status FROM next_actions WHERE sales_cycle_id = ? ORDER BY id
    `).all(cycleId)).toEqual([
      { id: 'action-race-current', status: 'completed' },
      { id: 'worker-confirm-offer', status: 'pending' },
    ]);
    expect(database.raw.prepare(`
      SELECT status, stop_reason, version FROM cadence_enrollments WHERE id = ?
    `).get(enrollmentId)).toEqual({ status: 'completed', stop_reason: 'phase_completed', version: 2 });
  }, 10_000);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle contender.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}
