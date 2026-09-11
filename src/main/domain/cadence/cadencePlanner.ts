import { BUILTIN_CADENCES } from './builtinCadences';
import {
  assertCanonicalInstant,
  nextStrictFutureOctoberOne,
  scheduleComponent,
  type ChannelPolicySnapshots,
} from './cadenceScheduler';
import { parseCadenceAggregate } from './cadenceTypes';
import type {
  CadenceActionComponent,
  CadenceAggregate,
  CadenceChannel,
  CadenceFamily,
  CadenceOutcome,
  CadenceOutcomeTransition,
  CadenceStep,
  CallWindow,
  ResolverOutcome,
} from './cadenceTypes';

const BUILTIN_WARM_CADENCE_V1 = BUILTIN_CADENCES[2]!;

export type ImpossibleReason =
  | 'missing_phone'
  | 'missing_email'
  | 'invalid_contact_method'
  | 'channel_disabled'
  | 'other';

export type ImpossibleDisposition = {
  reason: ImpossibleReason;
  notes: string | null;
};

export type CurrentActionMutation =
  | { kind: 'none' }
  | { kind: 'complete'; outcome: CadenceOutcome | ResolverOutcome; activityRequired: boolean }
  | {
    kind: 'impossible';
    outcome: 'marked_impossible';
    reason: ImpossibleReason;
    notes: string | null;
    activityRequired: true;
  }
  | { kind: 'remain_pending'; outcome: 'failed'; activityRequired: true };

export type EnrollmentMutation = {
  kind: 'start' | 'advance_component' | 'advance_step' | 'retry' | 'resolve' | 'stop' | 'complete';
  definitionId: string;
  currentStepId: string;
  scheduledStepCountDelta: 0 | 1;
  status: 'active' | 'completed' | 'stopped';
  stopReason: 'replied' | 'opted_out' | 'upgraded' | 'cadence_exhausted'
    | 'phase_completed' | 'inbound_response_handled' | 'inbound_response_impossible' | null;
};

export type NextActionDraft = {
  dueAt: string;
  actionType: 'call' | 'voicemail' | 'text' | 'email' | 'resolve_contact_method';
  channel: CadenceChannel | null;
  timezone: string;
  allowedWindow: string;
  cadenceDefinitionId: string;
  cadenceStepId: string;
  cadenceComponentId: string;
};

export type NextActionInstruction =
  | { kind: 'create'; draft: NextActionDraft }
  | {
    kind: 'reschedule_current';
    dueAt: string;
    timezone: string;
    allowedWindow: string;
    cadenceDefinitionId: string;
    cadenceStepId: string;
    cadenceComponentId: string;
  };

export type ReactivationRuleDraft = {
  ruleType: 'seasonal:heating-oct1' | 'new-frbo-listing' | 'lead-cert-expiry-window' | 'manual';
  ruleVersion: 1;
  dueAt: string | null;
  matcher: { eventType: 'new-frbo-listing' | 'lead-cert-expiry-window'; personWide: true } | null;
  logicalDedupeKey: string;
};

export type CadenceTerminal =
  | { kind: 'stop'; reason: 'replied' | 'opted_out' | 'upgraded' }
  | {
    kind: 'completed';
    reason: 'phase_completed' | 'inbound_response_handled' | 'inbound_response_impossible';
  }
  | { kind: 'exhausted'; reactivationDefaults: ReactivationRuleDraft[] };

type TransitionRecipeBase = {
  currentAction: CurrentActionMutation;
  enrollment: EnrollmentMutation;
  reactivationDrafts: ReactivationRuleDraft[];
};

export type TransitionRecipe = TransitionRecipeBase & (
  | { nextAction: NextActionInstruction; terminal: null }
  | { nextAction: null; terminal: CadenceTerminal }
);

export type CadenceEnrollmentState = {
  definitionId: string;
  anchorAt: string;
  currentStepId: string;
  scheduledStepCount: number;
  status: 'active' | 'completed' | 'stopped';
  mode: 'standard' | 'inbound_over_cap_response';
  allowedStepIds: readonly string[] | null;
};

type PlanningContext = {
  evaluationAt: string;
  timezone: string;
  policies: ChannelPolicySnapshots;
  priorCallWindow: CallWindow | null;
  totalProspectingScheduledSteps: number;
  highestProspectingAttemptCap: number;
};

