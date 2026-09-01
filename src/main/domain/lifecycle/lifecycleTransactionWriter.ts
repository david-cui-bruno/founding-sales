import type { AppDatabase } from '../../db/database';
import { z } from 'zod';
import {
  planActionOutcome,
  planCadenceStart,
  planCadenceUpgrade,
  planReactivationDefaults,
  type ImpossibleDisposition,
  type ReactivationRuleDraft,
  type TransitionRecipe,
} from '../cadence/cadencePlanner';
import type { CadenceRepository } from '../cadence/cadenceRepository';
import type { CadenceFamily, CadenceOutcome, ResolverOutcome } from '../cadence/cadenceTypes';
import type { ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import type { Activity, EventRepository } from '../events/eventRepository';
import type { IdentityRepository } from '../identity/identityRepository';
import type { SourceRepository } from '../source/sourceRepository';
import type { Clock } from '../support/clock';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleConflictError,
  LifecycleEligibilityError,
  LifecycleEvidenceError,
  LifecycleIdempotencyConflictError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { IdGenerator } from '../support/idGenerator';
import { CadenceEnrollmentRepository } from './cadenceEnrollmentRepository';
import {
  qualifiesFounderInterviewed,
  qualifiesFounderOffered,
} from './founderConfirmationEvidence';
import { deriveInboundSla } from './inboundSla';
import {
  promoteUnknownInboundReviewCommandSchema,
  reactivationInboundCommandSchema,
  reactivationReviewBlockerSchema,
  reactivationResultEnvelopeSchema,
  reactivationRuleCommandSchema,
  type ReactivateFromInboundCommand,
  type ReactivateFromRuleCommand,
  type PromoteUnknownInboundReviewCommand,
  type ReactivationCadenceIdentity,
  type ReactivationCommandEnvelope,
} from './reactivationContracts';
import type {
  ActionSettlementOutcome,
  CadenceActionBinding,
  CadenceEnrollment,
  CloseReadiness,
  ExpectedActionIntentAndSla,
  InboundSla,
  LifecycleReviewItem,
  LostNurtureReason,
  NextAction,
  NextActionIntentAndSla,
  ReactivationRule,
  SalesCycle,
  WonTerms,
} from './lifecycleTypes';
import {
  actionSettlementOutcomeSchema, serializeCanonical, utcTimestampSchema,
} from './lifecycleValidation';
import { qualifiesContactEvidence } from '../events/qualifyingContactEvidence';
import type { QualificationGateReason } from '../identity/identityTypes';
import { LifecycleReviewRepository } from './lifecycleReviewRepository';
import { NextActionRepository } from './nextActionRepository';
import {
  ReactivationRepository,
  type InsertReactivationRuleInput,
} from './reactivationRepository';
import { SalesCycleRepository } from './salesCycleRepository';

const NO_CADENCE: CadenceActionBinding = {
  cadenceEnrollmentId: null, cadenceDefinitionId: null,
  cadenceStepId: null, cadenceComponentId: null,
};

const lifecycleIdSchema = z.string().trim().min(1);
const createUnreviewedCycleSchema = z.object({
  personId: lifecycleIdSchema,
  prospectId: lifecycleIdSchema,
  entrySourceEventId: lifecycleIdSchema,
  effectiveAt: utcTimestampSchema,
}).strict();
const reviewToReadySchema = z.object({
  cycleId: lifecycleIdSchema,
  expectedCycleVersion: z.number().int().positive(),
  expectedCurrentActionId: lifecycleIdSchema,
  expectedProspectVersion: z.number().int().positive(),
  effectiveAt: utcTimestampSchema,
}).strict();
const recordContactSchema = z.object({
  cycleId: lifecycleIdSchema,
  expectedCycleVersion: z.number().int().positive(),
  expectedCurrentActionId: lifecycleIdSchema,
  activityId: lifecycleIdSchema,
  effectiveAt: utcTimestampSchema,
}).strict();
const founderConfirmationSchema = z.object({
  cycleId: lifecycleIdSchema,
  expectedCycleVersion: z.number().int().positive(),
  expectedCurrentActionId: lifecycleIdSchema,
  suggestionActivityId: lifecycleIdSchema,
  effectiveAt: utcTimestampSchema,
  confirmedAt: utcTimestampSchema,
}).strict();
const closeForOptOutSchema = z.object({
  personId: lifecycleIdSchema,
  evidenceActivityId: lifecycleIdSchema,
  effectiveAt: utcTimestampSchema,
  terminalStageEventId: lifecycleIdSchema.nullable(),
}).strict();

const completeCurrentActionSchema = z.object({
  cycleId: z.string().trim().min(1), expectedCycleVersion: z.number().int().positive(),
  expectedCurrentActionId: z.string().trim().min(1),
  expectedActionVersion: z.number().int().positive(),
  expectedEnrollmentVersion: z.number().int().positive(),
  outcome: z.enum([
    'answered', 'no_answer', 'voicemail_left', 'accepted', 'failed', 'replied',
    'opted_out', 'channel_unavailable', 'marked_impossible', 'resolved',
  ]),
  activityId: z.string().trim().min(1).nullable(),
  impossibleDisposition: z.object({
    reason: z.enum([
      'missing_phone', 'missing_email', 'invalid_contact_method', 'channel_disabled', 'other',
    ]),
    notes: z.string().nullable(),
  }).strict().nullable(),
  evaluationAt: utcTimestampSchema,
  manualReactivationDueAt: utcTimestampSchema.nullable(),
}).strict();

const readinessDimensionInputSchema = z.object({
  value: z.enum(['unknown', 'weak', 'moderate', 'strong']),
  evidenceActivityIds: z.array(z.string().trim().min(1)),
}).strict();

const reactivationRuleInputSchema = reactivationRuleCommandSchema;
const reactivationInboundInputSchema = reactivationInboundCommandSchema;
const reactivationReceiptResultSchema = reactivationResultEnvelopeSchema;

export type CreateUnreviewedCycleInput = Readonly<{
  personId: string;
  prospectId: string;
  entrySourceEventId: string;
  effectiveAt: string;
}>;

export type ReviewToReadyInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  expectedProspectVersion: number;
  effectiveAt: string;
}>;

export type RecordContactInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  activityId: string;
  effectiveAt: string;
}>;

export type ConfirmInterviewedInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  suggestionActivityId: string;
  effectiveAt: string;
  confirmedAt: string;
}>;

export type ConfirmOfferedInput = ConfirmInterviewedInput;

export type WonTermsInput =
  | Readonly<{
      billingModel: 'per_door_monthly';
      doorsCommitted: number;
      unitRateCents: number;
      foundingCustomer: boolean;
      effectiveAt: string;
    }>
  | Readonly<{
      billingModel: 'flat_monthly';
      doorsCommitted: number;
      unitRateCents: number;
      foundingCustomer: boolean;
      effectiveAt: string;
    }>
  | Readonly<{
      billingModel: 'manual_projected_monthly';
      doorsCommitted: number;
      unitRateCents: number;
      projectedMrrCents: number;
      manualProjectionReason: string;
      foundingCustomer: boolean;
      effectiveAt: string;
    }>;

export type ConfirmWonInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  effectiveAt: string;
  confirmedAt: string;
  terms: WonTermsInput;
}>;

export type CompleteOnboardingInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  effectiveAt: string;
  waived: boolean;
  waiverReason: string | null;
}>;

export type CompleteCurrentActionInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  expectedActionVersion: number;
  expectedEnrollmentVersion: number;
  outcome: CadenceOutcome | ResolverOutcome;
  activityId: string | null;
  impossibleDisposition: ImpossibleDisposition | null;
  evaluationAt: string;
  manualReactivationDueAt: string | null;
}>;

export type CloseLostNurtureQualification =
  | {
      reason: 'not_qualified' | 'disqualified';
      qualificationGateReason: QualificationGateReason;
    }
  | {
      reason: Exclude<LostNurtureReason, 'not_qualified' | 'disqualified' | 'opt_out'>;
      qualificationGateReason: null;
    };

export type CloseLostNurtureInput = Readonly<CloseLostNurtureQualification & {
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  notes: string | null;
  effectiveAt: string;
  manualReactivationDueAt: string | null;
  expectedProspectVersion: number | null;
}>;

export type SetDesignPartnerFitnessInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  fitness: number;
  updatedAt: string;
}>;

export type SetCloseReadinessInput = Readonly<{
  cycleId: string;
  expectedReadinessVersion: number;
  readiness: CloseReadiness['readiness'];
  assessedAt: string;
}>;

export type ReactivateFromRuleInput = ReactivateFromRuleCommand;
export type ReactivateFromInboundInput = ReactivateFromInboundCommand;
export type PromoteUnknownInboundReviewInput = PromoteUnknownInboundReviewCommand;

export type ReactivationResult = Readonly<
  | { kind: 'reactivated'; cycle: SalesCycle }
  | { kind: 'review_required'; reviewItem: LifecycleReviewItem }
  | { kind: 'permanently_blocked'; tombstoneId: string }
>;

export type ApplyProspectingTriggerInput = Readonly<{
  cycleId: string;
  expectedCycleVersion: number;
  expectedCurrentActionId: string;
  expectedActionVersion: number;
  expectedEnrollmentVersion: number;
  triggerSourceEventId: string;
  trigger: 'live_vacancy' | 'inbound_demo' | 'direct_referral';
  evaluationAt: string;
}>;

export type CloseForOptOutInput = Readonly<{
  personId: string;
  evidenceActivityId: string;
  effectiveAt: string;
  terminalStageEventId: string | null;
}>;

export type CloseForOptOutResult = Readonly<{
  cycle: SalesCycle | null;
  stoppedEnrollmentIds: readonly string[];
  cancelledActionIds: readonly string[];
}>;

export interface LifecycleCommands {
  createUnreviewedCycle(input: CreateUnreviewedCycleInput): SalesCycle;
  reviewToReady(input: ReviewToReadyInput): SalesCycle;
  recordQualifyingContact(input: RecordContactInput): SalesCycle;
  confirmInterviewed(input: ConfirmInterviewedInput): SalesCycle;
  confirmOffered(input: ConfirmOfferedInput): SalesCycle;
  confirmWon(input: ConfirmWonInput): SalesCycle;
  completeCurrentAction(input: CompleteCurrentActionInput): SalesCycle;
  closeLostNurture(input: CloseLostNurtureInput): SalesCycle;
  completeOnboarding(input: CompleteOnboardingInput): SalesCycle;
  reactivateFromRule(input: ReactivateFromRuleInput): ReactivationResult;
  reactivateFromInboundResponse(input: ReactivateFromInboundInput): ReactivationResult;
  promoteUnknownInboundReview(input: PromoteUnknownInboundReviewInput): ReactivationResult;
  setDesignPartnerFitness(input: SetDesignPartnerFitnessInput): SalesCycle;
  setCloseReadiness(input: SetCloseReadinessInput): CloseReadiness;
  applyProspectingTrigger(input: ApplyProspectingTriggerInput): SalesCycle;
}

export interface LifecycleTransactionCommands extends LifecycleCommands {
  closeForOptOut(input: CloseForOptOutInput): CloseForOptOutResult;
}

export type LifecycleWriterDependencies = Readonly<{
  database: AppDatabase;
  unitOfWork: DomainUnitOfWork;
  identities: IdentityRepository;
  events: EventRepository;
  sources: SourceRepository;
  cadences: CadenceRepository;
  clock: Clock;
  ids: IdGenerator;
  timezone: string;
  policies: ChannelPolicySnapshots;
}>;

export class LifecycleTransactionWriter implements LifecycleTransactionCommands {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly identities: IdentityRepository;
  private readonly events: EventRepository;
  private readonly sources: SourceRepository;
  private readonly cadences: CadenceRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly timezone: string;
  private readonly policies: ChannelPolicySnapshots;
  private readonly cycles: SalesCycleRepository;
  private readonly actions: NextActionRepository;
  private readonly enrollments: CadenceEnrollmentRepository;
  private readonly reactivations: ReactivationRepository;
  private readonly reviews: LifecycleReviewRepository;

