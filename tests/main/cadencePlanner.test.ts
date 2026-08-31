import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import {
  planActionOutcome,
  planCadenceStart,
  planCadenceUpgrade,
  planReactivationDefaults,
  type CadenceOutcomeInput,
  type CadenceEnrollmentState,
  type CadenceStartInput,
} from '../../src/main/domain/cadence/cadencePlanner';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { defineCadence } from '../../src/main/domain/cadence/cadenceTypes';

const [cadenceA, cadenceB, cadenceC, postInterview, postOffer, onboarding] = BUILTIN_CADENCES;
const evaluationAt = '2026-08-31T14:30:00.000Z';

function start(definition = cadenceA, overrides: Record<string, unknown> = {}) {
  return planCadenceStart({
    definition,
    anchorAt: evaluationAt,
    evaluationAt,
    timezone: 'America/New_York',
    policies: FOUNDER_CHANNEL_POLICIES_V1,
    priorCallWindow: null,
    totalProspectingScheduledSteps: 0,
    highestProspectingAttemptCap: definition.category === 'prospecting' ? definition.attemptCap : 0,
    mode: 'standard',
    allowedStepIds: null,
    ...overrides,
  });
}

function outcome(overrides: Record<string, unknown> = {}) {
  return planActionOutcome({
    salesCycleId: 'cycle-1',
    definition: cadenceA,
    enrollment: {
      definitionId: cadenceA.id,
      anchorAt: evaluationAt,
      currentStepId: cadenceA.steps[0]!.id,
      scheduledStepCount: 1,
      status: 'active',
      mode: 'standard',
      allowedStepIds: null,
    },
    action: { kind: 'component', componentId: cadenceA.steps[0]!.components[0]!.id },
    outcome: 'no_answer',
    evaluationAt,
    timezone: 'America/New_York',
    policies: FOUNDER_CHANNEL_POLICIES_V1,
    priorCallWindow: 'morning',
    totalProspectingScheduledSteps: 1,
    highestProspectingAttemptCap: 8,
    impossibleDisposition: null,
    ...overrides,
  });
}

function expectExclusiveRecipe(recipe: ReturnType<typeof start>): void {
  expect(Number(recipe.nextAction !== null) + Number(recipe.terminal !== null)).toBe(1);
}