export type CadenceStartInput = PlanningContext & {
  definition: CadenceAggregate;
  anchorAt: string;
  mode: CadenceEnrollmentState['mode'];
  allowedStepIds: readonly string[] | null;
};

export type CadenceOutcomeInput = PlanningContext & {
  salesCycleId: string;
  definition: CadenceAggregate;
  enrollment: CadenceEnrollmentState;
  action:
    | { kind: 'component'; componentId: string }
    | { kind: 'resolver'; blockedComponentId: string };
  outcome: CadenceOutcome | ResolverOutcome;
  impossibleDisposition: ImpossibleDisposition | null;
};

export type CadenceUpgradeInput = PlanningContext & {
  oldEnrollmentId: string;
  oldDefinition: CadenceAggregate;
  newDefinition: CadenceAggregate;
  trigger: 'live_vacancy' | 'inbound_demo' | 'direct_referral';
  anchorAt: string;
  lastCompletedChannel: CadenceChannel | null;
  completedActivityIds: readonly string[];
};

type UpgradeStart = {
  definitionId: string;
  anchorAt: string;
  mode: CadenceEnrollmentState['mode'];
  plannedStepIds: string[];
  creditedTriggerStepId: string;
  transition: TransitionRecipe;
};

export type CadenceUpgradePlan =
  | { kind: 'no_change'; reason: 'same_or_lower_precedence' | 'cap_exhausted' }
  | {
    kind: 'upgrade' | 'inbound_over_cap_response';
    stopOld: { enrollmentId: string; reason: 'upgraded' };
    startNew: UpgradeStart;
    totalProspectingScheduledStepsBefore: number;
    highestProspectingAttemptCap: number;
    preservedActivityIds: string[];
  };

export function planCadenceStart(input: CadenceStartInput): TransitionRecipe {
  input = { ...input, definition: parseCadenceAggregate(input.definition) };
  validatePlanningContext(input);
  assertCanonicalInstant(input.anchorAt, 'anchorAt');
  const eligibleSteps = validateAllowedPlan(input, 'start');
  const firstStep = eligibleSteps[0];
  if (firstStep === undefined) throw new CadencePlanningError('No cadence step is eligible to start.');
  const firstComponent = firstStep.components[0]!;
  return withNextAction({
    currentAction: { kind: 'none' },
    enrollment: enrollmentMutation('start', input.definition.id, firstStep.id, 1, 'active', null),
    nextAction: createInstruction(input.definition, firstStep, firstComponent, input),
    reactivationDrafts: [],
  });
}

export function planActionOutcome(input: CadenceOutcomeInput): TransitionRecipe {
  input = { ...input, definition: parseCadenceAggregate(input.definition) };
  validatePlanningContext(input);
  if (input.salesCycleId.trim().length === 0) throw new CadencePlanningError('SalesCycle ID is required.');
  if (input.enrollment.definitionId !== input.definition.id || input.enrollment.status !== 'active') {
    throw new CadencePlanningError('The active enrollment does not match the cadence definition.');
  }
  validateAllowedPlan({
    ...input,
    mode: input.enrollment.mode,
    allowedStepIds: input.enrollment.allowedStepIds,
    currentStepId: input.enrollment.currentStepId,
    scheduledStepCount: input.enrollment.scheduledStepCount,
  }, 'outcome');
  const step = requireStep(input.definition, input.enrollment.currentStepId);
  const componentId = input.action.kind === 'component'
    ? input.action.componentId
    : input.action.blockedComponentId;
  const component = requireComponent(step, componentId);

  if (input.action.kind === 'resolver') {
    if (input.outcome === 'resolved') return planResolved(input, step, component);
    if (input.outcome !== 'marked_impossible') {
      throw new CadencePlanningError('Resolvers accept only resolved or marked_impossible.');
    }
    const disposition = validateImpossibleDisposition(input.impossibleDisposition);
    return followTransition(
      input,
      step,
      component,
      component.outcomes.marked_impossible!,
      {
        kind: 'impossible', outcome: 'marked_impossible',
        reason: disposition.reason, notes: disposition.notes, activityRequired: true,
      },
    );
  }

  if (input.outcome === 'resolved' || input.outcome === 'marked_impossible'
    || !component.allowedOutcomes.includes(input.outcome)) {
    throw new CadencePlanningError('The outcome is invalid for this action component.');
  }
  if (input.outcome === 'failed') {
    const scheduled = scheduleComponent({
      step,
      component,
      anchorAt: input.enrollment.anchorAt,
      evaluationAt: input.evaluationAt,
      timezone: input.timezone,
      policies: input.policies,
      priorCallWindow: input.priorCallWindow,
    });
    return withNextAction({
      currentAction: { kind: 'remain_pending', outcome: 'failed', activityRequired: true },
      enrollment: enrollmentMutation('retry', input.definition.id, step.id, 0, 'active', null),
      nextAction: {
        kind: 'reschedule_current',
        dueAt: scheduled.dueAt,
        timezone: scheduled.timezone,
        allowedWindow: scheduled.allowedWindow,
        cadenceDefinitionId: input.definition.id,
        cadenceStepId: step.id,
        cadenceComponentId: component.id,
      },
      reactivationDrafts: [],
    });
  }
  return followTransition(
    input,
    step,
    component,
    component.outcomes[input.outcome]!,
    { kind: 'complete', outcome: input.outcome, activityRequired: true },
  );
}

