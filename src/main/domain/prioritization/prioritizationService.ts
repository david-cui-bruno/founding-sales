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
import { canonicalRuleJson } from './builtinPrioritizationRules';
import {
  calculateConfidence,
  calculateFit,
  deriveReachability,
  deriveVerifyFirst,
  evaluateQualification,
  parseCanonicalUtcMillis,
} from './qualificationEngine';
import { evaluateTriggers } from './triggerMath';
import { resolvePriorityMatrix } from './priorityMatrix';
import type {
  EffectivePriorityControl,
  EffectivePrioritySnapshot,
  NotPrioritizableEvaluation,
  PrioritizationEvaluation,
  PrioritizationPreview,
  PrioritizationPreferenceEvent,
  PrioritizationReason,
  PriorityOverride,
  ProspectPriorityProjection,
  QualificationResult,
  QualifiedPrioritizationEvaluation,
  RecalculationResult,
  StoredTriggerKey,
  TriggerEvent,
  TriggerEvidenceV1,
} from './prioritizationTypes';

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

const recalculateSchema = z.object({
  evaluationId: idSchema,
  prospectId: idSchema,
  ruleVersionId: idSchema,
  evaluatedAt: utcTimestampSchema,
  expectedProjectionVersion: z.number().int().positive().nullable(),
}).strict();

type ControlActionKind = 'priority_overridden' | 'pinned' | 'snoozed' | 'dismissed';

function canonicalCommandJson(value: unknown): string {
  return canonicalRuleJson(value);
}

export class PrioritizationService {
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
      const outcome = this.computeOutcome(parsed);
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

  private computeOutcome(parsed: {
    prospectId: string;
    ruleVersionId: string;
    evaluatedAt: string;
  }): PrioritizationPreview['outcome'] {
    const identity = this.repository.loadQualificationInputs(parsed.prospectId);
    const permission = identity.personDeletedAt !== null
      ? { kind: 'allowed' as const }
      : this.outboundPermission.inspectPerson(identity.personId);
    const qualification = evaluateQualification({
      snapshot: identity,
      permission: permission.kind === 'blocked'
        ? { kind: 'blocked', tombstoneIds: permission.tombstoneIds }
        : { kind: 'allowed' },
    });
    const rule = this.repository.getRuleVersion(parsed.ruleVersionId);
    if (rule === null) {
      throw new PrioritizationStaleWriteError('The requested rule version is not installed.');
    }
    if (qualification.kind !== 'qualified') {
      return Object.freeze({
        kind: 'not_prioritizable' as const,
        qualification,
        explanation: Object.freeze([gateReason(qualification)]),
      });
    }
    const snapshot = this.repository.loadQualifiedEvaluationInputs(parsed.prospectId);
    const lastContact = this.repository.loadQualifyingLastContact(
      parsed.prospectId, parsed.evaluatedAt,
    );
    const fit = calculateFit({ properties: snapshot.properties, rule: rule.document });
    const reachability = deriveReachability(snapshot.contactMethods);
    const confidence = calculateConfidence({
      snapshot, evaluatedAt: parsed.evaluatedAt, rule: rule.document,
    });
    const triggers = evaluateTriggers({
      events: snapshot.triggerEvents, rule: rule.document, evaluatedAt: parsed.evaluatedAt,
    });
    const selectedPositive = triggers.reasons
      .filter((reason) => reason.selected && reason.contributionMilliPoints > 0)
      .map((reason) => reason.triggerKey);
    const matrix = resolvePriorityMatrix({
      fitBand: fit.fitBand,
      timingBand: triggers.timingBand,
      reachability,
      selectedPositiveTriggerKeys: selectedPositive,
    });
    const verifyFirst = deriveVerifyFirst({
      priority: matrix.priority,
      dataConfidence: confidence.dataConfidence,
      rule: rule.document,
    });
    const explanation: PrioritizationReason[] = [
      ...fit.reasons,
      { kind: 'reachability', value: reachability },
      ...confidence.reasons,
      ...triggers.reasons,
      ...matrix.reasons,
    ];
    return Object.freeze({
      kind: 'evaluated' as const,
      fitPoints: fit.fitPoints,
      fitBand: fit.fitBand,
      timingMilliPoints: triggers.timingMilliPoints,
      timingBand: triggers.timingBand,
      reachability,
      dataConfidence: confidence.dataConfidence,
      priority: matrix.priority,
      play: matrix.play,
      earliestTriggerExpiresAt: triggers.earliestTriggerExpiresAt,
      verifyFirst,
      lastContactActivityId: lastContact?.activityId ?? null,
      lastContactAt: lastContact?.occurredAt ?? null,
      explanation: Object.freeze(explanation),
    });
  }

