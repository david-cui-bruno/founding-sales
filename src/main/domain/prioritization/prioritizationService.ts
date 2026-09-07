import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import {
  PrioritizationIdempotencyConflictError,
  PrioritizationInputCorruptionError,
  PrioritizationOperationalBlockError,
  PrioritizationStaleWriteError,
  PriorityP0ReachabilityError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { OutboundPermissionService } from '../optOut/outboundPermissionService';
import type { PrioritizationRepository } from './prioritizationRepository';
import type {
  EffectivePriorityControl,
  EffectivePrioritySnapshot,
  PrioritizationPreview,
  PrioritizationPreferenceEvent,
  PriorityOverride,
  RecalculationResult,
  QualifiedPrioritizationEvaluation,
  StoredTriggerKey,
  TriggerEvent,
  TriggerEvidenceV1,
} from './prioritizationTypes';

import { computePrioritizationOutcome, PrioritizationTransactionWriter } from './prioritizationTransactionWriter';

export type RecalculateProspectInput = {
  evaluationId: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  expectedProjectionVersion: number | null;
};

const idSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

export type RecordTriggerEventInput = Readonly<{
  id: string;
  prospectId: string;
  triggerType: StoredTriggerKey;
  effectiveAt: string;
  sourceExpiresAt: string | null;
  strengthMultiplier: number;
  verificationState: 'verified' | 'unverified';
  evidence: TriggerEvidenceV1;
}>;

export type PairwiseComparisonSnapshot = Readonly<{
  winner: Readonly<{ prospectId: string; evaluationId: string; projectionVersion: number }>;
  loser: Readonly<{ prospectId: string; evaluationId: string; projectionVersion: number }>;
}>;

export type ManualControlCommand = Readonly<{
  controlId: string;
  preferenceEventId: string;
  controlledProspectId: string;
  comparison: PairwiseComparisonSnapshot;
  reason: string;
  asOf: string;
  expiresAt: string;
}>;

export type PairwisePreferenceCommand = Readonly<{
  preferenceEventId: string;
  comparison: PairwiseComparisonSnapshot;
  reason: string;
  asOf: string;
}>;

const comparisonSchema = z.object({
  winner: z.object({
    prospectId: idSchema,
    evaluationId: idSchema,
    projectionVersion: z.number().int().positive(),
  }).strict(),
  loser: z.object({
    prospectId: idSchema,
    evaluationId: idSchema,
    projectionVersion: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.winner.prospectId === value.loser.prospectId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A pairwise comparison requires two distinct Prospects.',
    });
  }
});

const manualControlSchema = z.object({
  controlId: idSchema,
  preferenceEventId: idSchema,
  controlledProspectId: idSchema,
  comparison: comparisonSchema,
  reason: z.string().trim().min(1),
  asOf: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.asOf) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Controls require expiration after asOf.',
    });
  }
});

const pairwiseSchema = z.object({
  preferenceEventId: idSchema,
  comparison: comparisonSchema,
  reason: z.string().trim().min(1),
  asOf: utcTimestampSchema,
}).strict();

type ControlActionKind = 'priority_overridden' | 'pinned' | 'snoozed' | 'dismissed';