export function planCadenceUpgrade(input: CadenceUpgradeInput): CadenceUpgradePlan {
  input = {
    ...input,
    oldDefinition: parseCadenceAggregate(input.oldDefinition),
    newDefinition: parseCadenceAggregate(input.newDefinition),
  };
  validatePlanningContext(input);
  assertCanonicalInstant(input.anchorAt, 'anchorAt');
  const preservedActivityIds = validateEvidenceIds(input.completedActivityIds);
  if (input.oldDefinition.category !== 'prospecting' || input.newDefinition.category !== 'prospecting') {
    throw new CadencePlanningError('Only prospecting cadences participate in automatic upgrades.');
  }
  const precedence: Record<CadenceFamily, number> = {
    cadence_b: 1, cadence_a: 2, cadence_c: 3,
    post_interview: 0, post_offer: 0, onboarding: 0,
  };
  if (precedence[input.newDefinition.family] <= precedence[input.oldDefinition.family]) {
    return { kind: 'no_change', reason: 'same_or_lower_precedence' };
  }
  const expectedFamily = input.trigger === 'live_vacancy' ? 'cadence_a' : 'cadence_c';
  if (input.newDefinition.family !== expectedFamily) {
    throw new CadencePlanningError('The trigger does not select the supplied upgrade cadence.');
  }

  const highestCap = Math.max(
    input.highestProspectingAttemptCap,
    input.oldDefinition.attemptCap,
    input.newDefinition.attemptCap,
  );
  const remaining = highestCap - input.totalProspectingScheduledSteps;
  if (remaining <= 0) {
    if (input.trigger !== 'inbound_demo' && input.trigger !== 'direct_referral') {
      return { kind: 'no_change', reason: 'cap_exhausted' };
    }
    const responseStep = input.newDefinition.steps[0]!;
    const plannedStepIds = [responseStep.id];
    const transition = planCadenceStart({
      ...contextFromUpgrade(input, highestCap),
      definition: input.newDefinition,
      anchorAt: input.anchorAt,
      mode: 'inbound_over_cap_response',
      allowedStepIds: plannedStepIds,
    });
    return {
      kind: 'inbound_over_cap_response',
      stopOld: { enrollmentId: input.oldEnrollmentId, reason: 'upgraded' },
      startNew: {
        definitionId: input.newDefinition.id,
        anchorAt: input.anchorAt,
        mode: 'inbound_over_cap_response',
        plannedStepIds,
        creditedTriggerStepId: responseStep.id,
        transition,
      },
      totalProspectingScheduledStepsBefore: input.totalProspectingScheduledSteps,
      highestProspectingAttemptCap: highestCap,
      preservedActivityIds,
    };
  }

  const breakup = input.newDefinition.steps.find(({ breakup }) => breakup);
  if (breakup === undefined) throw new CadencePlanningError('An upgraded prospecting cadence requires breakup.');
  const nonBreakups = input.newDefinition.steps.filter(({ breakup: isBreakup }) => !isBreakup);
  const firstEligibleIndex = Math.max(0, nonBreakups.findIndex((step) => (
    step.components[0]?.channel !== input.lastCompletedChannel
  )));
  const allowedNonBreakups = Math.max(0, remaining - 1);
  const plannedStepIds = [
    ...nonBreakups.slice(firstEligibleIndex, firstEligibleIndex + allowedNonBreakups).map(({ id }) => id),
    breakup.id,
  ];
  const creditedTriggerStepId = plannedStepIds[0]!;
  const transition = planCadenceStart({
    ...contextFromUpgrade(input, highestCap),
    definition: input.newDefinition,
    anchorAt: input.anchorAt,
    mode: 'standard',
    allowedStepIds: plannedStepIds,
  });
  return {
    kind: 'upgrade',
    stopOld: { enrollmentId: input.oldEnrollmentId, reason: 'upgraded' },
    startNew: {
      definitionId: input.newDefinition.id,
      anchorAt: input.anchorAt,
      mode: 'standard',
      plannedStepIds,
      creditedTriggerStepId,
      transition,
    },
    totalProspectingScheduledStepsBefore: input.totalProspectingScheduledSteps,
    highestProspectingAttemptCap: highestCap,
    preservedActivityIds,
  };
}