  constructor(input: LifecycleWriterDependencies) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    input.events.assertBoundTo(input.database, input.unitOfWork);
    input.sources.assertBoundTo(input.database, input.unitOfWork);
    input.cadences.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.events = input.events;
    this.sources = input.sources;
    this.cadences = input.cadences;
    this.clock = input.clock;
    this.ids = input.ids;
    this.timezone = input.timezone;
    this.policies = input.policies;
    this.cycles = new SalesCycleRepository(input);
    this.actions = new NextActionRepository(input);
    this.enrollments = new CadenceEnrollmentRepository({ ...input, cadences: input.cadences });
    this.reactivations = new ReactivationRepository(input);
    this.reviews = new LifecycleReviewRepository(input);
  }

  createUnreviewedCycle(input: CreateUnreviewedCycleInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = createUnreviewedCycleSchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const person = this.identities.getPerson(parsed.personId);
    const prospect = this.identities.getCanonicalProspect(parsed.personId);
    const source = this.database.raw.prepare<
      [string], { person_id: string; prospect_id: string | null }
    >('SELECT person_id, prospect_id FROM source_events WHERE id = ?').get(parsed.entrySourceEventId);
    if (
      person === null || person.optedOut || person.deletedAt !== null
      || prospect === null || prospect.id !== parsed.prospectId
      || prospect.qualificationState !== 'unreviewed'
      || source?.person_id !== person.id
      || (source.prospect_id !== null && source.prospect_id !== prospect.id)
    ) throw new LifecycleEligibilityError();
    const cycleId = this.ids.next();
    const actionId = this.ids.next();
    const eventId = this.ids.next();
    const cycle = this.cycles.insertCycleWithDeferredAction({
      id: cycleId, personId: person.id, prospectId: prospect.id,
      entrySourceEventId: parsed.entrySourceEventId, stage: 'unreviewed',
      workflowStatus: 'active', currentNextActionId: actionId,
      stageEnteredAt: effectiveAt, createdAt: effectiveAt,
    });
    this.actions.insertNextAction({
      id: actionId, salesCycleId: cycle.id, actionType: 'review_lead', channel: null,
      status: 'pending', dueAt: effectiveAt, timezone: this.timezone,
      allowedWindow: null, slaDueAt: null, workIntent: 'internal_review',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      cadence: NO_CADENCE, createdAt: effectiveAt,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: cycle.id, fromStage: null, toStage: 'unreviewed',
      effectiveAt, confirmedAt: effectiveAt, confirmationKind: 'mechanical',
      transitionSequence: 1,
    });
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return this.cycles.getById(cycle.id)!;
  }

  reviewToReady(input: ReviewToReadyInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = reviewToReadySchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const cycle = this.requireExpectedOpenCycle(
      parsed.cycleId, parsed.expectedCycleVersion, 'unreviewed', parsed.expectedCurrentActionId,
    );
    this.assertTransitionEvidenceTimes(cycle, effectiveAt, effectiveAt, null);
    const prospect = this.identities.getCanonicalProspect(cycle.personId);
    if (
      prospect === null || prospect.id !== cycle.prospectId
      || prospect.version !== parsed.expectedProspectVersion
      || prospect.qualificationState !== 'unreviewed'
    ) throw new LifecycleEligibilityError('Only a canonical Unreviewed Prospect may enter Ready.');
    const family = prospect.segment === 'warm'
      ? 'cadence_c'
      : prospect.segment === 'hot' ? 'cadence_a' : 'cadence_b';
    const definition = this.cadences.getByFamilyVersion(family, 1);
    if (definition === null) throw new LifecycleConflictError('Required cadence is not installed.');
    const recipe = planCadenceStart({
      definition, anchorAt: effectiveAt, evaluationAt: effectiveAt,
      timezone: this.timezone, policies: this.policies, priorCallWindow: null,
      totalProspectingScheduledSteps: 0,
      highestProspectingAttemptCap: definition.attemptCap,
      mode: 'standard', allowedStepIds: null,
    });
    if (recipe.nextAction?.kind !== 'create') {
      throw new LifecycleConflictError('Cadence start did not produce a new action.');
    }
    const enrollmentId = this.ids.next();
    const nextActionId = this.ids.next();
    const eventId = this.ids.next();
    this.enrollments.insertCadenceEnrollment({
      id: enrollmentId, salesCycleId: cycle.id, definitionId: definition.id,
      anchorAt: effectiveAt, currentStepId: recipe.enrollment.currentStepId,
      scheduledStepCount: recipe.enrollment.scheduledStepCountDelta,
      status: 'active', mode: 'standard', allowedStepIds: null, createdAt: effectiveAt,
    });
    const draft = recipe.nextAction.draft;
    const cadence: CadenceActionBinding = {
      cadenceEnrollmentId: enrollmentId, cadenceDefinitionId: draft.cadenceDefinitionId,
      cadenceStepId: draft.cadenceStepId, cadenceComponentId: draft.cadenceComponentId,
    };
    this.actions.insertNextAction({
      id: nextActionId, salesCycleId: cycle.id, actionType: draft.actionType,
      channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
      timezone: draft.timezone, allowedWindow: draft.allowedWindow,
      slaDueAt: draft.slaDueAt, workIntent: 'discretionary_prospecting',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      cadence, createdAt: effectiveAt,
    });
    this.identities.updateProspectQualification({
      prospectId: prospect.id, personId: prospect.personId,
      expectedVersion: prospect.version, expectedState: 'unreviewed', nextState: 'eligible',
      qualificationGateReason: null,
      reason: 'Founder reviewed', updatedAt: effectiveAt,
    });
    const transitioned = this.cycles.transitionOpenProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: 'unreviewed',
      expectedWorkflowStatus: 'active', expectedCurrentActionId: cycle.currentNextActionId!,
      nextStage: 'ready', nextWorkflowStatus: 'active', nextActionId,
      stageEnteredAt: effectiveAt,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: cycle.id, fromStage: 'unreviewed', toStage: 'ready',
      effectiveAt, confirmedAt: effectiveAt, confirmationKind: 'founder',
      transitionSequence: 2,
    });
    this.actions.settleAction({
      actionId: cycle.currentNextActionId!, salesCycleId: cycle.id,
      expectedStatus: 'pending', expectedVersion: 1,
      expectedWorkIntent: 'internal_review',
      expectedInboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      expectedCadence: NO_CADENCE, status: 'completed', completedAt: effectiveAt,
      completionActivityId: null,
      settlement: {
        version: 1, outcome: 'reviewed_ready', reason: null, evidenceActivityId: null,
        plannerTransition: {
          definitionId: null, stepId: null, componentId: null,
          attempt: null, outcome: 'reviewed_ready',
        },
        cadence: NO_CADENCE, workIntent: 'internal_review',
        inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      },
    });
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return transitioned;
  }

  recordQualifyingContact(input: RecordContactInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = recordContactSchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const cycle = this.requireExpectedOpenCycle(
      parsed.cycleId, parsed.expectedCycleVersion, 'ready', parsed.expectedCurrentActionId,
    );
    const activity = this.events.getActivity(parsed.activityId);
    if (
      activity === null || activity.personId !== cycle.personId
      || activity.prospectId !== cycle.prospectId || activity.salesCycleId !== cycle.id
      || !qualifiesContactEvidence(activity, cycle.prospectId)
    ) throw new LifecycleEvidenceError('Activity does not mechanically qualify as Contacted.');
    this.assertTransitionEvidenceTimes(cycle, effectiveAt, effectiveAt, activity);
    const transitioned = this.cycles.transitionOpenProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: 'ready',
      expectedWorkflowStatus: 'active', expectedCurrentActionId: parsed.expectedCurrentActionId,
      nextStage: 'contacted', nextWorkflowStatus: 'active',
      nextActionId: parsed.expectedCurrentActionId, stageEnteredAt: effectiveAt,
    });
    this.events.appendStageEvent({
      id: this.ids.next(), salesCycleId: cycle.id, fromStage: 'ready', toStage: 'contacted',
      effectiveAt, confirmedAt: effectiveAt, confirmationKind: 'mechanical',
      transitionSequence: this.nextTransitionSequence(cycle.id),
    });
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return transitioned;
  }

  confirmInterviewed(input: ConfirmInterviewedInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = founderConfirmationSchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const confirmedAt = parsed.confirmedAt;
    if (effectiveAt > confirmedAt) throw new LifecycleEvidenceError('Effective time cannot follow confirmation.');
    const cycle = this.cycles.getById(parsed.cycleId);
    if (
      cycle === null || cycle.version !== parsed.expectedCycleVersion
      || cycle.currentNextActionId !== parsed.expectedCurrentActionId
      || cycle.workflowStatus !== 'active'
      || (cycle.stage !== 'ready' && cycle.stage !== 'contacted')
    ) throw new LifecycleConflictError('Interview confirmation projection is stale or illegal.');
    const activity = this.requireOwnedActivity(cycle, parsed.suggestionActivityId);
    if (!qualifiesFounderInterviewed(activity)) {
      throw new LifecycleEvidenceError('Interviewed requires founder-confirmed conversation evidence.');
    }
    this.assertTransitionEvidenceTimes(cycle, effectiveAt, confirmedAt, activity);
    let sequence = this.nextTransitionSequence(cycle.id);
    if (cycle.stage === 'ready') {
      this.events.appendStageEvent({
        id: this.ids.next(), salesCycleId: cycle.id, fromStage: 'ready', toStage: 'contacted',
        effectiveAt, confirmedAt, confirmationKind: 'backfill', transitionSequence: sequence,
        backfillProvenance: { version: 1, reason: 'founder_confirmed_interview' },
      });
      sequence += 1;
    }
    return this.swapStageCadence({
      cycle, targetStage: 'interviewed', family: 'post_interview', effectiveAt,
      confirmedAt, evidenceActivityId: activity.id, transitionSequence: sequence,
      fromStage: cycle.stage === 'ready' ? 'contacted' : cycle.stage,
    });
  }

  confirmOffered(input: ConfirmOfferedInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = founderConfirmationSchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const confirmedAt = parsed.confirmedAt;
    if (effectiveAt > confirmedAt) throw new LifecycleEvidenceError('Effective time cannot follow confirmation.');
    const cycle = this.requireExpectedOpenCycle(
      parsed.cycleId, parsed.expectedCycleVersion, 'interviewed', parsed.expectedCurrentActionId,
    );
    const activity = this.requireOwnedActivity(cycle, parsed.suggestionActivityId);
    if (!qualifiesFounderOffered(activity)) {
      throw new LifecycleEvidenceError('Offered requires founder-confirmed price-said evidence.');
    }
    this.assertTransitionEvidenceTimes(cycle, effectiveAt, confirmedAt, activity);
    return this.swapStageCadence({
      cycle, targetStage: 'offered', family: 'post_offer', effectiveAt, confirmedAt,
      evidenceActivityId: activity.id, transitionSequence: this.nextTransitionSequence(cycle.id),
      fromStage: 'interviewed',
    });
  }

  confirmWon(input: ConfirmWonInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = parseConfirmWonInput(input);
    const replayCycle = this.cycles.getById(parsed.cycleId);
    if (replayCycle?.stage === 'won'
      && (replayCycle.workflowStatus === 'onboarding' || replayCycle.workflowStatus === 'closed')) {
      const terms = this.cycles.getWonTerms(replayCycle.id);
      if (terms !== null && wonTermsMatchInput(terms, parsed.terms)) return replayCycle;
      throw new LifecycleConflictError('Won replay changed immutable founding terms.');
    }
    const cycle = this.requireExpectedOpenCycle(
      parsed.cycleId, parsed.expectedCycleVersion, 'offered', parsed.expectedCurrentActionId,
    );
    this.assertTransitionEvidenceTimes(cycle, parsed.effectiveAt, parsed.confirmedAt, null);
    const currentAction = this.requireCurrentAction(cycle);
    const currentEnrollment = this.requireActiveEnrollment(cycle);
    this.stopEnrollment(currentEnrollment, 'upgraded', parsed.effectiveAt);
    const definition = this.requireCadence('onboarding');
    const recipe = planCadenceStart({
      definition, anchorAt: parsed.effectiveAt, evaluationAt: parsed.effectiveAt,
      timezone: this.timezone, policies: this.policies, priorCallWindow: null,
      totalProspectingScheduledSteps: this.totalProspectingSteps(cycle.id),
      highestProspectingAttemptCap: this.highestProspectingCap(cycle.id),
      mode: 'standard', allowedStepIds: null,
    });
    if (recipe.nextAction?.kind !== 'create') throw new LifecycleConflictError('Onboarding start is invalid.');
    const enrollmentId = this.ids.next();
    const actionId = this.ids.next();
    const eventId = this.ids.next();
    this.enrollments.insertCadenceEnrollment({
      id: enrollmentId, salesCycleId: cycle.id, definitionId: definition.id,
      anchorAt: parsed.effectiveAt, currentStepId: recipe.enrollment.currentStepId,
      scheduledStepCount: recipe.enrollment.scheduledStepCountDelta,
      status: 'active', mode: 'standard', allowedStepIds: null, createdAt: parsed.effectiveAt,
    });
    const draft = recipe.nextAction.draft;
    const cadence = cadenceBinding(enrollmentId, draft);
    this.actions.insertNextAction({
      id: actionId, salesCycleId: cycle.id, actionType: draft.actionType,
      channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
      timezone: draft.timezone, allowedWindow: draft.allowedWindow,
      slaDueAt: draft.slaDueAt, workIntent: 'promised_follow_up',
      inboundSla: noneInboundSla(), cadence, createdAt: parsed.effectiveAt,
    });
    const projectedMrrCents = parsed.terms.billingModel === 'per_door_monthly'
      ? parsed.terms.doorsCommitted * parsed.terms.unitRateCents
      : parsed.terms.billingModel === 'flat_monthly'
        ? parsed.terms.unitRateCents
        : parsed.terms.projectedMrrCents;
    if (!Number.isSafeInteger(projectedMrrCents)) {
      throw new LifecycleEvidenceError('Projected MRR must remain a safe integer number of cents.');
    }
    this.cycles.insertWonTerms({
      salesCycleId: cycle.id, doorsCommitted: parsed.terms.doorsCommitted,
      billingModel: parsed.terms.billingModel, unitRateCents: parsed.terms.unitRateCents,
      projectedMrrCents, projectionFormulaVersion: 'founder_terms_v1',
      manualProjectionReason: parsed.terms.billingModel === 'manual_projected_monthly'
        ? parsed.terms.manualProjectionReason
        : null,
      foundingCustomer: parsed.terms.foundingCustomer,
      effectiveAt: parsed.terms.effectiveAt, createdAt: parsed.effectiveAt,
    });
    const transitioned = this.cycles.transitionOpenProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: 'offered',
      expectedWorkflowStatus: 'active', expectedCurrentActionId: currentAction.id,
      nextStage: 'won', nextWorkflowStatus: 'onboarding', nextActionId: actionId,
      stageEnteredAt: parsed.effectiveAt,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: cycle.id, fromStage: 'offered', toStage: 'won',
      effectiveAt: parsed.effectiveAt, confirmedAt: parsed.confirmedAt,
      confirmationKind: 'founder', transitionSequence: this.nextTransitionSequence(cycle.id),
    });
    this.settleReplacedAction(currentAction, 'won_confirmed', null, parsed.effectiveAt);
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return transitioned;
  }

  completeOnboarding(input: CompleteOnboardingInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: z.string().trim().min(1), expectedCycleVersion: z.number().int().positive(),
      expectedCurrentActionId: z.string().trim().min(1), effectiveAt: utcTimestampSchema,
      waived: z.boolean(), waiverReason: z.string().nullable(),
    }).strict().superRefine((value, context) => {
      if (!value.waived || (value.waiverReason?.trim().length ?? 0) === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Direct onboarding closure is only the explicit nonblank waiver path.',
        });
      }
    }).parse(input);
    const cycle = this.cycles.getById(parsed.cycleId);
    if (
      cycle === null || cycle.version !== parsed.expectedCycleVersion
      || cycle.stage !== 'won' || cycle.workflowStatus !== 'onboarding'
      || cycle.currentNextActionId !== parsed.expectedCurrentActionId
    ) throw new LifecycleConflictError('Onboarding projection is stale or already closed.');
    const action = this.requireCurrentAction(cycle);
    const enrollment = this.requireActiveEnrollment(cycle);
    if (this.cadences.getById(enrollment.cadenceDefinitionId)?.family !== 'onboarding') {
      throw new LifecycleConflictError('Won/onboarding must use the Onboarding cadence.');
    }
    this.stopEnrollment(enrollment, 'phase_completed', parsed.effectiveAt, 'complete');
    const closed = this.cycles.closeProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: 'won',
      expectedWorkflowStatus: 'onboarding', expectedCurrentActionId: action.id,
      finalStage: 'won', closedAt: parsed.effectiveAt, closeReason: null, closeNotes: null,
      onboardingStopReason: parsed.waived ? parsed.waiverReason : null,
    });
    this.settleReplacedAction(
      action, parsed.waived ? 'onboarding_waived' : 'phase_completed',
      null, parsed.effectiveAt, parsed.waiverReason,
    );
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return closed;
  }

  closeForOptOut(input: CloseForOptOutInput): CloseForOptOutResult {
    this.unitOfWork.assertWriteScope();
    const parsed = closeForOptOutSchema.parse(input);
    const effectiveAt = parsed.effectiveAt;
    const evidence = this.events.getActivity(parsed.evidenceActivityId);
    if (evidence === null || evidence.personId !== parsed.personId
      || evidence.observedOutcome !== 'opted_out') {
      throw new LifecycleEvidenceError('Opt-out closure requires Person-owned immutable Activity evidence.');
    }
    const cycle = this.cycles.getOperationalCycleForPerson(parsed.personId);
    if (cycle === null) {
      if (parsed.terminalStageEventId !== null) {
        throw new LifecycleEvidenceError('No-cycle opt-out closure cannot create a terminal StageEvent.');
      }
      const cancelledActionIds = this.cancelPendingOutboundForPerson(
        parsed.personId, evidence, effectiveAt,
      );
      return Object.freeze({
        cycle: null,
        stoppedEnrollmentIds: Object.freeze([]),
        cancelledActionIds,
      });
    }
    const preserveWon = cycle.stage === 'won' && cycle.workflowStatus === 'onboarding';
    if ((!preserveWon && parsed.terminalStageEventId === null)
      || (preserveWon && parsed.terminalStageEventId !== null)) {
      throw new LifecycleEvidenceError(
        preserveWon
          ? 'Won opt-out closure must not create another terminal StageEvent.'
          : 'Opt-out closure requires a stable terminal StageEvent ID.',
      );
    }
    const enrollment = this.enrollments.getActiveForCycle(cycle.id);
    const stoppedEnrollmentIds: string[] = [];
    if (enrollment !== null) {
      this.enrollments.applyCadenceEnrollmentMutation({
        enrollmentId: enrollment.id, salesCycleId: cycle.id, expectedVersion: enrollment.version,
        expectedDefinitionId: enrollment.cadenceDefinitionId,
        expectedCurrentStepId: enrollment.currentStepId!,
        expectedScheduledStepCount: enrollment.scheduledStepCount,
        expectedStatus: 'active', expectedMode: enrollment.mode,
        expectedAllowedStepIds: enrollment.allowedStepIds,
        mutation: {
          kind: 'stop', definitionId: enrollment.cadenceDefinitionId,
          currentStepId: enrollment.currentStepId!, scheduledStepCountDelta: 0,
          status: 'stopped', stopReason: 'opted_out',
        }, updatedAt: effectiveAt,
      });
      stoppedEnrollmentIds.push(enrollment.id);
    }
    const closed = this.cycles.closeProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: cycle.stage,
      expectedWorkflowStatus: cycle.workflowStatus as 'active' | 'onboarding',
      expectedCurrentActionId: cycle.currentNextActionId!,
      finalStage: preserveWon ? 'won' : 'lost_nurture',
      closedAt: effectiveAt, closeReason: preserveWon ? null : 'opt_out', closeNotes: null,
      onboardingStopReason: preserveWon ? 'opt_out' : null,
    });
    if (!preserveWon && parsed.terminalStageEventId !== null) {
      const sequence = this.events.listCycleStageEvents(cycle.id).length + 1;
      this.events.appendStageEvent({
        id: parsed.terminalStageEventId, salesCycleId: cycle.id,
        fromStage: cycle.stage, toStage: 'lost_nurture', effectiveAt,
        confirmedAt: effectiveAt, confirmationKind: 'mechanical', transitionSequence: sequence,
      });
    }
    const action = this.actions.getById(cycle.currentNextActionId!);
    if (action === null) throw new LifecycleConflictError('Current action is missing.');
    this.actions.settleAction({
      actionId: action.id, salesCycleId: cycle.id, expectedStatus: 'pending',
      expectedVersion: action.version, ...expectedIntentAndSla(action),
      expectedCadence: action.cadence,
      status: 'cancelled', completedAt: effectiveAt,
      completionActivityId: evidence.salesCycleId === action.salesCycleId ? evidence.id : null,
      settlement: {
        version: 1, outcome: 'opted_out', reason: 'person_wide_opt_out',
        evidenceActivityId: evidence.id,
        plannerTransition: {
          definitionId: action.cadence.cadenceDefinitionId,
          stepId: action.cadence.cadenceStepId,
          componentId: action.cadence.cadenceComponentId,
          attempt: this.settlementAttempt(action),
          outcome: 'opted_out',
        }, cadence: action.cadence, workIntent: action.workIntent, inboundSla: action.inboundSla,
      },
    });
    const cancelledActionIds = [
      action.id,
      ...this.cancelPendingOutboundForPerson(parsed.personId, evidence, effectiveAt),
    ].sort();
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return Object.freeze({
      cycle: closed,
      stoppedEnrollmentIds: Object.freeze(stoppedEnrollmentIds.sort()),
      cancelledActionIds: Object.freeze(cancelledActionIds),
    });
  }

  completeCurrentAction(input: CompleteCurrentActionInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = completeCurrentActionSchema.parse(input) as CompleteCurrentActionInput;
    const cycle = this.cycles.getById(parsed.cycleId);
    if (
      cycle === null || cycle.version !== parsed.expectedCycleVersion
      || cycle.currentNextActionId !== parsed.expectedCurrentActionId
      || (cycle.workflowStatus !== 'active' && cycle.workflowStatus !== 'onboarding')
    ) throw new StaleDomainWriteError();
    const action = this.requireCurrentAction(cycle);
    const enrollment = this.requireActiveEnrollment(cycle);
    if (action.version !== parsed.expectedActionVersion
      || enrollment.version !== parsed.expectedEnrollmentVersion
      || action.cadence.cadenceEnrollmentId !== enrollment.id
      || action.cadence.cadenceDefinitionId !== enrollment.cadenceDefinitionId
      || action.cadence.cadenceStepId !== enrollment.currentStepId
      || action.cadence.cadenceComponentId === null) {
      throw new StaleDomainWriteError();
    }
    const definition = this.cadences.getById(enrollment.cadenceDefinitionId);
    if (definition === null) throw new LifecycleEvidenceError('Cadence definition is missing.');
    const recipe = planActionOutcome({
      salesCycleId: cycle.id, definition,
      enrollment: {
        definitionId: enrollment.cadenceDefinitionId, anchorAt: enrollment.anchorAt,
        currentStepId: enrollment.currentStepId!, scheduledStepCount: enrollment.scheduledStepCount,
        status: enrollment.status, mode: enrollment.mode, allowedStepIds: enrollment.allowedStepIds,
      },
      action: action.actionType === 'resolve_contact_method'
        ? { kind: 'resolver', blockedComponentId: action.cadence.cadenceComponentId }
        : { kind: 'component', componentId: action.cadence.cadenceComponentId },
      outcome: parsed.outcome, impossibleDisposition: parsed.impossibleDisposition,
      evaluationAt: parsed.evaluationAt, timezone: this.timezone, policies: this.policies,
      priorCallWindow: parseCallWindow(action.allowedWindow),
      totalProspectingScheduledSteps: this.totalProspectingSteps(cycle.id),
      highestProspectingAttemptCap: this.highestProspectingCap(cycle.id),
    });
    const activity = this.validateOutcomeEvidence(cycle, action, recipe, parsed.activityId);
    const lifecycleCycle = cycle.stage === 'ready' && activity !== null
      && qualifiesContactEvidence(activity, cycle.prospectId)
      ? this.recordQualifyingContact({
          cycleId: cycle.id, expectedCycleVersion: cycle.version,
          expectedCurrentActionId: action.id, activityId: activity.id,
          effectiveAt: parsed.evaluationAt,
        })
      : cycle;
    const mutatedEnrollment = this.enrollments.applyCadenceEnrollmentMutation({
      enrollmentId: enrollment.id, salesCycleId: cycle.id,
      expectedVersion: enrollment.version, expectedDefinitionId: enrollment.cadenceDefinitionId,
      expectedCurrentStepId: enrollment.currentStepId!,
      expectedScheduledStepCount: enrollment.scheduledStepCount,
      expectedStatus: 'active', expectedMode: enrollment.mode,
      expectedAllowedStepIds: enrollment.allowedStepIds,
      mutation: recipe.enrollment, updatedAt: parsed.evaluationAt,
    });
    if (recipe.nextAction !== null) {
      if (recipe.nextAction.kind === 'reschedule_current') {
        this.actions.reschedulePendingAction({
          actionId: action.id, salesCycleId: cycle.id, expectedStatus: 'pending',
          expectedVersion: action.version, expectedDueAt: action.dueAt,
          ...expectedIntentAndSla(action),
          expectedCadence: action.cadence, dueAt: recipe.nextAction.dueAt,
          updatedAt: parsed.evaluationAt,
          timezone: recipe.nextAction.timezone, allowedWindow: recipe.nextAction.allowedWindow,
          slaDueAt: recipe.nextAction.slaDueAt, cadence: action.cadence,
        });
        this.assertOutcomePostcondition(cycle.id, mutatedEnrollment);
        return this.cycles.getById(cycle.id)!;
      }
      const draft = recipe.nextAction.draft;
      const nextActionId = this.ids.next();
      const binding = cadenceBinding(enrollment.id, draft);
      const retainIntent = recipe.enrollment.kind === 'advance_component'
        || recipe.enrollment.kind === 'resolve'
        || recipe.enrollment.kind === 'retry'
        || enrollment.mode === 'inbound_over_cap_response';
      const intentAndSla = retainIntent
        ? nextIntentAndSla(action.workIntent, action.inboundSla)
        : nextIntentAndSla('promised_follow_up', noneInboundSla());
      this.actions.insertNextAction({
        id: nextActionId, salesCycleId: cycle.id, actionType: draft.actionType,
        channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
        timezone: draft.timezone, allowedWindow: draft.allowedWindow,
        slaDueAt: draft.slaDueAt,
        ...intentAndSla,
        cadence: binding, createdAt: parsed.evaluationAt,
      });
      const transitioned = this.cycles.replaceCurrentAction({
        cycleId: lifecycleCycle.id, expectedVersion: lifecycleCycle.version,
        expectedStage: lifecycleCycle.stage,
        expectedWorkflowStatus: lifecycleCycle.workflowStatus as 'active' | 'onboarding',
        expectedCurrentActionId: action.id, nextActionId, updatedAt: parsed.evaluationAt,
      });
      this.settlePlannerAction(action, recipe, activity, parsed.evaluationAt);
      this.assertOutcomePostcondition(cycle.id, mutatedEnrollment);
      return transitioned;
    }
    return this.applyCadenceTerminal({
      cycle: lifecycleCycle, action, enrollment: mutatedEnrollment,
      definitionFamily: definition.family,
      recipe, activity, evaluationAt: parsed.evaluationAt,
      manualReactivationDueAt: parsed.manualReactivationDueAt,
    });
  }
  closeLostNurture(input: CloseLostNurtureInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: z.string().trim().min(1), expectedCycleVersion: z.number().int().positive(),
      expectedCurrentActionId: z.string().trim().min(1),
      reason: z.enum([
        'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
        'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
        'cadence_exhausted', 'disqualified', 'other',
      ]),
      qualificationGateReason: z.enum([
        'out_of_area', 'no_relevant_decision_relationship', 'institutional_outside_icp',
        'harmful_operator', 'non_paying_operator', 'unresolved_duplicate',
      ]).nullable(),
      notes: z.string().nullable(), effectiveAt: utcTimestampSchema,
      manualReactivationDueAt: utcTimestampSchema.nullable(),
      expectedProspectVersion: z.number().int().positive().nullable(),
    }).strict().superRefine((value, context) => {
      if (value.reason === 'other' && (value.notes?.trim().length ?? 0) === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Other requires notes.' });
      }
      const requiresGate = value.reason === 'not_qualified' || value.reason === 'disqualified';
      if (requiresGate !== (value.qualificationGateReason !== null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Disqualifying Lost-Nurture reasons require an exact qualification gate reason; other reasons require null.',
        });
      }
    }).parse(input) as CloseLostNurtureInput;
    const cycle = this.cycles.getById(parsed.cycleId);
    if (
      cycle === null || cycle.version !== parsed.expectedCycleVersion
      || cycle.currentNextActionId !== parsed.expectedCurrentActionId
      || cycle.workflowStatus !== 'active'
    ) throw new LifecycleConflictError('Lost-Nurture projection is stale.');
    const action = this.requireCurrentAction(cycle);
    const enrollment = this.enrollments.getActiveForCycle(cycle.id);
    const family = enrollment === null
      ? null
      : this.cadences.getById(enrollment.cadenceDefinitionId)?.family ?? null;
    const drafts = family === null
      ? planManualReactivation(cycle.id, parsed.effectiveAt, this.timezone, parsed.manualReactivationDueAt)
      : planReactivationDefaults({
        salesCycleId: cycle.id, family, evaluationAt: parsed.effectiveAt,
        timezone: this.timezone, manualDueAt: parsed.manualReactivationDueAt,
      });
    if (drafts.length === 0) {
      throw new LifecycleEligibilityError('Non-opt-out Lost-Nurture requires reactivation work.');
    }
    const shouldDisqualify = parsed.reason === 'not_qualified' || parsed.reason === 'disqualified';
    if (shouldDisqualify && parsed.expectedProspectVersion === null) {
      throw new LifecycleConflictError('Disqualification requires the expected Prospect version.');
    }
    if (enrollment !== null) this.stopEnrollment(enrollment, 'phase_completed', parsed.effectiveAt);
    for (const draft of drafts) {
      this.reactivations.insertRule(toRuleInsert(
        this.ids.next(), cycle.id, draft, parsed.effectiveAt,
      ));
    }
    if (shouldDisqualify) {
      const prospect = this.identities.getCanonicalProspect(cycle.personId);
      if (prospect === null || prospect.id !== cycle.prospectId) throw new LifecycleEligibilityError();
      this.identities.updateProspectQualification({
        prospectId: prospect.id, personId: prospect.personId,
        expectedVersion: parsed.expectedProspectVersion!, expectedState: prospect.qualificationState,
        nextState: 'disqualified', qualificationGateReason: parsed.qualificationGateReason!,
        reason: parsed.reason, updatedAt: parsed.effectiveAt,
      });
    }
    const eventId = this.ids.next();
    const closed = this.cycles.closeProjection({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: cycle.stage,
      expectedWorkflowStatus: cycle.workflowStatus as 'active' | 'onboarding',
      expectedCurrentActionId: action.id, finalStage: 'lost_nurture',
      closedAt: parsed.effectiveAt, closeReason: parsed.reason,
      closeNotes: parsed.notes, onboardingStopReason: null,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: cycle.id, fromStage: cycle.stage,
      toStage: 'lost_nurture', effectiveAt: parsed.effectiveAt,
      confirmedAt: parsed.effectiveAt, confirmationKind: 'founder',
      transitionSequence: this.nextTransitionSequence(cycle.id),
    });
    this.actions.settleAction({
      actionId: action.id, salesCycleId: cycle.id, expectedStatus: 'pending',
      expectedVersion: action.version, ...expectedIntentAndSla(action),
      expectedCadence: action.cadence,
      status: 'cancelled', completedAt: parsed.effectiveAt, completionActivityId: null,
      settlement: {
        version: 1, outcome: 'lost_nurture', reason: parsed.reason,
        evidenceActivityId: null,
        plannerTransition: {
          definitionId: action.cadence.cadenceDefinitionId,
          stepId: action.cadence.cadenceStepId,
          componentId: action.cadence.cadenceComponentId,
          attempt: this.settlementAttempt(action), outcome: 'lost_nurture',
        }, cadence: action.cadence, workIntent: action.workIntent, inboundSla: action.inboundSla,
      },
    });
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return closed;
  }
  reactivateFromRule(input: ReactivateFromRuleInput): ReactivationResult {
    this.unitOfWork.assertWriteScope();
    const parsed = reactivationRuleInputSchema.parse(input) as ReactivateFromRuleInput;
    const permanentBlock = this.permanentReactivationBlock(parsed.personId);
    if (permanentBlock !== null) return permanentBlock;
    const activationKey = `rule:${parsed.ruleId}`;
    const command = { version: 1 as const, command: { ...parsed } };
    const replay = this.readReactivationReplay(activationKey, command);
    if (replay !== null) return replay;
    const existingReview = this.reviews.getByActivationKey(activationKey);
    const definition = this.requirePinnedCadence(
      parsed.cadence,
      existingReview === null ? this.prospectingFamilyForPerson(parsed.personId) : null,
    );
    const rule = this.reactivations.getRule(parsed.ruleId);
    this.assertRuleActivationProof(parsed, rule);
    const blocker = this.reactivationBlocker({
      personId: parsed.personId, prospectId: parsed.prospectId,
      sourceCycleId: parsed.sourceCycleId, entrySourceEventId: parsed.entrySourceEventId,
      activatedAt: parsed.activatedAt,
      rule: rule === null ? null : {
        id: rule.id, salesCycleId: rule.salesCycleId, version: rule.version,
        consumedAt: rule.consumedAt, dueAt: rule.dueAt,
      },
      expectedRuleVersion: parsed.expectedRuleVersion,
    });
    if (blocker === 'invalid_or_not_due_rule') {
      throw new LifecycleEligibilityError('Reactivation rule is missing, stale, consumed, or not due.');
    }
    const review = this.prepareBlockedReactivation({
      activationKey, command, blocker, personId: parsed.personId,
      prospectId: parsed.prospectId, sourceCycleId: parsed.sourceCycleId,
      reactivationRuleId: parsed.ruleId, sourceEventId: null,
      activatedAt: parsed.activatedAt,
    });
    if (review !== null) return review;
    const cycle = this.createReactivatedCycle({
      personId: parsed.personId, prospectId: parsed.prospectId,
      entrySourceEventId: parsed.entrySourceEventId, newCycleId: parsed.newCycleId,
      activatedAt: parsed.activatedAt, kind: 'rule', definition,
    });
    this.reactivations.consumeRule({
      ruleId: parsed.ruleId, salesCycleId: parsed.sourceCycleId,
      expectedVersion: parsed.expectedRuleVersion, consumedAt: parsed.activatedAt,
    });
    this.reactivations.insertOrGetReceipt({
      activationKey, activationKind: 'rule', personId: parsed.personId,
      sourceCycleId: parsed.sourceCycleId, reactivationRuleId: parsed.ruleId,
      sourceEventId: null, newCycleId: parsed.newCycleId, command,
      result: {
        version: 1,
        result: {
          kind: 'reactivated', activationKind: 'rule', cycle, cadence: parsed.cadence,
        },
      },
      createdAt: parsed.activatedAt,
    });
    this.resolveExistingActivationReview(
      activationKey, parsed.activatedAt, cycle.id, 'rule', parsed.cadence,
    );
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return Object.freeze({ kind: 'reactivated', cycle });
  }

  reactivateFromInboundResponse(input: ReactivateFromInboundInput): ReactivationResult {
    this.unitOfWork.assertWriteScope();
    const parsed = reactivationInboundInputSchema.parse(input) as ReactivateFromInboundInput;
    const permanentBlock = this.permanentReactivationBlock(parsed.personId);
    if (permanentBlock !== null) return permanentBlock;
    const activationKey = parsed.evidence.kind === 'source_event'
      ? `inbound:${parsed.evidence.sourceEventId}`
      : `inbound-handle:${parsed.evidence.handleKind}:${parsed.evidence.normalizedValue}`;
    const command = { version: 1 as const, command: { ...parsed } };
    const replay = this.readReactivationReplay(activationKey, command);
    if (replay !== null) return replay;
    const definition = this.requirePinnedCadence(parsed.cadence, 'cadence_c');
    if (parsed.evidence.kind === 'unknown_handle') {
      const matches = this.identities.findContactMatchesByNormalizedHandle(
        parsed.evidence.handleKind, parsed.evidence.normalizedValue,
      );
      if (matches.length > 0) {
        throw new LifecycleEvidenceError('A known handle cannot use unknown-handle Review.');
      }
      const blocker = this.unknownHandleBlocker(parsed);
      return this.prepareBlockedReactivation({
        activationKey, command, blocker, personId: parsed.personId,
        prospectId: parsed.prospectId, sourceCycleId: parsed.sourceCycleId,
        reactivationRuleId: null, sourceEventId: null,
        activatedAt: parsed.activatedAt,
      })!;
    }
    const sourceEventId = parsed.evidence.sourceEventId;
    const source = this.sources.getById(sourceEventId);
    if (source === null || source.channel !== parsed.evidence.channel
      || source.observedAt > parsed.activatedAt) {
      throw new LifecycleEvidenceError('Inbound SourceEvent channel evidence is missing or changed.');
    }
    const blocker = this.reactivationBlocker({
      personId: parsed.personId, prospectId: parsed.prospectId,
      sourceCycleId: parsed.sourceCycleId, entrySourceEventId: sourceEventId,
      activatedAt: parsed.activatedAt, rule: undefined, expectedRuleVersion: undefined,
    });
    if (blocker === 'invalid_or_not_due_rule') {
      throw new LifecycleEvidenceError('Inbound activation cannot use rule-only eligibility.');
    }
    const review = this.prepareBlockedReactivation({
      activationKey, command, blocker, personId: parsed.personId,
      prospectId: parsed.prospectId, sourceCycleId: parsed.sourceCycleId,
      reactivationRuleId: null, sourceEventId,
      activatedAt: parsed.activatedAt,
    });
    if (review !== null) return review;
    const cycle = this.createReactivatedCycle({
      personId: parsed.personId, prospectId: parsed.prospectId,
      entrySourceEventId: sourceEventId, newCycleId: parsed.newCycleId,
      activatedAt: parsed.activatedAt, kind: 'inbound_response', definition,
    });
    this.reactivations.insertOrGetReceipt({
      activationKey, activationKind: 'inbound_response', personId: parsed.personId,
      sourceCycleId: parsed.sourceCycleId, reactivationRuleId: null,
      sourceEventId, newCycleId: parsed.newCycleId, command,
      result: {
        version: 1,
        result: {
          kind: 'reactivated', activationKind: 'inbound_response', cycle,
          cadence: parsed.cadence,
        },
      },
      createdAt: parsed.activatedAt,
    });
    this.resolveExistingActivationReview(
      activationKey, parsed.activatedAt, cycle.id, 'inbound_response', parsed.cadence,
    );
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return Object.freeze({ kind: 'reactivated', cycle });
  }

  promoteUnknownInboundReview(input: PromoteUnknownInboundReviewInput): ReactivationResult {
    this.unitOfWork.assertWriteScope();
    const parsed = promoteUnknownInboundReviewCommandSchema.parse(input);
    const review = this.reviews.getByActivationKey(parsed.activationKey);
    if (review === null || review.id !== parsed.reviewId
      || review.payload.blocker !== 'unknown_inbound_handle'
      || !('evidence' in review.payload.command)
      || review.payload.command.evidence.kind !== 'unknown_handle') {
      throw new StaleDomainWriteError();
    }
    const permanentBlock = this.permanentReactivationBlock(review.personId);
    if (permanentBlock !== null) return permanentBlock;
    const original = review.payload.command;
    if (serializeCanonical(original.cadence) !== serializeCanonical(parsed.cadence)) {
      throw new LifecycleIdempotencyConflictError();
    }
    const source = this.sources.getById(parsed.sourceEventId);
    if (source === null || source.channel !== parsed.channel
      || source.personId !== review.personId
      || (source.prospectId !== null && source.prospectId !== review.prospectId)
      || source.observedAt > parsed.activatedAt) {
      throw new LifecycleEvidenceError('Promoted inbound SourceEvent evidence is missing, future, or unowned.');
    }
    const promotedCommand = {
      evidence: {
        kind: 'source_event' as const,
        sourceEventId: parsed.sourceEventId,
        channel: parsed.channel,
      },
      personId: review.personId,
      prospectId: review.prospectId,
      sourceCycleId: review.sourceCycleId,
      newCycleId: original.newCycleId,
      activatedAt: parsed.activatedAt,
      cadence: parsed.cadence,
    };
    if (review.status === 'resolved') {
      const resolution = review.resolution;
      if (review.version !== parsed.expectedReviewVersion + 1
        || review.resolvedAt !== parsed.activatedAt
        || resolution?.kind !== 'promoted_unknown_inbound'
        || resolution.sourceEventId !== parsed.sourceEventId
        || resolution.newCycleId !== original.newCycleId
        || serializeCanonical(resolution.cadence) !== serializeCanonical(parsed.cadence)) {
        throw new LifecycleIdempotencyConflictError();
      }
      const replay = this.readReactivationReplay(
        `inbound:${parsed.sourceEventId}`, { version: 1, command: promotedCommand },
      );
      if (replay === null) {
        throw new LifecycleEvidenceError('Resolved unknown-handle Review is missing its receipt.');
      }
      return replay;
    }
    if (review.version !== parsed.expectedReviewVersion) throw new StaleDomainWriteError();
    const result = this.reactivateFromInboundResponse(promotedCommand);
    if (result.kind !== 'reactivated') return result;
    this.reviews.resolve({
      id: review.id, activationKey: review.activationKey,
      expectedVersion: parsed.expectedReviewVersion,
      resolution: {
        version: 1, kind: 'promoted_unknown_inbound',
        activationKind: 'inbound_response', sourceEventId: parsed.sourceEventId,
        newCycleId: original.newCycleId, cadence: parsed.cadence,
      },
      resolvedAt: parsed.activatedAt,
    });
    return result;
  }

  applyProspectingTrigger(input: ApplyProspectingTriggerInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: z.string().trim().min(1), expectedCycleVersion: z.number().int().positive(),
      expectedCurrentActionId: z.string().trim().min(1),
      expectedActionVersion: z.number().int().positive(),
      expectedEnrollmentVersion: z.number().int().positive(),
      triggerSourceEventId: z.string().trim().min(1),
      trigger: z.enum(['live_vacancy', 'inbound_demo', 'direct_referral']),
      evaluationAt: utcTimestampSchema,
    }).strict().parse(input) as ApplyProspectingTriggerInput;
    const cycle = this.cycles.getById(parsed.cycleId);
    if (cycle === null || cycle.version !== parsed.expectedCycleVersion
      || cycle.currentNextActionId !== parsed.expectedCurrentActionId
      || cycle.workflowStatus !== 'active'
      || (cycle.stage !== 'ready' && cycle.stage !== 'contacted')) {
      throw new LifecycleConflictError('Prospecting trigger projection is stale or ineligible.');
    }
    const action = this.requireCurrentAction(cycle);
    const enrollment = this.requireActiveEnrollment(cycle);
    if (action.version !== parsed.expectedActionVersion
      || enrollment.version !== parsed.expectedEnrollmentVersion
      || action.cadence.cadenceEnrollmentId !== enrollment.id) {
      throw new LifecycleConflictError('Prospecting trigger cadence evidence is stale.');
    }
    const source = this.sources.getById(parsed.triggerSourceEventId);
    const expectedChannel = parsed.trigger === 'live_vacancy' ? 'frbo'
      : parsed.trigger === 'inbound_demo' ? 'inbound_demo' : 'referral';
    if (source === null || source.personId !== cycle.personId
      || (source.prospectId !== null && source.prospectId !== cycle.prospectId)
      || source.channel !== expectedChannel) {
      throw new LifecycleEvidenceError('Prospecting trigger SourceEvent is not owned or typed correctly.');
    }
    const oldDefinition = this.cadences.getById(enrollment.cadenceDefinitionId);
    const newDefinition = this.requireCadence(
      parsed.trigger === 'live_vacancy' ? 'cadence_a' : 'cadence_c',
    );
    if (oldDefinition === null) throw new LifecycleEvidenceError('Old cadence definition is missing.');
    const completed = this.database.raw.prepare<
      [string], { id: string; channel: string }
    >(`
      SELECT id, channel FROM activities
      WHERE cadence_enrollment_id = ? ORDER BY occurred_at ASC, id ASC
    `).all(enrollment.id);
    const lastChannel = completed.map(({ channel }) => cadenceChannelOrNull(channel))
      .filter((channel) => channel !== null).at(-1) ?? null;
    const plan = planCadenceUpgrade({
      oldEnrollmentId: enrollment.id, oldDefinition, newDefinition,
      trigger: parsed.trigger, anchorAt: source.observedAt,
      lastCompletedChannel: lastChannel,
      completedActivityIds: completed.map(({ id }) => id),
      evaluationAt: parsed.evaluationAt, timezone: this.timezone,
      policies: this.policies, priorCallWindow: parseCallWindow(action.allowedWindow),
      totalProspectingScheduledSteps: this.totalProspectingSteps(cycle.id),
      highestProspectingAttemptCap: this.highestProspectingCap(cycle.id),
    });
    if (plan.kind === 'no_change') return cycle;
    const nextInstruction = plan.startNew.transition.nextAction;
    if (plan.stopOld.enrollmentId !== enrollment.id
      || nextInstruction?.kind !== 'create') {
      throw new LifecycleEvidenceError('Cadence upgrade plan is structurally invalid.');
    }
    this.stopEnrollment(enrollment, 'upgraded', parsed.evaluationAt);
    const newEnrollmentId = this.ids.next();
    const nextActionId = this.ids.next();
    const transition = plan.startNew.transition;
    this.enrollments.insertCadenceEnrollment({
      id: newEnrollmentId, salesCycleId: cycle.id,
      definitionId: plan.startNew.definitionId, anchorAt: plan.startNew.anchorAt,
      currentStepId: transition.enrollment.currentStepId,
      scheduledStepCount: transition.enrollment.scheduledStepCountDelta,
      status: 'active', mode: plan.kind === 'inbound_over_cap_response'
        ? 'inbound_over_cap_response' : 'standard',
      allowedStepIds: plan.startNew.plannedStepIds,
      createdAt: parsed.evaluationAt,
    });
    const draft = nextInstruction.draft;
    const inbound = parsed.trigger === 'inbound_demo' || parsed.trigger === 'direct_referral';
    const intentAndSla = inbound
      ? nextIntentAndSla(
        'inbound_response',
        deriveInboundSla(source, this.timezone, this.policies),
      )
      : nextIntentAndSla('discretionary_prospecting', noneInboundSla());
    this.actions.insertNextAction({
      id: nextActionId, salesCycleId: cycle.id, actionType: draft.actionType,
      channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
      timezone: draft.timezone, allowedWindow: draft.allowedWindow,
      slaDueAt: draft.slaDueAt,
      ...intentAndSla,
      cadence: cadenceBinding(newEnrollmentId, draft), createdAt: parsed.evaluationAt,
    });
    const transitioned = this.cycles.replaceCurrentAction({
      cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: cycle.stage,
      expectedWorkflowStatus: 'active', expectedCurrentActionId: action.id,
      nextActionId, updatedAt: parsed.evaluationAt,
    });
    this.actions.settleAction({
      actionId: action.id, salesCycleId: cycle.id, expectedStatus: 'pending',
      expectedVersion: action.version, ...expectedIntentAndSla(action),
      expectedCadence: action.cadence,
      status: 'cancelled', completedAt: parsed.evaluationAt, completionActivityId: null,
      settlement: {
        version: 1, outcome: 'upgraded', reason: parsed.trigger, evidenceActivityId: null,
        plannerTransition: {
          definitionId: action.cadence.cadenceDefinitionId,
          stepId: action.cadence.cadenceStepId,
          componentId: action.cadence.cadenceComponentId,
          attempt: this.settlementAttempt(action), outcome: 'upgraded',
        }, cadence: action.cadence, workIntent: action.workIntent, inboundSla: action.inboundSla,
      },
    });
    this.cycles.assertCurrentActionPostcondition(cycle.id);
    return transitioned;
  }
  setDesignPartnerFitness(input: SetDesignPartnerFitnessInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: z.string().trim().min(1), expectedCycleVersion: z.number().int().positive(),
      fitness: z.number().int().min(0).max(5), updatedAt: utcTimestampSchema,
    }).strict().parse(input);
    this.requireInterviewedHistory(parsed.cycleId);
    return this.cycles.setDesignPartnerFitness({
      cycleId: parsed.cycleId, expectedVersion: parsed.expectedCycleVersion,
      fitness: parsed.fitness, updatedAt: parsed.updatedAt,
    });
  }

  setCloseReadiness(input: SetCloseReadinessInput): CloseReadiness {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: z.string().trim().min(1), expectedReadinessVersion: z.number().int().nonnegative(),
      readiness: z.object({
        version: z.literal(1),
        demonstratedPain: readinessDimensionInputSchema,
        activeTimeline: readinessDimensionInputSchema,
        decisionAuthority: readinessDimensionInputSchema,
        willingnessToTryOrPay: readinessDimensionInputSchema,
        concreteNextStep: readinessDimensionInputSchema,
      }).strict(),
      assessedAt: utcTimestampSchema,
    }).strict().parse(input) as SetCloseReadinessInput;
    const cycle = this.requireInterviewedHistory(parsed.cycleId);
    const dimensions = [
      parsed.readiness.demonstratedPain, parsed.readiness.activeTimeline,
      parsed.readiness.decisionAuthority, parsed.readiness.willingnessToTryOrPay,
      parsed.readiness.concreteNextStep,
    ];
    for (const dimension of dimensions) {
      for (const activityId of dimension.evidenceActivityIds) {
        this.requireOwnedActivity(cycle, activityId);
      }
    }
    return this.cycles.setCloseReadiness({
      salesCycleId: cycle.id, expectedVersion: parsed.expectedReadinessVersion,
      readiness: parsed.readiness, assessedAt: parsed.assessedAt,
    });
  }

  private readReactivationReplay(
    activationKey: string,
    command: { version: 1; command: Record<string, unknown> },
  ): ReactivationResult | null {
    const receipt = this.reactivations.getReceipt(activationKey);
    if (receipt === null) return null;
    if (serializeCanonical(receipt.command) !== serializeCanonical(command)) {
      throw new LifecycleIdempotencyConflictError();
    }
    const result = reactivationReceiptResultSchema.parse(receipt.result);
    const cycle = result.result.cycle as SalesCycle;
    if (cycle.id !== receipt.newCycleId) {
      throw new LifecycleEvidenceError('Reactivation receipt result is missing its cycle.');
    }
    return Object.freeze({ kind: 'reactivated', cycle });
  }

  private assertRuleActivationProof(
    input: ReactivateFromRuleInput,
    rule: ReactivationRule | null,
  ): void {
    if (rule === null || rule.ruleType !== input.ruleType) {
      throw new LifecycleEligibilityError('Reactivation rule type does not match the command.');
    }
    if (input.trigger.kind === 'due') {
      if (rule.matcher !== null || rule.dueAt !== input.trigger.dueAt
        || input.activatedAt < input.trigger.dueAt) {
        throw new LifecycleEligibilityError('Due-rule activation proof is missing or stale.');
      }
      return;
    }
    const expectedChannel = input.ruleType === 'new-frbo-listing' ? 'frbo' : 'registry';
    const expectedMatcher = {
      version: 1 as const, eventType: input.trigger.eventType, personWide: true as const,
    };
    const source = this.sources.getById(input.trigger.sourceEventId);
    if (rule.dueAt !== null
      || serializeCanonical(rule.matcher) !== serializeCanonical(expectedMatcher)
      || input.trigger.sourceEventId !== input.entrySourceEventId
      || source === null || source.personId !== input.personId
      || (source.prospectId !== null && source.prospectId !== input.prospectId)
      || source.channel !== expectedChannel || source.observedAt > input.activatedAt
      || source.observedAt < rule.createdAt
      || !isNamedReactivationSource(source.sourceRecord, input.trigger.eventType)) {
      throw new LifecycleEligibilityError('Event-rule activation requires matching owned trigger proof.');
    }
  }

  private reactivationBlocker(input: {
    personId: string;
    prospectId: string;
    sourceCycleId: string;
    entrySourceEventId: string;
    activatedAt: string;
    rule: {
      id: string;
      salesCycleId: string;
      version: number;
      consumedAt: string | null;
      dueAt: string | null;
    } | null | undefined;
    expectedRuleVersion: number | undefined;
  }): z.infer<typeof reactivationReviewBlockerSchema> | 'invalid_or_not_due_rule' | null {
    const person = this.identities.getPerson(input.personId);
    const prospect = this.identities.getCanonicalProspect(input.personId);
    const sourceCycle = this.cycles.getById(input.sourceCycleId);
    const source = this.sources.getById(input.entrySourceEventId);
    if (input.rule === null
      || (input.rule !== undefined && (
        input.rule.salesCycleId !== input.sourceCycleId
        || input.rule.version !== input.expectedRuleVersion
        || input.rule.consumedAt !== null
        || (input.rule.dueAt !== null && input.rule.dueAt > input.activatedAt)
      ))) return 'invalid_or_not_due_rule';
    if (
      sourceCycle === null || sourceCycle.personId !== input.personId
      || sourceCycle.prospectId !== input.prospectId || sourceCycle.workflowStatus !== 'closed'
      || source === null || source.personId !== input.personId
      || (source.prospectId !== null && source.prospectId !== input.prospectId)
    ) return 'invalid_source_ownership';
    if (person === null || person.deletedAt !== null || person.optedOut) return 'person_unavailable';
    if (prospect === null || prospect.id !== input.prospectId
      || prospect.qualificationState !== 'eligible') return 'prospect_ineligible';
    if (this.cycles.getOperationalCycleForPerson(input.personId) !== null) return 'operational_cycle_exists';
    return null;
  }

  private permanentReactivationBlock(personId: string): Extract<
    ReactivationResult, { kind: 'permanently_blocked' }
  > | null {
    const row = this.database.raw.prepare<
      [string], { id: string }
    >(`
      SELECT id FROM opt_out_tombstones WHERE person_id = ?
    `).get(personId);
    return row === undefined
      ? null
      : Object.freeze({ kind: 'permanently_blocked', tombstoneId: row.id });
  }

  private prepareBlockedReactivation(input: {
    activationKey: string;
    command: ReactivationCommandEnvelope;
    blocker: z.infer<typeof reactivationReviewBlockerSchema> | null;
    personId: string;
    prospectId: string;
    sourceCycleId: string;
    reactivationRuleId: string | null;
    sourceEventId: string | null;
    activatedAt: string;
  }): ReactivationResult | null {
    const existing = this.reviews.getByActivationKey(input.activationKey);
    if (existing !== null) {
      const storedCommand = typeof existing.payload === 'object' && existing.payload !== null
        ? (existing.payload as { command?: unknown }).command
        : undefined;
      if (serializeCanonical(storedCommand) !== serializeCanonical(input.command.command)) {
        throw new LifecycleIdempotencyConflictError();
      }
    }
    if (input.blocker === null) return null;
    if (existing !== null) {
      if (existing.status !== 'open') {
        throw new LifecycleIdempotencyConflictError();
      }
      return Object.freeze({ kind: 'review_required', reviewItem: existing });
    }
    const payload = {
      version: 1 as const, kind: 'reactivation_blocked' as const,
      blocker: input.blocker, command: input.command.command,
    };
    const reviewItem = this.reviews.insertOrGetOpen({
      id: this.ids.next(), activationKey: input.activationKey,
      personId: input.personId, prospectId: input.prospectId,
      sourceCycleId: input.sourceCycleId,
      reactivationRuleId: input.reactivationRuleId, sourceEventId: input.sourceEventId,
      reason: input.blocker, payload, createdAt: input.activatedAt,
    });
    return Object.freeze({ kind: 'review_required', reviewItem });
  }

  private resolveExistingActivationReview(
    activationKey: string,
    resolvedAt: string,
    newCycleId: string,
    activationKind: 'rule' | 'inbound_response',
    cadence: ReactivationCadenceIdentity,
  ): void {
    const review = this.reviews.getByActivationKey(activationKey);
    if (review?.status === 'open') {
      this.reviews.resolve({
        id: review.id, activationKey, expectedVersion: review.version,
        resolution: {
          version: 1, kind: 'reactivated', activationKind, newCycleId, cadence,
        },
        resolvedAt,
      });
    }
  }

  private createReactivatedCycle(input: {
    personId: string;
    prospectId: string;
    entrySourceEventId: string;
    newCycleId: string;
    activatedAt: string;
    kind: 'rule' | 'inbound_response';
    definition: NonNullable<ReturnType<CadenceRepository['getById']>>;
  }): SalesCycle {
    const prospect = this.identities.getCanonicalProspect(input.personId);
    if (prospect === null || prospect.id !== input.prospectId) throw new LifecycleEligibilityError();
    const definition = input.definition;
    const recipe = planCadenceStart({
      definition, anchorAt: input.activatedAt, evaluationAt: input.activatedAt,
      timezone: this.timezone, policies: this.policies, priorCallWindow: null,
      totalProspectingScheduledSteps: 0,
      highestProspectingAttemptCap: definition.attemptCap,
      mode: 'standard', allowedStepIds: null,
    });
    if (recipe.nextAction?.kind !== 'create') {
      throw new LifecycleConflictError('Reactivation cadence start is invalid.');
    }
    const enrollmentId = this.ids.next();
    const actionId = this.ids.next();
    const eventId = this.ids.next();
    const stage = input.kind === 'inbound_response' ? 'contacted' : 'ready';
    this.cycles.insertCycleWithDeferredAction({
      id: input.newCycleId, personId: input.personId, prospectId: input.prospectId,
      entrySourceEventId: input.entrySourceEventId, stage, workflowStatus: 'active',
      currentNextActionId: actionId, stageEnteredAt: input.activatedAt,
      createdAt: input.activatedAt,
    });
    this.enrollments.insertCadenceEnrollment({
      id: enrollmentId, salesCycleId: input.newCycleId, definitionId: definition.id,
      anchorAt: input.activatedAt, currentStepId: recipe.enrollment.currentStepId,
      scheduledStepCount: recipe.enrollment.scheduledStepCountDelta,
      status: 'active', mode: 'standard', allowedStepIds: null, createdAt: input.activatedAt,
    });
    const draft = recipe.nextAction.draft;
    const source = this.sources.getById(input.entrySourceEventId);
    const inboundSla = input.kind === 'inbound_response' && source !== null
      ? deriveInboundSla(source, this.timezone, this.policies)
      : noneInboundSla();
    const intentAndSla = input.kind === 'inbound_response'
      ? nextIntentAndSla('inbound_response', inboundSla)
      : nextIntentAndSla('discretionary_prospecting', inboundSla);
    this.actions.insertNextAction({
      id: actionId, salesCycleId: input.newCycleId, actionType: draft.actionType,
      channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
      timezone: draft.timezone, allowedWindow: draft.allowedWindow,
      slaDueAt: draft.slaDueAt,
      ...intentAndSla, cadence: cadenceBinding(enrollmentId, draft), createdAt: input.activatedAt,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: input.newCycleId, fromStage: null, toStage: stage,
      effectiveAt: input.activatedAt, confirmedAt: input.activatedAt,
      confirmationKind: 'mechanical', transitionSequence: 1,
    });
    return this.cycles.getById(input.newCycleId)!;
  }

  private requirePinnedCadence(
    identity: ReactivationCadenceIdentity,
    expectedFamily: 'cadence_a' | 'cadence_b' | 'cadence_c' | null,
  ): NonNullable<ReturnType<CadenceRepository['getById']>> {
    const definition = this.cadences.getById(identity.definitionId);
    if (definition === null
      || definition.family !== identity.family
      || definition.version !== identity.version
      || definition.contentHash !== identity.contentHash
      || (expectedFamily !== null && definition.family !== expectedFamily)
      || definition.category !== 'prospecting') {
      throw new LifecycleEvidenceError('Pinned reactivation cadence identity is not installed or eligible.');
    }
    return definition;
  }

  private prospectingFamilyForPerson(
    personId: string,
  ): 'cadence_a' | 'cadence_b' | 'cadence_c' {
    const prospect = this.identities.getCanonicalProspect(personId);
    if (prospect === null) throw new LifecycleEligibilityError();
    return prospect.segment === 'warm' ? 'cadence_c'
      : prospect.segment === 'hot' ? 'cadence_a' : 'cadence_b';
  }

  private unknownHandleBlocker(
    input: ReactivateFromInboundInput,
  ): z.infer<typeof reactivationReviewBlockerSchema> {
    const person = this.identities.getPerson(input.personId);
    const prospect = this.identities.getCanonicalProspect(input.personId);
    const sourceCycle = this.cycles.getById(input.sourceCycleId);
    if (sourceCycle === null || sourceCycle.personId !== input.personId
      || sourceCycle.prospectId !== input.prospectId || sourceCycle.workflowStatus !== 'closed'
      || person === null || person.deletedAt !== null || person.optedOut
      || prospect === null || prospect.id !== input.prospectId) {
      throw new LifecycleEvidenceError('Unknown inbound handle Review ownership is invalid.');
    }
    return 'unknown_inbound_handle';
  }

  private swapStageCadence(input: {
    cycle: SalesCycle;
    targetStage: 'interviewed' | 'offered';
    family: 'post_interview' | 'post_offer';
    effectiveAt: string;
    confirmedAt: string;
    evidenceActivityId: string;
    transitionSequence: number;
    fromStage: 'contacted' | 'interviewed';
  }): SalesCycle {
    const currentAction = this.requireCurrentAction(input.cycle);
    const currentEnrollment = this.requireActiveEnrollment(input.cycle);
    this.stopEnrollment(currentEnrollment, 'upgraded', input.effectiveAt);
    const definition = this.requireCadence(input.family);
    const recipe = planCadenceStart({
      definition, anchorAt: input.effectiveAt, evaluationAt: input.effectiveAt,
      timezone: this.timezone, policies: this.policies, priorCallWindow: null,
      totalProspectingScheduledSteps: this.totalProspectingSteps(input.cycle.id),
      highestProspectingAttemptCap: this.highestProspectingCap(input.cycle.id),
      mode: 'standard', allowedStepIds: null,
    });
    if (recipe.nextAction?.kind !== 'create') {
      throw new LifecycleConflictError('Post-stage cadence start is invalid.');
    }
    const enrollmentId = this.ids.next();
    const actionId = this.ids.next();
    const eventId = this.ids.next();
    this.enrollments.insertCadenceEnrollment({
      id: enrollmentId, salesCycleId: input.cycle.id, definitionId: definition.id,
      anchorAt: input.effectiveAt, currentStepId: recipe.enrollment.currentStepId,
      scheduledStepCount: recipe.enrollment.scheduledStepCountDelta,
      status: 'active', mode: 'standard', allowedStepIds: null,
      createdAt: input.effectiveAt,
    });
    const draft = recipe.nextAction.draft;
    const cadence = cadenceBinding(enrollmentId, draft);
    this.actions.insertNextAction({
      id: actionId, salesCycleId: input.cycle.id, actionType: draft.actionType,
      channel: draft.channel, status: 'pending', dueAt: draft.dueAt,
      timezone: draft.timezone, allowedWindow: draft.allowedWindow,
      slaDueAt: draft.slaDueAt, workIntent: 'promised_follow_up',
      inboundSla: noneInboundSla(), cadence, createdAt: input.effectiveAt,
    });
    const transitioned = this.cycles.transitionOpenProjection({
      cycleId: input.cycle.id, expectedVersion: input.cycle.version,
      expectedStage: input.cycle.stage, expectedWorkflowStatus: 'active',
      expectedCurrentActionId: currentAction.id, nextStage: input.targetStage,
      nextWorkflowStatus: 'active', nextActionId: actionId,
      stageEnteredAt: input.effectiveAt,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: input.cycle.id, fromStage: input.fromStage,
      toStage: input.targetStage, effectiveAt: input.effectiveAt,
      confirmedAt: input.confirmedAt, confirmationKind: 'founder',
      transitionSequence: input.transitionSequence,
    });
    this.settleReplacedAction(
      currentAction, `${input.targetStage}_confirmed`, input.evidenceActivityId,
      input.effectiveAt,
    );
    this.cycles.assertCurrentActionPostcondition(input.cycle.id);
    return transitioned;
  }

  private stopEnrollment(
    enrollment: CadenceEnrollment,
    reason: 'upgraded' | 'phase_completed',
    updatedAt: string,
    kind: 'stop' | 'complete' = 'stop',
  ): CadenceEnrollment {
    return this.enrollments.applyCadenceEnrollmentMutation({
      enrollmentId: enrollment.id, salesCycleId: enrollment.salesCycleId,
      expectedVersion: enrollment.version,
      expectedDefinitionId: enrollment.cadenceDefinitionId,
      expectedCurrentStepId: enrollment.currentStepId!,
      expectedScheduledStepCount: enrollment.scheduledStepCount,
      expectedStatus: 'active', expectedMode: enrollment.mode,
      expectedAllowedStepIds: enrollment.allowedStepIds,
      mutation: {
        kind, definitionId: enrollment.cadenceDefinitionId,
        currentStepId: enrollment.currentStepId!, scheduledStepCountDelta: 0,
        status: kind === 'complete' ? 'completed' : 'stopped', stopReason: reason,
      }, updatedAt,
    });
  }

  private settleReplacedAction(
    action: NextAction,
    outcome: ActionSettlementOutcome,
    evidenceActivityId: string | null,
    completedAt: string,
    reason: string | null = null,
  ): NextAction {
    return this.actions.settleAction({
      actionId: action.id, salesCycleId: action.salesCycleId,
      expectedStatus: 'pending', expectedVersion: action.version,
      ...expectedIntentAndSla(action),
      expectedCadence: action.cadence, status: 'completed', completedAt,
      completionActivityId: evidenceActivityId,
      settlement: {
        version: 1, outcome, reason, evidenceActivityId,
        plannerTransition: {
          definitionId: action.cadence.cadenceDefinitionId,
          stepId: action.cadence.cadenceStepId,
          componentId: action.cadence.cadenceComponentId,
          attempt: this.settlementAttempt(action), outcome,
        }, cadence: action.cadence, workIntent: action.workIntent,
        inboundSla: action.inboundSla,
      },
    });
  }

  private settlementAttempt(action: NextAction): number | null {
    if (action.cadence.cadenceEnrollmentId === null) return null;
    const enrollment = this.enrollments.getById(action.cadence.cadenceEnrollmentId);
    const definition = enrollment === null
      ? null : this.cadences.getById(enrollment.cadenceDefinitionId);
    if (enrollment === null || definition === null
      || action.cadence.cadenceDefinitionId !== enrollment.cadenceDefinitionId) {
      throw new LifecycleEvidenceError('Settlement cadence enrollment evidence is missing.');
    }
    const effectiveStepIds = enrollment.allowedStepIds
      ?? definition.steps.map(({ id }) => id);
    const attempt = effectiveStepIds.indexOf(action.cadence.cadenceStepId) + 1;
    if (attempt <= 0 || attempt > enrollment.scheduledStepCount) {
      throw new LifecycleEvidenceError('Settlement cadence attempt evidence is inconsistent.');
    }
    return attempt;
  }

  private cancelPendingOutboundForPerson(
    personId: string,
    evidence: Activity,
    completedAt: string,
  ): readonly string[] {
    const cancelledActionIds = this.actions.listPendingOutboundForPerson(personId)
      .map((action) => {
        this.actions.settleAction({
          actionId: action.id, salesCycleId: action.salesCycleId,
          expectedStatus: 'pending', expectedVersion: action.version,
          ...expectedIntentAndSla(action), expectedCadence: action.cadence,
          status: 'cancelled', completedAt,
          completionActivityId: evidence.salesCycleId === action.salesCycleId ? evidence.id : null,
          settlement: {
            version: 1, outcome: 'opted_out', reason: 'person_wide_opt_out',
            evidenceActivityId: evidence.id,
            plannerTransition: {
              definitionId: action.cadence.cadenceDefinitionId,
              stepId: action.cadence.cadenceStepId,
              componentId: action.cadence.cadenceComponentId,
              attempt: this.settlementAttempt(action),
              outcome: 'opted_out',
            },
            cadence: action.cadence, workIntent: action.workIntent,
            inboundSla: action.inboundSla,
          },
        });
        return action.id;
      });
    return Object.freeze(cancelledActionIds);
  }

  private validateOutcomeEvidence(
    cycle: SalesCycle,
    action: NextAction,
    recipe: TransitionRecipe,
    activityId: string | null,
  ): Activity | null {
    const requiresActivity = recipe.currentAction.kind !== 'none'
      && recipe.currentAction.kind !== 'remain_pending'
      ? recipe.currentAction.activityRequired
      : recipe.currentAction.kind === 'remain_pending';
    if (!requiresActivity) {
      if (activityId !== null) {
        throw new LifecycleEvidenceError('This cadence outcome does not accept Activity evidence.');
      }
      return null;
    }
    if (activityId === null) throw new LifecycleEvidenceError('Cadence outcome requires Activity evidence.');
    if (recipe.currentAction.kind === 'none') {
      throw new LifecycleConflictError('A cadence outcome cannot omit its action mutation.');
    }
    const activity = this.requireOwnedActivity(cycle, activityId);
    if (
      activity.cadenceEnrollmentId !== action.cadence.cadenceEnrollmentId
      || activity.cadenceStepId !== action.cadence.cadenceStepId
      || activity.cadenceComponentId !== action.cadence.cadenceComponentId
      || (action.channel !== null && activity.channel !== action.channel)
      || activity.observedOutcome !== recipe.currentAction.outcome
    ) throw new LifecycleEvidenceError('Activity does not match the current cadence action and outcome.');
    return activity;
  }

  private settlePlannerAction(
    action: NextAction,
    recipe: TransitionRecipe,
    activity: Activity | null,
    completedAt: string,
  ): NextAction {
    if (recipe.currentAction.kind === 'none' || recipe.currentAction.kind === 'remain_pending') {
      throw new LifecycleConflictError('The planner did not settle the current action.');
    }
    const settlementOutcome = actionSettlementOutcomeSchema.parse(recipe.currentAction.outcome);
    const status = recipe.currentAction.kind === 'impossible' ? 'impossible' : 'completed';
    const reason = recipe.currentAction.kind === 'impossible'
      ? { code: recipe.currentAction.reason, notes: recipe.currentAction.notes }
      : null;
    return this.actions.settleAction({
      actionId: action.id, salesCycleId: action.salesCycleId,
      expectedStatus: 'pending', expectedVersion: action.version,
      ...expectedIntentAndSla(action),
      expectedCadence: action.cadence, status, completedAt,
      completionActivityId: activity?.id ?? null,
      settlement: {
        version: 1, outcome: settlementOutcome, reason,
        evidenceActivityId: activity?.id ?? null,
        plannerTransition: {
          definitionId: action.cadence.cadenceDefinitionId,
          stepId: action.cadence.cadenceStepId,
          componentId: action.cadence.cadenceComponentId,
          attempt: this.settlementAttempt(action),
          outcome: settlementOutcome,
        }, cadence: action.cadence, workIntent: action.workIntent,
        inboundSla: action.inboundSla,
      },
    });
  }

  private assertOutcomePostcondition(cycleId: string, enrollment: CadenceEnrollment): void {
    const stored = this.enrollments.getById(enrollment.id);
    if (stored === null
      || stored.currentStepId !== enrollment.currentStepId
      || stored.scheduledStepCount !== enrollment.scheduledStepCount
      || stored.status !== enrollment.status) {
      throw new LifecycleConflictError('Cadence enrollment postcondition failed.');
    }
    this.cycles.assertCurrentActionPostcondition(cycleId);
  }

  private applyCadenceTerminal(input: {
    cycle: SalesCycle;
    action: NextAction;
    enrollment: CadenceEnrollment;
    definitionFamily: CadenceFamily;
    recipe: TransitionRecipe;
    activity: Activity | null;
    evaluationAt: string;
    manualReactivationDueAt: string | null;
  }): SalesCycle {
    const terminal = input.recipe.terminal;
    if (terminal === null) throw new LifecycleConflictError('Cadence terminal is missing.');
    if (terminal.kind === 'stop') {
      if (terminal.reason === 'opted_out') {
        throw new LifecycleEligibilityError('Opt-out must use Task 10 scoped tombstone closure.');
      }
      if (terminal.reason === 'replied') {
        return this.replaceWithNonCadenceAction({
          ...input, actionType: 'book_conversation', workIntent: 'inbound_response',
          outcome: 'replied', reason: null,
        });
      }
      throw new LifecycleConflictError('Cadence upgrades use the explicit upgrade command.');
    }
    if (terminal.kind === 'exhausted') return this.closeExhaustedCadence(input);
    if (terminal.reason === 'phase_completed' && input.definitionFamily === 'post_interview') {
      return this.replaceWithNonCadenceAction({
        ...input, actionType: 'confirm_offer', workIntent: 'internal_review',
        outcome: 'phase_completed', reason: null,
      });
    }
    if (terminal.reason === 'phase_completed' && input.definitionFamily === 'onboarding') {
      const closed = this.cycles.closeProjection({
        cycleId: input.cycle.id, expectedVersion: input.cycle.version,
        expectedStage: 'won', expectedWorkflowStatus: 'onboarding',
        expectedCurrentActionId: input.action.id, finalStage: 'won',
        closedAt: input.evaluationAt, closeReason: null, closeNotes: null,
        onboardingStopReason: null,
      });
      this.settlePlannerAction(input.action, input.recipe, input.activity, input.evaluationAt);
      this.assertOutcomePostcondition(input.cycle.id, input.enrollment);
      return closed;
    }
    if (terminal.reason === 'inbound_response_handled') {
      return this.replaceWithNonCadenceAction({
        ...input, actionType: 'book_promised_follow_up', workIntent: 'promised_follow_up',
        outcome: terminal.reason, reason: null,
      });
    }
    if (terminal.reason === 'inbound_response_impossible') {
      return this.replaceWithNonCadenceAction({
        ...input, actionType: 'review_inbound_response', workIntent: 'internal_review',
        outcome: terminal.reason, reason: 'contact method impossible',
      });
    }
    throw new LifecycleConflictError('Cadence terminal is not valid for this lifecycle phase.');
  }

  private replaceWithNonCadenceAction(input: {
    cycle: SalesCycle;
    action: NextAction;
    enrollment: CadenceEnrollment;
    recipe: TransitionRecipe;
    activity: Activity | null;
    evaluationAt: string;
    actionType: string;
    workIntent: 'internal_review' | 'inbound_response' | 'promised_follow_up';
    outcome: string;
    reason: string | null;
  }): SalesCycle {
    const nextActionId = this.ids.next();
    this.actions.insertNextAction({
      id: nextActionId, salesCycleId: input.cycle.id, actionType: input.actionType,
      channel: null, status: 'pending', dueAt: input.evaluationAt,
      timezone: this.timezone, allowedWindow: null, slaDueAt: null,
      workIntent: input.workIntent, inboundSla: noneInboundSla(),
      cadence: NO_CADENCE, createdAt: input.evaluationAt,
    });
    const transitioned = this.cycles.replaceCurrentAction({
      cycleId: input.cycle.id, expectedVersion: input.cycle.version,
      expectedStage: input.cycle.stage,
      expectedWorkflowStatus: input.cycle.workflowStatus as 'active' | 'onboarding',
      expectedCurrentActionId: input.action.id, nextActionId,
      updatedAt: input.evaluationAt,
    });
    this.settlePlannerAction(input.action, input.recipe, input.activity, input.evaluationAt);
    this.assertOutcomePostcondition(input.cycle.id, input.enrollment);
    return transitioned;
  }

  private closeExhaustedCadence(input: {
    cycle: SalesCycle;
    action: NextAction;
    enrollment: CadenceEnrollment;
    definitionFamily: CadenceFamily;
    recipe: TransitionRecipe;
    activity: Activity | null;
    evaluationAt: string;
    manualReactivationDueAt: string | null;
  }): SalesCycle {
    const manualDrafts = input.manualReactivationDueAt === null
      ? []
      : planManualReactivation(
        input.cycle.id, input.evaluationAt, this.timezone,
        input.manualReactivationDueAt,
      );
    const drafts = [...new Map(
      [...input.recipe.reactivationDrafts, ...manualDrafts]
        .map((draft) => [draft.logicalDedupeKey, draft]),
    ).values()];
    if (drafts.length === 0) {
      throw new LifecycleEligibilityError('Cadence exhaustion requires at least one reactivation rule.');
    }
    for (const draft of drafts) {
      this.reactivations.insertRule(toRuleInsert(
        this.ids.next(), input.cycle.id, draft, input.evaluationAt,
      ));
    }
    const eventId = this.ids.next();
    const closed = this.cycles.closeProjection({
      cycleId: input.cycle.id, expectedVersion: input.cycle.version,
      expectedStage: input.cycle.stage,
      expectedWorkflowStatus: input.cycle.workflowStatus as 'active' | 'onboarding',
      expectedCurrentActionId: input.action.id, finalStage: 'lost_nurture',
      closedAt: input.evaluationAt, closeReason: 'cadence_exhausted', closeNotes: null,
      onboardingStopReason: null,
    });
    this.events.appendStageEvent({
      id: eventId, salesCycleId: input.cycle.id, fromStage: input.cycle.stage,
      toStage: 'lost_nurture', effectiveAt: input.evaluationAt,
      confirmedAt: input.evaluationAt, confirmationKind: 'mechanical',
      transitionSequence: this.nextTransitionSequence(input.cycle.id),
    });
    this.settlePlannerAction(input.action, input.recipe, input.activity, input.evaluationAt);
    this.assertOutcomePostcondition(input.cycle.id, input.enrollment);
    return closed;
  }

  private requireCurrentAction(cycle: SalesCycle): NextAction {
    const action = cycle.currentNextActionId === null
      ? null
      : this.actions.getById(cycle.currentNextActionId);
    if (action === null || action.status !== 'pending' || action.salesCycleId !== cycle.id) {
      throw new LifecycleConflictError('Current pending action is missing.');
    }
    return action;
  }

  private requireActiveEnrollment(cycle: SalesCycle): CadenceEnrollment {
    const enrollment = this.enrollments.getActiveForCycle(cycle.id);
    if (enrollment === null) throw new LifecycleConflictError('Required active cadence is missing.');
    return enrollment;
  }

  private requireOwnedActivity(cycle: SalesCycle, activityId: string): Activity {
    const activity = this.events.getActivity(activityId);
    if (
      activity === null || activity.personId !== cycle.personId
      || activity.prospectId !== cycle.prospectId || activity.salesCycleId !== cycle.id
    ) throw new LifecycleEvidenceError('Activity evidence does not belong to the SalesCycle.');
    return activity;
  }

  private requireCadence(family: CadenceFamily) {
    const definition = this.cadences.getByFamilyVersion(family, 1);
    if (definition === null) throw new LifecycleConflictError('Required cadence is not installed.');
    return definition;
  }

  private nextTransitionSequence(cycleId: string): number {
    return this.events.listCycleStageEvents(cycleId).length + 1;
  }

  private totalProspectingSteps(cycleId: string): number {
    return this.enrollments.listForCycle(cycleId).reduce((total, enrollment) => {
      const definition = this.cadences.getById(enrollment.cadenceDefinitionId);
      return total + (definition?.category === 'prospecting' ? enrollment.scheduledStepCount : 0);
    }, 0);
  }

  private highestProspectingCap(cycleId: string): number {
    return this.enrollments.listForCycle(cycleId).reduce((highest, enrollment) => {
      const definition = this.cadences.getById(enrollment.cadenceDefinitionId);
      return definition?.category === 'prospecting'
        ? Math.max(highest, definition.attemptCap)
        : highest;
    }, 0);
  }

  private requireExpectedOpenCycle(
    id: string,
    version: number,
    stage: SalesCycle['stage'],
    currentActionId: string,
  ): SalesCycle {
    const cycle = this.cycles.getById(id);
    if (
      cycle === null || cycle.version !== version || cycle.stage !== stage
      || cycle.workflowStatus !== 'active' || cycle.currentNextActionId !== currentActionId
    ) throw new LifecycleConflictError('Expected lifecycle projection is stale.');
    return cycle;
  }

  private requireInterviewedHistory(cycleId: string): SalesCycle {
    const cycle = this.cycles.getById(cycleId);
    if (cycle === null
      || !this.events.listCycleStageEvents(cycle.id).some(({ toStage }) => toStage === 'interviewed')) {
      throw new LifecycleEligibilityError('Interviewed history is required.');
    }
    return cycle;
  }

  private assertTransitionEvidenceTimes(
    cycle: SalesCycle,
    effectiveAt: string,
    confirmedAt: string,
    activity: Activity | null,
  ): void {
    if (effectiveAt > confirmedAt || (activity !== null && activity.occurredAt > confirmedAt)) {
      throw new LifecycleEvidenceError('Transition evidence cannot occur after confirmation.');
    }
    const previous = this.events.listCycleStageEvents(cycle.id).at(-1);
    if (previous !== undefined && effectiveAt < previous.effectiveAt) {
      throw new LifecycleEvidenceError('Ordinary lifecycle effective times cannot move backward.');
    }
  }

}

