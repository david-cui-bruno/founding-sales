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
import { ReactivationRepository } from '../../src/main/domain/lifecycle/reactivationRepository';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { OperationalCycleExistsError, StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import {
  spawnActionCompletionWorker,
  spawnDomainWriteWorker,
  spawnSqlTransactionWorker,
} from '../support/domainWriteWorker';

const OCTOBER = '2026-10-01T13:00:00.000Z';

describe('concurrent SalesCycle invariant', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function openLifecycleHarness(ids: readonly string[] = []) {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const remaining = [...ids];
    const idSource = { next: () => {
      const id = remaining.shift();
      if (id === undefined) throw new Error('Race loser consumed an unexpected ID.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids: idSource });
    const events = new EventRepository({ database, unitOfWork, clock, ids: idSource });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    return {
      key, unitOfWork, events,
      service: new LifecycleService({
        database, unitOfWork, identities, events, sources, cadences, clock, ids: idSource,
        timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
      }),
    };
  }

  function seedCadenceCycle(input: {
    prefix: string;
    family: 'post_interview' | 'post_offer';
    stage: 'interviewed' | 'offered';
    stepIndex: number;
  }) {
    if (database === undefined) throw new Error('Race database is not open.');
    const prospect = seedProspect(database.raw, input.prefix);
    const definition = BUILTIN_CADENCES.find(({ family }) => family === input.family)!;
    const step = definition.steps[input.stepIndex]!;
    const component = step.components[0]!;
    const cycleId = `${input.prefix}-cycle`;
    const enrollmentId = `${input.prefix}-enrollment`;
    const actionId = `${input.prefix}-action`;
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
          current_next_action_id, stage_entered_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)
      `).run(
        cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
        input.stage, actionId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, stop_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'standard', NULL, 1, NULL, ?, ?)
      `).run(
        enrollmentId, cycleId, definition.id, DOMAIN_TIMESTAMP,
        step.id, input.stepIndex + 1, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          allowed_window, work_intent, cadence_enrollment_id, cadence_step_id,
          cadence_component_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, 'America/New_York', 'afternoon',
          'promised_follow_up', ?, ?, ?, 1, ?, ?)
      `).run(
        actionId, cycleId, component.actionType, component.channel, DOMAIN_TIMESTAMP,
        enrollmentId, step.id, component.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    return { prospect, definition, step, component, cycleId, enrollmentId, actionId };
  }

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
          componentId: component.id, attempt: 2, outcome: 'answered',
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

  it('serializes two reactivation rules and replays the winning immutable receipt', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'reactivation-race');
    const sourceCycleId = insertClosedCycle({
      database: database.raw, prefix: 'reactivation-race-source', prospect,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => OCTOBER };
    const allocated = ['losing-review'];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Receipt replay consumed an ID.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    const reactivations = new ReactivationRepository({ database, unitOfWork });
    unitOfWork.immediate(() => {
      cadences.installBuiltins();
      for (const ruleId of ['winning-rule', 'losing-rule']) {
        reactivations.insertRule({
          id: ruleId, salesCycleId: sourceCycleId, ruleType: 'manual',
          dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
        });
      }
    });
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const step = definition.steps[0]!;
    const component = step.components[0]!;
    const cadence = {
      definitionId: definition.id, family: 'cadence_c' as const,
      version: definition.version, contentHash: definition.contentHash,
    };
    const commandFor = (ruleId: string, newCycleId: string) => ({
      ruleId, expectedRuleVersion: 1, personId: prospect.personId,
      prospectId: prospect.prospectId, sourceCycleId,
      entrySourceEventId: prospect.sourceEventId, newCycleId,
      activatedAt: OCTOBER, ruleType: 'manual' as const,
      trigger: { kind: 'due' as const, dueAt: OCTOBER }, cadence,
    });
    const winning = commandFor('winning-rule', 'winning-cycle');
    const commandJson = canonicalJson({ version: 1, command: winning });
    const resultJson = canonicalJson({
      version: 1,
      result: {
        kind: 'reactivated', activationKind: 'rule', cadence,
        cycle: {
          id: 'winning-cycle', personId: prospect.personId,
          prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId,
          stage: 'ready', workflowStatus: 'active', currentNextActionId: 'winning-action',
          stageEnteredAt: OCTOBER, designPartnerFitness: null, closeReason: null,
          closeNotes: null, onboardingStopReason: null, closedAt: null,
          version: 1, createdAt: OCTOBER, updatedAt: OCTOBER,
        },
      },
    });
    const readyPath = `${workspace.path}.reactivation-ready`;
    const worker = spawnSqlTransactionWorker({
      databasePath: workspace.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath,
      statements: [
        {
          sql: `INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
            current_next_action_id, stage_entered_at, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'ready', 'active', ?, ?, 1, ?, ?)`,
          params: [
            'winning-cycle', prospect.personId, prospect.prospectId, prospect.sourceEventId,
            'winning-action', OCTOBER, OCTOBER, OCTOBER,
          ],
        },
        {
          sql: `INSERT INTO cadence_enrollments (
            id, sales_cycle_id, cadence_definition_id, status, anchor_at,
            current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
            version, stop_reason, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, 1, 'standard', NULL, 1, NULL, ?, ?)`,
          params: [
            'winning-enrollment', 'winning-cycle', definition.id, OCTOBER,
            step.id, OCTOBER, OCTOBER,
          ],
        },
        {
          sql: `INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status, due_at, timezone,
            allowed_window, work_intent, cadence_enrollment_id, cadence_step_id,
            cadence_component_id, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, 'America/New_York', ?,
            'promised_follow_up', ?, ?, ?, 1, ?, ?)`,
          params: [
            'winning-action', 'winning-cycle', component.actionType, component.channel,
            OCTOBER, 'founder_text_v1:morning', 'winning-enrollment', step.id,
            component.id, OCTOBER, OCTOBER,
          ],
        },
        {
          sql: `INSERT INTO stage_events (
            id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
            confirmation_kind, transition_sequence, created_at
          ) VALUES ('winning-stage', 'winning-cycle', NULL, 'ready', ?, ?, 'mechanical', 1, ?)`,
          params: [OCTOBER, OCTOBER, OCTOBER],
        },
        {
          sql: `UPDATE reactivation_rules SET consumed_at = ?
            WHERE id = 'winning-rule' AND consumed_at IS NULL`,
          params: [OCTOBER],
        },
        {
          sql: `INSERT INTO cycle_reactivation_receipts (
            activation_key, activation_kind, person_id, source_cycle_id,
            reactivation_rule_id, source_event_id, new_cycle_id,
            command_json, result_json, created_at
          ) VALUES ('rule:winning-rule', 'rule', ?, ?, 'winning-rule', NULL,
            'winning-cycle', ?, ?, ?)`,
          params: [prospect.personId, sourceCycleId, commandJson, resultJson, OCTOBER],
        },
      ],
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    const losingResult = service.reactivateFromRule(
      commandFor('losing-rule', 'losing-cycle'),
    );
    expect(losingResult).toMatchObject({
      kind: 'review_required',
      reviewItem: { id: 'losing-review', reason: 'operational_cycle_exists' },
    });
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(service.reactivateFromRule(winning)).toMatchObject({
      kind: 'reactivated', cycle: { id: 'winning-cycle', currentNextActionId: 'winning-action' },
    });
    expect(reactivations.getRule('winning-rule')?.consumedAt).toBe(OCTOBER);
    expect(reactivations.getRule('losing-rule')?.consumedAt).toBeNull();
    expect(database.raw.prepare(`
      SELECT id, current_next_action_id FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).all(prospect.personId)).toEqual([
      { id: 'winning-cycle', current_next_action_id: 'winning-action' },
    ]);
  }, 10_000);

  it('serializes replacement against close without orphan rules or actions', async () => {
    const harness = await openLifecycleHarness();
    const seeded = seedCadenceCycle({
      prefix: 'replacement-close-race', family: 'post_interview',
      stage: 'interviewed', stepIndex: 1,
    });
    harness.unitOfWork.immediate(() => harness.events.appendActivity({
      id: 'replacement-close-activity', personId: seeded.prospect.personId,
      prospectId: seeded.prospect.prospectId, salesCycleId: seeded.cycleId,
      cadenceEnrollmentId: seeded.enrollmentId, cadenceStepId: seeded.step.id,
      cadenceComponentId: seeded.component.id, kind: 'call', direction: 'outbound',
      channel: 'phone', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'answered', metadata: {},
    }));
    const settlementJson = canonicalJson({
      version: 1, outcome: 'answered', reason: null,
      evidenceActivityId: 'replacement-close-activity',
      plannerTransition: {
        definitionId: seeded.definition.id, stepId: seeded.step.id,
        componentId: seeded.component.id, attempt: seeded.step.sequence + 1,
        outcome: 'answered',
      },
      cadence: {
        cadenceEnrollmentId: seeded.enrollmentId,
        cadenceDefinitionId: seeded.definition.id,
        cadenceStepId: seeded.step.id, cadenceComponentId: seeded.component.id,
      },
      workIntent: 'promised_follow_up',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
    });
    const readyPath = `${workspace!.path}.replacement-close-ready`;
    const worker = spawnActionCompletionWorker({
      databasePath: workspace!.path, nativeBinding: resolveNativeBinding(),
      keyHex: harness.key.bytes.toString('hex'), readyPath,
      cycleId: seeded.cycleId, enrollmentId: seeded.enrollmentId,
      actionId: seeded.actionId, replacementActionId: 'replacement-close-winner',
      activityId: 'replacement-close-activity', timestamp: DOMAIN_TIMESTAMP, settlementJson,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    expect(() => harness.service.closeLostNurture({
      cycleId: seeded.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: seeded.actionId, reason: 'bad_timing', notes: null,
      effectiveAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: OCTOBER,
      expectedProspectVersion: null,
    })).toThrow();
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT current_next_action_id, workflow_status FROM sales_cycles WHERE id = ?
    `).get(seeded.cycleId)).toEqual({
      current_next_action_id: 'replacement-close-winner', workflow_status: 'active',
    });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM reactivation_rules WHERE sales_cycle_id = ?
    `).get(seeded.cycleId)).toEqual({ count: 0 });
    expect(database!.raw.prepare(`
      SELECT id, status FROM next_actions WHERE sales_cycle_id = ? ORDER BY id
    `).all(seeded.cycleId)).toEqual([
      { id: seeded.actionId, status: 'completed' },
      { id: 'replacement-close-winner', status: 'pending' },
    ]);
  }, 10_000);

  it('serializes Won against Lost-Nurture so exactly one terminal projection wins', async () => {
    const harness = await openLifecycleHarness();
    const seeded = seedCadenceCycle({
      prefix: 'won-lost-race', family: 'post_offer', stage: 'offered', stepIndex: 0,
    });
    const settlement = canonicalJson({
      version: 1, outcome: 'lost_nurture', reason: 'bad_timing', evidenceActivityId: null,
      plannerTransition: {
        definitionId: seeded.definition.id, stepId: seeded.step.id,
        componentId: seeded.component.id, attempt: seeded.step.sequence + 1,
        outcome: 'lost_nurture',
      },
      cadence: {
        cadenceEnrollmentId: seeded.enrollmentId,
        cadenceDefinitionId: seeded.definition.id,
        cadenceStepId: seeded.step.id, cadenceComponentId: seeded.component.id,
      }, workIntent: 'promised_follow_up',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
    });
    const readyPath = `${workspace!.path}.won-lost-ready`;
    const worker = spawnSqlTransactionWorker({
      databasePath: workspace!.path, nativeBinding: resolveNativeBinding(),
      keyHex: harness.key.bytes.toString('hex'), readyPath,
      statements: [
        {
          sql: `UPDATE cadence_enrollments SET status='stopped', stop_reason='phase_completed',
            version=version+1, updated_at=? WHERE id=? AND status='active'`,
          params: [DOMAIN_TIMESTAMP, seeded.enrollmentId],
        },
        {
          sql: `INSERT INTO reactivation_rules (
            id, sales_cycle_id, rule_type, due_at, matcher_json, version, consumed_at, created_at
          ) VALUES ('won-lost-manual', ?, 'manual', ?, NULL, 1, NULL, ?)`,
          params: [seeded.cycleId, OCTOBER, DOMAIN_TIMESTAMP],
        },
        {
          sql: `UPDATE sales_cycles SET stage='lost_nurture', workflow_status='closed',
            current_next_action_id=NULL, stage_entered_at=?, close_reason='bad_timing',
            close_notes=NULL, onboarding_stop_reason=NULL, closed_at=?, version=version+1,
            updated_at=? WHERE id=? AND version=1 AND stage='offered'
            AND current_next_action_id=?`,
          params: [DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, seeded.cycleId, seeded.actionId],
        },
        {
          sql: `INSERT INTO stage_events (
            id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
            confirmation_kind, transition_sequence, created_at
          ) VALUES ('won-lost-event', ?, 'offered', 'lost_nurture', ?, ?, 'founder', 1, ?)`,
          params: [seeded.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP],
        },
        {
          sql: `UPDATE next_actions SET status='cancelled', settlement_json=?, completed_at=?,
            version=version+1, updated_at=? WHERE id=? AND status='pending'`,
          params: [settlement, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, seeded.actionId],
        },
      ],
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    expect(() => harness.service.confirmWon({
      cycleId: seeded.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: seeded.actionId, effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
      terms: {
        billingModel: 'per_door_monthly', doorsCommitted: 2, unitRateCents: 5000,
        foundingCustomer: true, effectiveAt: DOMAIN_TIMESTAMP,
      },
    })).toThrow();
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id FROM sales_cycles WHERE id = ?
    `).get(seeded.cycleId)).toEqual({
      stage: 'lost_nurture', workflow_status: 'closed', current_next_action_id: null,
    });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM won_terms WHERE sales_cycle_id = ?
    `).get(seeded.cycleId)).toEqual({ count: 0 });
  }, 10_000);

  it('re-reads and cancels a concurrent replacement inside the scoped opt-out seam', async () => {
    const harness = await openLifecycleHarness();
    const seeded = seedCadenceCycle({
      prefix: 'optout-replacement-race', family: 'post_interview',
      stage: 'interviewed', stepIndex: 1,
    });
    harness.unitOfWork.immediate(() => {
      harness.events.appendActivity({
        id: 'optout-replacement-completion', personId: seeded.prospect.personId,
        prospectId: seeded.prospect.prospectId, salesCycleId: seeded.cycleId,
        cadenceEnrollmentId: seeded.enrollmentId, cadenceStepId: seeded.step.id,
        cadenceComponentId: seeded.component.id, kind: 'call', direction: 'outbound',
        channel: 'phone', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'answered', metadata: {},
      });
      harness.events.appendActivity({
        id: 'optout-race-evidence', personId: seeded.prospect.personId,
        prospectId: seeded.prospect.prospectId, salesCycleId: seeded.cycleId,
        kind: 'text', direction: 'inbound', channel: 'text', occurredAt: DOMAIN_TIMESTAMP,
        observedOutcome: 'opted_out', metadata: {},
      });
    });
    const settlementJson = canonicalJson({
      version: 1, outcome: 'answered', reason: null,
      evidenceActivityId: 'optout-replacement-completion',
      plannerTransition: {
        definitionId: seeded.definition.id, stepId: seeded.step.id,
        componentId: seeded.component.id, attempt: seeded.step.sequence + 1,
        outcome: 'answered',
      }, cadence: {
        cadenceEnrollmentId: seeded.enrollmentId,
        cadenceDefinitionId: seeded.definition.id,
        cadenceStepId: seeded.step.id, cadenceComponentId: seeded.component.id,
      }, workIntent: 'promised_follow_up',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
    });
    const readyPath = `${workspace!.path}.optout-replacement-ready`;
    const worker = spawnActionCompletionWorker({
      databasePath: workspace!.path, nativeBinding: resolveNativeBinding(),
      keyHex: harness.key.bytes.toString('hex'), readyPath,
      cycleId: seeded.cycleId, enrollmentId: seeded.enrollmentId,
      actionId: seeded.actionId, replacementActionId: 'optout-race-replacement',
      activityId: 'optout-replacement-completion', timestamp: DOMAIN_TIMESTAMP, settlementJson,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    const result = harness.unitOfWork.immediate(() => harness.service.scopedWriter().closeForOptOut({
      personId: seeded.prospect.personId, evidenceActivityId: 'optout-race-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: 'optout-race-terminal',
    }));
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(result.cycle).toMatchObject({
      stage: 'lost_nurture', workflowStatus: 'closed', currentNextActionId: null,
    });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions
      WHERE sales_cycle_id = ? AND status = 'pending'
    `).get(seeded.cycleId)).toEqual({ count: 0 });
    expect(database!.raw.prepare(`
      SELECT id, status FROM next_actions WHERE sales_cycle_id = ? ORDER BY id
    `).all(seeded.cycleId)).toEqual([
      { id: 'optout-race-replacement', status: 'cancelled' },
      { id: seeded.actionId, status: 'completed' },
    ]);
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
