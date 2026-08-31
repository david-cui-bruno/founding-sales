import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import type {
  ActionSettlement,
  ActionSettlementOutcome,
  CadenceActionBinding,
  InboundSla,
} from '../../src/main/domain/lifecycle/lifecycleTypes';
import { serializeCanonical } from '../../src/main/domain/lifecycle/lifecycleValidation';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const DUE = '2026-08-30T12:15:00.000Z';
const NONE_SLA: Extract<InboundSla, { kind: 'none' }> = {
  kind: 'none', dueAt: null, sourceEventId: null, provenance: null,
};

describe('shared cadence settlement validation', () => {
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
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    return seedProspect(database.raw, 'cadence-settlement');
  }

  it.each([
    { label: 'reversed', kind: 'reversed' as const },
    { label: 'duplicate', kind: 'duplicate' as const },
    { label: 'truncated prospecting', kind: 'truncated' as const },
    { label: 'forged over-cap', kind: 'overcap' as const },
  ])('rejects a $label effective plan at write, reread, and audit', async ({ kind }) => {
    const prospect = await setup();
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    const first = definition.steps[0]!;
    const second = definition.steps[1]!;
    const breakup = definition.steps.at(-1)!;
    const step = kind === 'reversed' ? second : first;
    const allowedStepIds = kind === 'reversed'
      ? [second.id, first.id, breakup.id]
      : kind === 'duplicate'
        ? [first.id, first.id, breakup.id]
        : [first.id];
    const fixture = seedCadenceAction({
      prospect,
      definitionId: definition.id,
      stepId: step.id,
      componentId: step.components[0]!.id,
      scheduledStepCount: 1,
      mode: kind === 'overcap' ? 'inbound_over_cap_response' : 'standard',
      allowedStepIds,
      actionType: 'call',
      outcome: 'answered',
    });

    expect(() => settleFixture(fixture)).toThrow();
    expect(actions.getById('cadence-action')).toMatchObject({ status: 'pending' });

    persistRawSettlement(fixture);
    expect(() => actions.getById('cadence-action')).toThrow();
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP }))
      .toContainEqual(expect.objectContaining({
        kind: 'action_settlement_invalid', recordId: 'cadence-action',
      }));
  });

  it.each([
    {
      label: 'conditional call branch', componentIndex: 0, actionType: 'call',
      outcome: 'no_answer' as const, valid: true,
    },
    {
      label: 'conditional voicemail branch', componentIndex: 1, actionType: 'voicemail',
      outcome: 'voicemail_left' as const, valid: true,
    },
    {
      label: 'conditional text branch', componentIndex: 2, actionType: 'text',
      outcome: 'accepted' as const, valid: true,
    },
    {
      label: 'resolver success branch', componentIndex: 0, actionType: 'resolve_contact_method',
      outcome: 'resolved' as const, valid: true,
    },
    {
      label: 'resolver impossible branch', componentIndex: 0, actionType: 'resolve_contact_method',
      outcome: 'marked_impossible' as const, valid: true,
    },
    {
      label: 'accepted call', componentIndex: 0, actionType: 'call',
      outcome: 'accepted' as const, valid: false,
    },
    {
      label: 'answered resolver', componentIndex: 0, actionType: 'resolve_contact_method',
      outcome: 'answered' as const, valid: false,
    },
    {
      label: 'forged action type', componentIndex: 0, actionType: 'text',
      outcome: 'answered' as const, valid: false,
    },
  ])('enforces the installed component graph for $label', async (testCase) => {
    const prospect = await setup();
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    const step = definition.steps[0]!;
    const component = step.components[testCase.componentIndex]!;
    const fixture = seedCadenceAction({
      prospect,
      definitionId: definition.id,
      stepId: step.id,
      componentId: component.id,
      scheduledStepCount: 1,
      mode: 'standard',
      allowedStepIds: null,
      actionType: testCase.actionType,
      outcome: testCase.outcome,
    });

    if (testCase.valid) {
      expect(settleFixture(fixture)).toMatchObject({ status: fixture.status });
      expect(actions.getById('cadence-action')).toMatchObject({ status: fixture.status });
      expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP }))
        .not.toContainEqual(expect.objectContaining({
          kind: 'action_settlement_invalid', recordId: 'cadence-action',
        }));
      return;
    }

    expect(() => settleFixture(fixture)).toThrow();
    expect(actions.getById('cadence-action')).toMatchObject({ status: 'pending' });
    persistRawSettlement(fixture);
    expect(() => actions.getById('cadence-action')).toThrow();
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP }))
      .toContainEqual(expect.objectContaining({
        kind: 'action_settlement_invalid', recordId: 'cadence-action',
      }));
  });

  function seedCadenceAction(input: {
    prospect: ReturnType<typeof seedProspect>;
    definitionId: string;
    stepId: string;
    componentId: string;
    scheduledStepCount: number;
    mode: 'standard' | 'inbound_over_cap_response';
    allowedStepIds: readonly string[] | null;
    actionType: string;
    outcome: ActionSettlementOutcome;
  }): {
    cadence: CadenceActionBinding;
    settlement: ActionSettlement;
    status: 'completed' | 'impossible';
    completionActivityId: string | null;
  } {
    const definition = BUILTIN_CADENCES.find(({ id }) => id === input.definitionId)!;
    const step = definition.steps.find(({ id }) => id === input.stepId)!;
    const component = step.components.find(({ id }) => id === input.componentId)!;
    const cadence: CadenceActionBinding = {
      cadenceEnrollmentId: 'cadence-enrollment', cadenceDefinitionId: definition.id,
      cadenceStepId: step.id, cadenceComponentId: component.id,
    };
    const evidenceRequired = input.outcome !== 'resolved';
    const completionActivityId = evidenceRequired ? 'cadence-activity' : null;
    const reason: ActionSettlement['reason'] = input.outcome === 'marked_impossible'
      ? { code: 'missing_phone', notes: null }
      : null;
    const status = input.outcome === 'marked_impossible' ? 'impossible' as const : 'completed' as const;
    const settlement: ActionSettlement = {
      version: 1, outcome: input.outcome, reason,
      evidenceActivityId: completionActivityId,
      plannerTransition: {
        definitionId: definition.id, stepId: step.id, componentId: component.id,
        attempt: input.scheduledStepCount, outcome: input.outcome,
      },
      cadence, workIntent: 'discretionary_prospecting', inboundSla: NONE_SLA,
    };
    unitOfWork.immediate(() => {
      cycles.insertCycleWithDeferredAction({
        id: 'cadence-cycle', personId: input.prospect.personId,
        prospectId: input.prospect.prospectId,
        entrySourceEventId: input.prospect.sourceEventId,
        stage: 'ready', workflowStatus: 'active', currentNextActionId: 'cadence-action',
        stageEnteredAt: DOMAIN_TIMESTAMP, createdAt: DOMAIN_TIMESTAMP,
      });
      database!.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, created_at, updated_at
        ) VALUES ('cadence-enrollment', 'cadence-cycle', ?, 'active', ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        definition.id, DOMAIN_TIMESTAMP, step.id, input.scheduledStepCount, input.mode,
        input.allowedStepIds === null ? null : serializeCanonical(input.allowedStepIds),
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      actions.insertNextAction({
        id: 'cadence-action', salesCycleId: 'cadence-cycle', actionType: input.actionType,
        channel: input.actionType === 'resolve_contact_method' ? null : component.channel,
        status: 'pending', dueAt: DUE, timezone: 'America/New_York',
        allowedWindow: 'afternoon', slaDueAt: null,
        workIntent: 'discretionary_prospecting', inboundSla: NONE_SLA,
        cadence, createdAt: DOMAIN_TIMESTAMP,
      });
      if (completionActivityId !== null) {
        events.appendActivity({
          id: completionActivityId, personId: input.prospect.personId,
          prospectId: input.prospect.prospectId, salesCycleId: 'cadence-cycle',
          cadenceEnrollmentId: 'cadence-enrollment', cadenceStepId: step.id,
          cadenceComponentId: component.id,
          kind: component.actionType, direction: 'outbound', channel: component.channel,
          occurredAt: DOMAIN_TIMESTAMP, observedOutcome: input.outcome, metadata: {},
        });
      }
      actions.insertNextAction({
        id: 'replacement-action', salesCycleId: 'cadence-cycle', actionType: 'review',
        channel: null, status: 'pending', dueAt: DUE, timezone: 'America/New_York',
        allowedWindow: null, slaDueAt: null, workIntent: 'internal_review',
        inboundSla: NONE_SLA,
        cadence: {
          cadenceEnrollmentId: null, cadenceDefinitionId: null,
          cadenceStepId: null, cadenceComponentId: null,
        }, createdAt: DOMAIN_TIMESTAMP,
      });
      cycles.replaceCurrentAction({
        cycleId: 'cadence-cycle', expectedVersion: 1, expectedStage: 'ready',
        expectedWorkflowStatus: 'active', expectedCurrentActionId: 'cadence-action',
        nextActionId: 'replacement-action', updatedAt: DOMAIN_TIMESTAMP,
      });
    });
    return { cadence, settlement, status, completionActivityId };
  }

  function settleFixture(fixture: {
    cadence: CadenceActionBinding;
    settlement: ActionSettlement;
    status: 'completed' | 'impossible';
    completionActivityId: string | null;
  }) {
    return unitOfWork.immediate(() => actions.settleAction({
      actionId: 'cadence-action', salesCycleId: 'cadence-cycle',
      expectedStatus: 'pending', expectedVersion: 1,
      expectedWorkIntent: 'discretionary_prospecting', expectedInboundSla: NONE_SLA,
      expectedCadence: fixture.cadence, status: fixture.status,
      completedAt: DOMAIN_TIMESTAMP, completionActivityId: fixture.completionActivityId,
      settlement: fixture.settlement,
    }));
  }

  function persistRawSettlement(fixture: {
    settlement: ActionSettlement;
    status: 'completed' | 'impossible';
    completionActivityId: string | null;
  }): void {
    database!.raw.prepare(`
      UPDATE next_actions
      SET status = ?, completion_activity_id = ?, settlement_json = ?,
        completed_at = ?, updated_at = ?, version = version + 1
      WHERE id = 'cadence-action'
    `).run(
      fixture.status, fixture.completionActivityId, serializeCanonical(fixture.settlement),
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
  }
});