function cadenceBinding(
  enrollmentId: string,
  draft: {
    cadenceDefinitionId: string;
    cadenceStepId: string;
    cadenceComponentId: string;
  },
): CadenceActionBinding {
  return {
    cadenceEnrollmentId: enrollmentId,
    cadenceDefinitionId: draft.cadenceDefinitionId,
    cadenceStepId: draft.cadenceStepId,
    cadenceComponentId: draft.cadenceComponentId,
  };
}

function noneInboundSla(): Extract<InboundSla, { kind: 'none' }> {
  return { kind: 'none', dueAt: null, sourceEventId: null, provenance: null };
}

function nextIntentAndSla(
  workIntent: NextAction['workIntent'],
  inboundSla: InboundSla,
): NextActionIntentAndSla {
  if (workIntent === 'inbound_response') return { workIntent, inboundSla };
  if (inboundSla.kind !== 'none') {
    throw new LifecycleEvidenceError('Non-inbound work cannot retain inbound SLA evidence.');
  }
  return { workIntent, inboundSla };
}

function expectedIntentAndSla(
  action: Pick<NextAction, 'workIntent' | 'inboundSla'>,
): ExpectedActionIntentAndSla {
  const evidence = nextIntentAndSla(action.workIntent, action.inboundSla);
  return evidence.workIntent === 'inbound_response'
    ? { expectedWorkIntent: evidence.workIntent, expectedInboundSla: evidence.inboundSla }
    : { expectedWorkIntent: evidence.workIntent, expectedInboundSla: evidence.inboundSla };
}

