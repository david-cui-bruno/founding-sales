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
    'parcel', 'deed', 'permit', 'violation',
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
  segment: z.enum(['hot', 'cold', 'warm']),
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
  person_id: idSchema,
  prospect_id: idSchema,
  command_json: z.string(),
  result_json: z.string(),
  created_at: utcTimestampSchema,
}).strict();
const storedSourceEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  sourceRecord: nonemptyJsonObjectSchema,
  customSourceReason: customSourceReasonSchema.nullable(),
}).strict();
const storedSourceRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  prospect_id: idSchema.nullable(),
  channel: z.enum([
    'frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom',
    'parcel', 'deed', 'permit', 'violation',
  ]),
  observed_at: utcTimestampSchema,
  source_record_json: z.string(),
  evidence_ref: nullableNonblankSchema,
  referred_by_person_id: idSchema.nullable(),
  referrer_unknown_reason: z.enum([
    'not_provided', 'unresolvable', 'legacy_import', 'other',
  ]).nullable(),
}).strict();
const storedProspectRowSchema = z.object({
  id: idSchema,
  person_id: idSchema,
  qualification_state: z.enum(['unreviewed', 'eligible', 'disqualified', 'merge_review']),
  qualification_reason: z.string().nullable(),
}).strict();

export type CanonicalIntakeCommand = z.infer<typeof canonicalCommandSchema>;

export type SourceIntakeReceipt = {
  sourceEventId: string;
  personId: string;
  prospectId: string;
  command: CanonicalIntakeCommand;
  /** Exact canonical bytes used as the intake idempotency key. */
  commandJson: string;
  result: StoredIntakeResult;
  createdAt: string;
};

export type IntakeReceiptIntegrityReason =
  | 'noncanonical_command_json'
  | 'noncanonical_result_json'
  | 'result_ownership_mismatch'
  | 'source_mismatch'
  | 'prospect_ownership_mismatch'
  | 'organization_context_mismatch'
  | 'property_context_mismatch'
  | 'identity_review_mismatch'
  | 'unstable_context_ids';

export class IntakeReceiptIntegrityError extends Error {
  readonly sourceEventId: string;
  readonly reason: IntakeReceiptIntegrityReason;

