import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { canonicalJson, type CadenceFamily } from '../../src/main/domain/cadence/cadenceTypes';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import type { CompleteCurrentActionInput } from '../../src/main/domain/lifecycle/lifecycleTransactionWriter';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const TIMEZONE = 'America/New_York';
const WON_FAULT_PHASES = [
  'old_enrollment_stop', 'onboarding_enrollment_insert', 'onboarding_action_insert',
  'won_terms_insert', 'cycle_projection', 'stage_event_insert', 'old_action_settlement',
] as const;

type Harness = Readonly<{
  database: AppDatabase;
  unitOfWork: DomainUnitOfWork;
  service: LifecycleService;
  events: EventRepository;
}>;

type SeededTerminal = Readonly<{
  prospect: SeededProspect;
  cycleId: string;
  enrollmentId: string;
  actionId: string;
  definitionId: string;
  stepId: string;
  componentId: string;
  componentChannel: string;
  componentActionType: 'call' | 'voicemail' | 'text' | 'email';
}>;

describe('LifecycleService cadence terminal mappings', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(ids: string[]): Promise<Harness> {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [...ids];
    const idSource = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids: idSource });
    const events = new EventRepository({ database, unitOfWork, clock, ids: idSource });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    return {
      database,
      unitOfWork,
      events,
      service: new LifecycleService({
        database, unitOfWork, identities, events, sources, cadences,
        clock, ids: idSource, timezone: TIMEZONE, policies: FOUNDER_CHANNEL_POLICIES_V1,
      }),
    };
  }

  function seedTerminal(input: {
    prefix: string;
    family: CadenceFamily;
    stage: 'ready' | 'contacted' | 'interviewed' | 'offered' | 'won';
    workflowStatus?: 'active' | 'onboarding';
    stepIndex: number;
    componentIndex?: number;
    mode?: 'standard' | 'inbound_over_cap_response';
    actionType?: string;
    actionChannel?: string | null;
    workIntent?: 'discretionary_prospecting' | 'promised_follow_up' | 'inbound_response';
  }): SeededTerminal {
    if (database === undefined) throw new Error('Harness is not open.');
    const definition = BUILTIN_CADENCES.find(({ family }) => family === input.family)!;
    const step = definition.steps[input.stepIndex]!;
    const component = step.components[input.componentIndex ?? 0]!;
    const prospect = seedProspect(database.raw, input.prefix);
    const cycleId = `${input.prefix}-cycle`;
    const enrollmentId = `${input.prefix}-enrollment`;
    const actionId = `${input.prefix}-action`;
    const mode = input.mode ?? 'standard';
    const workIntent = input.workIntent
      ?? (definition.category === 'prospecting' ? 'discretionary_prospecting' : 'promised_follow_up');
    const isInbound = workIntent === 'inbound_response';
    const inboundDueAt = isInbound ? '2026-09-01T12:00:00.000Z' : null;
    const provenance = isInbound ? canonicalJson({
      version: 1,
      sourceEventId: prospect.sourceEventId,
      sourceObservedAt: DOMAIN_TIMESTAMP,
      calculation: 'elapsed_hours',
      hours: 48,
      policyId: null,
      computedDueAt: inboundDueAt,
    }) : null;
    const workflowStatus = input.workflowStatus ?? 'active';
    const allowedStepIdsJson = mode === 'inbound_over_cap_response'
      ? canonicalJson([step.id])
      : null;

    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
        input.stage, workflowStatus, actionId, DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          stop_reason, version, created_at, updated_at
        )
        SELECT ?, ?, ?, 'stopped', ?, ?, ?, 'standard', NULL,
          'upgraded', 1, ?, ?
        WHERE ? = 'inbound_over_cap_response'
      `).run(
        `${enrollmentId}-prior-cap`, cycleId, definition.id, DOMAIN_TIMESTAMP,
        definition.steps.at(-1)!.id, definition.attemptCap,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, mode,
      );
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          stop_reason, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        enrollmentId, cycleId, definition.id, DOMAIN_TIMESTAMP, step.id,
        mode === 'inbound_over_cap_response' ? 1 : input.stepIndex + 1,
        mode, allowedStepIdsJson, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          allowed_window, work_intent, sla_due_at,
          inbound_sla_kind, inbound_sla_due_at, inbound_sla_source_event_id,
          inbound_sla_provenance_json,
          cadence_enrollment_id, cadence_step_id, cadence_component_id,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        actionId, cycleId, input.actionType ?? component.actionType,
        input.actionChannel === undefined ? component.channel : input.actionChannel,
        DOMAIN_TIMESTAMP, TIMEZONE,
        component.actionType === 'call' ? 'afternoon' : `founder_${component.channel}_v1:afternoon`,
        workIntent,
        isInbound ? 'direct_referral_elapsed' : null,
        inboundDueAt,
        isInbound ? prospect.sourceEventId : null,
        provenance,
        enrollmentId, step.id, component.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      if (input.stage === 'won') {
        database.raw.prepare(`
          INSERT INTO won_terms (
            sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
            projected_mrr_cents, projection_formula_version,
            manual_projection_reason, founding_customer, effective_at, created_at
          ) VALUES (?, 10, 'per_door_monthly', 2500, 25000, 'v1', NULL, 1, ?, ?)
        `).run(cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      }
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    return {
      prospect, cycleId, enrollmentId, actionId, definitionId: definition.id,
      stepId: step.id, componentId: component.id,
      componentChannel: component.channel, componentActionType: component.actionType,
    };
  }

  function appendOutcome(
    harness: Harness,
    seeded: SeededTerminal,
    outcome: string,
    id = `${seeded.actionId}-activity`,
  ): string {
    harness.unitOfWork.immediate(() => harness.events.appendActivity({
      id, personId: seeded.prospect.personId, prospectId: seeded.prospect.prospectId,
      salesCycleId: seeded.cycleId, cadenceEnrollmentId: seeded.enrollmentId,
      cadenceStepId: seeded.stepId, cadenceComponentId: seeded.componentId,
      kind: seeded.componentActionType, direction: 'outbound', channel: seeded.componentChannel,
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: outcome, metadata: {},
    }));
    return id;
  }

  it('maps completed post-interview and onboarding phases without inventing stage events', async () => {
    const harness = await setup(['confirm-offer-action']);
    const postInterview = seedTerminal({
      prefix: 'post-interview-terminal', family: 'post_interview',
      stage: 'interviewed', stepIndex: 1,
    });
    const pitchActivity = appendOutcome(harness, postInterview, 'answered');
    const postInterviewCommand: CompleteCurrentActionInput = {
      cycleId: postInterview.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: postInterview.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'answered', activityId: pitchActivity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    };
    const pendingConfirmation = harness.service.completeCurrentAction(postInterviewCommand);
    expect(pendingConfirmation).toMatchObject({
      stage: 'interviewed', workflowStatus: 'active',
      currentNextActionId: 'confirm-offer-action', version: 2,
    });
    expect(harness.database.raw.prepare(`
      SELECT action_type, work_intent, status FROM next_actions WHERE id = 'confirm-offer-action'
    `).get()).toEqual({ action_type: 'confirm_offer', work_intent: 'internal_review', status: 'pending' });
    expect(harness.events.listCycleStageEvents(postInterview.cycleId)).toEqual([]);
    expect(() => harness.service.completeCurrentAction(postInterviewCommand))
      .toThrow(StaleDomainWriteError);

    const onboarding = seedTerminal({
      prefix: 'onboarding-terminal', family: 'onboarding', stage: 'won',
      workflowStatus: 'onboarding', stepIndex: 0, componentIndex: 2,
    });
    const firstJobActivity = appendOutcome(harness, onboarding, 'accepted');
    const onboardingCommand: CompleteCurrentActionInput = {
      cycleId: onboarding.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: onboarding.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'accepted', activityId: firstJobActivity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    };
    const closed = harness.service.completeCurrentAction(onboardingCommand);
    expect(closed).toMatchObject({
      stage: 'won', workflowStatus: 'closed', currentNextActionId: null, version: 2,
    });
    expect(harness.events.listCycleStageEvents(onboarding.cycleId)).toEqual([]);
    expect(() => harness.service.completeCurrentAction(onboardingCommand))
      .toThrow(StaleDomainWriteError);
    expect(harness.database.raw.prepare(`
      SELECT status, stop_reason FROM cadence_enrollments WHERE id = ?
    `).get(onboarding.enrollmentId)).toEqual({ status: 'completed', stop_reason: 'phase_completed' });
  });

  it('turns handled and impossible inbound over-cap responses into concrete internal work', async () => {
    const harness = await setup(['book-follow-up-action', 'review-impossible-action']);
    const handled = seedTerminal({
      prefix: 'inbound-handled', family: 'cadence_c', stage: 'contacted', stepIndex: 0,
      mode: 'inbound_over_cap_response', workIntent: 'inbound_response',
    });
    const handledActivity = appendOutcome(harness, handled, 'accepted');
    const handledCommand: CompleteCurrentActionInput = {
      cycleId: handled.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: handled.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'accepted', activityId: handledActivity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    };
    const handledCycle = harness.service.completeCurrentAction(handledCommand);
    expect(handledCycle).toMatchObject({ currentNextActionId: 'book-follow-up-action', version: 2 });
    expect(harness.database.raw.prepare(`
      SELECT action_type, work_intent, status FROM next_actions WHERE id = 'book-follow-up-action'
    `).get()).toEqual({
      action_type: 'book_promised_follow_up', work_intent: 'promised_follow_up', status: 'pending',
    });
    expect(() => harness.service.completeCurrentAction(handledCommand))
      .toThrow(StaleDomainWriteError);

    const impossible = seedTerminal({
      prefix: 'inbound-impossible', family: 'cadence_c', stage: 'contacted', stepIndex: 0,
      mode: 'inbound_over_cap_response', actionType: 'resolve_contact_method',
      actionChannel: null, workIntent: 'inbound_response',
    });
    const impossibleActivity = appendOutcome(harness, impossible, 'marked_impossible');
    const impossibleCommand: CompleteCurrentActionInput = {
      cycleId: impossible.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: impossible.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'marked_impossible', activityId: impossibleActivity,
      impossibleDisposition: { reason: 'missing_phone', notes: null },
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    };
    const impossibleCycle = harness.service.completeCurrentAction(impossibleCommand);
    expect(impossibleCycle).toMatchObject({ currentNextActionId: 'review-impossible-action', version: 2 });
    expect(harness.database.raw.prepare(`
      SELECT action_type, work_intent, status FROM next_actions WHERE id = 'review-impossible-action'
    `).get()).toEqual({
      action_type: 'review_inbound_response', work_intent: 'internal_review', status: 'pending',
    });
    expect(() => harness.service.completeCurrentAction(impossibleCommand))
      .toThrow(StaleDomainWriteError);
  });

  it('closes prospecting and post-offer breakups with exact reactivation work', async () => {
    const harness = await setup([
      'a-seasonal-rule', 'a-frbo-rule', 'a-lost-event',
      'offer-manual-rule', 'offer-lost-event',
    ]);
    const cadenceA = seedTerminal({
      prefix: 'cadence-a-terminal', family: 'cadence_a', stage: 'contacted', stepIndex: 7,
    });
    const cadenceAActivity = appendOutcome(harness, cadenceA, 'accepted');
    const cadenceACommand: CompleteCurrentActionInput = {
      cycleId: cadenceA.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: cadenceA.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'accepted', activityId: cadenceAActivity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    };
    const cadenceAClosed = harness.service.completeCurrentAction(cadenceACommand);
    expect(cadenceAClosed).toMatchObject({
      stage: 'lost_nurture', workflowStatus: 'closed', closeReason: 'cadence_exhausted',
      currentNextActionId: null, version: 2,
    });
    expect(harness.database.raw.prepare(`
      SELECT rule_type FROM reactivation_rules WHERE sales_cycle_id = ? ORDER BY rule_type
    `).all(cadenceA.cycleId)).toEqual([
      { rule_type: 'new-frbo-listing' }, { rule_type: 'seasonal:heating-oct1' },
    ]);
    expect(() => harness.service.completeCurrentAction(cadenceACommand))
      .toThrow(StaleDomainWriteError);

    const postOffer = seedTerminal({
      prefix: 'post-offer-terminal', family: 'post_offer', stage: 'offered', stepIndex: 4,
    });
    const postOfferActivity = appendOutcome(harness, postOffer, 'accepted');
    const postOfferCommand: CompleteCurrentActionInput = {
      cycleId: postOffer.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: postOffer.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'accepted', activityId: postOfferActivity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP,
      manualReactivationDueAt: '2026-10-15T13:00:00.000Z',
    };
    const postOfferClosed = harness.service.completeCurrentAction(postOfferCommand);
    expect(postOfferClosed).toMatchObject({
      stage: 'lost_nurture', workflowStatus: 'closed', closeReason: 'cadence_exhausted',
    });
    expect(harness.database.raw.prepare(`
      SELECT rule_type, due_at FROM reactivation_rules WHERE sales_cycle_id = ?
    `).all(postOffer.cycleId)).toEqual([
      { rule_type: 'manual', due_at: '2026-10-15T13:00:00.000Z' },
    ]);
    expect(() => harness.service.completeCurrentAction(postOfferCommand))
      .toThrow(StaleDomainWriteError);
  });

  it('rolls an exhausted terminal back when a later rule insert faults', async () => {
    const harness = await setup(['duplicate-rule', 'duplicate-rule']);
    const cadenceA = seedTerminal({
      prefix: 'cadence-a-fault', family: 'cadence_a', stage: 'contacted', stepIndex: 7,
    });
    const activity = appendOutcome(harness, cadenceA, 'accepted');
    expect(() => harness.service.completeCurrentAction({
      cycleId: cadenceA.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: cadenceA.actionId,
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'accepted', activityId: activity, impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    })).toThrow();
    expect(harness.database.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id, version
      FROM sales_cycles WHERE id = ?
    `).get(cadenceA.cycleId)).toEqual({
      stage: 'contacted', workflow_status: 'active',
      current_next_action_id: cadenceA.actionId, version: 1,
    });
    expect(harness.database.raw.prepare(`
      SELECT status, version FROM next_actions WHERE id = ?
    `).get(cadenceA.actionId)).toEqual({ status: 'pending', version: 1 });
    expect(harness.database.raw.prepare(`
      SELECT status, stop_reason, version FROM cadence_enrollments WHERE id = ?
    `).get(cadenceA.enrollmentId)).toEqual({ status: 'active', stop_reason: null, version: 1 });
    expect(harness.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM reactivation_rules WHERE sales_cycle_id = ?
    `).get(cadenceA.cycleId)).toEqual({ count: 0 });
  });

  it('rolls every terminal mapping back when final action settlement faults', async () => {
    const harness = await setup([
      'fault-post-review', 'fault-inbound-booking', 'fault-inbound-review',
      'fault-a-seasonal', 'fault-a-frbo', 'fault-a-event',
      'fault-offer-manual', 'fault-offer-event',
    ]);
    const cases: readonly Readonly<{
      seeded: SeededTerminal;
      outcome: CompleteCurrentActionInput['outcome'];
      impossibleDisposition: CompleteCurrentActionInput['impossibleDisposition'];
      manualReactivationDueAt: string | null;
    }>[] = [
      {
        seeded: seedTerminal({
          prefix: 'fault-post-interview', family: 'post_interview',
          stage: 'interviewed', stepIndex: 1,
        }),
        outcome: 'answered' as const,
        impossibleDisposition: null,
        manualReactivationDueAt: null,
      },
      {
        seeded: seedTerminal({
          prefix: 'fault-onboarding', family: 'onboarding', stage: 'won',
          workflowStatus: 'onboarding', stepIndex: 0, componentIndex: 2,
        }),
        outcome: 'accepted' as const,
        impossibleDisposition: null,
        manualReactivationDueAt: null,
      },
      {
        seeded: seedTerminal({
          prefix: 'fault-inbound-handled', family: 'cadence_c',
          stage: 'contacted', stepIndex: 0, mode: 'inbound_over_cap_response',
          workIntent: 'inbound_response',
        }),
        outcome: 'accepted' as const,
        impossibleDisposition: null,
        manualReactivationDueAt: null,
      },
      {
        seeded: seedTerminal({
          prefix: 'fault-inbound-impossible', family: 'cadence_c',
          stage: 'contacted', stepIndex: 0, mode: 'inbound_over_cap_response',
          actionType: 'resolve_contact_method', actionChannel: null,
          workIntent: 'inbound_response',
        }),
        outcome: 'marked_impossible' as const,
        impossibleDisposition: { reason: 'missing_phone' as const, notes: null },
        manualReactivationDueAt: null,
      },
      {
        seeded: seedTerminal({
          prefix: 'fault-cadence-a', family: 'cadence_a', stage: 'contacted', stepIndex: 7,
        }),
        outcome: 'accepted' as const,
        impossibleDisposition: null,
        manualReactivationDueAt: null,
      },
      {
        seeded: seedTerminal({
          prefix: 'fault-post-offer', family: 'post_offer', stage: 'offered', stepIndex: 4,
        }),
        outcome: 'accepted' as const,
        impossibleDisposition: null,
        manualReactivationDueAt: '2026-10-15T13:00:00.000Z',
      },
    ];

    for (const [index, terminalCase] of cases.entries()) {
      const activityId = appendOutcome(
        harness, terminalCase.seeded, terminalCase.outcome,
        `${terminalCase.seeded.actionId}-fault-activity`,
      );
      const before = cycleSnapshot(harness.database, terminalCase.seeded.cycleId);
      const triggerName = `fault_terminal_settlement_${index}`;
      harness.database.raw.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF status ON next_actions
        WHEN OLD.id = '${terminalCase.seeded.actionId}'
        BEGIN SELECT RAISE(ABORT, 'injected terminal settlement fault'); END
      `);
      try {
        expect(() => harness.service.completeCurrentAction({
          cycleId: terminalCase.seeded.cycleId, expectedCycleVersion: 1,
          expectedCurrentActionId: terminalCase.seeded.actionId,
          expectedActionVersion: 1, expectedEnrollmentVersion: 1,
          outcome: terminalCase.outcome, activityId,
          impossibleDisposition: terminalCase.impossibleDisposition,
          evaluationAt: DOMAIN_TIMESTAMP,
          manualReactivationDueAt: terminalCase.manualReactivationDueAt,
        })).toThrow('injected terminal settlement fault');
      } finally {
        harness.database.raw.exec(`DROP TRIGGER ${triggerName}`);
      }
      expect(cycleSnapshot(harness.database, terminalCase.seeded.cycleId)).toEqual(before);
    }
  });

  it.each(WON_FAULT_PHASES)(
    'rolls the full Offered-to-Won transaction back after %s failure',
    async (faultPoint) => {
      const harness = await setup([
        'fault-onboarding-enrollment', 'fault-onboarding-action', 'fault-won-event',
      ]);
      const offered = seedTerminal({
        prefix: `won-fault-${faultPoint}`, family: 'post_offer',
        stage: 'offered', stepIndex: 0,
      });
      const before = cycleSnapshot(harness.database, offered.cycleId);
      const when = faultPoint === 'old_enrollment_stop'
        ? `AFTER UPDATE OF status ON cadence_enrollments WHEN NEW.id = '${offered.enrollmentId}'`
        : faultPoint === 'onboarding_enrollment_insert'
          ? `AFTER INSERT ON cadence_enrollments WHEN NEW.id = 'fault-onboarding-enrollment'`
          : faultPoint === 'onboarding_action_insert'
            ? `AFTER INSERT ON next_actions WHEN NEW.id = 'fault-onboarding-action'`
            : faultPoint === 'won_terms_insert'
              ? `AFTER INSERT ON won_terms WHEN NEW.sales_cycle_id = '${offered.cycleId}'`
              : faultPoint === 'cycle_projection'
                ? `AFTER UPDATE ON sales_cycles WHEN NEW.id = '${offered.cycleId}'`
                : faultPoint === 'stage_event_insert'
                  ? `AFTER INSERT ON stage_events WHEN NEW.id = 'fault-won-event'`
                  : `AFTER UPDATE OF status ON next_actions WHEN NEW.id = '${offered.actionId}'`;
      harness.database.raw.exec(`
        CREATE TRIGGER fault_won_${faultPoint} ${when}
        BEGIN SELECT RAISE(ABORT, 'fault:${faultPoint}'); END
      `);
      try {
        expect(() => harness.service.confirmWon({
          cycleId: offered.cycleId, expectedCycleVersion: 1,
          expectedCurrentActionId: offered.actionId,
          effectiveAt: DOMAIN_TIMESTAMP, confirmedAt: DOMAIN_TIMESTAMP,
          terms: {
            billingModel: 'per_door_monthly', doorsCommitted: 4,
            unitRateCents: 2500, foundingCustomer: true,
            effectiveAt: DOMAIN_TIMESTAMP,
          },
        })).toThrow(`fault:${faultPoint}`);
      } finally {
        harness.database.raw.exec(`DROP TRIGGER fault_won_${faultPoint}`);
      }
      expect(cycleSnapshot(harness.database, offered.cycleId)).toEqual(before);
    },
  );
});

function cycleSnapshot(database: AppDatabase, cycleId: string): unknown {
  return {
    cycle: database.raw.prepare('SELECT * FROM sales_cycles WHERE id = ?').all(cycleId),
    actions: database.raw.prepare(`
      SELECT * FROM next_actions WHERE sales_cycle_id = ? ORDER BY id
    `).all(cycleId),
    enrollments: database.raw.prepare(`
      SELECT * FROM cadence_enrollments WHERE sales_cycle_id = ? ORDER BY id
    `).all(cycleId),
    rules: database.raw.prepare(`
      SELECT * FROM reactivation_rules WHERE sales_cycle_id = ? ORDER BY id
    `).all(cycleId),
    stageEvents: database.raw.prepare(`
      SELECT * FROM stage_events WHERE sales_cycle_id = ? ORDER BY transition_sequence, id
    `).all(cycleId),
    wonTerms: database.raw.prepare('SELECT * FROM won_terms WHERE sales_cycle_id = ?').all(cycleId),
  };
}