function parseCallWindow(value: string | null): 'morning' | 'afternoon' | 'evening' | null {
  return value === 'morning' || value === 'afternoon' || value === 'evening' ? value : null;
}

function cadenceChannelOrNull(
  value: string,
): 'phone' | 'voicemail' | 'text' | 'email' | null {
  return value === 'phone' || value === 'voicemail' || value === 'text' || value === 'email'
    ? value : null;
}

function isNamedReactivationSource(
  value: Record<string, unknown>,
  eventType: 'new-frbo-listing' | 'lead-cert-expiry-window',
): boolean {
  const evidence = value.reactivationTrigger;
  return typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
    && Object.keys(evidence).sort().join('|') === 'eventType|version'
    && (evidence as Record<string, unknown>).version === 1
    && (evidence as Record<string, unknown>).eventType === eventType;
}

function planManualReactivation(
  salesCycleId: string,
  evaluationAt: string,
  timezone: string,
  manualDueAt: string | null,
) {
  return planReactivationDefaults({
    salesCycleId, family: 'cadence_c', evaluationAt, timezone, manualDueAt,
  });
}

function toRuleInsert(
  id: string,
  salesCycleId: string,
  draft: ReactivationRuleDraft,
  createdAt: string,
): InsertReactivationRuleInput {
  const common = { id, salesCycleId, version: draft.ruleVersion, createdAt };
  if (draft.ruleType === 'seasonal:heating-oct1' || draft.ruleType === 'manual') {
    if (draft.dueAt === null || draft.matcher !== null) {
      throw new LifecycleEvidenceError('Due reactivation draft is malformed.');
    }
    return { ...common, ruleType: draft.ruleType, dueAt: draft.dueAt, matcher: null };
  }
  if (draft.dueAt !== null || draft.matcher === null
    || draft.matcher.eventType !== draft.ruleType) {
    throw new LifecycleEvidenceError('Event reactivation draft is malformed.');
  }
  if (draft.ruleType === 'new-frbo-listing') {
    return {
      ...common, ruleType: draft.ruleType, dueAt: null,
      matcher: { version: 1, eventType: draft.ruleType, personWide: true },
    };
  }
  return {
    ...common, ruleType: draft.ruleType, dueAt: null,
    matcher: { version: 1, eventType: draft.ruleType, personWide: true },
  };
}