  /**
   * Transaction-owning trigger recording with caller-stable ID and exact
   * proof-preselected idempotent replay.
   */
  recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent {
    const parsed = z.object({
      id: idSchema,
      prospectId: idSchema,
      triggerType: z.string().min(1),
      effectiveAt: utcTimestampSchema,
      sourceExpiresAt: utcTimestampSchema.nullable(),
      strengthMultiplier: z.number().min(0).max(2),
      verificationState: z.enum(['verified', 'unverified']),
      evidence: z.unknown(),
    }).strict().parse(input);
    const evidence = input.evidence;
    if (evidence.triggerType !== parsed.triggerType) {
      throw new PrioritizationInputCorruptionError('Trigger evidence key must match the stored key.');
    }
    return this.unitOfWork.immediate(() => {
      const rule = this.repository.getRuleVersion(evidence.authoredUnderRuleVersionId);
      if (rule === null) {
        throw new PrioritizationStaleWriteError('The authoring rule version is not installed.');
      }
      const isReceipt = evidence.proof.kind === 'reactivation_rule_receipt';
      const byId = this.repository.getTriggerEventById(parsed.id);
      const byProof = evidence.proof.kind === 'reactivation_rule_receipt'
        ? this.repository.getTriggerEventByActivationKey(evidence.proof.activationKey)
        : this.repository.getTriggerEventBySourceEvent(evidence.proof.sourceEventId);
      const candidate: TriggerEvent = {
        id: parsed.id,
        prospectId: parsed.prospectId,
        sourceEventId: isReceipt ? null : (evidence.proof as { sourceEventId: string }).sourceEventId,
        reactivationReceiptActivationKey: isReceipt
          ? (evidence.proof as { activationKey: string }).activationKey
          : null,
        reactivationRuleId: isReceipt ? (evidence.proof as { ruleId: string }).ruleId : null,
        triggerType: parsed.triggerType as StoredTriggerKey,
        effectiveAt: parsed.effectiveAt,
        expiresAt: parsed.sourceExpiresAt,
        strengthMultiplier: parsed.strengthMultiplier,
        verificationState: parsed.verificationState,
        evidence,
        createdAt: parsed.effectiveAt,
      };
      const matchesStored = (stored: TriggerEvent): boolean => (
        stored.id === candidate.id
        && stored.prospectId === candidate.prospectId
        && stored.sourceEventId === candidate.sourceEventId
        && stored.reactivationReceiptActivationKey === candidate.reactivationReceiptActivationKey
        && stored.reactivationRuleId === candidate.reactivationRuleId
        && stored.triggerType === candidate.triggerType
        && stored.effectiveAt === candidate.effectiveAt
        && stored.expiresAt === candidate.expiresAt
        && stored.strengthMultiplier === candidate.strengthMultiplier
        && stored.verificationState === candidate.verificationState
        && JSON.stringify(stored.evidence) === JSON.stringify(candidate.evidence)
      );
      if (byId !== null) {
        if (matchesStored(byId)) return byId;
        throw new PrioritizationIdempotencyConflictError(
          'The trigger event ID already exists for a different command.',
        );
      }
      if (byProof !== null) {
        if (matchesStored(byProof)) return byProof;
        throw new PrioritizationIdempotencyConflictError(
          'The trigger proof already authored a different trigger event.',
        );
      }
      if (isReceipt) {
        const proof = evidence.proof as Extract<
          TriggerEvidenceV1['proof'], { kind: 'reactivation_rule_receipt' }
        >;
        if (evidence.function !== 'windowed') {
          throw new PrioritizationInputCorruptionError(
            'nurture_resurrection requires a windowed evidence envelope.',
          );
        }
        if (evidence.startsAt !== proof.activatedAt
          || parsed.effectiveAt !== proof.activatedAt) {
          throw new PrioritizationInputCorruptionError(
            'nurture_resurrection starts exactly at the receipt activation.',
          );
        }
        const expectedEndMillis = parseCanonicalUtcMillis(proof.activatedAt, 'activatedAt')
          + 14 * 86_400_000;
        if (parseCanonicalUtcMillis(evidence.endsAt, 'endsAt') !== expectedEndMillis) {
          throw new PrioritizationInputCorruptionError(
            'nurture_resurrection ends exactly fourteen days after activation.',
          );
        }
      } else if (evidence.proof.kind === 'source_event'
        && evidence.proof.sourceObservedAt !== parsed.effectiveAt) {
        throw new PrioritizationInputCorruptionError(
          'Source-backed triggers set effective_at to the SourceEvent observation.',
        );
      }
      return this.repository.appendTriggerEvent(candidate);
    });
  }

