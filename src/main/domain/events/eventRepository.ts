import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import {
  ActivityMediaConsentError,
  DomainRepositoryDatabaseMismatchError,
  IdempotencyOwnershipConflictError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { IdGenerator } from '../support/idGenerator';
import type {
  Activity,
  ActivityAmendment,
  AppendActivityAmendmentInput,
  AppendActivityInput,
  AppendConsentPolicyRecordInput,
  AppendStageEventInput,
  ConsentPolicyRecord,
  StageEvent,
} from './eventTypes';

export type {
  Activity,
  ActivityAmendment,
  AppendActivityAmendmentInput,
  AppendActivityInput,
  AppendConsentPolicyRecordInput,
  AppendStageEventInput,
  ConsentPolicyRecord,
  StageEvent,
} from './eventTypes';
export type { ActivityKind } from './eventTypes';

const idSchema = z.string().trim().min(1);
const textSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
const lifecycleStageSchema = z.enum([
  'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
]);
const activityKindSchema = z.enum([
  'call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system',
]);
const jsonTextSchema = z.string().transform(parseStoredJson);

const appendActivityInputSchema = z.object({
  id: idSchema.optional(),
  personId: idSchema,
  prospectId: idSchema.nullable().optional(),
  salesCycleId: idSchema.nullable().optional(),
  cadenceEnrollmentId: idSchema.nullable().optional(),
  cadenceStepId: idSchema.nullable().optional(),
  cadenceComponentId: idSchema.nullable().optional(),
  kind: activityKindSchema,
  direction: z.enum(['inbound', 'outbound', 'internal']),
  channel: textSchema,
  occurredAt: utcTimestampSchema.optional(),
  durationSeconds: z.number().int().safe().nonnegative().nullable().optional(),
  observedOutcome: z.string().nullable().optional(),
  adapter: textSchema.nullable().optional(),
  providerIdempotencyKey: textSchema.nullable().optional(),
  providerReference: z.string().nullable().optional(),
  consentPolicyRecordId: idSchema.nullable().optional(),
  recordingStorageRef: textSchema.nullable().optional(),
  transcriptStorageRef: textSchema.nullable().optional(),
  metadata: z.unknown().optional(),
  noteText: z.string().trim().min(1).max(10_000).nullable().optional(),
  callOutcome: z.enum([
    'no_answer', 'voicemail', 'spoke', 'interview_booked', 'not_interested', 'opted_out',
  ]).nullable().optional(),
  callbackAt: utcTimestampSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.providerIdempotencyKey != null && value.adapter == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A provider idempotency key requires an adapter.',
      path: ['providerIdempotencyKey'],
    });
  }
  const cadenceEvidence = [
    value.cadenceEnrollmentId,
    value.cadenceStepId,
    value.cadenceComponentId,
  ];
  const presentEvidence = cadenceEvidence.filter((item) => item != null).length;
  if (presentEvidence !== 0 && (presentEvidence !== cadenceEvidence.length || value.salesCycleId == null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Cadence Activity evidence requires cycle, enrollment, step, and component IDs.',
      path: ['cadenceEnrollmentId'],
    });
  }
  if (value.noteText != null && value.kind !== 'note') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Founder note prose belongs only to note activities.',
      path: ['noteText'],
    });
  }
  if ((value.callOutcome != null || value.callbackAt != null) && value.kind !== 'call') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Call outcome fields belong only to call activities.',
      path: ['callOutcome'],
    });
  }
});

const appendActivityAmendmentInputSchema = z.object({
  id: idSchema.optional(),
  activityId: idSchema,
  amendmentKind: textSchema,
  correction: z.unknown(),
  reason: textSchema,
}).strict();

const appendStageEventInputSchema = z.object({
  id: idSchema.optional(),
  salesCycleId: idSchema,
  fromStage: lifecycleStageSchema.nullable(),
  toStage: lifecycleStageSchema,
  effectiveAt: utcTimestampSchema,
  confirmedAt: utcTimestampSchema.optional(),
  confirmationKind: z.enum(['mechanical', 'founder', 'backfill']),
  transitionSequence: z.number().int().safe().positive(),
  backfillProvenance: z.unknown().nullable().optional(),
}).strict().superRefine((value, context) => {
  const hasBackfill = value.backfillProvenance != null;
  if ((value.confirmationKind === 'backfill') !== hasBackfill) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Backfill stage events require backfill provenance and other events forbid it.',
      path: ['backfillProvenance'],
    });
  }
});