  constructor(sourceEventId: string, reason: IntakeReceiptIntegrityReason) {
    super('The intake receipt is inconsistent with canonical relational state.');
    this.name = 'IntakeReceiptIntegrityError';
    this.sourceEventId = sourceEventId;
    this.reason = reason;
  }
}

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

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
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
      throw new IntakeReceiptIntegrityError(sourceEventId, 'result_ownership_mismatch');
    }
    const personId = idSchema.parse(result.personId);
    const prospectId = idSchema.parse(result.prospectId);
    this.validateIntegrity({
      sourceEventId, personId, prospectId, command, result,
    }, 'append');
    const commandJson = serializeCanonicalIntakeCommand(command);
    const resultJson = serializeCanonicalIntakeResult(result);
    const createdAt = utcTimestampSchema.parse(this.clock.now());
    const row = this.database.raw.prepare(`
      INSERT INTO source_intake_receipts (
        source_event_id, person_id, prospect_id, command_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING
        source_event_id, person_id, prospect_id, command_json, result_json, created_at
    `).get(sourceEventId, personId, prospectId, commandJson, resultJson, createdAt);
    return this.parseReceipt(row);
  }

  getBySourceEventId(sourceEventId: string): SourceIntakeReceipt | null {
    const parsedId = idSchema.parse(sourceEventId);
    const row = this.database.raw.prepare(`
      SELECT
        source_event_id, person_id, prospect_id, command_json, result_json, created_at
      FROM source_intake_receipts
      WHERE source_event_id = ?
    `).get(parsedId);
    return row === undefined ? null : this.parseReceipt(row);
  }

  private parseReceipt(value: unknown): SourceIntakeReceipt {
    const row = storedRowSchema.parse(value);
    const commandEnvelope = parseStoredJson(row.command_json, commandEnvelopeSchema);
    const resultEnvelope = parseStoredJson(row.result_json, resultEnvelopeSchema);
    const result = resultEnvelope.result as StoredIntakeResult;
    if (serializeCanonicalIntakeCommand(commandEnvelope.command) !== row.command_json) {
      throw new IntakeReceiptIntegrityError(
        row.source_event_id,
        'noncanonical_command_json',
      );
    }
    if (serializeCanonicalIntakeResult(result) !== row.result_json) {
      throw new IntakeReceiptIntegrityError(row.source_event_id, 'noncanonical_result_json');
    }
    this.validateIntegrity({
      sourceEventId: row.source_event_id,
      personId: row.person_id,
      prospectId: row.prospect_id,
      command: commandEnvelope.command,
      result,
    }, 'read');
    return {
      sourceEventId: row.source_event_id,
      personId: row.person_id,
      prospectId: row.prospect_id,
      command: commandEnvelope.command,
      commandJson: row.command_json,
      result,
      createdAt: row.created_at,
    };
  }

  private validateIntegrity(input: {
    sourceEventId: string;
    personId: string;
    prospectId: string;
    command: CanonicalIntakeCommand;
    result: StoredIntakeResult;
  }, mode: 'append' | 'read'): void {
    if (
      input.command.source.id !== input.sourceEventId
      || input.result.sourceEventId !== input.sourceEventId
      || input.result.personId !== input.personId
      || input.result.prospectId !== input.prospectId
    ) {
      throw new IntakeReceiptIntegrityError(
        input.sourceEventId,
        'result_ownership_mismatch',
      );
    }
    validateImmutableResultShape(input.sourceEventId, input.result);
    assertStableUniqueContextIds(
      input.sourceEventId,
      input.result.organizationIds,
      input.result.propertyIds,
    );
    const sourceRow = this.database.raw.prepare(`
      SELECT
        id, person_id, prospect_id, channel, observed_at, source_record_json,
        evidence_ref, referred_by_person_id, referrer_unknown_reason
      FROM source_events
      WHERE id = ?
    `).get(input.sourceEventId);
    if (sourceRow === undefined) {
      throw new IntakeReceiptIntegrityError(input.sourceEventId, 'source_mismatch');
    }
    const source = parseStoredSource(sourceRow);
    if (
      source.personId !== input.personId
      || (source.prospectId !== null && source.prospectId !== input.prospectId)
      || serializeCanonicalJson(source.payload)
        !== serializeCanonicalJson(input.command.source)
    ) {
      throw new IntakeReceiptIntegrityError(input.sourceEventId, 'source_mismatch');
    }
    const prospectRow = this.database.raw.prepare(`
      SELECT id, person_id, qualification_state, qualification_reason
      FROM prospects
      WHERE id = ?
    `).get(input.prospectId);
    if (prospectRow === undefined) {
      throw new IntakeReceiptIntegrityError(
        input.sourceEventId,
        'prospect_ownership_mismatch',
      );
    }
    const prospect = storedProspectRowSchema.parse(prospectRow);
    if (prospect.person_id !== input.personId) {
      throw new IntakeReceiptIntegrityError(
        input.sourceEventId,
        'prospect_ownership_mismatch',
      );
    }
    // Qualification and context links are mutable projections. They prove a
    // receipt truthful when appended, but later supported corrections must not
    // make immutable historical evidence unreadable. Referenced context entity
    // IDs must still be real on reads; only the mutable joins are historical.
    if (mode === 'append') {
      validateIdentityReview(input.sourceEventId, input.result, prospect);
    }
    for (const organizationId of input.result.organizationIds) {
      const linked = mode === 'append'
        ? this.database.raw.prepare(`
          SELECT 1
          FROM prospect_organizations AS link
          INNER JOIN organizations AS organization ON organization.id = link.organization_id
          WHERE link.prospect_id = ? AND link.organization_id = ?
        `).get(input.prospectId, organizationId)
        : this.database.raw.prepare(`
          SELECT 1 FROM organizations WHERE id = ?
        `).get(organizationId);
      if (linked === undefined) {
        throw new IntakeReceiptIntegrityError(
          input.sourceEventId,
          'organization_context_mismatch',
        );
      }
    }
    for (const propertyId of input.result.propertyIds) {
      const linked = mode === 'append'
        ? this.database.raw.prepare(`
          SELECT 1
          FROM prospect_properties AS link
          INNER JOIN properties AS property ON property.id = link.property_id
          WHERE link.prospect_id = ? AND link.property_id = ?
        `).get(input.prospectId, propertyId)
        : this.database.raw.prepare(`
          SELECT 1 FROM properties WHERE id = ?
        `).get(propertyId);
      if (linked === undefined) {
        throw new IntakeReceiptIntegrityError(
          input.sourceEventId,
          'property_context_mismatch',
        );
      }
    }
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

export function serializeCanonicalIntakeResult(result: StoredIntakeResult): string {
  const parsed = intakeResultSchema.parse(result) as StoredIntakeResult;
  return serializeCanonicalJson({ formatVersion: 1, result: parsed });
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

function assertStableUniqueContextIds(
  sourceEventId: string,
  organizationIds: string[],
  propertyIds: string[],
): void {
  for (const ids of [organizationIds, propertyIds]) {
    const stable = [...new Set(ids)].sort(compareStrings);
    if (stable.length !== ids.length || stable.some((id, index) => id !== ids[index])) {
      throw new IntakeReceiptIntegrityError(sourceEventId, 'unstable_context_ids');
    }
  }
}

function parseStoredSource(value: unknown): {
  personId: string;
  prospectId: string | null;
  payload: CanonicalIntakeCommand['source'];
} {
  const row = storedSourceRowSchema.parse(value);
  const envelope = parseStoredJson(row.source_record_json, storedSourceEnvelopeSchema);
  let referral: CanonicalIntakeCommand['source']['referral'] = null;
  if (row.referred_by_person_id !== null && row.referrer_unknown_reason === null) {
    referral = { kind: 'known', referredByPersonId: row.referred_by_person_id };
  } else if (row.referred_by_person_id === null && row.referrer_unknown_reason !== null) {
    referral = { kind: 'unknown', reason: row.referrer_unknown_reason };
  } else if (row.channel === 'referral') {
    throw new z.ZodError([]);
  }
  const payload = canonicalSourceSchema.parse({
    id: row.id,
    channel: row.channel,
    observedAt: row.observed_at,
    sourceRecord: envelope.sourceRecord,
    evidenceRef: row.evidence_ref,
    referral,
    customSourceReason: envelope.customSourceReason,
  });
  return { personId: row.person_id, prospectId: row.prospect_id, payload };
}

function validateIdentityReview(
  sourceEventId: string,
  result: StoredIntakeResult,
  prospect: z.infer<typeof storedProspectRowSchema>,
): void {
  const persistedReason = prospect.qualification_state === 'merge_review'
    ? identityReviewReasonSchema.safeParse(prospect.qualification_reason)
    : { success: true as const, data: null };
  if (
    !persistedReason.success
    || result.identityReviewReason !== persistedReason.data
  ) {
    throw new IntakeReceiptIntegrityError(sourceEventId, 'identity_review_mismatch');
  }
}

function validateImmutableResultShape(
  sourceEventId: string,
  result: StoredIntakeResult,
): void {
  if (
    (result.disposition === 'created_merge_review' && result.identityReviewReason === null)
    || (result.disposition === 'created' && result.identityReviewReason !== null)
  ) {
    throw new IntakeReceiptIntegrityError(sourceEventId, 'identity_review_mismatch');
  }
}