export function planReactivationDefaults(input: {
  salesCycleId: string;
  family: CadenceFamily;
  evaluationAt: string;
  timezone: string;
  manualDueAt: string | null;
}): ReactivationRuleDraft[] {
  if (input.salesCycleId.trim().length === 0) throw new CadencePlanningError('SalesCycle ID is required.');
  const evaluationEpoch = assertCanonicalInstant(input.evaluationAt, 'evaluationAt');
  const drafts: ReactivationRuleDraft[] = [];
  if (input.family === 'cadence_a' || input.family === 'cadence_b') {
    const october = nextStrictFutureOctoberOne(input);
    drafts.push({
      ruleType: 'seasonal:heating-oct1', ruleVersion: 1,
      dueAt: october.dueAt, matcher: null,
      logicalDedupeKey: `${input.salesCycleId}:seasonal:heating-oct1:${october.localDate}`,
    });
    if (input.family === 'cadence_a') {
      drafts.push(eventDraft(input.salesCycleId, 'new-frbo-listing'));
    } else {
      drafts.push(eventDraft(input.salesCycleId, 'lead-cert-expiry-window'));
    }
  }
  if (input.manualDueAt !== null) {
    const manualEpoch = assertCanonicalInstant(input.manualDueAt, 'manualDueAt');
    if (manualEpoch <= evaluationEpoch) throw new CadencePlanningError('Manual reactivation must be future.');
    drafts.push({
      ruleType: 'manual', ruleVersion: 1, dueAt: input.manualDueAt, matcher: null,
      logicalDedupeKey: `${input.salesCycleId}:manual:${input.manualDueAt}`,
    });
  }
  return [...new Map(drafts.map((draft) => [draft.logicalDedupeKey, draft])).values()];
}

export class CadencePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CadencePlanningError';
  }
}

function planResolved(
  input: CadenceOutcomeInput,
  step: CadenceStep,
  component: CadenceActionComponent,
): TransitionRecipe {
  return withNextAction({
    currentAction: { kind: 'complete', outcome: 'resolved', activityRequired: false },
    enrollment: enrollmentMutation('retry', input.definition.id, step.id, 0, 'active', null),
    nextAction: createInstruction(input.definition, step, component, {
      ...input,
      anchorAt: input.enrollment.anchorAt,
    }),
    reactivationDrafts: [],
  });
}

function followTransition(
  input: CadenceOutcomeInput,
  step: CadenceStep,
  component: CadenceActionComponent,
  transition: CadenceOutcomeTransition,
  currentAction: CurrentActionMutation,
): TransitionRecipe {
  if (transition.kind === 'retry_component') {
    throw new CadencePlanningError('Retry transitions are handled only by failed outcomes.');
  }
  if (transition.kind === 'resolve_contact_method') {
    return withNextAction({
      currentAction,
      enrollment: enrollmentMutation('resolve', input.definition.id, step.id, 0, 'active', null),
      nextAction: {
        kind: 'create',
        draft: {
          dueAt: input.evaluationAt,
          actionType: 'resolve_contact_method',
          channel: null,
          timezone: input.timezone,
          allowedWindow: 'internal:immediate',
          cadenceDefinitionId: input.definition.id,
          cadenceStepId: step.id,
          cadenceComponentId: component.id,
        },
      },
      reactivationDrafts: [],
    });
  }
  if (transition.kind === 'stop') {
    return withTerminal({
      currentAction,
      enrollment: enrollmentMutation('stop', input.definition.id, step.id, 0, 'stopped', transition.reason),
      terminal: { kind: 'stop', reason: transition.reason },
      reactivationDrafts: [],
    });
  }
  if (transition.kind === 'next_component') {
    const target = requireComponentByDefinition(input.definition, transition.componentId);
    const targetStep = requireContainingStep(input.definition, target.id);
    return withNextAction({
      currentAction,
      enrollment: enrollmentMutation('advance_component', input.definition.id, targetStep.id, 0, 'active', null),
      nextAction: createInstruction(input.definition, targetStep, target, {
        ...input,
        anchorAt: input.enrollment.anchorAt,
      }),
      reactivationDrafts: [],
    });
  }
  return completeStep(input, step, currentAction);
}