export class PrioritizationService {
  private readonly writer: PrioritizationTransactionWriter;
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;
  private readonly repository: PrioritizationRepository;
  private readonly outboundPermission: OutboundPermissionService;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
    repository: PrioritizationRepository;
    outboundPermission: OutboundPermissionService;
  }) {
    input.repository.assertBoundTo(input.database, input.unitOfWork);
    input.outboundPermission.assertBoundTo(input.database, input.unitOfWork);
    this.writer = new PrioritizationTransactionWriter(input);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.repository = input.repository;
    this.outboundPermission = input.outboundPermission;
  }

  /**
   * Idempotent, write-free preview over one coherent read snapshot. May use
   * any installed rule version and may evaluate an explicit future time.
   */
  evaluatePreview(input: {
    prospectId: string;
    ruleVersionId: string;
    evaluatedAt: string;
  }): PrioritizationPreview {
    const parsed = z.object({
      prospectId: idSchema,
      ruleVersionId: idSchema,
      evaluatedAt: utcTimestampSchema,
    }).strict().parse(input);
    if (this.database.raw.inTransaction) {
      throw new PrioritizationInputCorruptionError(
        'Preview rejects an already-active raw transaction.',
      );
    }
    this.database.raw.exec('BEGIN');
    try {
      const outcome = computePrioritizationOutcome({ repository: this.repository, outboundPermission: this.outboundPermission }, parsed);
      return Object.freeze({
        prospectId: parsed.prospectId,
        ruleVersionId: parsed.ruleVersionId,
        evaluatedAt: parsed.evaluatedAt,
        outcome,
      });
    } finally {
      this.database.raw.exec('ROLLBACK');
    }
  }

  scopedWriter(): PrioritizationTransactionWriter {
    this.unitOfWork.assertWriteScope();
    return this.writer;
  }

  recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent {
    return this.unitOfWork.immediate(() => this.writer.recordTriggerEvent(input));
  }

  recalculateProspect(input: RecalculateProspectInput): RecalculationResult {
    return this.unitOfWork.immediate(() => this.writer.recalculateProspect(input));
  }

  createPriorityOverride(
    input: ManualControlCommand & { priority: 'p0' | 'p1' | 'p2' | 'p3' },
  ): EffectivePrioritySnapshot {
    const parsed = manualControlSchema.extend({
      priority: z.enum(['p0', 'p1', 'p2', 'p3']),
    }).parse(input);
    return this.executeManualControl(parsed, 'priority', 'priority_overridden', parsed.priority);
  }

  pinProspect(input: ManualControlCommand): EffectivePrioritySnapshot {
    return this.executeManualControl(manualControlSchema.parse(input), 'pin_to_top', 'pinned', null);
  }

  snoozeProspect(input: ManualControlCommand): EffectivePrioritySnapshot {
    return this.executeManualControl(manualControlSchema.parse(input), 'snooze', 'snoozed', null);
  }

  dismissProspect(input: ManualControlCommand): EffectivePrioritySnapshot {
    return this.executeManualControl(manualControlSchema.parse(input), 'dismiss', 'dismissed', null);
  }

  private executeManualControl(
    parsed: z.infer<typeof manualControlSchema> & { priority?: 'p0' | 'p1' | 'p2' | 'p3' },
    kind: PriorityOverride['kind'],
    action: ControlActionKind,
    priority: 'p0' | 'p1' | 'p2' | 'p3' | null,
  ): EffectivePrioritySnapshot {
    const requiredSide = action === 'snoozed' || action === 'dismissed' ? 'loser' : 'winner';
    if (parsed.comparison[requiredSide].prospectId !== parsed.controlledProspectId) {
      throw new PrioritizationInputCorruptionError(
        `A ${kind} control requires the controlled Prospect be the comparison ${requiredSide}.`,
      );
    }
    return this.unitOfWork.immediate(() => {
      const existingControl = this.repository.getOverrideById(parsed.controlId);
      const existingEvent = this.repository.getPreferenceEventById(parsed.preferenceEventId);
      if (existingControl !== null && existingEvent !== null) {
        if (
          existingControl.prospectId === parsed.controlledProspectId
          && existingControl.kind === kind
          && existingControl.priority === priority
          && existingControl.reason === parsed.reason
          && existingControl.createdAt === parsed.asOf
          && existingEvent.controlId === parsed.controlId
          && existingEvent.winnerEvaluationId === parsed.comparison.winner.evaluationId
          && existingEvent.loserEvaluationId === parsed.comparison.loser.evaluationId
        ) {
          return this.readEffectiveSnapshot(parsed.controlledProspectId, parsed.asOf);
        }
        throw new PrioritizationIdempotencyConflictError(
          'The control ID already exists for a different command.',
        );
      }
      if (existingControl !== null || existingEvent !== null) {
        throw new PrioritizationIdempotencyConflictError(
          'A partial manual-control record exists for these IDs.',
        );
      }
      const now = utcTimestampSchema.parse(this.clock.now());
      if (parsed.asOf > now) {
        throw new PrioritizationInputCorruptionError('Manual controls require asOf <= clock.now().');
      }
      this.validateComparison(parsed.comparison, parsed.asOf);
      if (kind === 'priority' && priority === 'p0') {
        const projection = this.repository.getProjection(parsed.controlledProspectId);
        if (projection === null || projection.reachability !== 'direct') {
          throw new PriorityP0ReachabilityError();
        }
      }
      this.repository.createOverride({
        id: parsed.controlId,
        prospectId: parsed.controlledProspectId,
        kind,
        priority,
        reason: parsed.reason,
        createdAt: parsed.asOf,
        expiresAt: parsed.expiresAt,
        status: 'active',
        expiredAt: null,
      });
      this.repository.appendPreferenceEvent({
        id: parsed.preferenceEventId,
        controlId: parsed.controlId,
        controlledProspectId: parsed.controlledProspectId,
        action,
        winnerProspectId: parsed.comparison.winner.prospectId,
        winnerEvaluationId: parsed.comparison.winner.evaluationId,
        loserProspectId: parsed.comparison.loser.prospectId,
        loserEvaluationId: parsed.comparison.loser.evaluationId,
        observedAt: parsed.asOf,
        context: { formatVersion: 1, reason: parsed.reason },
        createdAt: parsed.asOf,
      });
      return this.readEffectiveSnapshot(parsed.controlledProspectId, parsed.asOf);
    });
  }

  private validateComparison(
    comparison: PairwiseComparisonSnapshot,
    asOf: string,
  ): void {
    for (const side of [comparison.winner, comparison.loser]) {
      const identity = this.repository.loadQualificationInputs(side.prospectId);
      if (identity.personDeletedAt !== null) {
        throw new PrioritizationOperationalBlockError('person_deleted', [side.prospectId]);
      }
      const permission = this.outboundPermission.inspectPerson(identity.personId);
      if (permission.kind === 'blocked') {
        throw new PrioritizationOperationalBlockError('person_opted_out', permission.tombstoneIds);
      }
      this.repository.sweepExpiredControls({ prospectId: side.prospectId, asOf });
      const projection = this.repository.getProjection(side.prospectId);
      if (projection === null
        || projection.evaluationId !== side.evaluationId
        || projection.version !== side.projectionVersion) {
        throw new PrioritizationStaleWriteError('The pairwise comparison snapshot is stale.');
      }
    }
  }

  recordOutOfOrderChoice(input: PairwisePreferenceCommand): PrioritizationPreferenceEvent {
    return this.recordPairwise(pairwiseSchema.parse(input), 'acted_out_of_order');
  }

  recordReorder(input: PairwisePreferenceCommand): PrioritizationPreferenceEvent {
    return this.recordPairwise(pairwiseSchema.parse(input), 'reordered');
  }

  private recordPairwise(
    parsed: z.infer<typeof pairwiseSchema>,
    action: 'acted_out_of_order' | 'reordered',
  ): PrioritizationPreferenceEvent {
    return this.unitOfWork.immediate(() => {
      const existing = this.repository.getPreferenceEventById(parsed.preferenceEventId);
      if (existing !== null) {
        if (
          existing.action === action
          && existing.controlId === null
          && existing.winnerProspectId === parsed.comparison.winner.prospectId
          && existing.winnerEvaluationId === parsed.comparison.winner.evaluationId
          && existing.loserProspectId === parsed.comparison.loser.prospectId
          && existing.loserEvaluationId === parsed.comparison.loser.evaluationId
          && existing.observedAt === parsed.asOf
        ) {
          return existing;
        }
        throw new PrioritizationIdempotencyConflictError(
          'The preference event ID already exists for a different command.',
        );
      }
      const now = utcTimestampSchema.parse(this.clock.now());
      if (parsed.asOf > now) {
        throw new PrioritizationInputCorruptionError('Preference events require asOf <= clock.now().');
      }
      this.validateComparison(parsed.comparison, parsed.asOf);
      return this.repository.appendPreferenceEvent({
        id: parsed.preferenceEventId,
        controlId: null,
        controlledProspectId: null,
        action,
        winnerProspectId: parsed.comparison.winner.prospectId,
        winnerEvaluationId: parsed.comparison.winner.evaluationId,
        loserProspectId: parsed.comparison.loser.prospectId,
        loserEvaluationId: parsed.comparison.loser.evaluationId,
        observedAt: parsed.asOf,
        context: { formatVersion: 1, reason: parsed.reason },
        createdAt: parsed.asOf,
      });
    });
  }

  expireControl(input: {
    controlId: string;
    expectedStatus: 'active';
    expectedExpiresAt: string;
    newExpiresAt: string;
    asOf: string;
  }): PriorityOverride {
    const parsed = z.object({
      controlId: idSchema,
      expectedStatus: z.literal('active'),
      expectedExpiresAt: utcTimestampSchema,
      newExpiresAt: utcTimestampSchema,
      asOf: utcTimestampSchema,
    }).strict().parse(input);
    if (parsed.newExpiresAt !== parsed.asOf) {
      throw new PrioritizationInputCorruptionError('Explicit retirement requires newExpiresAt=asOf.');
    }
    if (parsed.newExpiresAt > parsed.expectedExpiresAt) {
      throw new PrioritizationInputCorruptionError('Controls may only shorten expiration.');
    }
    return this.unitOfWork.immediate(() => {
      const control = this.repository.getOverrideById(parsed.controlId);
      if (control === null) {
        throw new PrioritizationStaleWriteError('The priority control does not exist.');
      }
      return this.repository.expireOverrideCas({
        controlId: parsed.controlId,
        prospectId: control.prospectId,
        expectedStatus: 'active',
        expectedExpiresAt: parsed.expectedExpiresAt,
        newExpiresAt: parsed.newExpiresAt,
        expiredAt: parsed.asOf,
      });
    });
  }

  sweepExpiredControls(input: {
    prospectId: string;
    asOf: string;
  }): readonly PriorityOverride[] {
    const parsed = z.object({
      prospectId: idSchema,
      asOf: utcTimestampSchema,
    }).strict().parse(input);
    return this.unitOfWork.immediate(() => this.repository.sweepExpiredControls(parsed));
  }

  /**
   * Read-only effective snapshot. Does not sweep: an expired-but-unswept row
   * is ineffective for the read but remains a conservative raw P0 guard.
   */
  getEffectivePrioritySnapshot(input: {
    prospectId: string;
    asOf: string;
  }): EffectivePrioritySnapshot {
    const parsed = z.object({
      prospectId: idSchema,
      asOf: utcTimestampSchema,
    }).strict().parse(input);
    return this.readEffectiveSnapshot(parsed.prospectId, parsed.asOf);
  }

  private readEffectiveSnapshot(prospectId: string, asOf: string): EffectivePrioritySnapshot {
    const identity = this.repository.loadQualificationInputs(prospectId);
    if (identity.personDeletedAt !== null) {
      throw new PrioritizationOperationalBlockError('person_deleted', [prospectId]);
    }
    const permission = this.outboundPermission.inspectPerson(identity.personId);
    if (permission.kind === 'blocked') {
      throw new PrioritizationOperationalBlockError('person_opted_out', permission.tombstoneIds);
    }
    const projection = this.repository.getProjection(prospectId);
    if (projection === null) {
      throw new PrioritizationInputCorruptionError(
        'The Prospect has no current priority projection.',
      );
    }
    const evaluation = this.repository.getEvaluationById(projection.evaluationId);
    if (evaluation === null || evaluation.decisionKind !== 'evaluated') {
      throw new PrioritizationInputCorruptionError(
        'The projection references a missing or gated evaluation.',
      );
    }
    const controls = this.repository.listOverrides(prospectId);
    const effective: Partial<Record<PriorityOverride['kind'], EffectivePriorityControl>> = {};
    for (const control of controls) {
      const isEffective = control.status === 'active'
        && control.createdAt <= asOf && asOf < control.expiresAt;
      if (!isEffective) continue;
      if (effective[control.kind] !== undefined) {
        throw new PrioritizationInputCorruptionError(
          'Overlapping effective controls of one kind are corruption.',
        );
      }
      effective[control.kind] = Object.freeze({
        id: control.id,
        kind: control.kind,
        priority: control.priority,
        reason: control.reason,
        createdAt: control.createdAt,
        expiresAt: control.expiresAt,
        status: 'active' as const,
      });
    }
    let effectivePriority = projection.priority;
    const priorityControl = effective.priority ?? null;
    if (priorityControl !== null && priorityControl.priority !== null) {
      if (priorityControl.priority === 'p0' && projection.reachability !== 'direct') {
        throw new PriorityP0ReachabilityError();
      }
      effectivePriority = priorityControl.priority;
    }
    // Cloud axes (Task 5): read straight from the prospect row; tiebreaker
    // display data only, never blended into local fit/timing points.
    const cloudAxes = this.repository.loadCloudScoreAxes(prospectId);
    return Object.freeze({
      prospectId,
      ruleVersionId: projection.ruleVersionId,
      evaluationId: projection.evaluationId,
      projectionVersion: projection.version,
      evaluatedAt: projection.evaluatedAt,
      asOf,
      computedPriority: projection.priority,
      effectivePriority,
      computedPlay: (evaluation as QualifiedPrioritizationEvaluation).play,
      fitPoints: projection.fitPoints,
      fitBand: projection.fitBand,
      timingMilliPoints: projection.timingMilliPoints,
      timingBand: projection.timingBand,
      reachability: projection.reachability,
      dataConfidence: projection.dataConfidence,
      earliestTriggerExpiresAt: projection.earliestTriggerExpiresAt,
      verifyFirst: projection.verifyFirst,
      lastContactActivityId: projection.lastContactActivityId,
      lastContactAt: projection.lastContactAt,
      cloudTiming: cloudAxes.cloudTiming,
      cloudFit: cloudAxes.cloudFit,
      cloudSourcePercentile: cloudAxes.cloudSourcePercentile,
      controls: Object.freeze({
        priority: priorityControl,
        pin: effective.pin_to_top ?? null,
        snooze: effective.snooze ?? null,
        dismiss: effective.dismiss ?? null,
      }),
      explanation: (evaluation as QualifiedPrioritizationEvaluation).explanation,
    }) as EffectivePrioritySnapshot;
  }
}