  /**
   * Transaction-owning idempotent recalculation. Preselects the caller-stable
   * evaluation ID before mutable-fact loads, defaults, or the injected clock.
   */
  recalculateProspect(input: {
    evaluationId: string;
    prospectId: string;
    ruleVersionId: string;
    evaluatedAt: string;
    expectedProjectionVersion: number | null;
  }): RecalculationResult {
    const parsed = recalculateSchema.parse(input) as {
      evaluationId: string;
      prospectId: string;
      ruleVersionId: string;
      evaluatedAt: string;
      expectedProjectionVersion: number | null;
    };
    const commandJson = canonicalCommandJson({
      formatVersion: 1,
      command: 'recalculate_prospect',
      evaluationId: parsed.evaluationId,
      prospectId: parsed.prospectId,
      ruleVersionId: parsed.ruleVersionId,
      evaluatedAt: parsed.evaluatedAt,
      expectedProjectionVersion: parsed.expectedProjectionVersion,
    });
    return this.unitOfWork.immediate(() => {
      const existing = this.repository.getStoredEvaluationCommand(parsed.evaluationId);
      if (existing !== null) {
        if (existing.commandJson !== commandJson) {
          throw new PrioritizationIdempotencyConflictError(
            'The evaluation ID already exists for a different command.',
          );
        }
        return this.replayStoredResult(parsed.evaluationId);
      }
      const now = utcTimestampSchema.parse(this.clock.now());
      if (parsed.evaluatedAt > now) {
        throw new PrioritizationInputCorruptionError(
          'First execution rejects evaluatedAt later than the injected clock.',
        );
      }
      const priorProjection = this.repository.getProjection(parsed.prospectId);
      if (priorProjection !== null && parsed.evaluatedAt < priorProjection.evaluatedAt) {
        throw new PrioritizationStaleWriteError(
          'Recalculation cannot evaluate earlier than the current projection.',
        );
      }
      for (const control of this.repository.listOverrides(parsed.prospectId)) {
        if (control.status === 'active' && parsed.evaluatedAt < control.createdAt) {
          throw new PrioritizationStaleWriteError(
            'Recalculation cannot evaluate earlier than an effective control creation.',
          );
        }
      }
      const activeRule = this.repository.getActiveRuleVersion();
      if (activeRule === null || activeRule.id !== parsed.ruleVersionId) {
        throw new PrioritizationStaleWriteError(
          'Recalculation requires the workspace active rule version.',
        );
      }
      const outcome = this.computeOutcome(parsed);
      const resultJson = canonicalCommandJson(outcome);
      const inputSnapshotJson = this.buildInputSnapshotJson(parsed, outcome);
      if (outcome.kind === 'evaluated') {
        const evaluation: QualifiedPrioritizationEvaluation = {
          decisionKind: 'evaluated',
          id: parsed.evaluationId,
          prospectId: parsed.prospectId,
          ruleVersionId: parsed.ruleVersionId,
          evaluatedAt: parsed.evaluatedAt,
          fitPoints: outcome.fitPoints,
          fitBand: outcome.fitBand,
          timingMilliPoints: outcome.timingMilliPoints,
          timingBand: outcome.timingBand,
          reachability: outcome.reachability,
          dataConfidence: outcome.dataConfidence,
          priority: outcome.priority,
          play: outcome.play,
          earliestTriggerExpiresAt: outcome.earliestTriggerExpiresAt,
          verifyFirst: outcome.verifyFirst,
          lastContactActivityId: outcome.lastContactActivityId,
          lastContactAt: outcome.lastContactAt,
          explanation: outcome.explanation,
        };
        const stored = this.repository.appendEvaluation({
          evaluation: evaluation as PrioritizationEvaluation,
          commandJson,
          inputSnapshotJson,
          resultJson,
        });
        this.repository.sweepExpiredControls({
          prospectId: parsed.prospectId, asOf: parsed.evaluatedAt,
        });
        if (outcome.reachability !== 'direct') {
          this.retireEffectiveControls(parsed.prospectId, parsed.evaluatedAt, 'priority_p0_only');
        }
        const projection = this.writeProjection(parsed, outcome);
        this.assertProjectionPostcondition(parsed.prospectId, stored.id);
        return Object.freeze({
          kind: 'evaluated' as const,
          evaluation: stored as QualifiedPrioritizationEvaluation,
          projection,
        });
      }
      const gatedEvaluation: NotPrioritizableEvaluation = {
        decisionKind: 'not_prioritizable',
        id: parsed.evaluationId,
        prospectId: parsed.prospectId,
        ruleVersionId: parsed.ruleVersionId,
        evaluatedAt: parsed.evaluatedAt,
        qualification: outcome.qualification as Exclude<QualificationResult, { kind: 'qualified' }>,
        explanation: outcome.explanation,
      };
      if (priorProjection === null) {
        if (parsed.expectedProjectionVersion !== null) {
          throw new PrioritizationStaleWriteError(
            'Gated recalculation expected a projection that does not exist.',
          );
        }
      } else if (priorProjection.version !== parsed.expectedProjectionVersion) {
        throw new PrioritizationStaleWriteError(
          'Gated recalculation requires the exact current projection version.',
        );
      }
      const stored = this.repository.appendEvaluation({
        evaluation: gatedEvaluation as PrioritizationEvaluation,
        commandJson,
        inputSnapshotJson,
        resultJson,
      });
      this.repository.sweepExpiredControls({
        prospectId: parsed.prospectId, asOf: parsed.evaluatedAt,
      });
      this.retireEffectiveControls(parsed.prospectId, parsed.evaluatedAt, 'all');
      if (priorProjection !== null) {
        this.repository.deleteProjectionCas({
          prospectId: parsed.prospectId,
          expectedVersion: priorProjection.version,
        });
      }
      return Object.freeze({
        kind: 'not_prioritizable' as const,
        evaluation: stored as NotPrioritizableEvaluation,
        projection: null,
        qualification: gatedEvaluation.qualification,
      });
    });
  }