function completeStep(
  input: CadenceOutcomeInput,
  currentStep: CadenceStep,
  currentAction: CurrentActionMutation,
): TransitionRecipe {
  if (input.enrollment.mode === 'inbound_over_cap_response') {
    const reason = currentAction.kind === 'impossible'
      ? 'inbound_response_impossible'
      : 'inbound_response_handled';
    return withTerminal({
      currentAction,
      enrollment: enrollmentMutation(
        'complete', input.definition.id, currentStep.id, 0, 'completed', reason,
      ),
      terminal: { kind: 'completed', reason },
      reactivationDrafts: [],
    });
  }
  const nextStep = nextStepAfter(input, currentStep);
  if (nextStep !== null) {
    return withNextAction({
      currentAction,
      enrollment: enrollmentMutation('advance_step', input.definition.id, nextStep.id, 1, 'active', null),
      nextAction: createInstruction(input.definition, nextStep, nextStep.components[0]!, {
        ...input,
        anchorAt: input.enrollment.anchorAt,
      }),
      reactivationDrafts: [],
    });
  }

  const shouldExhaust = currentStep.breakup
    && (input.definition.category === 'prospecting' || input.definition.family === 'post_offer');
  if (shouldExhaust) {
    const reactivationDrafts = planReactivationDefaults({
      salesCycleId: input.salesCycleId,
      family: input.definition.family,
      evaluationAt: input.evaluationAt,
      timezone: input.timezone,
      manualDueAt: null,
    });
    return withTerminal({
      currentAction,
      enrollment: enrollmentMutation(
        'complete', input.definition.id, currentStep.id, 0, 'completed', 'cadence_exhausted',
      ),
      terminal: { kind: 'exhausted', reactivationDefaults: reactivationDrafts },
      reactivationDrafts,
    });
  }
  return withTerminal({
    currentAction,
    enrollment: enrollmentMutation(
      'complete', input.definition.id, currentStep.id, 0, 'completed', 'phase_completed',
    ),
    terminal: { kind: 'completed', reason: 'phase_completed' },
    reactivationDrafts: [],
  });
}

function nextStepAfter(input: CadenceOutcomeInput, currentStep: CadenceStep): CadenceStep | null {
  const allowed = input.enrollment.allowedStepIds === null
    ? input.definition.steps
    : input.enrollment.allowedStepIds.map((id) => requireStep(input.definition, id));
  const currentIndex = allowed.findIndex(({ id }) => id === currentStep.id);
  if (currentIndex < 0) throw new CadencePlanningError('The current step is absent from the allowed plan.');
  if (currentIndex === allowed.length - 1) return null;

  if (input.definition.category === 'prospecting') {
    const remaining = input.highestProspectingAttemptCap - input.totalProspectingScheduledSteps;
    if (remaining <= 0) {
      if (!currentStep.breakup) {
        throw new CadencePlanningError('Prospecting cap exhausted before mandatory breakup.');
      }
      return null;
    }
    if (remaining === 1) {
      const breakup = allowed.find(({ breakup: isBreakup }) => isBreakup);
      if (breakup === undefined) throw new CadencePlanningError('The final slot is reserved for breakup.');
      return breakup.id === currentStep.id ? null : breakup;
    }
  }
  return allowed[currentIndex + 1] ?? null;
}

