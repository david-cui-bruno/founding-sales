import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import {
  DomainRepositoryDatabaseMismatchError,
  PrioritizationInputCorruptionError,
  PrioritizationRuleConflictError,
  PrioritizationStaleWriteError,
  PriorityControlOverlapError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { qualifiesContactEvidence } from '../events/qualifyingContactEvidence';
import {
  canonicalRuleJson,
  computeRuleContentHash,
  type PrioritizationRuleDocument,
} from './builtinPrioritizationRules';
import { parseMaintenanceProfileV1 } from './qualificationEngine';
import { classifyStoredTriggerKey } from './triggerMath';
import type {
  ContactMethodFact,
  LastContactEvidence,
  PrioritizationEvaluation,
  PrioritizationPreferenceEvent,
  PriorityOverride,
  PropertyFact,
  ProspectPriorityProjection,
  QualificationInputSnapshot,
  QualifiedInputSnapshot,
  TriggerEvent,
} from './prioritizationTypes';

const idSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  'Timestamps must be canonical UTC ISO strings with milliseconds.',
);

const gateReasonSchema = z.enum([
  'out_of_area', 'no_relevant_decision_relationship', 'institutional_outside_icp',
  'harmful_operator', 'non_paying_operator', 'unresolved_duplicate',
]);

const priorityPlaySchema = z.enum([
  'contact_immediately', 'find_direct_line', 'contact_today', 'quick_fit_check',
  'qualify_this_week', 'nurture', 'watch_for_trigger', 'archive_candidate',
]);

const prioritizationReasonSchema = z.union([
  z.object({
    kind: z.literal('gate'),
    code: z.enum(['qualification_gated', 'pending_review', 'person_deleted', 'person_opted_out']),
    gateReasons: z.array(gateReasonSchema),
    evidenceIds: z.array(idSchema),
  }).strict(),
  z.object({
    kind: z.literal('fit'),
    category: z.enum(['door_count', 'management', 'route_density', 'relevant_profile']),
    points: z.number().int(),
  }).strict(),
  z.object({
    kind: z.literal('reachability'),
    value: z.enum(['direct', 'indirect', 'none']),
  }).strict(),
  z.object({
    kind: z.literal('confidence'),
    component: z.enum([
      'source_evidence', 'source_age', 'property_verification', 'contact_method',
      'profile_evidence',
    ]),
    points: z.number().int(),
  }).strict(),
  z.object({
    kind: z.literal('trigger'),
    triggerKey: z.string().min(1),
    eventId: idSchema,
    code: z.enum([
      'active', 'suppressed', 'not_yet_effective', 'expired', 'below_threshold',
      'window_inactive', 'custom_not_configured',
    ]),
    selected: z.boolean(),
    contributed: z.boolean(),
    contributionMilliPoints: z.number().int(),
    winningEventId: idSchema.nullable(),
    recomputedExpiresAt: utcTimestampSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('matrix'),
    code: z.enum(['matrix_cell', 'high_hot_without_direct', 'nurture_only_p0_block']),
  }).strict(),
]);

const qualificationResultSchema = z.union([
  z.object({
    kind: z.literal('gated'),
    prospectId: idSchema,
    reasons: z.array(gateReasonSchema).min(1),
    evidenceIds: z.array(idSchema),
  }).strict(),
  z.object({
    kind: z.literal('pending_review'),
    prospectId: idSchema,
    qualificationState: z.literal('unreviewed'),
    evidenceIds: z.array(idSchema),
  }).strict(),
  z.object({
    kind: z.literal('operationally_blocked'),
    prospectId: idSchema,
    reason: z.enum(['person_deleted', 'person_opted_out']),
    evidenceIds: z.array(idSchema),
  }).strict(),
]);

const triggerFunctionEvidenceSchema = z.discriminatedUnion('function', [
  z.object({ function: z.literal('decaying') }),
  z.object({ function: z.literal('approaching'), deadlineAt: utcTimestampSchema }),
  z.object({
    function: z.literal('windowed'),
    startsAt: utcTimestampSchema,
    endsAt: utcTimestampSchema,
  }),
]);

const sourceProofSchema = z.object({
  kind: z.literal('source_event'),
  sourceEventId: idSchema,
  sourceObservedAt: utcTimestampSchema,
}).strict();

const receiptProofSchema = z.object({
  kind: z.literal('reactivation_rule_receipt'),
  activationKey: idSchema,
  ruleId: idSchema,
  ruleType: z.enum([
    'seasonal:heating-oct1', 'new-frbo-listing', 'lead-cert-expiry-window', 'manual',
  ]),
  sourceCycleId: idSchema,
  newCycleId: idSchema,
  activatedAt: utcTimestampSchema,
}).strict();

const triggerEvidenceBaseSchema = z.object({
  formatVersion: z.literal(1),
  triggerType: z.string().min(1),
  authoredUnderRuleVersionId: idSchema,
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  function: z.enum(['decaying', 'approaching', 'windowed']),
  deadlineAt: utcTimestampSchema.optional(),
  startsAt: utcTimestampSchema.optional(),
  endsAt: utcTimestampSchema.optional(),
  proof: z.union([sourceProofSchema, receiptProofSchema]),
});

function parseTriggerEvidence(value: unknown): TriggerEvent['evidence'] {
  const base = triggerEvidenceBaseSchema.parse(value);
  const functionShape = triggerFunctionEvidenceSchema.parse(value);
  classifyStoredTriggerKey(base.triggerType);
  const sortedRefs = [...base.evidenceRefs].sort();
  if (new Set(sortedRefs).size !== sortedRefs.length
    || JSON.stringify(sortedRefs) !== JSON.stringify(base.evidenceRefs)) {
    throw new PrioritizationInputCorruptionError(
      'Trigger evidence refs must be unique and lexically sorted.',
    );
  }
  if (base.triggerType === 'nurture_resurrection') {
    if (base.proof.kind !== 'reactivation_rule_receipt' || functionShape.function !== 'windowed') {
      throw new PrioritizationInputCorruptionError(
        'nurture_resurrection requires a windowed rule-receipt evidence envelope.',
      );
    }
  } else if (base.proof.kind !== 'source_event') {
    throw new PrioritizationInputCorruptionError(
      'Source-backed trigger keys require SourceEvent proof.',
    );
  }
  return Object.freeze({
    formatVersion: 1,
    triggerType: base.triggerType,
    authoredUnderRuleVersionId: base.authoredUnderRuleVersionId,
    evidenceRefs: Object.freeze([...base.evidenceRefs]),
    ...functionShape,
    proof: Object.freeze({ ...base.proof }),
  }) as TriggerEvent['evidence'];
}

const storedRuleRowSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  rules_json: z.string().min(1),
  created_at: utcTimestampSchema,
}).strict();

const storedTriggerRowSchema = z.object({
  id: idSchema,
  prospect_id: idSchema,
  source_event_id: idSchema.nullable(),
  reactivation_receipt_activation_key: idSchema.nullable(),
  reactivation_rule_id: idSchema.nullable(),
  trigger_type: z.string().min(1),
  effective_at: utcTimestampSchema,
  expires_at: utcTimestampSchema.nullable(),
  strength_multiplier: z.number().min(0).max(2),
  verification_state: z.enum(['verified', 'unverified']),
  evidence_json: z.string().min(1),
  created_at: utcTimestampSchema,
}).strict();

const storedEvaluationRowSchema = z.object({
  id: idSchema,
  prospect_id: idSchema,
  rule_version_id: idSchema,
  decision_kind: z.enum(['evaluated', 'not_prioritizable']),
  evaluated_at: utcTimestampSchema,
  fit_points: z.number().int().min(0).max(30).nullable(),
  fit_band: z.enum(['low', 'medium', 'high']).nullable(),
  timing_millipoints: z.number().int().min(0).max(40_000).nullable(),
  timing_band: z.enum(['cold', 'warm', 'hot']).nullable(),
  reachability: z.enum(['direct', 'indirect', 'none']).nullable(),
  data_confidence: z.number().int().min(0).max(10).nullable(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).nullable(),
  earliest_trigger_expires_at: utcTimestampSchema.nullable(),
  verify_first: z.union([z.literal(0), z.literal(1)]).nullable(),
  last_contact_activity_id: idSchema.nullable(),
  last_contact_at: utcTimestampSchema.nullable(),
  qualification_json: z.string().nullable(),
  command_json: z.string().min(1),
  input_snapshot_json: z.string().min(1),
  result_json: z.string().min(1),
  explanation_json: z.string().min(1),
  created_at: utcTimestampSchema,
}).strict();

