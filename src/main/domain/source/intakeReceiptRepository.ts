import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const idSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const nonemptyJsonObjectSchema = jsonObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  'Source record must be a non-empty JSON object.',
);
const nullableNonblankSchema = z.string().trim().min(1).nullable();
const referralSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), referredByPersonId: idSchema }).strict(),
  z.object({
    kind: z.literal('unknown'),
    reason: z.enum(['not_provided', 'unresolvable', 'legacy_import', 'other']),
  }).strict(),
]).nullable();
const customSourceReasonSchema = z.enum([
  'manual_quick_add', 'csv_import', 'spreadsheet_paste', 'other',
]);
const canonicalContactSchema = z.object({
  kind: z.enum(['phone', 'email']),
  normalizedValue: z.string().min(1),
  reachability: z.enum(['direct', 'indirect', 'none']),
  isPrimary: z.boolean(),
  inContacts: z.boolean().nullable(),
}).strict();
const canonicalOrganizationSchema = z.object({
  canonicalName: z.string().min(1),
  normalizedAliases: z.array(z.string().min(1)),
  relationship: z.string().nullable(),
  sourceRecord: jsonValueSchema.nullable(),
}).strict();
const canonicalAddressSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: z.string().min(1).nullable(),
  locality: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1).nullable(),
  countryCode: z.string().length(2),
}).strict();
const canonicalPropertySchema = z.object({
  canonicalAddress: canonicalAddressSchema,
  doorCount: z.number().int().safe().nonnegative().nullable(),
  propertyType: z.string().nullable(),
  maintenanceProfile: jsonValueSchema.nullable(),
  sourceRecord: jsonValueSchema.nullable(),
  verifiedAt: utcTimestampSchema.nullable(),
  organizationAlias: z.string().min(1).nullable(),
  relationship: z.string().nullable(),
}).strict();
const canonicalSourceSchema = z.object({
  id: idSchema,
  channel: z.enum([
    'frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom',
  ]),
  observedAt: utcTimestampSchema,
  sourceRecord: nonemptyJsonObjectSchema,
  evidenceRef: nullableNonblankSchema,
  referral: referralSchema,
  customSourceReason: customSourceReasonSchema.nullable(),
}).strict().superRefine((source, context) => {
  if ((source.channel === 'referral') !== (source.referral !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Referral attribution mismatch.' });
  }
  if ((source.channel === 'custom') !== (source.customSourceReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom-source reason mismatch.' });
  }
});
const canonicalCommandSchema = z.object({
  person: z.object({
    displayName: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    neverRecord: z.boolean(),
    provenance: jsonValueSchema.nullable(),
  }).strict(),
  contacts: z.array(canonicalContactSchema),
  organizations: z.array(canonicalOrganizationSchema),
  properties: z.array(canonicalPropertySchema),
  source: canonicalSourceSchema,
  segment: z.enum(['hot_frbo', 'cold_registry', 'warm']),
}).strict();
const identityReviewReasonSchema = z.enum([
  'shared_handle', 'conflicting_handle_matches',
  'indirect_handle_match', 'deleted_person_match',
]);
const contextReviewReasonSchema = z.enum([
  'ambiguous_organization', 'ambiguous_property',
  'organization_not_found', 'property_organization_conflict',
]);
export type StoredIntakeResult = {
  disposition: 'created' | 'matched_existing' | 'created_merge_review';
  personId: string;
  prospectId: string;
  sourceEventId: string;
  identityReviewReason: z.infer<typeof identityReviewReasonSchema> | null;
  contextReviewReasons: Array<z.infer<typeof contextReviewReasonSchema>>;
  organizationIds: string[];
  propertyIds: string[];
};
const intakeResultSchema = z.object({
  disposition: z.enum(['created', 'matched_existing', 'created_merge_review']),
  personId: idSchema,
  prospectId: idSchema,
  sourceEventId: idSchema,
  identityReviewReason: identityReviewReasonSchema.nullable(),
  contextReviewReasons: z.array(contextReviewReasonSchema),
  organizationIds: z.array(idSchema),
  propertyIds: z.array(idSchema),
}).strict();
const commandEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  command: canonicalCommandSchema,
}).strict();
const resultEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  result: intakeResultSchema,
}).strict();
const storedRowSchema = z.object({
  source_event_id: idSchema,
  command_json: z.string(),
  result_json: z.string(),
  created_at: utcTimestampSchema,
}).strict();

