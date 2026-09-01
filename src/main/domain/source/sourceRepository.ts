import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type {
  AppendSourceEventInput,
  CustomSourceReason,
  ReferralAttribution,
  SourceEvent,
} from './sourceTypes';

export type {
  AppendSourceEventInput,
  CustomSourceReason,
  ReferralAttribution,
  ReferralUnknownReason,
  SourceChannel,
  SourceEvent,
} from './sourceTypes';

const idSchema = z.string().trim().min(1);
const nonblankTextSchema = z.string().trim().min(1);
const nullableNonblankTextSchema = nonblankTextSchema.nullable().optional();
const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
const referralUnknownReasonSchema = z.enum([
  'not_provided', 'unresolvable', 'legacy_import', 'other',
]);
const customSourceReasonSchema = z.enum([
  'manual_quick_add', 'csv_import', 'spreadsheet_paste', 'other',
]);
const sourceRecordSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  'Source record must be a non-empty JSON object.',
);
const commonInputShape = {
  id: idSchema,
  personId: idSchema,
  prospectId: idSchema.nullable().optional(),
  salesCycleId: idSchema.nullable().optional(),
  observedAt: utcTimestampSchema,
  sourceRecord: sourceRecordSchema,
  evidenceRef: nullableNonblankTextSchema,
};
const knownReferralSchema = z.object({
  kind: z.literal('known'),
  referredByPersonId: idSchema,
}).strict();
const unknownReferralSchema = z.object({
  kind: z.literal('unknown'),
  reason: referralUnknownReasonSchema,
}).strict();
const appendSourceEventInputSchema = z.discriminatedUnion('channel', [
  z.object({ ...commonInputShape, channel: z.literal('frbo') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('registry') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('rireig') }).strict(),
  z.object({
    ...commonInputShape,
    channel: z.literal('referral'),
    referral: z.discriminatedUnion('kind', [knownReferralSchema, unknownReferralSchema]),
  }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('inbound_demo') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('community') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('parcel') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('deed') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('permit') }).strict(),
  z.object({ ...commonInputShape, channel: z.literal('violation') }).strict(),
  z.object({
    ...commonInputShape,
    channel: z.literal('custom'),
    customSourceReason: customSourceReasonSchema,
  }).strict(),
]);

const storedEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  sourceRecord: sourceRecordSchema,
  customSourceReason: customSourceReasonSchema.nullable(),
}).strict();
const storedRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  prospect_id: idSchema.nullable(),
  sales_cycle_id: idSchema.nullable(),
  channel: z.enum([
    'frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom',
    'parcel', 'deed', 'permit', 'violation',
  ]),
  observed_at: utcTimestampSchema,
  source_record_json: z.string().transform(parseStoredEnvelope),
  evidence_ref: nonblankTextSchema.nullable(),
  referred_by_person_id: idSchema.nullable(),
  referrer_unknown_reason: referralUnknownReasonSchema.nullable(),
  created_at: utcTimestampSchema,
}).strict();

const sourceColumns = `
  id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
  source_record_json, evidence_ref, referred_by_person_id,
  referrer_unknown_reason, created_at
`;

export class SourceEventIdempotencyConflictError extends Error {
  readonly sourceEventId: string;

  constructor(sourceEventId: string) {
    super('The source-event ID is already associated with a different canonical payload.');
    this.name = 'SourceEventIdempotencyConflictError';
    this.sourceEventId = sourceEventId;
  }
}

export class SourceRepository {
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