  private buildInputSnapshotJson(
    parsed: { prospectId: string; ruleVersionId: string; evaluatedAt: string },
    outcome: PrioritizationPreview['outcome'],
  ): string {
    if (outcome.kind === 'not_prioritizable') {
      return canonicalCommandJson({
        formatVersion: 1,
        kind: 'gate_snapshot',
        prospectId: parsed.prospectId,
        ruleVersionId: parsed.ruleVersionId,
        evaluatedAt: parsed.evaluatedAt,
        qualification: outcome.qualification,
      });
    }
    const snapshot = this.repository.loadQualifiedEvaluationInputs(parsed.prospectId);
    const lastContact = this.repository.loadQualifyingLastContact(
      parsed.prospectId, parsed.evaluatedAt,
    );
    return canonicalCommandJson({
      formatVersion: 1,
      kind: 'evaluated_snapshot',
      prospectId: parsed.prospectId,
      ruleVersionId: parsed.ruleVersionId,
      evaluatedAt: parsed.evaluatedAt,
      originalSource: snapshot.originalSource,
      properties: snapshot.properties,
      contactMethods: snapshot.contactMethods,
      lastContact,
      triggerEvents: snapshot.triggerEvents,
    });
  }

  private replayStoredResult(evaluationId: string): RecalculationResult {
    const stored = this.repository.getEvaluationById(evaluationId);
    if (stored === null) {
      throw new PrioritizationInputCorruptionError('Stored evaluation disappeared during replay.');
    }
    if (stored.decisionKind === 'evaluated') {
      const projection = this.repository.getProjection(stored.prospectId);
      if (projection === null || projection.evaluationId !== stored.id) {
        // A later fresh evaluation may own the projection; gated retry returns
        // the immutable result without reapplying mutations.
        return Object.freeze({
          kind: 'evaluated' as const,
          evaluation: stored as QualifiedPrioritizationEvaluation,
          projection: projection ?? this.projectionFromEvaluation(stored),
        });
      }
      return Object.freeze({
        kind: 'evaluated' as const,
        evaluation: stored as QualifiedPrioritizationEvaluation,
        projection,
      });
    }
    return Object.freeze({
      kind: 'not_prioritizable' as const,
      evaluation: stored as NotPrioritizableEvaluation,
      projection: null,
      qualification: (stored as NotPrioritizableEvaluation).qualification,
    });
  }

  private projectionFromEvaluation(
    evaluation: QualifiedPrioritizationEvaluation,
  ): ProspectPriorityProjection {
    return Object.freeze({
      prospectId: evaluation.prospectId,
      ruleVersionId: evaluation.ruleVersionId,
      evaluationId: evaluation.id,
      fitPoints: evaluation.fitPoints,
      fitBand: evaluation.fitBand,
      timingMilliPoints: evaluation.timingMilliPoints,
      timingBand: evaluation.timingBand,
      reachability: evaluation.reachability,
      dataConfidence: evaluation.dataConfidence,
      priority: evaluation.priority,
      earliestTriggerExpiresAt: evaluation.earliestTriggerExpiresAt,
      verifyFirst: evaluation.verifyFirst,
      lastContactActivityId: evaluation.lastContactActivityId,
      lastContactAt: evaluation.lastContactAt,
      version: 1,
      evaluatedAt: evaluation.evaluatedAt,
      updatedAt: evaluation.evaluatedAt,
    });
  }