const appendConsentPolicyRecordInputSchema = z.object({
  id: idSchema.optional(),
  personId: idSchema,
  activityId: idSchema.nullable().optional(),
  policyKind: z.enum(['recording', 'cloud_processing', 'outbound']),
  policyVersion: textSchema,
  effectiveAt: utcTimestampSchema,
  decision: z.enum(['granted', 'denied', 'not_required', 'unknown']),
  evidence: z.unknown(),
}).strict();

const storedActivityRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  prospect_id: idSchema.nullable(),
  sales_cycle_id: idSchema.nullable(),
  cadence_enrollment_id: idSchema.nullable(),
  cadence_step_id: idSchema.nullable(),
  cadence_component_id: idSchema.nullable(),
  kind: activityKindSchema,
  direction: z.enum(['inbound', 'outbound', 'internal']),
  channel: textSchema,
  occurred_at: utcTimestampSchema,
  duration_seconds: z.number().int().safe().nonnegative().nullable(),
  observed_outcome: z.string().nullable(),
  adapter: textSchema.nullable(),
  provider_idempotency_key: textSchema.nullable(),
  provider_reference: z.string().nullable(),
  consent_policy_record_id: idSchema.nullable(),
  recording_storage_ref: textSchema.nullable(),
  transcript_storage_ref: textSchema.nullable(),
  metadata_json: jsonTextSchema,
  created_at: utcTimestampSchema,
  note_text: z.string().nullable(),
  call_outcome: z.enum([
    'no_answer', 'voicemail', 'spoke', 'interview_booked', 'not_interested', 'opted_out',
  ]).nullable(),
  callback_at: utcTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  const cadenceEvidence = [
    value.cadence_enrollment_id,
    value.cadence_step_id,
    value.cadence_component_id,
  ];
  const presentEvidence = cadenceEvidence.filter((item) => item !== null).length;
  if (presentEvidence !== 0 && (presentEvidence !== cadenceEvidence.length || value.sales_cycle_id === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stored cadence evidence must include cycle, enrollment, step, and component IDs.',
      path: ['cadence_enrollment_id'],
    });
  }
});

const storedActivityAmendmentRowSchema = z.object({
  id: idSchema,
  activity_id: idSchema,
  amendment_kind: textSchema,
  correction_json: jsonTextSchema,
  reason: textSchema,
  created_at: utcTimestampSchema,
}).strict();

const storedStageEventRowSchema = z.object({
  id: idSchema,
  sales_cycle_id: idSchema,
  from_stage: lifecycleStageSchema.nullable(),
  to_stage: lifecycleStageSchema,
  effective_at: utcTimestampSchema,
  confirmed_at: utcTimestampSchema,
  confirmation_kind: z.enum(['mechanical', 'founder', 'backfill']),
  transition_sequence: z.number().int().safe().positive(),
  backfill_provenance_json: jsonTextSchema.nullable(),
  created_at: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  const hasBackfill = value.backfill_provenance_json != null;
  if ((value.confirmation_kind === 'backfill') !== hasBackfill) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stored stage-event backfill provenance is invalid.',
      path: ['backfill_provenance_json'],
    });
  }
});

const storedConsentPolicyRecordRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  activity_id: idSchema.nullable(),
  policy_kind: z.enum(['recording', 'cloud_processing', 'outbound']),
  policy_version: textSchema,
  effective_at: utcTimestampSchema,
  decision: z.enum(['granted', 'denied', 'not_required', 'unknown']),
  evidence_json: jsonTextSchema,
  created_at: utcTimestampSchema,
}).strict();
const storedMediaConsentRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  activity_id: idSchema.nullable(),
  policy_kind: z.enum(['recording', 'cloud_processing', 'outbound']),
  effective_at: utcTimestampSchema,
  decision: z.enum(['granted', 'denied', 'not_required', 'unknown']),
}).strict();