  append(input: AppendSourceEventInput): SourceEvent {
    this.unitOfWork.assertWriteScope();
    const parsed = appendSourceEventInputSchema.parse(input);
    const canonicalInput = canonicalizeInput(parsed);
    const existing = this.getById(canonicalInput.id);
    if (existing !== null) {
      if (!samePayload(existing, canonicalInput)) {
        throw new SourceEventIdempotencyConflictError(canonicalInput.id);
      }
      return existing;
    }

    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const envelope = serializeCanonicalJson({
      formatVersion: 1,
      sourceRecord: canonicalInput.sourceRecord,
      customSourceReason: canonicalInput.customSourceReason,
    }, 'source record');
    const row = this.database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
        source_record_json, evidence_ref, referred_by_person_id,
        referrer_unknown_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${sourceColumns}
    `).get(
      canonicalInput.id,
      canonicalInput.personId,
      canonicalInput.prospectId,
      canonicalInput.salesCycleId,
      canonicalInput.channel,
      canonicalInput.observedAt,
      envelope,
      canonicalInput.evidenceRef,
      canonicalInput.referral?.kind === 'known'
        ? canonicalInput.referral.referredByPersonId
        : null,
      canonicalInput.referral?.kind === 'unknown'
        ? canonicalInput.referral.reason
        : null,
      createdAt,
    );
    return parseSourceEvent(row);
  }

  getById(id: string): SourceEvent | null {
    const parsedId = idSchema.parse(id);
    const row = this.database.raw.prepare(`
      SELECT ${sourceColumns}
      FROM source_events
      WHERE id = ?
    `).get(parsedId);
    return row === undefined ? null : parseSourceEvent(row);
  }

  listByPerson(personId: string): SourceEvent[] {
    const parsedPersonId = idSchema.parse(personId);
    const rows = this.database.raw.prepare(`
      SELECT ${sourceColumns}
      FROM source_events
      WHERE person_id = ?
      ORDER BY observed_at ASC, id ASC
    `).all(parsedPersonId);
    return rows.map(parseSourceEvent);
  }
}

type CanonicalSourceInput = {
  id: string;
  personId: string;
  prospectId: string | null;
  salesCycleId: string | null;
  channel: SourceEvent['channel'];
  observedAt: string;
  sourceRecord: Record<string, unknown>;
  evidenceRef: string | null;
  referral: ReferralAttribution | null;
  customSourceReason: CustomSourceReason | null;
};

function canonicalizeInput(
  parsed: z.infer<typeof appendSourceEventInputSchema>,
): CanonicalSourceInput {
  const sourceRecord = canonicalizeJson(parsed.sourceRecord, new Set(), 'source record');
  return {
    id: parsed.id,
    personId: parsed.personId,
    prospectId: parsed.prospectId ?? null,
    salesCycleId: parsed.salesCycleId ?? null,
    channel: parsed.channel,
    observedAt: parsed.observedAt,
    sourceRecord: sourceRecord as Record<string, unknown>,
    evidenceRef: parsed.evidenceRef ?? null,
    referral: parsed.channel === 'referral' ? parsed.referral : null,
    customSourceReason: parsed.channel === 'custom' ? parsed.customSourceReason : null,
  };
}

function parseSourceEvent(value: unknown): SourceEvent {
  const row = storedRowSchema.parse(value);
  const referral = parseReferral(row);
  if ((row.channel === 'referral') !== (referral !== null)) {
    throw new z.ZodError([]);
  }
  if ((row.channel === 'custom') !== (row.source_record_json.customSourceReason !== null)) {
    throw new z.ZodError([]);
  }
  return {
    id: row.id,
    personId: row.person_id,
    prospectId: row.prospect_id,
    salesCycleId: row.sales_cycle_id,
    channel: row.channel,
    observedAt: row.observed_at,
    sourceRecord: row.source_record_json.sourceRecord,
    evidenceRef: row.evidence_ref,
    referral,
    customSourceReason: row.source_record_json.customSourceReason,
    createdAt: row.created_at,
  };
}

function parseReferral(row: z.infer<typeof storedRowSchema>): ReferralAttribution | null {
  if (row.referred_by_person_id !== null && row.referrer_unknown_reason === null) {
    return { kind: 'known', referredByPersonId: row.referred_by_person_id };
  }
  if (row.referred_by_person_id === null && row.referrer_unknown_reason !== null) {
    return { kind: 'unknown', reason: row.referrer_unknown_reason };
  }
  return null;
}

function parseStoredEnvelope(value: string, context: z.RefinementCtx) {
  try {
    return storedEnvelopeSchema.parse(JSON.parse(value) as unknown);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stored source JSON is malformed.' });
    return z.NEVER;
  }
}

function samePayload(existing: SourceEvent, input: CanonicalSourceInput): boolean {
  return existing.personId === input.personId
    && existing.prospectId === input.prospectId
    && existing.salesCycleId === input.salesCycleId
    && existing.channel === input.channel
    && existing.observedAt === input.observedAt
    && existing.evidenceRef === input.evidenceRef
    && serializeCanonicalJson(existing.sourceRecord, 'source record')
      === serializeCanonicalJson(input.sourceRecord, 'source record')
    && serializeCanonicalJson(existing.referral, 'referral')
      === serializeCanonicalJson(input.referral, 'referral')
    && existing.customSourceReason === input.customSourceReason;
}

function serializeCanonicalJson(value: unknown, field: string): string {
  return JSON.stringify(canonicalizeJson(value, new Set(), field));
}

function canonicalizeJson(
  value: unknown,
  seen: Set<object>,
  field: string,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  if (seen.has(value)) throw new TypeError(`${field} must be JSON-serializable.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeJson(entry, seen, field));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${field} must be JSON-serializable.`);
    }
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeJson(
        (value as Record<string, unknown>)[key], seen, field,
      );
    }
    return canonical;
  } finally {
    seen.delete(value);
  }
}