describe('pure cadence planning', () => {
  it('starts one anchored step and returns exactly one next-action instruction', () => {
    const recipe = start();
    expect(recipe).toMatchObject({
      currentAction: { kind: 'none' },
      enrollment: {
        kind: 'start', definitionId: cadenceA.id,
        currentStepId: cadenceA.steps[0]!.id, scheduledStepCountDelta: 1,
      },
      nextAction: {
        kind: 'create',
        draft: {
          actionType: 'call', channel: 'phone', cadenceDefinitionId: cadenceA.id,
          cadenceStepId: cadenceA.steps[0]!.id,
          cadenceComponentId: cadenceA.steps[0]!.components[0]!.id,
        },
      },
      terminal: null,
    });
    expectExclusiveRecipe(recipe);
  });

  it('branches each compound Day-0 component without incrementing the scheduled-step count', () => {
    const voicemail = outcome();
    expect(voicemail).toMatchObject({
      currentAction: { kind: 'complete', outcome: 'no_answer', activityRequired: true },
      enrollment: { kind: 'advance_component', scheduledStepCountDelta: 0 },
      nextAction: { kind: 'create', draft: { actionType: 'voicemail' } },
    });
    expect(outcome({
      action: { kind: 'component', componentId: cadenceA.steps[0]!.components[1]!.id },
      outcome: 'voicemail_left',
    })).toMatchObject({
      enrollment: { kind: 'advance_component', scheduledStepCountDelta: 0 },
      nextAction: { kind: 'create', draft: { actionType: 'text' } },
    });
    expect(outcome({
      action: { kind: 'component', componentId: cadenceA.steps[0]!.components[2]!.id },
      outcome: 'accepted',
    })).toMatchObject({
      enrollment: { kind: 'advance_step', scheduledStepCountDelta: 1 },
      nextAction: { kind: 'create', draft: { cadenceStepId: cadenceA.steps[1]!.id } },
    });
  });

  it('accepts every declared component outcome and always returns an exclusive recipe', () => {
    for (const definition of BUILTIN_CADENCES) {
      for (const step of definition.steps) {
        for (const component of step.components) {
          for (const declaredOutcome of component.allowedOutcomes) {
            const recipe = planActionOutcome({
              salesCycleId: `cycle-${definition.id}`,
              definition,
              enrollment: {
                definitionId: definition.id,
                anchorAt: evaluationAt,
                currentStepId: step.id,
                scheduledStepCount: step.sequence + 1,
                status: 'active',
                mode: 'standard',
                allowedStepIds: null,
              },
              action: { kind: 'component', componentId: component.id },
              outcome: declaredOutcome,
              evaluationAt,
              timezone: 'America/New_York',
              policies: FOUNDER_CHANNEL_POLICIES_V1,
              priorCallWindow: null,
              totalProspectingScheduledSteps: step.sequence + 1,
              highestProspectingAttemptCap: definition.category === 'prospecting'
                ? definition.attemptCap
                : 0,
              impossibleDisposition: null,
            });
            expect(Number(recipe.nextAction !== null) + Number(recipe.terminal !== null)).toBe(1);
          }
        }
      }
    }
  });

  it('keeps failed delivery incomplete and reschedules the same action deterministically', () => {
    const recipe = outcome({ outcome: 'failed', evaluationAt: '2026-08-31T16:00:00.000Z' });
    expect(recipe).toMatchObject({
      currentAction: { kind: 'remain_pending', outcome: 'failed', activityRequired: true },
      enrollment: { kind: 'retry', scheduledStepCountDelta: 0 },
      nextAction: { kind: 'reschedule_current', cadenceComponentId: cadenceA.steps[0]!.components[0]!.id },
      terminal: null,
    });
    expectExclusiveRecipe(recipe);
  });

  it('creates a resolver tied to the blocked component and retries it after resolution', () => {
    const blocked = outcome({ outcome: 'channel_unavailable' });
    expect(blocked).toMatchObject({
      currentAction: { kind: 'complete', outcome: 'channel_unavailable', activityRequired: true },
      enrollment: { kind: 'resolve', scheduledStepCountDelta: 0 },
      nextAction: {
        kind: 'create',
        draft: {
          actionType: 'resolve_contact_method', channel: null,
          cadenceStepId: cadenceA.steps[0]!.id,
          cadenceComponentId: cadenceA.steps[0]!.components[0]!.id,
        },
      },
    });
    const resolved = outcome({
      action: { kind: 'resolver', blockedComponentId: cadenceA.steps[0]!.components[0]!.id },
      outcome: 'resolved',
    });
    expect(resolved).toMatchObject({
      currentAction: { kind: 'complete', outcome: 'resolved', activityRequired: false },
      enrollment: { kind: 'retry', scheduledStepCountDelta: 0 },
      nextAction: { kind: 'create', draft: { actionType: 'call' } },
    });
  });

  it('requires a nonblank impossible reason and notes for other, then follows the explicit branch', () => {
    const resolver = { kind: 'resolver' as const, blockedComponentId: cadenceA.steps[0]!.components[0]!.id };
    expect(() => outcome({ action: resolver, outcome: 'marked_impossible' })).toThrow();
    expect(() => outcome({
      action: resolver,
      outcome: 'marked_impossible',
      impossibleDisposition: { reason: 'other', notes: '   ' },
    })).toThrow();
    expect(outcome({
      action: resolver,
      outcome: 'marked_impossible',
      impossibleDisposition: { reason: 'missing_phone', notes: null },
    })).toMatchObject({
      currentAction: {
        kind: 'impossible', outcome: 'marked_impossible', reason: 'missing_phone',
      },
      nextAction: { kind: 'create', draft: { actionType: 'voicemail' } },
    });
  });

  it('does not permit a breakup to exhaust until success or explicit impossibility', () => {
    const breakup = cadenceA.steps.at(-1)!;
    const component = breakup.components[0]!;
    const common: Omit<CadenceOutcomeInput, 'outcome'> = {
      salesCycleId: 'cycle-1',
      definition: cadenceA,
      enrollment: {
        definitionId: cadenceA.id, anchorAt: evaluationAt, currentStepId: breakup.id,
        scheduledStepCount: 8, status: 'active' as const, mode: 'standard' as const,
        allowedStepIds: null,
      },
      action: { kind: 'component' as const, componentId: component.id },
      evaluationAt,
      timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null,
      totalProspectingScheduledSteps: 8,
      highestProspectingAttemptCap: 8,
      impossibleDisposition: null,
    };
    expect(planActionOutcome({ ...common, outcome: 'failed' })).toMatchObject({
      currentAction: { kind: 'remain_pending' }, terminal: null,
    });
    expect(planActionOutcome({ ...common, outcome: 'accepted' })).toMatchObject({
      nextAction: null, terminal: { kind: 'exhausted' },
    });
    expect(planActionOutcome({
      salesCycleId: 'cycle-1',
      ...common,
      action: { kind: 'resolver', blockedComponentId: component.id },
      outcome: 'marked_impossible',
      impossibleDisposition: { reason: 'missing_phone', notes: null },
    })).toMatchObject({ nextAction: null, terminal: { kind: 'exhausted' } });
  });

  it('reserves the final remaining prospecting step for breakup', () => {
    const recipe = outcome({
      definition: cadenceB,
      enrollment: {
        definitionId: cadenceB.id, anchorAt: evaluationAt,
        currentStepId: cadenceB.steps[0]!.id, scheduledStepCount: 1,
        status: 'active', mode: 'standard', allowedStepIds: null,
      },
      action: { kind: 'component', componentId: cadenceB.steps[0]!.components[2]!.id },
      outcome: 'accepted',
      totalProspectingScheduledSteps: 5,
      highestProspectingAttemptCap: 6,
    });
    expect(recipe).toMatchObject({
      enrollment: { kind: 'advance_step', scheduledStepCountDelta: 1 },
      nextAction: { kind: 'create', draft: { cadenceStepId: cadenceB.steps.at(-1)!.id } },
    });
  });

  it('rejects reordered, truncated, and over-cap standard prospecting plans at start', () => {
    const breakupId = cadenceA.steps.at(-1)!.id;
    expect(() => start(cadenceA, {
      allowedStepIds: [cadenceA.steps[2]!.id, cadenceA.steps[1]!.id, breakupId],
    })).toThrow();
    expect(() => start(cadenceA, {
      allowedStepIds: [cadenceA.steps[2]!.id],
    })).toThrow();
    expect(() => start(cadenceA, {
      allowedStepIds: [cadenceA.steps[2]!.id, breakupId],
      totalProspectingScheduledSteps: 7,
      highestProspectingAttemptCap: 8,
    })).toThrow();
  });

  it('rejects forged persisted prospecting plans before applying an outcome', () => {
    const first = cadenceA.steps[0]!;
    const acceptedLastComponent = first.components.at(-1)!;
    const common = {
      action: { kind: 'component' as const, componentId: acceptedLastComponent.id },
      outcome: 'accepted' as const,
    };
    expect(() => outcome({
      ...common,
      enrollment: {
        definitionId: cadenceA.id, anchorAt: evaluationAt,
        currentStepId: first.id, scheduledStepCount: 1,
        status: 'active', mode: 'standard', allowedStepIds: [first.id],
      },
    })).toThrow();
    expect(() => outcome({
      ...common,
      enrollment: {
        definitionId: cadenceA.id, anchorAt: evaluationAt,
        currentStepId: first.id, scheduledStepCount: 1,
        status: 'active', mode: 'standard',
        allowedStepIds: [cadenceA.steps[1]!.id, first.id, cadenceA.steps.at(-1)!.id],
      },
    })).toThrow();
    expect(() => outcome({
      ...common,
      totalProspectingScheduledSteps: 7,
      enrollment: {
        definitionId: cadenceA.id, anchorAt: evaluationAt,
        currentStepId: first.id, scheduledStepCount: 1,
        status: 'active', mode: 'standard',
        allowedStepIds: [first.id, cadenceA.steps[1]!.id, cadenceA.steps.at(-1)!.id],
      },
    })).toThrow();
  });

  it('rejects truncated or skipped explicit plans for fixed post-stage cadences', () => {
    const first = postOffer.steps[0]!;
    const breakup = postOffer.steps.at(-1)!;

    expect(() => start(postOffer, {
      allowedStepIds: postOffer.steps.slice(0, -1).map(({ id }) => id),
    })).toThrow();
    expect(() => start(postOffer, {
      allowedStepIds: [first.id, breakup.id],
    })).toThrow();

    const forgedOutcome = (allowedStepIds: readonly string[]) => planActionOutcome({
      salesCycleId: 'cycle-forged-post-offer',
      definition: postOffer,
      enrollment: {
        definitionId: postOffer.id,
        anchorAt: evaluationAt,
        currentStepId: first.id,
        scheduledStepCount: 1,
        status: 'active',
        mode: 'standard',
        allowedStepIds,
      },
      action: { kind: 'component', componentId: first.components[0]!.id },
      outcome: 'accepted',
      evaluationAt,
      timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null,
      totalProspectingScheduledSteps: 0,
      highestProspectingAttemptCap: 0,
      impossibleDisposition: null,
    });
    expect(() => forgedOutcome(postOffer.steps.slice(0, -1).map(({ id }) => id))).toThrow();
    expect(() => forgedOutcome([first.id, breakup.id])).toThrow();
  });

  it('rejects a forged Post-Offer last step with count one for null and full plans', () => {
    const lastStep = postOffer.steps.at(-1)!;
    for (const allowedStepIds of [null, postOffer.steps.map(({ id }) => id)]) {
      expect(() => outcome({
        definition: postOffer,
        enrollment: {
          definitionId: postOffer.id,
          anchorAt: evaluationAt,
          currentStepId: lastStep.id,
          scheduledStepCount: 1,
          status: 'active',
          mode: 'standard',
          allowedStepIds,
        },
        action: { kind: 'component', componentId: lastStep.components[0]!.id },
        outcome: 'accepted',
        totalProspectingScheduledSteps: 0,
        highestProspectingAttemptCap: 0,
      })).toThrow();
    }
  });

  it('requires a positive integer scheduled-step count at the resolved plan index', () => {
    const intermediate = postOffer.steps[2]!;
    for (const scheduledStepCount of [0, 1.5, 2, 4]) {
      expect(() => outcome({
        definition: postOffer,
        enrollment: {
          definitionId: postOffer.id,
          anchorAt: evaluationAt,
          currentStepId: intermediate.id,
          scheduledStepCount,
          status: 'active',
          mode: 'standard',
          allowedStepIds: null,
        },
        action: { kind: 'component', componentId: intermediate.components[0]!.id },
        outcome: 'accepted',
        totalProspectingScheduledSteps: 0,
        highestProspectingAttemptCap: 0,
      })).toThrow();
    }

    const breakup = cadenceA.steps.at(-1)!;
    expect(outcome({
      definition: cadenceA,
      enrollment: {
        definitionId: cadenceA.id,
        anchorAt: evaluationAt,
        currentStepId: breakup.id,
        scheduledStepCount: 2,
        status: 'active',
        mode: 'standard',
        allowedStepIds: [cadenceA.steps[2]!.id, breakup.id],
      },
      action: { kind: 'component', componentId: breakup.components[0]!.id },
      outcome: 'accepted',
      totalProspectingScheduledSteps: 8,
      highestProspectingAttemptCap: 8,
    })).toMatchObject({ terminal: { kind: 'exhausted' } });
  });

  it('requires an over-cap response enrollment count of exactly one', () => {
    const firstStep = cadenceC.steps[0]!;
    expect(() => outcome({
      definition: cadenceC,
      enrollment: {
        definitionId: cadenceC.id,
        anchorAt: evaluationAt,
        currentStepId: firstStep.id,
        scheduledStepCount: 2,
        status: 'active',
        mode: 'inbound_over_cap_response',
        allowedStepIds: [firstStep.id],
      },
      action: { kind: 'component', componentId: firstStep.components[0]!.id },
      outcome: 'accepted',
      totalProspectingScheduledSteps: 5,
      highestProspectingAttemptCap: 4,
    })).toThrow();
  });

  it('permits exactly the first trigger-response step for an exhausted over-cap plan', () => {
    expect(() => start(cadenceC, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [cadenceC.steps[1]!.id],
      totalProspectingScheduledSteps: 4,
      highestProspectingAttemptCap: 4,
    })).toThrow();
    expect(() => start(cadenceC, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [cadenceC.steps[0]!.id, cadenceC.steps[1]!.id],
      totalProspectingScheduledSteps: 4,
      highestProspectingAttemptCap: 4,
    })).toThrow();
    expect(() => start(cadenceC, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [cadenceC.steps[0]!.id],
      totalProspectingScheduledSteps: 3,
      highestProspectingAttemptCap: 4,
    })).toThrow();
    expect(() => planActionOutcome({
      salesCycleId: 'cycle-forged-over-cap',
      definition: cadenceC,
      enrollment: {
        definitionId: cadenceC.id, anchorAt: evaluationAt,
        currentStepId: cadenceC.steps[1]!.id, scheduledStepCount: 1,
        status: 'active', mode: 'inbound_over_cap_response',
        allowedStepIds: [cadenceC.steps[1]!.id],
      },
      action: { kind: 'component', componentId: cadenceC.steps[1]!.components[0]!.id },
      outcome: 'answered', evaluationAt, timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1, priorCallWindow: null,
      totalProspectingScheduledSteps: 5, highestProspectingAttemptCap: 4,
      impossibleDisposition: null,
    })).toThrow();
  });

  it('rejects inbound over-cap response mode outside builtin Warm Cadence C', () => {
    for (const definition of [cadenceA, cadenceB]) {
      expect(() => start(definition, {
        mode: 'inbound_over_cap_response',
        allowedStepIds: [definition.steps[0]!.id],
        totalProspectingScheduledSteps: definition.attemptCap,
        highestProspectingAttemptCap: definition.attemptCap,
      })).toThrow();
    }
    expect(() => start(postOffer, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [postOffer.steps[0]!.id],
      totalProspectingScheduledSteps: 0,
      highestProspectingAttemptCap: 0,
    })).toThrow();

    const warmDraft = structuredClone(cadenceC);
    Reflect.deleteProperty(warmDraft, 'contentHash');
    const customWarmCadence = defineCadence({
      ...warmDraft,
      id: 'custom-warm-cadence-v2',
      version: 2,
      name: 'Custom Warm Cadence',
    });
    expect(() => start(customWarmCadence, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [customWarmCadence.steps[0]!.id],
      totalProspectingScheduledSteps: customWarmCadence.attemptCap,
      highestProspectingAttemptCap: customWarmCadence.attemptCap,
    })).toThrow();

    const forgedBuiltinIdentity = defineCadence({
      ...warmDraft,
      name: 'Forged Warm Cadence',
    });
    expect(() => start(forgedBuiltinIdentity, {
      mode: 'inbound_over_cap_response',
      allowedStepIds: [forgedBuiltinIdentity.steps[0]!.id],
      totalProspectingScheduledSteps: forgedBuiltinIdentity.attemptCap,
      highestProspectingAttemptCap: forgedBuiltinIdentity.attemptCap,
    })).toThrow();
  });

  it('plans B→A and A/B→C upgrades without downgrades or duplicate first channels', () => {
    const common = {
      oldEnrollmentId: 'old-enrollment',
      anchorAt: evaluationAt,
      evaluationAt,
      timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: 'morning' as const,
      totalProspectingScheduledSteps: 2,
      highestProspectingAttemptCap: 6,
      lastCompletedChannel: 'phone' as const,
      completedActivityIds: ['activity-one', 'activity-two'],
    };
    const bToA = planCadenceUpgrade({
      ...common, oldDefinition: cadenceB, newDefinition: cadenceA, trigger: 'live_vacancy',
    });
    expect(bToA).toMatchObject({
      kind: 'upgrade', stopOld: { enrollmentId: 'old-enrollment', reason: 'upgraded' },
      startNew: {
        definitionId: cadenceA.id,
        creditedTriggerStepId: cadenceA.steps[2]!.id,
        plannedStepIds: expect.arrayContaining([cadenceA.steps.at(-1)!.id]),
      },
      highestProspectingAttemptCap: 8,
      preservedActivityIds: ['activity-one', 'activity-two'],
    });
    expect(planCadenceUpgrade({
      ...common, oldDefinition: cadenceA, newDefinition: cadenceC, trigger: 'inbound_demo',
      lastCompletedChannel: 'text',
    })).toMatchObject({
      kind: 'upgrade', startNew: { creditedTriggerStepId: cadenceC.steps[1]!.id },
    });
    expect(planCadenceUpgrade({
      ...common, oldDefinition: cadenceB, newDefinition: cadenceC, trigger: 'direct_referral',
      lastCompletedChannel: 'phone',
    })).toMatchObject({
      kind: 'upgrade', startNew: { creditedTriggerStepId: cadenceC.steps[0]!.id },
    });
    expect(planCadenceUpgrade({
      ...common, oldDefinition: cadenceC, newDefinition: cadenceA, trigger: 'live_vacancy',
    })).toEqual({ kind: 'no_change', reason: 'same_or_lower_precedence' });
  });

  it('preserves total count, bounds upgrades, and grants only one inbound over-cap response', () => {
    const bounded = planCadenceUpgrade({
      oldEnrollmentId: 'old', oldDefinition: cadenceB, newDefinition: cadenceC,
      trigger: 'direct_referral', anchorAt: evaluationAt, evaluationAt,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null, totalProspectingScheduledSteps: 5,
      highestProspectingAttemptCap: 6, lastCompletedChannel: 'phone',
      completedActivityIds: ['activity-before-upgrade'],
    });
    expect(bounded).toMatchObject({
      kind: 'upgrade',
      startNew: { plannedStepIds: [cadenceC.steps.at(-1)!.id] },
      highestProspectingAttemptCap: 6,
    });

    const overCap = planCadenceUpgrade({
      oldEnrollmentId: 'old', oldDefinition: cadenceA, newDefinition: cadenceC,
      trigger: 'inbound_demo', anchorAt: evaluationAt, evaluationAt,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null, totalProspectingScheduledSteps: 8,
      highestProspectingAttemptCap: 8, lastCompletedChannel: 'text',
      completedActivityIds: ['activity-before-over-cap'],
    });
    expect(overCap).toMatchObject({
      kind: 'inbound_over_cap_response',
      startNew: {
        mode: 'inbound_over_cap_response',
        plannedStepIds: [cadenceC.steps[0]!.id],
        creditedTriggerStepId: cadenceC.steps[0]!.id,
      },
    });
    if (overCap.kind !== 'inbound_over_cap_response') throw new Error('Expected over-cap plan.');
    expect(planActionOutcome({
      salesCycleId: 'cycle-1',
      definition: cadenceC,
      enrollment: {
        definitionId: cadenceC.id, anchorAt: evaluationAt,
        currentStepId: cadenceC.steps[0]!.id, scheduledStepCount: 1,
        status: 'active', mode: 'inbound_over_cap_response',
        allowedStepIds: [cadenceC.steps[0]!.id],
      },
      action: { kind: 'component', componentId: cadenceC.steps[0]!.components[0]!.id },
      outcome: 'accepted', evaluationAt, timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1, priorCallWindow: null,
      totalProspectingScheduledSteps: 9, highestProspectingAttemptCap: 8,
      impossibleDisposition: null,
    })).toMatchObject({
      nextAction: null,
      terminal: { kind: 'completed', reason: 'inbound_response_handled' },
    });
    expect(planActionOutcome({
      salesCycleId: 'cycle-1',
      definition: cadenceC,
      enrollment: {
        definitionId: cadenceC.id, anchorAt: evaluationAt,
        currentStepId: cadenceC.steps[0]!.id, scheduledStepCount: 1,
        status: 'active', mode: 'inbound_over_cap_response',
        allowedStepIds: [cadenceC.steps[0]!.id],
      },
      action: { kind: 'resolver', blockedComponentId: cadenceC.steps[0]!.components[0]!.id },
      outcome: 'marked_impossible', evaluationAt, timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1, priorCallWindow: null,
      totalProspectingScheduledSteps: 9, highestProspectingAttemptCap: 8,
      impossibleDisposition: { reason: 'missing_phone', notes: null },
    })).toMatchObject({
      enrollment: { kind: 'complete', scheduledStepCountDelta: 0 },
      nextAction: null,
      terminal: { kind: 'completed', reason: 'inbound_response_impossible' },
    });
  });

  it('keeps post-stage caps separate and models onboarding as one three-component step', () => {
    expect(start(postInterview)).toMatchObject({
      enrollment: { scheduledStepCountDelta: 1 }, nextAction: { draft: { actionType: 'text' } },
    });
    expect(start(postOffer)).toMatchObject({ nextAction: { draft: { actionType: 'email' } } });
    const welcome = start(onboarding);
    expect(welcome).toMatchObject({ nextAction: { draft: { actionType: 'text' } } });
    expect(onboarding.steps[0]!.components).toHaveLength(3);

    const onboardingState: CadenceEnrollmentState = {
      definitionId: onboarding.id,
      anchorAt: evaluationAt,
      currentStepId: onboarding.steps[0]!.id,
      scheduledStepCount: 1,
      status: 'active' as const,
      mode: 'standard' as const,
      allowedStepIds: null,
    };
    const onboardingOutcome = (componentIndex: number) => planActionOutcome({
      salesCycleId: 'won-cycle',
      definition: onboarding,
      enrollment: onboardingState,
      action: { kind: 'component', componentId: onboarding.steps[0]!.components[componentIndex]!.id },
      outcome: 'accepted',
      evaluationAt,
      timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null,
      totalProspectingScheduledSteps: 99,
      highestProspectingAttemptCap: 0,
      impossibleDisposition: null,
    });
    expect(onboardingOutcome(0)).toMatchObject({
      enrollment: { kind: 'advance_component', scheduledStepCountDelta: 0 },
      nextAction: { draft: { cadenceComponentId: onboarding.steps[0]!.components[1]!.id } },
    });
    expect(onboardingOutcome(1)).toMatchObject({
      enrollment: { kind: 'advance_component', scheduledStepCountDelta: 0 },
      nextAction: { draft: { cadenceComponentId: onboarding.steps[0]!.components[2]!.id } },
    });
    expect(onboardingOutcome(2)).toMatchObject({
      enrollment: { kind: 'complete', scheduledStepCountDelta: 0 },
      nextAction: null,
      terminal: { kind: 'completed', reason: 'phase_completed' },
    });
  });

  it('builds deterministic reactivation defaults with strictly-future local October 1', () => {
    const first = planReactivationDefaults({
      salesCycleId: 'cycle-1', family: 'cadence_a',
      evaluationAt: '2026-10-01T14:00:00.000Z', timezone: 'America/New_York',
      manualDueAt: null,
    });
    const second = planReactivationDefaults({
      salesCycleId: 'cycle-1', family: 'cadence_a',
      evaluationAt: '2026-10-01T14:00:00.000Z', timezone: 'America/New_York',
      manualDueAt: null,
    });
    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        ruleType: 'seasonal:heating-oct1', ruleVersion: 1,
        dueAt: '2027-10-01T13:00:00.000Z', matcher: null,
        logicalDedupeKey: 'cycle-1:seasonal:heating-oct1:2027-10-01',
      },
      {
        ruleType: 'new-frbo-listing', ruleVersion: 1, dueAt: null,
        matcher: { eventType: 'new-frbo-listing', personWide: true },
        logicalDedupeKey: 'cycle-1:new-frbo-listing:v1',
      },
    ]);
  });

  it('uses only the four stored reactivation types and requires an explicit future manual date', () => {
    const common: Omit<Parameters<typeof planReactivationDefaults>[0], 'family'> = {
      salesCycleId: 'cycle-2', evaluationAt, timezone: 'America/New_York', manualDueAt: null,
    };
    expect(planReactivationDefaults({ ...common, family: 'cadence_b' }).map(({ ruleType }) => ruleType))
      .toEqual(['seasonal:heating-oct1', 'lead-cert-expiry-window']);
    expect(planReactivationDefaults({ ...common, family: 'cadence_c' })).toEqual([]);
    expect(planReactivationDefaults({ ...common, family: 'post_offer' })).toEqual([]);
    expect(planReactivationDefaults({
      ...common, family: 'post_offer', manualDueAt: '2026-09-10T14:00:00.000Z',
    })).toEqual([{
      ruleType: 'manual', ruleVersion: 1, dueAt: '2026-09-10T14:00:00.000Z', matcher: null,
      logicalDedupeKey: 'cycle-2:manual:2026-09-10T14:00:00.000Z',
    }]);
    expect(() => planReactivationDefaults({
      ...common, family: 'cadence_c', manualDueAt: evaluationAt,
    })).toThrow();
  });

  it('does not import persistence, clocks, UUIDs, or implicit current time', () => {
    for (const file of ['cadenceScheduler.ts', 'cadencePlanner.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/main/domain/cadence', file), 'utf8');
      expect(source).not.toMatch(/from ['"].*(?:db|Repository|clock|idGenerator)/i);
      expect(source).not.toMatch(/Date\.now\s*\(|new Date\s*\(\s*\)/);
    }
  });

  it('is mutation-free and byte-identical for identical inputs', () => {
    const input: CadenceStartInput = {
      definition: cadenceA,
      anchorAt: evaluationAt,
      evaluationAt,
      timezone: 'America/New_York',
      policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null,
      totalProspectingScheduledSteps: 0,
      highestProspectingAttemptCap: 8,
      mode: 'standard' as const,
      allowedStepIds: null,
    };
    const before = JSON.stringify(input);
    const first = JSON.stringify(planCadenceStart(input));
    const second = JSON.stringify(planCadenceStart(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(second).toBe(first);
  });

  it('revalidates cloned and cast cadence aggregates at every public planning boundary', () => {
    const corruptedA = structuredClone(cadenceA);
    (corruptedA.steps[0]!.components[0]!.template as { body: string }).body =
      'hash-breaking clone mutation';
    expect(() => start(corruptedA)).toThrow();
    expect(() => outcome({ definition: corruptedA })).toThrow();

    const corruptedB = structuredClone(cadenceB);
    (corruptedB.steps[0]!.components[0]!.template as { body: string }).body =
      'hash-breaking old definition';
    expect(() => planCadenceUpgrade({
      oldEnrollmentId: 'old', oldDefinition: corruptedB, newDefinition: cadenceA,
      trigger: 'live_vacancy', anchorAt: evaluationAt, evaluationAt,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null, totalProspectingScheduledSteps: 1,
      highestProspectingAttemptCap: 6, lastCompletedChannel: 'phone',
      completedActivityIds: [],
    })).toThrow();

    const corruptedC = structuredClone(cadenceC);
    (corruptedC.steps[0]!.components[0]!.template as { body: string }).body =
      'hash-breaking new definition';
    expect(() => planCadenceUpgrade({
      oldEnrollmentId: 'old', oldDefinition: cadenceA, newDefinition: corruptedC,
      trigger: 'inbound_demo', anchorAt: evaluationAt, evaluationAt,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
      priorCallWindow: null, totalProspectingScheduledSteps: 1,
      highestProspectingAttemptCap: 8, lastCompletedChannel: 'phone',
      completedActivityIds: [],
    })).toThrow();
  });
});