function parseConfirmWonInput(input: ConfirmWonInput): ConfirmWonInput {
  const common = {
    cycleId: z.string().trim().min(1),
    expectedCycleVersion: z.number().int().safe().positive(),
    expectedCurrentActionId: z.string().trim().min(1),
    effectiveAt: utcTimestampSchema,
    confirmedAt: utcTimestampSchema,
  };
  const termsCommon = {
    doorsCommitted: z.number().int().safe().nonnegative(),
    unitRateCents: z.number().int().safe().nonnegative(),
    foundingCustomer: z.boolean(),
    effectiveAt: utcTimestampSchema,
  };
  const parsed = z.object({
    ...common,
    terms: z.discriminatedUnion('billingModel', [
      z.object({ billingModel: z.literal('per_door_monthly'), ...termsCommon }).strict(),
      z.object({ billingModel: z.literal('flat_monthly'), ...termsCommon }).strict(),
      z.object({
        billingModel: z.literal('manual_projected_monthly'), ...termsCommon,
        projectedMrrCents: z.number().int().safe().nonnegative(),
        manualProjectionReason: z.string().trim().min(1),
      }).strict(),
    ]),
  }).strict().parse(input) as ConfirmWonInput;
  if (parsed.effectiveAt > parsed.confirmedAt) {
    throw new LifecycleEvidenceError('Effective time cannot follow confirmation.');
  }
  return parsed;
}

function wonTermsMatchInput(terms: WonTerms, input: WonTermsInput): boolean {
  const projected = input.billingModel === 'per_door_monthly'
    ? input.doorsCommitted * input.unitRateCents
    : input.billingModel === 'flat_monthly' ? input.unitRateCents : input.projectedMrrCents;
  return terms.billingModel === input.billingModel
    && terms.doorsCommitted === input.doorsCommitted
    && terms.unitRateCents === input.unitRateCents
    && terms.projectedMrrCents === projected
    && terms.foundingCustomer === input.foundingCustomer
    && terms.effectiveAt === input.effectiveAt
    && terms.manualProjectionReason === (
      input.billingModel === 'manual_projected_monthly' ? input.manualProjectionReason : null
    );
}