const storedProjectionRowSchema = z.object({
  prospect_id: idSchema,
  rule_version_id: idSchema,
  evaluation_id: idSchema,
  decision_kind: z.literal('evaluated'),
  fit_points: z.number().int().min(0).max(30),
  fit_band: z.enum(['low', 'medium', 'high']),
  timing_millipoints: z.number().int().min(0).max(40_000),
  timing_band: z.enum(['cold', 'warm', 'hot']),
  reachability: z.enum(['direct', 'indirect', 'none']),
  data_confidence: z.number().int().min(0).max(10),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']),
  earliest_trigger_expires_at: utcTimestampSchema.nullable(),
  verify_first: z.union([z.literal(0), z.literal(1)]),
  last_contact_activity_id: idSchema.nullable(),
  last_contact_at: utcTimestampSchema.nullable(),
  version: z.number().int().positive(),
  evaluated_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();

const storedOverrideRowSchema = z.object({
  id: idSchema,
  prospect_id: idSchema,
  override_kind: z.enum(['priority', 'pin_to_top', 'snooze', 'dismiss']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).nullable(),
  reason: z.string().trim().min(1),
  expires_at: utcTimestampSchema,
  created_at: utcTimestampSchema,
  status: z.enum(['active', 'expired']),
  expired_at: utcTimestampSchema.nullable(),
}).strict().superRefine((row, context) => {
  if ((row.override_kind === 'priority') !== (row.priority !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Priority controls require a priority.' });
  }
  if ((row.status === 'expired') !== (row.expired_at !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expired controls require expired_at.' });
  }
  if (row.expires_at <= row.created_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Controls require expires_at after created_at.' });
  }
});

const storedPreferenceRowSchema = z.object({
  id: idSchema,
  control_id: idSchema.nullable(),
  controlled_prospect_id: idSchema.nullable(),
  action_kind: z.enum([
    'acted_out_of_order', 'snoozed', 'dismissed', 'reordered',
    'priority_overridden', 'pinned',
  ]),
  winner_prospect_id: idSchema,
  winner_evaluation_id: idSchema,
  winner_decision_kind: z.literal('evaluated'),
  loser_prospect_id: idSchema,
  loser_evaluation_id: idSchema,
  loser_decision_kind: z.literal('evaluated'),
  observed_at: utcTimestampSchema,
  context_json: z.string().min(1),
  created_at: utcTimestampSchema,
}).strict();

const preferenceContextSchema = z.object({
  formatVersion: z.literal(1),
  reason: z.string().trim().min(1),
}).strict();

const ruleDocumentSchema = z.object({
  formatVersion: z.literal(1),
  id: idSchema,
  version: z.number().int().positive(),
  fit: z.unknown(),
  confidence: z.unknown(),
  timing: z.unknown(),
}).passthrough();

export type ProjectionCasUpdate = Readonly<{
  prospectId: string;
  expectedVersion: number;
  projection: Omit<ProspectPriorityProjection, 'version'>;
}>;

export type ProjectionCasDelete = Readonly<{
  prospectId: string;
  expectedVersion: number;
}>;

export type OverrideExpirationCas = Readonly<{
  controlId: string;
  prospectId: string;
  expectedStatus: 'active';
  expectedExpiresAt: string;
  newExpiresAt: string;
  expiredAt: string;
}>;

export type PrioritizationRuleVersion = Readonly<{
  id: string;
  version: number;
  contentHash: string;
  document: PrioritizationRuleDocument;
  createdAt: string;
}>;

const RULE_COLUMNS = 'id, version, content_hash, rules_json, created_at';
const TRIGGER_COLUMNS = `
  id, prospect_id, source_event_id, reactivation_receipt_activation_key,
  reactivation_rule_id, trigger_type, effective_at, expires_at,
  strength_multiplier, verification_state, evidence_json, created_at
`;
const EVALUATION_COLUMNS = `
  id, prospect_id, rule_version_id, decision_kind, evaluated_at, fit_points,
  fit_band, timing_millipoints, timing_band, reachability, data_confidence,
  priority, earliest_trigger_expires_at, verify_first, last_contact_activity_id,
  last_contact_at, qualification_json, command_json, input_snapshot_json,
  result_json, explanation_json, created_at
`;
const PROJECTION_COLUMNS = `
  prospect_id, rule_version_id, evaluation_id, decision_kind, fit_points,
  fit_band, timing_millipoints, timing_band, reachability, data_confidence,
  priority, earliest_trigger_expires_at, verify_first, last_contact_activity_id,
  last_contact_at, version, evaluated_at, updated_at
`;
const OVERRIDE_COLUMNS = `
  id, prospect_id, override_kind, priority, reason, expires_at, created_at,
  status, expired_at
`;
const PREFERENCE_COLUMNS = `
  id, control_id, controlled_prospect_id, action_kind, winner_prospect_id,
  winner_evaluation_id, winner_decision_kind, loser_prospect_id,
  loser_evaluation_id, loser_decision_kind, observed_at, context_json,
  created_at
`;

function canonicalJsonOrCorrupt<T>(text: string, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PrioritizationInputCorruptionError(`${label} JSON is malformed.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PrioritizationInputCorruptionError(`${label} JSON failed strict validation.`);
  }
  return parsed.data;
}

export class PrioritizationRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  installRuleVersion(input: PrioritizationRuleDocument & { contentHash?: string }): PrioritizationRuleVersion {
    this.unitOfWork.assertWriteScope();
    const document = ruleDocumentSchema.parse(input);
    const body: Record<string, unknown> = { ...document };
    delete body.contentHash;
    const contentHash = computeRuleContentHash(body);
    if (input.contentHash !== undefined && input.contentHash !== contentHash) {
      throw new PrioritizationRuleConflictError('Rule content hash does not match the canonical document.');
    }
    const canonicalJson = canonicalRuleJson(body);
    const existingById = this.getRuleVersion(document.id);
    const existingByVersion = this.getRuleVersionByVersion(document.version);
    if (existingById !== null) {
      if (
        existingById.version === document.version
        && existingById.contentHash === contentHash
        && canonicalRuleJson(existingById.document) === canonicalJson
      ) {
        return existingById;
      }
      throw new PrioritizationRuleConflictError('Rule ID already exists with different content.');
    }
    if (existingByVersion !== null) {
      throw new PrioritizationRuleConflictError('Rule version already exists with different content.');
    }
    const now = utcTimestampSchema.parse(this.clock.now());
    const row = this.database.raw.prepare(`
      INSERT INTO prioritization_rule_versions (${RULE_COLUMNS})
      VALUES (?, ?, ?, ?, ?)
      RETURNING ${RULE_COLUMNS}
    `).get(document.id, document.version, contentHash, canonicalJson, now);
    return parseRuleVersion(row);
  }

  getRuleVersion(id: string): PrioritizationRuleVersion | null {
    const row = this.database.raw.prepare(`
      SELECT ${RULE_COLUMNS} FROM prioritization_rule_versions WHERE id = ?
    `).get(idSchema.parse(id));
    return row === undefined ? null : parseRuleVersion(row);
  }

  getRuleVersionByVersion(version: number): PrioritizationRuleVersion | null {
    const row = this.database.raw.prepare(`
      SELECT ${RULE_COLUMNS} FROM prioritization_rule_versions WHERE version = ?
    `).get(z.number().int().positive().parse(version));
    return row === undefined ? null : parseRuleVersion(row);
  }

  getActiveRuleVersion(): PrioritizationRuleVersion | null {
    const pointer = this.database.raw.prepare(`
      SELECT active_prioritization_rule_version_id AS id
      FROM workspace_settings WHERE singleton = 1
    `).get() as { id: string | null } | undefined;
    if (pointer === undefined || pointer.id === null) return null;
    const rule = this.getRuleVersion(pointer.id);
    if (rule === null) {
      throw new PrioritizationInputCorruptionError('Active rule pointer names a missing rule version.');
    }
    return rule;
  }

  activateRuleVersion(input: {
    ruleVersionId: string;
    expectedActiveRuleVersionId: string | null;
  }): PrioritizationRuleVersion {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      ruleVersionId: idSchema,
      expectedActiveRuleVersionId: idSchema.nullable(),
    }).strict().parse(input);
    const rule = this.getRuleVersion(parsed.ruleVersionId);
    if (rule === null) {
      throw new PrioritizationRuleConflictError('Cannot activate a rule version that is not installed.');
    }
    const result = this.database.raw.prepare(`
      UPDATE workspace_settings
      SET active_prioritization_rule_version_id = ?, updated_at = ?
      WHERE singleton = 1
        AND active_prioritization_rule_version_id IS ?
    `).run(
      parsed.ruleVersionId,
      utcTimestampSchema.parse(this.clock.now()),
      parsed.expectedActiveRuleVersionId,
    );
    if (result.changes === 0) {
      throw new PrioritizationStaleWriteError('The active rule pointer changed before activation.');
    }
    return rule;
  }

  getTriggerEventById(id: string): TriggerEvent | null {
    const row = this.database.raw.prepare(`
      SELECT ${TRIGGER_COLUMNS} FROM trigger_events WHERE id = ?
    `).get(idSchema.parse(id));
    return row === undefined ? null : parseTriggerEventRow(row);
  }

  getTriggerEventBySourceEvent(sourceEventId: string): TriggerEvent | null {
    const row = this.database.raw.prepare(`
      SELECT ${TRIGGER_COLUMNS} FROM trigger_events WHERE source_event_id = ?
    `).get(idSchema.parse(sourceEventId));
    return row === undefined ? null : parseTriggerEventRow(row);
  }

  getTriggerEventByActivationKey(activationKey: string): TriggerEvent | null {
    const row = this.database.raw.prepare(`
      SELECT ${TRIGGER_COLUMNS} FROM trigger_events
      WHERE reactivation_receipt_activation_key = ?
    `).get(idSchema.parse(activationKey));
    return row === undefined ? null : parseTriggerEventRow(row);
  }

  listTriggerEvents(prospectId: string): TriggerEvent[] {
    const rows = this.database.raw.prepare(`
      SELECT ${TRIGGER_COLUMNS} FROM trigger_events
      WHERE prospect_id = ?
      ORDER BY id
    `).all(idSchema.parse(prospectId));
    return rows.map(parseTriggerEventRow);
  }

  appendTriggerEvent(input: TriggerEvent): TriggerEvent {
    this.unitOfWork.assertWriteScope();
    const evidence = parseTriggerEvidence(input.evidence);
    const row = this.database.raw.prepare(`
      INSERT INTO trigger_events (${TRIGGER_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${TRIGGER_COLUMNS}
    `).get(
      idSchema.parse(input.id),
      idSchema.parse(input.prospectId),
      input.sourceEventId,
      input.reactivationReceiptActivationKey,
      input.reactivationRuleId,
      input.triggerType,
      utcTimestampSchema.parse(input.effectiveAt),
      input.expiresAt === null ? null : utcTimestampSchema.parse(input.expiresAt),
      input.strengthMultiplier,
      input.verificationState,
      JSON.stringify(evidence),
      utcTimestampSchema.parse(input.createdAt),
    );
    return parseTriggerEventRow(row);
  }

  /**
   * Cloud-computed axes on the prospect row (Task 5). Both null until a
   * scorer re-emission lands; tiebreaker/display data only.
   */
  loadCloudScoreAxes(prospectId: string): {
    cloudFit: number | null;
    cloudTiming: number | null;
  } {
    const row = this.database.raw.prepare(
      'SELECT cloud_fit, cloud_timing FROM prospects WHERE id = ?',
    ).get(idSchema.parse(prospectId)) as {
      cloud_fit: number | null; cloud_timing: number | null;
    } | undefined;
    return {
      cloudFit: row?.cloud_fit ?? null,
      cloudTiming: row?.cloud_timing ?? null,
    };
  }

  loadQualificationInputs(prospectId: string): QualificationInputSnapshot {
    const row = this.database.raw.prepare(`
      SELECT
        prospect.id AS prospect_id,
        prospect.person_id AS person_id,
        prospect.qualification_state AS qualification_state,
        prospect.qualification_gate_reason AS qualification_gate_reason,
        prospect.original_source_event_id AS original_source_event_id,
        person.deleted_at AS person_deleted_at
      FROM prospects AS prospect
      JOIN persons AS person ON person.id = prospect.person_id
      WHERE prospect.id = ?
    `).get(idSchema.parse(prospectId));
    if (row === undefined) {
      throw new PrioritizationInputCorruptionError('Prioritization requires an existing canonical Prospect.');
    }
    const parsed = z.object({
      prospect_id: idSchema,
      person_id: idSchema,
      qualification_state: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
      qualification_gate_reason: gateReasonSchema.nullable(),
      original_source_event_id: idSchema,
      person_deleted_at: utcTimestampSchema.nullable(),
    }).strict().parse(row);
    return Object.freeze({
      prospectId: parsed.prospect_id,
      personId: parsed.person_id,
      qualificationState: parsed.qualification_state,
      qualificationGateReason: parsed.qualification_gate_reason,
      personDeletedAt: parsed.person_deleted_at,
      originalSourceEventId: parsed.original_source_event_id,
    });
  }

  loadQualifiedEvaluationInputs(prospectId: string): QualifiedInputSnapshot {
    const identity = this.loadQualificationInputs(prospectId);
    const sourceRow = this.database.raw.prepare(`
      SELECT id, channel, observed_at, evidence_ref
      FROM source_events
      WHERE id = ? AND person_id = ?
    `).get(identity.originalSourceEventId, identity.personId);
    if (sourceRow === undefined) {
      throw new PrioritizationInputCorruptionError('Original SourceEvent ownership is inconsistent.');
    }
    const source = z.object({
      id: idSchema,
      channel: z.string().min(1),
      observed_at: utcTimestampSchema,
      evidence_ref: z.string().nullable(),
    }).strict().parse(sourceRow);

    const propertyRows = this.database.raw.prepare(`
      SELECT
        property.id AS id,
        property.door_count AS door_count,
        property.country_code AS country_code,
        property.region AS region,
        property.locality AS locality,
        property.verified_at AS verified_at,
        property.maintenance_profile_json AS maintenance_profile_json
      FROM prospect_properties AS link
      JOIN properties AS property ON property.id = link.property_id
      WHERE link.prospect_id = ?
      ORDER BY property.id
    `).all(identity.prospectId);
    const properties: PropertyFact[] = propertyRows.map((value) => {
      const parsed = z.object({
        id: idSchema,
        door_count: z.number().int().nonnegative().nullable(),
        country_code: z.string().length(2),
        region: z.string().min(1),
        locality: z.string().min(1),
        verified_at: utcTimestampSchema.nullable(),
        maintenance_profile_json: z.string().nullable(),
      }).strict().parse(value);
      return Object.freeze({
        id: parsed.id,
        doorCount: parsed.door_count,
        countryCode: parsed.country_code,
        region: parsed.region,
        locality: parsed.locality,
        verifiedAt: parsed.verified_at,
        maintenanceProfile: parsed.maintenance_profile_json === null
          ? null
          : parseMaintenanceProfileV1(JSON.parse(parsed.maintenance_profile_json) as unknown),
      });
    });

    const contactRows = this.database.raw.prepare(`
      SELECT id, kind, validation_state, reachability
      FROM person_contact_methods
      WHERE person_id = ?
      ORDER BY id
    `).all(identity.personId);
    const contactMethods: ContactMethodFact[] = contactRows.map((value) => {
      const parsed = z.object({
        id: idSchema,
        kind: z.enum(['phone', 'email']),
        validation_state: z.enum(['unverified', 'valid', 'invalid']),
        reachability: z.enum(['direct', 'indirect', 'none']),
      }).strict().parse(value);
      return Object.freeze({
        id: parsed.id,
        kind: parsed.kind,
        validationState: parsed.validation_state,
        reachability: parsed.reachability,
      });
    });

    return Object.freeze({
      prospectId: identity.prospectId,
      personId: identity.personId,
      originalSource: Object.freeze({
        id: source.id,
        channel: source.channel,
        observedAt: source.observed_at,
        evidenceRef: source.evidence_ref,
      }),
      properties: Object.freeze(properties),
      contactMethods: Object.freeze(contactMethods),
      lastContact: null,
      triggerEvents: Object.freeze(this.listTriggerEvents(identity.prospectId)),
    });
  }

  /**
   * The authoritative last-contact fact derived from immutable Activities at
   * or before `evaluatedAt`, never from `prospects.last_contact_at`. Selects
   * the greatest canonical `(occurred_at, id COLLATE BINARY)` qualifying pair;
   * a qualifying Activity after `evaluatedAt` makes the input corrupt.
   */
  loadQualifyingLastContact(prospectId: string, evaluatedAt: string): LastContactEvidence | null {
    const prospect = idSchema.parse(prospectId);
    const boundary = utcTimestampSchema.parse(evaluatedAt);
    const rows = this.database.raw.prepare(`
      SELECT id, prospect_id, kind, direction, occurred_at, observed_outcome
      FROM activities
      WHERE prospect_id = ?
      ORDER BY occurred_at DESC, id COLLATE BINARY DESC
    `).all(prospect);
    let best: LastContactEvidence | null = null;
    for (const value of rows) {
      const parsed = z.object({
        id: idSchema,
        prospect_id: idSchema,
        kind: z.enum([
          'call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system',
        ]),
        direction: z.enum(['inbound', 'outbound', 'internal']),
        occurred_at: utcTimestampSchema,
        observed_outcome: z.string().nullable(),
      }).strict().parse(value);
      if (!qualifiesContactEvidence({
        prospectId: parsed.prospect_id,
        kind: parsed.kind,
        direction: parsed.direction,
        observedOutcome: parsed.observed_outcome,
      }, prospect)) continue;
      if (parsed.occurred_at > boundary) {
        throw new PrioritizationInputCorruptionError(
          'A qualifying Activity after evaluatedAt corrupts the evaluation input.',
        );
      }
      if (best === null) {
        best = Object.freeze({ activityId: parsed.id, occurredAt: parsed.occurred_at });
      }
    }
    return best;
  }

  getEvaluationById(id: string): PrioritizationEvaluation | null {
    const row = this.database.raw.prepare(`
      SELECT ${EVALUATION_COLUMNS} FROM prioritization_evaluations WHERE id = ?
    `).get(idSchema.parse(id));
    return row === undefined ? null : parseEvaluationRow(row);
  }

  getStoredEvaluationCommand(id: string): { commandJson: string; resultJson: string } | null {
    const row = this.database.raw.prepare(`
      SELECT command_json, result_json FROM prioritization_evaluations WHERE id = ?
    `).get(idSchema.parse(id)) as { command_json: string; result_json: string } | undefined;
    if (row === undefined) return null;
    return { commandJson: row.command_json, resultJson: row.result_json };
  }

  getEvaluationInputSnapshot(id: string): string | null {
    const row = this.database.raw.prepare(`
      SELECT input_snapshot_json FROM prioritization_evaluations WHERE id = ?
    `).get(idSchema.parse(id)) as { input_snapshot_json: string } | undefined;
    return row === undefined ? null : row.input_snapshot_json;
  }

  appendEvaluation(input: {
    evaluation: PrioritizationEvaluation;
    commandJson: string;
    inputSnapshotJson: string;
    resultJson: string;
  }): PrioritizationEvaluation {
    this.unitOfWork.assertWriteScope();
    const evaluation = input.evaluation;
    const isEvaluated = evaluation.decisionKind === 'evaluated';
    const row = this.database.raw.prepare(`
      INSERT INTO prioritization_evaluations (${EVALUATION_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${EVALUATION_COLUMNS}
    `).get(
      idSchema.parse(evaluation.id),
      idSchema.parse(evaluation.prospectId),
      idSchema.parse(evaluation.ruleVersionId),
      evaluation.decisionKind,
      utcTimestampSchema.parse(evaluation.evaluatedAt),
      isEvaluated ? evaluation.fitPoints : null,
      isEvaluated ? evaluation.fitBand : null,
      isEvaluated ? evaluation.timingMilliPoints : null,
      isEvaluated ? evaluation.timingBand : null,
      isEvaluated ? evaluation.reachability : null,
      isEvaluated ? evaluation.dataConfidence : null,
      isEvaluated ? evaluation.priority : null,
      isEvaluated ? evaluation.earliestTriggerExpiresAt : null,
      isEvaluated ? (evaluation.verifyFirst ? 1 : 0) : null,
      isEvaluated ? evaluation.lastContactActivityId : null,
      isEvaluated ? evaluation.lastContactAt : null,
      isEvaluated ? null : JSON.stringify(evaluation.qualification),
      input.commandJson,
      input.inputSnapshotJson,
      input.resultJson,
      JSON.stringify(evaluation.explanation),
      utcTimestampSchema.parse(this.clock.now()),
    );
    return parseEvaluationRow(row);
  }

  getProjection(prospectId: string): ProspectPriorityProjection | null {
    const row = this.database.raw.prepare(`
      SELECT ${PROJECTION_COLUMNS} FROM prospect_priority_projection WHERE prospect_id = ?
    `).get(idSchema.parse(prospectId));
    return row === undefined ? null : parseProjectionRow(row);
  }

  insertProjection(input: ProspectPriorityProjection): ProspectPriorityProjection {
    this.unitOfWork.assertWriteScope();
    const row = this.database.raw.prepare(`
      INSERT INTO prospect_priority_projection (${PROJECTION_COLUMNS})
      VALUES (?, ?, ?, 'evaluated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${PROJECTION_COLUMNS}
    `).get(
      idSchema.parse(input.prospectId),
      idSchema.parse(input.ruleVersionId),
      idSchema.parse(input.evaluationId),
      input.fitPoints,
      input.fitBand,
      input.timingMilliPoints,
      input.timingBand,
      input.reachability,
      input.dataConfidence,
      input.priority,
      input.earliestTriggerExpiresAt,
      input.verifyFirst ? 1 : 0,
      input.lastContactActivityId,
      input.lastContactAt,
      input.version,
      utcTimestampSchema.parse(input.evaluatedAt),
      utcTimestampSchema.parse(input.updatedAt),
    );
    return parseProjectionRow(row);
  }

  updateProjectionCas(input: ProjectionCasUpdate): ProspectPriorityProjection {
    this.unitOfWork.assertWriteScope();
    const projection = input.projection;
    const row = this.database.raw.prepare(`
      UPDATE prospect_priority_projection
      SET rule_version_id = ?, evaluation_id = ?, fit_points = ?, fit_band = ?,
          timing_millipoints = ?, timing_band = ?, reachability = ?,
          data_confidence = ?, priority = ?, earliest_trigger_expires_at = ?,
          verify_first = ?, last_contact_activity_id = ?, last_contact_at = ?,
          version = version + 1, evaluated_at = ?, updated_at = ?
      WHERE prospect_id = ? AND version = ?
      RETURNING ${PROJECTION_COLUMNS}
    `).get(
      idSchema.parse(projection.ruleVersionId),
      idSchema.parse(projection.evaluationId),
      projection.fitPoints,
      projection.fitBand,
      projection.timingMilliPoints,
      projection.timingBand,
      projection.reachability,
      projection.dataConfidence,
      projection.priority,
      projection.earliestTriggerExpiresAt,
      projection.verifyFirst ? 1 : 0,
      projection.lastContactActivityId,
      projection.lastContactAt,
      utcTimestampSchema.parse(projection.evaluatedAt),
      utcTimestampSchema.parse(projection.updatedAt),
      idSchema.parse(input.prospectId),
      z.number().int().positive().parse(input.expectedVersion),
    );
    if (row === undefined) {
      throw new PrioritizationStaleWriteError('The priority projection changed before this update.');
    }
    return parseProjectionRow(row);
  }

  deleteProjectionCas(input: ProjectionCasDelete): void {
    this.unitOfWork.assertWriteScope();
    const result = this.database.raw.prepare(`
      DELETE FROM prospect_priority_projection
      WHERE prospect_id = ? AND version = ?
    `).run(
      idSchema.parse(input.prospectId),
      z.number().int().positive().parse(input.expectedVersion),
    );
    if (result.changes === 0) {
      throw new PrioritizationStaleWriteError('The priority projection changed before this deletion.');
    }
  }

  getOverrideById(controlId: string): PriorityOverride | null {
    const row = this.database.raw.prepare(`
      SELECT ${OVERRIDE_COLUMNS} FROM priority_overrides WHERE id = ?
    `).get(idSchema.parse(controlId));
    return row === undefined ? null : parseOverrideRow(row);
  }

  createOverride(input: PriorityOverride): PriorityOverride {
    this.unitOfWork.assertWriteScope();
    if (input.status !== 'active' || input.expiredAt !== null) {
      throw new PrioritizationInputCorruptionError('New controls insert only active/NULL expired_at rows.');
    }
    if (utcTimestampSchema.parse(input.expiresAt) <= utcTimestampSchema.parse(input.createdAt)) {
      throw new PrioritizationInputCorruptionError('Controls require expiration after creation.');
    }
    const overlap = this.database.raw.prepare(`
      SELECT id FROM priority_overrides
      WHERE prospect_id = ? AND override_kind = ? AND status = 'active'
        AND created_at <= ? AND ? < expires_at
    `).get(input.prospectId, input.kind, input.createdAt, input.createdAt) as
      | { id: string }
      | undefined;
    if (overlap !== undefined) throw new PriorityControlOverlapError(input.kind);
    const row = this.database.raw.prepare(`
      INSERT INTO priority_overrides (${OVERRIDE_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)
      RETURNING ${OVERRIDE_COLUMNS}
    `).get(
      idSchema.parse(input.id),
      idSchema.parse(input.prospectId),
      input.kind,
      input.priority,
      z.string().trim().min(1).parse(input.reason),
      input.expiresAt,
      input.createdAt,
    );
    return parseOverrideRow(row);
  }

  /**
   * Historical name: returns rows effective at explicit `asOf` by persisted
   * status and half-open interval. Never consults wall time.
   */
  listActiveOverrides(prospectId: string, asOf: string): PriorityOverride[] {
    const boundary = utcTimestampSchema.parse(asOf);
    const rows = this.database.raw.prepare(`
      SELECT ${OVERRIDE_COLUMNS} FROM priority_overrides
      WHERE prospect_id = ? AND status = 'active'
        AND created_at <= ? AND ? < expires_at
      ORDER BY override_kind, created_at, id
    `).all(idSchema.parse(prospectId), boundary, boundary);
    return rows.map(parseOverrideRow);
  }

  listOverrides(prospectId: string): PriorityOverride[] {
    const rows = this.database.raw.prepare(`
      SELECT ${OVERRIDE_COLUMNS} FROM priority_overrides
      WHERE prospect_id = ?
      ORDER BY override_kind, created_at, id
    `).all(idSchema.parse(prospectId));
    return rows.map(parseOverrideRow);
  }

  /**
   * Natural expiration sweep in stable order. Leaves expires_at unchanged and
   * is idempotent at the same asOf.
   */
  sweepExpiredControls(input: {
    prospectId: string;
    asOf: string;
  }): readonly PriorityOverride[] {
    this.unitOfWork.assertWriteScope();
    const boundary = utcTimestampSchema.parse(input.asOf);
    const prospect = idSchema.parse(input.prospectId);
    const candidates = this.database.raw.prepare(`
      SELECT id FROM priority_overrides
      WHERE prospect_id = ? AND status = 'active' AND expires_at <= ?
      ORDER BY prospect_id, override_kind, created_at, id
    `).all(prospect, boundary) as { id: string }[];
    const swept: PriorityOverride[] = [];
    for (const { id } of candidates) {
      const row = this.database.raw.prepare(`
        UPDATE priority_overrides
        SET status = 'expired', expired_at = ?
        WHERE id = ? AND status = 'active' AND expires_at <= ?
        RETURNING ${OVERRIDE_COLUMNS}
      `).get(boundary, id, boundary);
      if (row !== undefined) swept.push(parseOverrideRow(row));
    }
    return Object.freeze(swept);
  }

  /**
   * Explicit retirement: shortens expires_at to the exact expiration time and
   * expires the row one-way in one guarded statement.
   */
  expireOverrideCas(input: OverrideExpirationCas): PriorityOverride {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      controlId: idSchema,
      prospectId: idSchema,
      expectedStatus: z.literal('active'),
      expectedExpiresAt: utcTimestampSchema,
      newExpiresAt: utcTimestampSchema,
      expiredAt: utcTimestampSchema,
    }).strict().parse(input);
    if (parsed.newExpiresAt !== parsed.expiredAt) {
      throw new PrioritizationInputCorruptionError('Explicit retirement requires newExpiresAt=expiredAt.');
    }
    if (parsed.newExpiresAt > parsed.expectedExpiresAt) {
      throw new PrioritizationInputCorruptionError('Controls may only shorten expiration.');
    }
    const row = this.database.raw.prepare(`
      UPDATE priority_overrides
      SET expires_at = ?, status = 'expired', expired_at = ?
      WHERE id = ? AND prospect_id = ? AND status = 'active' AND expires_at = ?
      RETURNING ${OVERRIDE_COLUMNS}
    `).get(
      parsed.newExpiresAt,
      parsed.expiredAt,
      parsed.controlId,
      parsed.prospectId,
      parsed.expectedExpiresAt,
    );
    if (row === undefined) {
      throw new PrioritizationStaleWriteError('The priority control changed before retirement.');
    }
    return parseOverrideRow(row);
  }

  getPreferenceEventById(id: string): PrioritizationPreferenceEvent | null {
    const row = this.database.raw.prepare(`
      SELECT ${PREFERENCE_COLUMNS} FROM prioritization_preference_events WHERE id = ?
    `).get(idSchema.parse(id));
    return row === undefined ? null : parsePreferenceRow(row);
  }

  listPreferenceEvents(prospectId: string): PrioritizationPreferenceEvent[] {
    const prospect = idSchema.parse(prospectId);
    const rows = this.database.raw.prepare(`
      SELECT ${PREFERENCE_COLUMNS} FROM prioritization_preference_events
      WHERE winner_prospect_id = ? OR loser_prospect_id = ?
      ORDER BY observed_at, id
    `).all(prospect, prospect);
    return rows.map(parsePreferenceRow);
  }

  appendPreferenceEvent(input: PrioritizationPreferenceEvent): PrioritizationPreferenceEvent {
    this.unitOfWork.assertWriteScope();
    const context = preferenceContextSchema.parse(input.context);
    const row = this.database.raw.prepare(`
      INSERT INTO prioritization_preference_events (${PREFERENCE_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, 'evaluated', ?, ?, 'evaluated', ?, ?, ?)
      RETURNING ${PREFERENCE_COLUMNS}
    `).get(
      idSchema.parse(input.id),
      input.controlId,
      input.controlledProspectId,
      input.action,
      idSchema.parse(input.winnerProspectId),
      idSchema.parse(input.winnerEvaluationId),
      idSchema.parse(input.loserProspectId),
      idSchema.parse(input.loserEvaluationId),
      utcTimestampSchema.parse(input.observedAt),
      JSON.stringify(context),
      utcTimestampSchema.parse(input.createdAt),
    );
    return parsePreferenceRow(row);
  }
}

function parseRuleVersion(value: unknown): PrioritizationRuleVersion {
  const row = storedRuleRowSchema.parse(value);
  const document = canonicalJsonOrCorrupt(
    row.rules_json, ruleDocumentSchema, 'Rule document',
  ) as unknown as PrioritizationRuleDocument;
  if (document.id !== row.id || document.version !== row.version) {
    throw new PrioritizationInputCorruptionError('Stored rule JSON names a different rule identity.');
  }
  const body: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  delete body.contentHash;
  if (computeRuleContentHash(body) !== row.content_hash) {
    throw new PrioritizationInputCorruptionError('Stored rule content hash mismatch.');
  }
  return Object.freeze({
    id: row.id,
    version: row.version,
    contentHash: row.content_hash,
    document: Object.freeze(document),
    createdAt: row.created_at,
  });
}

function parseTriggerEventRow(value: unknown): TriggerEvent {
  const row = storedTriggerRowSchema.parse(value);
  const evidence = parseTriggerEvidence(JSON.parse(row.evidence_json) as unknown);
  if (evidence.triggerType !== row.trigger_type) {
    throw new PrioritizationInputCorruptionError('Trigger evidence names a different stored key.');
  }
  if (row.trigger_type === 'nurture_resurrection') {
    if (evidence.proof.kind !== 'reactivation_rule_receipt'
      || row.reactivation_receipt_activation_key !== evidence.proof.activationKey
      || row.reactivation_rule_id !== evidence.proof.ruleId) {
      throw new PrioritizationInputCorruptionError('Receipt proof columns diverge from evidence.');
    }
  } else if (evidence.proof.kind !== 'source_event'
    || row.source_event_id !== evidence.proof.sourceEventId) {
    throw new PrioritizationInputCorruptionError('Source proof columns diverge from evidence.');
  }
  return Object.freeze({
    id: row.id,
    prospectId: row.prospect_id,
    sourceEventId: row.source_event_id,
    reactivationReceiptActivationKey: row.reactivation_receipt_activation_key,
    reactivationRuleId: row.reactivation_rule_id,
    triggerType: row.trigger_type as TriggerEvent['triggerType'],
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    strengthMultiplier: row.strength_multiplier,
    verificationState: row.verification_state,
    evidence,
    createdAt: row.created_at,
  });
}

function parseEvaluationRow(value: unknown): PrioritizationEvaluation {
  const row = storedEvaluationRowSchema.parse(value);
  const explanation = canonicalJsonOrCorrupt(
    row.explanation_json, z.array(prioritizationReasonSchema), 'Evaluation explanation',
  );
  if (row.decision_kind === 'evaluated') {
    return Object.freeze({
      decisionKind: 'evaluated' as const,
      id: row.id,
      prospectId: row.prospect_id,
      ruleVersionId: row.rule_version_id,
      evaluatedAt: row.evaluated_at,
      fitPoints: row.fit_points!,
      fitBand: row.fit_band!,
      timingMilliPoints: row.timing_millipoints!,
      timingBand: row.timing_band!,
      reachability: row.reachability!,
      dataConfidence: row.data_confidence!,
      priority: row.priority!,
      play: derivePlayFromResult(row.result_json),
      earliestTriggerExpiresAt: row.earliest_trigger_expires_at,
      verifyFirst: row.verify_first === 1,
      lastContactActivityId: row.last_contact_activity_id,
      lastContactAt: row.last_contact_at,
      explanation: Object.freeze(explanation),
    }) as PrioritizationEvaluation;
  }
  const qualification = canonicalJsonOrCorrupt(
    row.qualification_json!, qualificationResultSchema, 'Evaluation qualification',
  );
  if (qualification.prospectId !== row.prospect_id) {
    throw new PrioritizationInputCorruptionError('Qualification envelope names a different Prospect.');
  }
  return Object.freeze({
    decisionKind: 'not_prioritizable' as const,
    id: row.id,
    prospectId: row.prospect_id,
    ruleVersionId: row.rule_version_id,
    evaluatedAt: row.evaluated_at,
    qualification,
    explanation: Object.freeze(explanation),
  }) as PrioritizationEvaluation;
}

const resultEnvelopePlaySchema = z.object({ play: priorityPlaySchema }).passthrough();

function derivePlayFromResult(resultJson: string): z.infer<typeof priorityPlaySchema> {
  let value: unknown;
  try {
    value = JSON.parse(resultJson) as unknown;
  } catch {
    throw new PrioritizationInputCorruptionError('Evaluation result JSON is malformed.');
  }
  const parsed = resultEnvelopePlaySchema.safeParse(value);
  if (!parsed.success) {
    throw new PrioritizationInputCorruptionError('Evaluated result envelope requires the exact play.');
  }
  return parsed.data.play;
}

function parseProjectionRow(value: unknown): ProspectPriorityProjection {
  const row = storedProjectionRowSchema.parse(value);
  if ((row.last_contact_activity_id === null) !== (row.last_contact_at === null)) {
    throw new PrioritizationInputCorruptionError('Projection last-contact pair must be all-or-none.');
  }
  return Object.freeze({
    prospectId: row.prospect_id,
    ruleVersionId: row.rule_version_id,
    evaluationId: row.evaluation_id,
    fitPoints: row.fit_points,
    fitBand: row.fit_band,
    timingMilliPoints: row.timing_millipoints,
    timingBand: row.timing_band,
    reachability: row.reachability,
    dataConfidence: row.data_confidence,
    priority: row.priority,
    earliestTriggerExpiresAt: row.earliest_trigger_expires_at,
    verifyFirst: row.verify_first === 1,
    lastContactActivityId: row.last_contact_activity_id,
    lastContactAt: row.last_contact_at,
    version: row.version,
    evaluatedAt: row.evaluated_at,
    updatedAt: row.updated_at,
  });
}

function parseOverrideRow(value: unknown): PriorityOverride {
  const row = storedOverrideRowSchema.parse(value);
  return Object.freeze({
    id: row.id,
    prospectId: row.prospect_id,
    kind: row.override_kind,
    priority: row.priority,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    expiredAt: row.expired_at,
  });
}

function parsePreferenceRow(value: unknown): PrioritizationPreferenceEvent {
  const row = storedPreferenceRowSchema.parse(value);
  const context = canonicalJsonOrCorrupt(
    row.context_json, preferenceContextSchema, 'Preference context',
  );
  return Object.freeze({
    id: row.id,
    controlId: row.control_id,
    controlledProspectId: row.controlled_prospect_id,
    action: row.action_kind,
    winnerProspectId: row.winner_prospect_id,
    winnerEvaluationId: row.winner_evaluation_id,
    loserProspectId: row.loser_prospect_id,
    loserEvaluationId: row.loser_evaluation_id,
    observedAt: row.observed_at,
    context: Object.freeze(context),
    createdAt: row.created_at,
  });
}

export { parseTriggerEvidence };