function validateAllowedPlan(
  input: PlanningContext & {
    definition: CadenceAggregate;
    mode: CadenceEnrollmentState['mode'];
    allowedStepIds: readonly string[] | null;
    currentStepId?: string;
    scheduledStepCount?: number;
  },
  phase: 'start' | 'outcome',
): CadenceStep[] {
  const explicit = input.allowedStepIds;
  const allowed = explicit === null
    ? [...input.definition.steps]
    : explicit.map((id) => requireStep(input.definition, id));
  if (allowed.length === 0) throw new CadencePlanningError('The allowed cadence plan cannot be empty.');

  const definitionPositions = new Map(input.definition.steps.map((step, index) => [step.id, index]));
  const positions = allowed.map((step) => definitionPositions.get(step.id)!);
  if (new Set(positions).size !== positions.length
    || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
    throw new CadencePlanningError('Allowed cadence steps must be an ordered definition subsequence.');
  }

  let resolvedCurrentIndex: number | null = null;
  if (phase === 'outcome') {
    resolvedCurrentIndex = allowed.findIndex(({ id }) => id === input.currentStepId);
    if (resolvedCurrentIndex < 0) {
      throw new CadencePlanningError('The current step is absent from the allowed plan.');
    }
    const expectedScheduledStepCount = input.mode === 'inbound_over_cap_response'
      ? 1
      : resolvedCurrentIndex + 1;
    if (!Number.isInteger(input.scheduledStepCount)
      || input.scheduledStepCount !== expectedScheduledStepCount) {
      throw new CadencePlanningError(
        'The enrollment scheduled-step count does not match its current plan position.',
      );
    }
  }

  if (input.mode === 'inbound_over_cap_response') {
    const firstStep = input.definition.steps[0];
    const expectedTotal = phase === 'start'
      ? input.highestProspectingAttemptCap
      : input.highestProspectingAttemptCap + 1;
    if (input.definition.category !== 'prospecting'
      || input.definition.id !== BUILTIN_WARM_CADENCE_V1.id
      || input.definition.family !== BUILTIN_WARM_CADENCE_V1.family
      || input.definition.version !== BUILTIN_WARM_CADENCE_V1.version
      || input.definition.contentHash !== BUILTIN_WARM_CADENCE_V1.contentHash
      || explicit === null
      || allowed.length !== 1
      || firstStep === undefined
      || allowed[0]?.id !== firstStep.id
      || input.totalProspectingScheduledSteps !== expectedTotal
      || (phase === 'outcome' && input.currentStepId !== firstStep.id)) {
      throw new CadencePlanningError(
        'An over-cap inbound response permits exactly its first trigger-response step.',
      );
    }
    return allowed;
  }

  if (input.definition.category !== 'prospecting') {
    if (explicit !== null && (allowed.length !== input.definition.steps.length
      || allowed.some((step, index) => step.id !== input.definition.steps[index]?.id))) {
      throw new CadencePlanningError(
        'A fixed non-prospecting cadence requires its exact complete definition plan.',
      );
    }
    return allowed;
  }
  const remaining = input.highestProspectingAttemptCap - input.totalProspectingScheduledSteps;
  if (remaining < 0 || (phase === 'start' && remaining === 0)) {
    throw new CadencePlanningError('The prospecting step cap is exhausted.');
  }
  if (explicit !== null) {
    if (allowed.at(-1)?.breakup !== true) {
      throw new CadencePlanningError('A standard prospecting plan must end with breakup.');
    }
    if (phase === 'start' && allowed.length > remaining) {
      throw new CadencePlanningError('The allowed cadence plan exceeds the remaining cap.');
    }
    if (phase === 'outcome') {
      if (allowed.length - resolvedCurrentIndex! - 1 > remaining) {
        throw new CadencePlanningError('The persisted cadence plan exceeds the remaining cap.');
      }
    }
  }
  if (phase === 'start' && explicit === null && remaining === 1) {
    const breakup = allowed.find(({ breakup: isBreakup }) => isBreakup);
    if (breakup === undefined) throw new CadencePlanningError('The last prospecting slot requires breakup.');
    return [breakup];
  }
  return allowed;
}

function createInstruction(
  definition: CadenceAggregate,
  step: CadenceStep,
  component: CadenceActionComponent,
  input: Pick<CadenceStartInput, 'anchorAt' | 'evaluationAt' | 'timezone' | 'policies' | 'priorCallWindow'>,
): NextActionInstruction {
  const scheduled = scheduleComponent({
    step,
    component,
    anchorAt: input.anchorAt,
    evaluationAt: input.evaluationAt,
    timezone: input.timezone,
    policies: input.policies,
    priorCallWindow: input.priorCallWindow,
  });
  return {
    kind: 'create',
    draft: {
      actionType: component.actionType,
      channel: component.channel,
      dueAt: scheduled.dueAt,
      timezone: scheduled.timezone,
      allowedWindow: scheduled.allowedWindow,
      cadenceDefinitionId: definition.id,
      cadenceStepId: step.id,
      cadenceComponentId: component.id,
    },
  };
}

