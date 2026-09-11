import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import {
  PrioritizationIdempotencyConflictError,
  PrioritizationInputCorruptionError,
  PrioritizationStaleWriteError,
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
  NotPrioritizableEvaluation,
  PrioritizationEvaluation,
  PrioritizationPreview,
  PrioritizationReason,
  ProspectPriorityProjection,
  QualificationResult,
  QualifiedPrioritizationEvaluation,
  RecalculationResult,
  StoredTriggerKey,
  TriggerEvent,
  TriggerEvidenceV1,
} from './prioritizationTypes';

import type { RecordTriggerEventInput, RecalculateProspectInput } from './prioritizationService';

const idSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const recalculateSchema = z.object({
  evaluationId: idSchema,
  prospectId: idSchema,
  ruleVersionId: idSchema,
  evaluatedAt: utcTimestampSchema,
  expectedProjectionVersion: z.number().int().positive().nullable(),
}).strict();

function canonicalCommandJson(value: unknown): string {
  return canonicalRuleJson(value);
}

/** Same mutation implementation as the public service, in the caller's exact UOW. */
export class PrioritizationTransactionWriter {
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;
  private readonly repository: PrioritizationRepository;
  private readonly outboundPermission: OutboundPermissionService;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; clock: Clock;
    repository: PrioritizationRepository; outboundPermission: OutboundPermissionService }) {
    input.repository.assertBoundTo(input.database, input.unitOfWork);
    input.outboundPermission.assertBoundTo(input.database, input.unitOfWork);
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.repository = input.repository;
    this.outboundPermission = input.outboundPermission;
  }

  /**
   * Transaction-scoped trigger recording with caller-stable ID and exact
   * proof-preselected idempotent replay.
   */
  recordTriggerEvent(input: RecordTriggerEventInput): TriggerEvent {
    this.unitOfWork.assertWriteScope();
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
  }

  /**
   * Transaction-scoped idempotent recalculation. Preselects the caller-stable
   * evaluation ID before mutable-fact loads, defaults, or the injected clock.
   */
  recalculateProspect(input: RecalculateProspectInput): RecalculationResult {
    this.unitOfWork.assertWriteScope();
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
    const outcome = computePrioritizationOutcome({ repository: this.repository, outboundPermission: this.outboundPermission }, parsed);
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


}

export function computePrioritizationOutcome(dependencies: { repository: PrioritizationRepository;
outboundPermission: OutboundPermissionService }, parsed: {
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
}): PrioritizationPreview['outcome'] {
  const identity = dependencies.repository.loadQualificationInputs(parsed.prospectId);
  const permission = identity.personDeletedAt !== null
    ? { kind: 'allowed' as const }
    : dependencies.outboundPermission.inspectPerson(identity.personId);
  const qualification = evaluateQualification({
    snapshot: identity,
    permission: permission.kind === 'blocked'
      ? { kind: 'blocked', tombstoneIds: permission.tombstoneIds }
      : { kind: 'allowed' },
  });
  const rule = dependencies.repository.getRuleVersion(parsed.ruleVersionId);
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
  const snapshot = dependencies.repository.loadQualifiedEvaluationInputs(parsed.prospectId);
  const lastContact = dependencies.repository.loadQualifyingLastContact(
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