const activityColumns = `
  id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
  cadence_step_id, cadence_component_id,
  kind, direction,
  channel, occurred_at, duration_seconds, observed_outcome, adapter,
  provider_idempotency_key, provider_reference, consent_policy_record_id,
  recording_storage_ref, transcript_storage_ref, metadata_json, created_at,
  note_text, call_outcome, callback_at
`;
const amendmentColumns = `
  id, activity_id, amendment_kind, correction_json, reason, created_at
`;
const stageEventColumns = `
  id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
  confirmation_kind, transition_sequence, backfill_provenance_json, created_at
`;
const consentColumns = `
  id, person_id, activity_id, policy_kind, policy_version, effective_at,
  decision, evidence_json, created_at
`;

export class EventRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
    ids: IdGenerator;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  appendActivity(input: AppendActivityInput): Activity {
    this.unitOfWork.assertWriteScope();
    const parsed = appendActivityInputSchema.parse(input);
    const metadataJson = serializeJson(parsed.metadata ?? {}, 'activity metadata');
    const adapter = parsed.adapter ?? null;
    const providerKey = parsed.providerIdempotencyKey ?? null;
    const recordingStorageRef = parsed.recordingStorageRef ?? null;
    const transcriptStorageRef = parsed.transcriptStorageRef ?? null;
    const hasSuppliedMedia = recordingStorageRef !== null || transcriptStorageRef !== null;

    if (adapter !== null && providerKey !== null) {
      const existing = this.database.raw.prepare(`
        SELECT ${activityColumns}
        FROM activities
        WHERE adapter = ? AND provider_idempotency_key = ?
      `).get(adapter, providerKey);
      if (existing !== undefined) {
        const canonical = this.parseAndValidateActivity(existing);
        if (
          canonical.personId !== parsed.personId
          || canonical.prospectId !== (parsed.prospectId ?? null)
          || canonical.salesCycleId !== (parsed.salesCycleId ?? null)
          || canonical.cadenceEnrollmentId !== (parsed.cadenceEnrollmentId ?? null)
          || canonical.cadenceStepId !== (parsed.cadenceStepId ?? null)
          || canonical.cadenceComponentId !== (parsed.cadenceComponentId ?? null)
          || (parsed.cadenceEnrollmentId != null && canonical.channel !== parsed.channel)
        ) {
          throw new IdempotencyOwnershipConflictError(adapter, providerKey);
        }
        if (parsed.id !== undefined && canonical.id !== parsed.id) {
          if (this.getActivity(parsed.id) !== null) {
            throw new Error('The Activity ID and provider idempotency key identify different rows.');
          }
        }
        if (hasSuppliedMedia) {
          this.assertApplicableRecordingConsent({
            personId: parsed.personId,
            consentPolicyRecordId: parsed.consentPolicyRecordId ?? null,
            activityId: canonical.id,
            occurredAt: canonical.occurredAt,
          });
        }
        return canonical;
      }
    }

    const id = idSchema.parse(parsed.id ?? this.ids.next());
    const occurredAt = utcTimestampSchema.parse(parsed.occurredAt ?? this.clock.now());
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    if (hasSuppliedMedia) {
      this.assertApplicableRecordingConsent({
        personId: parsed.personId,
        consentPolicyRecordId: parsed.consentPolicyRecordId ?? null,
        activityId: id,
        occurredAt,
      });
    }
    const row = this.database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
        cadence_step_id, cadence_component_id, kind,
        direction, channel, occurred_at, duration_seconds, observed_outcome,
        adapter, provider_idempotency_key, provider_reference,
        consent_policy_record_id, recording_storage_ref, transcript_storage_ref,
        metadata_json, created_at, note_text, call_outcome, callback_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${activityColumns}
    `).get(
      id,
      parsed.personId,
      parsed.prospectId ?? null,
      parsed.salesCycleId ?? null,
      parsed.cadenceEnrollmentId ?? null,
      parsed.cadenceStepId ?? null,
      parsed.cadenceComponentId ?? null,
      parsed.kind,
      parsed.direction,
      parsed.channel,
      occurredAt,
      parsed.durationSeconds ?? null,
      parsed.observedOutcome ?? null,
      adapter,
      providerKey,
      parsed.providerReference ?? null,
      parsed.consentPolicyRecordId ?? null,
      recordingStorageRef,
      transcriptStorageRef,
      metadataJson,
      createdAt,
      parsed.noteText ?? null,
      parsed.callOutcome ?? null,
      parsed.callbackAt ?? null,
    );
    return this.parseAndValidateActivity(row);
  }

  appendActivityAmendment(input: AppendActivityAmendmentInput): ActivityAmendment {
    this.unitOfWork.assertWriteScope();
    const parsed = appendActivityAmendmentInputSchema.parse(input);
    const id = idSchema.parse(parsed.id ?? this.ids.next());
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const correctionJson = serializeJson(parsed.correction, 'activity correction');
    const row = this.database.raw.prepare(`
      INSERT INTO activity_amendments (
        id, activity_id, amendment_kind, correction_json, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING ${amendmentColumns}
    `).get(id, parsed.activityId, parsed.amendmentKind, correctionJson, parsed.reason, createdAt);
    return parseActivityAmendment(row);
  }

  appendStageEvent(input: AppendStageEventInput): StageEvent {
    this.unitOfWork.assertWriteScope();
    const parsed = appendStageEventInputSchema.parse(input);
    const id = idSchema.parse(parsed.id ?? this.ids.next());
    const confirmedAt = utcTimestampSchema.parse(parsed.confirmedAt ?? this.clock.now());
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const backfillJson = parsed.backfillProvenance == null
      ? null
      : serializeJson(parsed.backfillProvenance, 'backfill provenance');
    const row = this.database.raw.prepare(`
      INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, transition_sequence, backfill_provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${stageEventColumns}
    `).get(
      id,
      parsed.salesCycleId,
      parsed.fromStage,
      parsed.toStage,
      parsed.effectiveAt,
      confirmedAt,
      parsed.confirmationKind,
      parsed.transitionSequence,
      backfillJson,
      createdAt,
    );
    return parseStageEvent(row);
  }

  appendConsentPolicyRecord(input: AppendConsentPolicyRecordInput): ConsentPolicyRecord {
    this.unitOfWork.assertWriteScope();
    const parsed = appendConsentPolicyRecordInputSchema.parse(input);
    const id = idSchema.parse(parsed.id ?? this.ids.next());
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const evidenceJson = serializeJson(parsed.evidence, 'consent evidence');
    const row = this.database.raw.prepare(`
      INSERT INTO consent_policy_records (
        id, person_id, activity_id, policy_kind, policy_version,
        effective_at, decision, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${consentColumns}
    `).get(
      id,
      parsed.personId,
      parsed.activityId ?? null,
      parsed.policyKind,
      parsed.policyVersion,
      parsed.effectiveAt,
      parsed.decision,
      evidenceJson,
      createdAt,
    );
    return parseConsentPolicyRecord(row);
  }

  getActivity(id: string): Activity | null {
    const parsedId = idSchema.parse(id);
    const row = this.database.raw.prepare(`
      SELECT ${activityColumns}
      FROM activities
      WHERE id = ?
    `).get(parsedId);
    return row === undefined ? null : this.parseAndValidateActivity(row);
  }

  listCycleStageEvents(salesCycleId: string): StageEvent[] {
    const id = idSchema.parse(salesCycleId);
    const rows = this.database.raw.prepare(`
      SELECT ${stageEventColumns}
      FROM stage_events
      WHERE sales_cycle_id = ?
      ORDER BY transition_sequence ASC, id ASC
    `).all(id);
    const events = rows.map(parseStageEvent);
    events.forEach((event, index) => {
      if (event.transitionSequence !== index + 1) {
        throw new Error('Stage-event transition sequence must be contiguous from one.');
      }
    });
    return events;
  }

  private parseAndValidateActivity(value: unknown): Activity {
    const activity = parseActivity(value);
    if (activity.recordingStorageRef !== null || activity.transcriptStorageRef !== null) {
      this.assertApplicableRecordingConsent({
        personId: activity.personId,
        consentPolicyRecordId: activity.consentPolicyRecordId,
        activityId: activity.id,
        occurredAt: activity.occurredAt,
      });
    }
    return activity;
  }

  private assertApplicableRecordingConsent(input: {
    personId: string;
    consentPolicyRecordId: string | null;
    activityId: string;
    occurredAt: string;
  }): void {
    if (input.consentPolicyRecordId === null) throw new ActivityMediaConsentError();
    const value = this.database.raw.prepare(`
      SELECT id, person_id, activity_id, policy_kind, effective_at, decision
      FROM consent_policy_records
      WHERE id = ?
    `).get(input.consentPolicyRecordId);
    if (value === undefined) throw new ActivityMediaConsentError();
    const consent = storedMediaConsentRowSchema.parse(value);
    if (
      consent.person_id !== input.personId
      || consent.policy_kind !== 'recording'
      || (consent.decision !== 'granted' && consent.decision !== 'not_required')
      || consent.effective_at > input.occurredAt
      || (consent.activity_id !== null && consent.activity_id !== input.activityId)
    ) {
      throw new ActivityMediaConsentError();
    }
  }
}

function parseActivity(value: unknown): Activity {
  const row = storedActivityRowSchema.parse(value);
  return {
    id: row.id,
    personId: row.person_id,
    prospectId: row.prospect_id,
    salesCycleId: row.sales_cycle_id,
    cadenceEnrollmentId: row.cadence_enrollment_id,
    cadenceStepId: row.cadence_step_id,
    cadenceComponentId: row.cadence_component_id,
    kind: row.kind,
    direction: row.direction,
    channel: row.channel,
    occurredAt: row.occurred_at,
    durationSeconds: row.duration_seconds,
    observedOutcome: row.observed_outcome,
    adapter: row.adapter,
    providerIdempotencyKey: row.provider_idempotency_key,
    providerReference: row.provider_reference,
    consentPolicyRecordId: row.consent_policy_record_id,
    recordingStorageRef: row.recording_storage_ref,
    transcriptStorageRef: row.transcript_storage_ref,
    metadata: row.metadata_json,
    createdAt: row.created_at,
    noteText: row.note_text,
    callOutcome: row.call_outcome,
    callbackAt: row.callback_at,
  } as Activity;
}

function parseActivityAmendment(value: unknown): ActivityAmendment {
  const row = storedActivityAmendmentRowSchema.parse(value);
  return {
    id: row.id,
    activityId: row.activity_id,
    amendmentKind: row.amendment_kind,
    correction: row.correction_json,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function parseStageEvent(value: unknown): StageEvent {
  const row = storedStageEventRowSchema.parse(value);
  return {
    id: row.id,
    salesCycleId: row.sales_cycle_id,
    fromStage: row.from_stage,
    toStage: row.to_stage,
    effectiveAt: row.effective_at,
    confirmedAt: row.confirmed_at,
    confirmationKind: row.confirmation_kind,
    transitionSequence: row.transition_sequence,
    backfillProvenance: row.backfill_provenance_json,
    createdAt: row.created_at,
  };
}

function parseConsentPolicyRecord(value: unknown): ConsentPolicyRecord {
  const row = storedConsentPolicyRecordRowSchema.parse(value);
  return {
    id: row.id,
    personId: row.person_id,
    activityId: row.activity_id,
    policyKind: row.policy_kind,
    policyVersion: row.policy_version,
    effectiveAt: row.effective_at,
    decision: row.decision,
    evidence: row.evidence_json,
    createdAt: row.created_at,
  };
}

function parseStoredJson(value: string, context: z.RefinementCtx): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stored JSON is malformed.' });
    return z.NEVER;
  }
}

function serializeJson(value: unknown, field: string): string {
  assertJsonValue(value, new Set(), field);
  return JSON.stringify(value);
}

function assertJsonValue(value: unknown, seen: Set<object>, field: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (typeof value !== 'object') throw new TypeError(`${field} must be JSON-serializable.`);
  if (seen.has(value)) throw new TypeError(`${field} must be JSON-serializable.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJsonValue(entry, seen, field);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${field} must be JSON-serializable.`);
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, seen, field);
    }
  } finally {
    seen.delete(value);
  }
}