function enrollmentMutation(
  kind: EnrollmentMutation['kind'],
  definitionId: string,
  currentStepId: string,
  scheduledStepCountDelta: 0 | 1,
  status: EnrollmentMutation['status'],
  stopReason: EnrollmentMutation['stopReason'],
): EnrollmentMutation {
  return { kind, definitionId, currentStepId, scheduledStepCountDelta, status, stopReason };
}

function withNextAction(
  input: TransitionRecipeBase & { nextAction: NextActionInstruction },
): TransitionRecipe {
  return { ...input, terminal: null };
}

function withTerminal(
  input: TransitionRecipeBase & { terminal: CadenceTerminal },
): TransitionRecipe {
  return { ...input, nextAction: null };
}

function validateImpossibleDisposition(value: ImpossibleDisposition | null): ImpossibleDisposition {
  if (value === null || value.reason.trim().length === 0) {
    throw new CadencePlanningError('Marked impossible requires a reason.');
  }
  if (value.reason === 'other' && (value.notes === null || value.notes.trim().length === 0)) {
    throw new CadencePlanningError('The other impossible reason requires notes.');
  }
  return { reason: value.reason, notes: value.notes === null ? null : value.notes.trim() };
}

function validatePlanningContext(input: PlanningContext): void {
  assertCanonicalInstant(input.evaluationAt, 'evaluationAt');
  if (!Number.isInteger(input.totalProspectingScheduledSteps)
    || input.totalProspectingScheduledSteps < 0
    || !Number.isInteger(input.highestProspectingAttemptCap)
    || input.highestProspectingAttemptCap < 0) {
    throw new CadencePlanningError('Prospecting counts must be nonnegative integers.');
  }
}

function validateEvidenceIds(ids: readonly string[]): string[] {
  const normalized = ids.map((id) => id.trim());
  if (normalized.some((id) => id.length === 0) || new Set(normalized).size !== normalized.length) {
    throw new CadencePlanningError('Completed Activity IDs must be nonblank and unique.');
  }
  return [...normalized];
}

function requireStep(definition: CadenceAggregate, id: string): CadenceStep {
  const step = definition.steps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new CadencePlanningError('Unknown cadence step.');
  return step;
}

function requireComponent(step: CadenceStep, id: string): CadenceActionComponent {
  const component = step.components.find((candidate) => candidate.id === id);
  if (component === undefined) throw new CadencePlanningError('The component does not belong to the current step.');
  return component;
}

function requireComponentByDefinition(
  definition: CadenceAggregate,
  id: string,
): CadenceActionComponent {
  for (const step of definition.steps) {
    const component = step.components.find((candidate) => candidate.id === id);
    if (component !== undefined) return component;
  }
  throw new CadencePlanningError('Unknown cadence component target.');
}

function requireContainingStep(definition: CadenceAggregate, componentId: string): CadenceStep {
  const step = definition.steps.find((candidate) => (
    candidate.components.some(({ id }) => id === componentId)
  ));
  if (step === undefined) throw new CadencePlanningError('Unknown cadence component owner.');
  return step;
}

function eventDraft(
  salesCycleId: string,
  eventType: 'new-frbo-listing' | 'lead-cert-expiry-window',
): ReactivationRuleDraft {
  return {
    ruleType: eventType,
    ruleVersion: 1,
    dueAt: null,
    matcher: { eventType, personWide: true },
    logicalDedupeKey: `${salesCycleId}:${eventType}:v1`,
  };
}

function contextFromUpgrade(
  input: CadenceUpgradeInput,
  highestProspectingAttemptCap: number,
): PlanningContext {
  return {
    evaluationAt: input.evaluationAt,
    timezone: input.timezone,
    policies: input.policies,
    priorCallWindow: input.priorCallWindow,
    totalProspectingScheduledSteps: input.totalProspectingScheduledSteps,
    highestProspectingAttemptCap,
  };
}