export type CanonicalIntakeCommand = z.infer<typeof canonicalCommandSchema>;

export type SourceIntakeReceipt = {
  sourceEventId: string;
  command: CanonicalIntakeCommand;
  /** Exact canonical bytes used as the intake idempotency key. */
  commandJson: string;
  result: StoredIntakeResult;
  createdAt: string;
};

export class IntakeReceiptRepository {
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

  append(input: {
    sourceEventId: string;
    command: CanonicalIntakeCommand;
    result: StoredIntakeResult;
  }): SourceIntakeReceipt {
    this.unitOfWork.assertWriteScope();
    const sourceEventId = idSchema.parse(input.sourceEventId);
    const command = canonicalCommandSchema.parse(input.command);
    const result = intakeResultSchema.parse(input.result) as StoredIntakeResult;
    if (command.source.id !== sourceEventId || result.sourceEventId !== sourceEventId) {
      throw new z.ZodError([]);
    }
    const commandJson = serializeCanonicalIntakeCommand(command);
    const resultJson = serializeCanonicalJson({ formatVersion: 1, result });
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const row = this.database.raw.prepare(`
      INSERT INTO source_intake_receipts (
        source_event_id, command_json, result_json, created_at
      ) VALUES (?, ?, ?, ?)
      RETURNING source_event_id, command_json, result_json, created_at
    `).get(sourceEventId, commandJson, resultJson, createdAt);
    return parseReceipt(row);
  }

  getBySourceEventId(sourceEventId: string): SourceIntakeReceipt | null {
    const parsedId = idSchema.parse(sourceEventId);
    const row = this.database.raw.prepare(`
      SELECT source_event_id, command_json, result_json, created_at
      FROM source_intake_receipts
      WHERE source_event_id = ?
    `).get(parsedId);
    return row === undefined ? null : parseReceipt(row);
  }
}

export function serializeCanonicalIntakeCommand(command: CanonicalIntakeCommand): string {
  const parsed = canonicalCommandSchema.parse(command);
  const canonical = {
    ...parsed,
    person: { ...parsed.person, aliases: [...parsed.person.aliases].sort() },
    contacts: sortCanonical(parsed.contacts),
    organizations: sortCanonical(parsed.organizations.map((organization) => ({
      ...organization,
      normalizedAliases: [...organization.normalizedAliases].sort(),
    }))),
    properties: sortCanonical(parsed.properties),
  };
  return serializeCanonicalJson({ formatVersion: 1, command: canonical });
}

function parseReceipt(value: unknown): SourceIntakeReceipt {
  const row = storedRowSchema.parse(value);
  const commandEnvelope = parseStoredJson(row.command_json, commandEnvelopeSchema);
  const resultEnvelope = parseStoredJson(row.result_json, resultEnvelopeSchema);
  const result = resultEnvelope.result as StoredIntakeResult;
  if (
    commandEnvelope.command.source.id !== row.source_event_id
    || result.sourceEventId !== row.source_event_id
  ) {
    throw new z.ZodError([]);
  }
  return {
    sourceEventId: row.source_event_id,
    command: commandEnvelope.command,
    commandJson: row.command_json,
    result,
    createdAt: row.created_at,
  };
}

function parseStoredJson<T>(value: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new z.ZodError([]);
  }
  return schema.parse(parsed);
}

function sortCanonical<T>(values: T[]): T[] {
  return [...values].sort((left, right) => compareStrings(
    serializeCanonicalJson(left),
    serializeCanonicalJson(right),
  ));
}

function serializeCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function canonicalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object') {
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value).sort(([left], [right]) => (
      compareStrings(left, right)
    ))) {
      output[key] = canonicalizeJson(child);
    }
    return output;
  }
  throw new z.ZodError([]);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