  private writeProjection(
    parsed: {
      evaluationId: string;
      prospectId: string;
      ruleVersionId: string;
      evaluatedAt: string;
      expectedProjectionVersion: number | null;
    },
    outcome: Extract<PrioritizationPreview['outcome'], { kind: 'evaluated' }>,
  ): ProspectPriorityProjection {
    const body = {
      prospectId: parsed.prospectId,
      ruleVersionId: parsed.ruleVersionId,
      evaluationId: parsed.evaluationId,
      fitPoints: outcome.fitPoints,
      fitBand: outcome.fitBand,
      timingMilliPoints: outcome.timingMilliPoints,
      timingBand: outcome.timingBand,
      reachability: outcome.reachability,
      dataConfidence: outcome.dataConfidence,
      priority: outcome.priority,
      earliestTriggerExpiresAt: outcome.earliestTriggerExpiresAt,
      verifyFirst: outcome.verifyFirst,
      lastContactActivityId: outcome.lastContactActivityId,
      lastContactAt: outcome.lastContactAt,
      evaluatedAt: parsed.evaluatedAt,
      updatedAt: parsed.evaluatedAt,
    };
    if (parsed.expectedProjectionVersion === null) {
      const existing = this.repository.getProjection(parsed.prospectId);
      if (existing !== null) {
        throw new PrioritizationStaleWriteError(
          'A projection already exists; recalculation expected absence.',
        );
      }
      const controls = this.repository.listActiveOverrides(parsed.prospectId, parsed.evaluatedAt);
      if (controls.length > 0) {
        throw new PrioritizationStaleWriteError(
          'First projection insert requires no effective controls.',
        );
      }
      return this.repository.insertProjection({ ...body, version: 1 });
    }
    const current = this.repository.getProjection(parsed.prospectId);
    if (current === null) {
      throw new PrioritizationStaleWriteError('The expected projection does not exist.');
    }
    if (current.evaluatedAt > parsed.evaluatedAt) {
      throw new PrioritizationStaleWriteError('The projection is newer than this evaluation.');
    }
    return this.repository.updateProjectionCas({
      prospectId: parsed.prospectId,
      expectedVersion: parsed.expectedProjectionVersion,
      projection: body,
    });
  }

  private retireEffectiveControls(
    prospectId: string,
    asOf: string,
    scope: 'priority_p0_only' | 'all',
  ): void {
    const effective = this.repository.listActiveOverrides(prospectId, asOf);
    const p0Controls = effective.filter(
      (control) => control.kind === 'priority' && control.priority === 'p0',
    );
    const others = effective.filter(
      (control) => !(control.kind === 'priority' && control.priority === 'p0'),
    );
    const targets = scope === 'priority_p0_only' ? p0Controls : [...p0Controls, ...others];
    for (const control of targets) {
      this.repository.expireOverrideCas({
        controlId: control.id,
        prospectId,
        expectedStatus: 'active',
        expectedExpiresAt: control.expiresAt,
        newExpiresAt: asOf,
        expiredAt: asOf,
      });
    }
  }

  private assertProjectionPostcondition(prospectId: string, evaluationId: string): void {
    const projection = this.repository.getProjection(prospectId);
    if (projection === null || projection.evaluationId !== evaluationId) {
      throw new PrioritizationStaleWriteError('The projection postcondition failed.');
    }
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

function gateReason(
  qualification: Exclude<QualificationResult, { kind: 'qualified' }>,
): PrioritizationReason {
  if (qualification.kind === 'gated') {
    return Object.freeze({
      kind: 'gate' as const,
      code: 'qualification_gated' as const,
      gateReasons: qualification.reasons,
      evidenceIds: qualification.evidenceIds,
    });
  }
  if (qualification.kind === 'pending_review') {
    return Object.freeze({
      kind: 'gate' as const,
      code: 'pending_review' as const,
      gateReasons: Object.freeze([]),
      evidenceIds: qualification.evidenceIds,
    });
  }
  return Object.freeze({
    kind: 'gate' as const,
    code: qualification.reason,
    gateReasons: Object.freeze([]),
    evidenceIds: qualification.evidenceIds,
  });
}
