import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { IdempotencyOwnershipConflictError } from '../support/domainErrors';
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
  cadenceStepId: idSchema.nullable().optional(),
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
  metadata: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  if (value.providerIdempotencyKey != null && value.adapter == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A provider idempotency key requires an adapter.',
      path: ['providerIdempotencyKey'],
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
  cadence_step_id: idSchema.nullable(),
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
  recording_storage_ref: z.null(),
  transcript_storage_ref: z.null(),
  metadata_json: jsonTextSchema,
  created_at: utcTimestampSchema,
}).strict();

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

const activityColumns = `
  id, person_id, prospect_id, sales_cycle_id, cadence_step_id, kind, direction,
  channel, occurred_at, duration_seconds, observed_outcome, adapter,
  provider_idempotency_key, provider_reference, consent_policy_record_id,
  recording_storage_ref, transcript_storage_ref, metadata_json, created_at
`;
const amendmentColumns = `
  id, activity_id, amendment_kind, correction_json, reason, created_at
`;
const stageEventColumns = `
  id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
  confirmation_kind, backfill_provenance_json, created_at
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
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  appendActivity(input: AppendActivityInput): Activity {
    this.unitOfWork.assertWriteScope();
    const parsed = appendActivityInputSchema.parse(input);
    const id = idSchema.parse(parsed.id ?? this.ids.next());
    const occurredAt = utcTimestampSchema.parse(parsed.occurredAt ?? this.clock.now());
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const adapter = parsed.adapter ?? null;
    const providerKey = parsed.providerIdempotencyKey ?? null;

    if (adapter !== null && providerKey !== null) {
      const existing = this.database.raw.prepare(`
        SELECT ${activityColumns}
        FROM activities
        WHERE adapter = ? AND provider_idempotency_key = ?
      `).get(adapter, providerKey);
      if (existing !== undefined) {
        const canonical = parseActivity(existing);
        if (
          canonical.personId !== parsed.personId
          || canonical.prospectId !== (parsed.prospectId ?? null)
          || canonical.salesCycleId !== (parsed.salesCycleId ?? null)
        ) {
          throw new IdempotencyOwnershipConflictError(adapter, providerKey);
        }
        if (canonical.id !== id) {
          if (this.getActivity(id) !== null) {
            throw new Error('The Activity ID and provider idempotency key identify different rows.');
          }
        }
        return canonical;
      }
    }

    const metadataJson = serializeJson(parsed.metadata ?? {}, 'activity metadata');
    const row = this.database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, cadence_step_id, kind,
        direction, channel, occurred_at, duration_seconds, observed_outcome,
        adapter, provider_idempotency_key, provider_reference,
        consent_policy_record_id, recording_storage_ref, transcript_storage_ref,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      RETURNING ${activityColumns}
    `).get(
      id,
      parsed.personId,
      parsed.prospectId ?? null,
      parsed.salesCycleId ?? null,
      parsed.cadenceStepId ?? null,
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
      metadataJson,
      createdAt,
    );
    return parseActivity(row);
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
        confirmation_kind, backfill_provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${stageEventColumns}
    `).get(
      id,
      parsed.salesCycleId,
      parsed.fromStage,
      parsed.toStage,
      parsed.effectiveAt,
      confirmedAt,
      parsed.confirmationKind,
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
    return row === undefined ? null : parseActivity(row);
  }

  listCycleStageEvents(salesCycleId: string): StageEvent[] {
    const id = idSchema.parse(salesCycleId);
    const rows = this.database.raw.prepare(`
      SELECT ${stageEventColumns}
      FROM stage_events
      WHERE sales_cycle_id = ?
      ORDER BY effective_at ASC, confirmed_at ASC, id ASC
    `).all(id);
    return rows.map(parseStageEvent);
  }
}

function parseActivity(value: unknown): Activity {
  const row = storedActivityRowSchema.parse(value);
  return {
    id: row.id,
    personId: row.person_id,
    prospectId: row.prospect_id,
    salesCycleId: row.sales_cycle_id,
    cadenceStepId: row.cadence_step_id,
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
    metadata: row.metadata_json,
    createdAt: row.created_at,
  };
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
