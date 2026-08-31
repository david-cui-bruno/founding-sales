import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleEvidenceError,
  LifecycleIdempotencyConflictError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  deepFreezeLifecycle,
  type CycleReactivationReceipt,
  type ReactivationRule,
} from './lifecycleTypes';
import {
  reactivationCommandEnvelopeSchema,
  reactivationResultEnvelopeSchema,
  type ReactivationCommandEnvelope,
  type ReactivationResultEnvelope,
} from './reactivationContracts';
import {
  collectReceiptEvidenceViolations,
  type ReactivationReceiptEvidence,
} from './reactivationEvidenceValidator';
import {
  idSchema,
  parseCanonicalJson,
  serializeCanonical,
  utcTimestampSchema,
} from './lifecycleValidation';

const ruleTypeSchema = z.enum([
  'seasonal:heating-oct1', 'new-frbo-listing', 'lead-cert-expiry-window', 'manual',
]);
const newFrboMatcherSchema = z.object({
  version: z.literal(1), eventType: z.literal('new-frbo-listing'), personWide: z.literal(true),
}).strict();
const leadCertMatcherSchema = z.object({
  version: z.literal(1), eventType: z.literal('lead-cert-expiry-window'), personWide: z.literal(true),
}).strict();
const ruleValueSchema = z.discriminatedUnion('ruleType', [
  z.object({
    ruleType: z.literal('seasonal:heating-oct1'), dueAt: utcTimestampSchema,
    matcher: z.null(),
  }).strict(),
  z.object({
    ruleType: z.literal('manual'), dueAt: utcTimestampSchema, matcher: z.null(),
  }).strict(),
  z.object({
    ruleType: z.literal('new-frbo-listing'), dueAt: z.null(), matcher: newFrboMatcherSchema,
  }).strict(),
  z.object({
    ruleType: z.literal('lead-cert-expiry-window'), dueAt: z.null(), matcher: leadCertMatcherSchema,
  }).strict(),
]);
const storedRuleSchema = z.object({
  id: idSchema, sales_cycle_id: idSchema, rule_type: ruleTypeSchema,
  due_at: utcTimestampSchema.nullable(), matcher_json: z.string().nullable(),
  version: z.number().int().safe().positive(), consumed_at: utcTimestampSchema.nullable(),
  created_at: utcTimestampSchema,
}).strict();
const storedReceiptSchema = z.object({
  activation_key: z.string().trim().min(1), activation_kind: z.enum(['rule', 'inbound_response']),
  person_id: idSchema, source_cycle_id: idSchema, reactivation_rule_id: idSchema.nullable(),
  source_event_id: idSchema.nullable(), new_cycle_id: idSchema,
  command_json: z.string(), result_json: z.string(), created_at: utcTimestampSchema,
}).strict();
const receiptInputSchema = z.object({
  activationKey: z.string().trim().min(1),
  activationKind: z.enum(['rule', 'inbound_response']),
  personId: idSchema,
  sourceCycleId: idSchema,
  reactivationRuleId: idSchema.nullable(),
  sourceEventId: idSchema.nullable(),
  newCycleId: idSchema,
  command: reactivationCommandEnvelopeSchema,
  result: reactivationResultEnvelopeSchema,
  createdAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  const command = value.command.command;
  const result = value.result.result;
  const commandIsRule = 'ruleType' in command;
  if ((value.activationKind === 'rule') !== commandIsRule
    || result.activationKind !== value.activationKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt command/result kind mismatch.' });
  }
  const sourceEventId = commandIsRule ? null
    : command.evidence.kind === 'source_event' ? command.evidence.sourceEventId : null;
  const ruleId = commandIsRule ? command.ruleId : null;
  const expectedKey = commandIsRule ? `rule:${command.ruleId}`
    : sourceEventId === null ? null : `inbound:${sourceEventId}`;
  if (expectedKey === null
    || value.activationKey !== expectedKey
    || value.personId !== command.personId
    || value.sourceCycleId !== command.sourceCycleId
    || value.reactivationRuleId !== ruleId
    || value.sourceEventId !== sourceEventId
    || value.newCycleId !== command.newCycleId
    || value.createdAt !== command.activatedAt
    || result.cycle.id !== command.newCycleId
    || result.cycle.personId !== command.personId
    || result.cycle.prospectId !== command.prospectId
    || result.cycle.entrySourceEventId !== (commandIsRule
      ? command.entrySourceEventId : sourceEventId)
    || serializeCanonical(result.cadence) !== serializeCanonical(command.cadence)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Receipt ownership, evidence, cadence, or activation snapshot mismatch.',
    });
  }
});
const ruleColumns = `
  id, sales_cycle_id, rule_type, due_at, matcher_json, version, consumed_at, created_at
`;
const receiptColumns = `
  activation_key, activation_kind, person_id, source_cycle_id,
  reactivation_rule_id, source_event_id, new_cycle_id, command_json,
  result_json, created_at
`;

export type InsertReactivationRuleInput = Readonly<{
  id: string;
  salesCycleId: string;
  version: number;
  createdAt: string;
}> & (
  | Readonly<{ ruleType: 'seasonal:heating-oct1' | 'manual'; dueAt: string; matcher: null }>
  | Readonly<{
      ruleType: 'new-frbo-listing'; dueAt: null;
      matcher: Readonly<{ version: 1; eventType: 'new-frbo-listing'; personWide: true }>;
    }>
  | Readonly<{
      ruleType: 'lead-cert-expiry-window'; dueAt: null;
      matcher: Readonly<{ version: 1; eventType: 'lead-cert-expiry-window'; personWide: true }>;
    }>
);

export type ConsumeReactivationRuleInput = Readonly<{
  ruleId: string;
  salesCycleId: string;
  expectedVersion: number;
  consumedAt: string;
}>;

export type InsertReactivationReceiptInput = Readonly<{
  activationKey: string;
  activationKind: 'rule' | 'inbound_response';
  personId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  newCycleId: string;
  command: ReactivationCommandEnvelope;
  result: ReactivationResultEnvelope;
  createdAt: string;
}>;

export class ReactivationRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  insertRule(input: InsertReactivationRuleInput): ReactivationRule {
    this.unitOfWork.assertWriteScope();
    const common = z.object({
      id: idSchema, salesCycleId: idSchema,
      version: z.number().int().safe().positive(), createdAt: utcTimestampSchema,
    }).strict().parse({
      id: input.id, salesCycleId: input.salesCycleId,
      version: input.version, createdAt: input.createdAt,
    });
    const value = ruleValueSchema.parse({
      ruleType: input.ruleType, dueAt: input.dueAt, matcher: input.matcher,
    });
    const parsed = { ...common, ...value } as InsertReactivationRuleInput;
    const matcherJson = parsed.matcher === null
      ? null
      : serializeCanonical(parsed.matcher);
    const existing = this.getRule(parsed.id);
    if (existing !== null) {
      if (
        existing.salesCycleId === parsed.salesCycleId
        && existing.ruleType === parsed.ruleType
        && existing.dueAt === parsed.dueAt
        && serializeCanonical(existing.matcher) === serializeCanonical(parsed.matcher)
        && existing.version === parsed.version
        && existing.createdAt === parsed.createdAt
      ) return existing;
      throw new LifecycleIdempotencyConflictError();
    }
    const row = this.database.raw.prepare(`
      INSERT INTO reactivation_rules (
        id, sales_cycle_id, rule_type, due_at, matcher_json, version, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      RETURNING ${ruleColumns}
    `).get(
      parsed.id, parsed.salesCycleId, parsed.ruleType, parsed.dueAt,
      matcherJson, parsed.version, parsed.createdAt,
    );
    return parseRule(row);
  }

  consumeRule(input: ConsumeReactivationRuleInput): ReactivationRule {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      ruleId: idSchema, salesCycleId: idSchema,
      expectedVersion: z.number().int().safe().positive(), consumedAt: utcTimestampSchema,
    }).strict().parse(input);
    const row = this.database.raw.prepare(`
      UPDATE reactivation_rules SET consumed_at = ?
      WHERE id = ? AND sales_cycle_id = ? AND version = ? AND consumed_at IS NULL
      RETURNING ${ruleColumns}
    `).get(parsed.consumedAt, parsed.ruleId, parsed.salesCycleId, parsed.expectedVersion);
    if (row === undefined) throw new StaleDomainWriteError();
    return parseRule(row);
  }

  insertOrGetReceipt(input: InsertReactivationReceiptInput): CycleReactivationReceipt {
    this.unitOfWork.assertWriteScope();
    const activationKey = z.string().trim().min(1).parse(input.activationKey);
    const existing = this.getReceipt(activationKey);
    let parsed: z.infer<typeof receiptInputSchema>;
    try {
      parsed = receiptInputSchema.parse(input);
      assertReceiptRelations(this.database, parsed);
    } catch (error) {
      if (existing !== null) throw new LifecycleIdempotencyConflictError();
      throw error;
    }
    if (existing !== null) {
      assertReceiptEquals(existing, parsed);
      return existing;
    }
    const commandJson = serializeCanonical(parsed.command);
    const resultJson = serializeCanonical(parsed.result);
    const row = this.database.raw.prepare(`
      INSERT INTO cycle_reactivation_receipts (
        activation_key, activation_kind, person_id, source_cycle_id,
        reactivation_rule_id, source_event_id, new_cycle_id,
        command_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${receiptColumns}
    `).get(
      parsed.activationKey, parsed.activationKind, parsed.personId,
      parsed.sourceCycleId, parsed.reactivationRuleId, parsed.sourceEventId,
      parsed.newCycleId, commandJson, resultJson, parsed.createdAt,
    );
    return parseReceipt(row, this.database);
  }

  getRule(ruleId: string): ReactivationRule | null {
    const id = idSchema.parse(ruleId);
    const row = this.database.raw.prepare(`
      SELECT ${ruleColumns} FROM reactivation_rules WHERE id = ?
    `).get(id);
    return row === undefined ? null : parseRule(row);
  }

  listRulesForCycle(salesCycleId: string): readonly ReactivationRule[] {
    const id = idSchema.parse(salesCycleId);
    return Object.freeze(this.database.raw.prepare(`
      SELECT ${ruleColumns} FROM reactivation_rules WHERE sales_cycle_id = ?
      ORDER BY rule_type ASC, due_at ASC, id ASC
    `).all(id).map(parseRule));
  }

  getReceipt(activationKey: string): CycleReactivationReceipt | null {
    const key = z.string().trim().min(1).parse(activationKey);
    const row = this.database.raw.prepare(`
      SELECT ${receiptColumns} FROM cycle_reactivation_receipts WHERE activation_key = ?
    `).get(key);
    return row === undefined ? null : parseReceipt(row, this.database);
  }
}

function parseRule(value: unknown): ReactivationRule {
  const row = storedRuleSchema.parse(value);
  const parsedValue = ruleValueSchema.parse({
    ruleType: row.rule_type,
    dueAt: row.due_at,
    matcher: row.matcher_json === null
      ? null
      : parseCanonicalJson(row.matcher_json, z.union([newFrboMatcherSchema, leadCertMatcherSchema])),
  });
  return deepFreezeLifecycle({
    id: row.id, salesCycleId: row.sales_cycle_id, ...parsedValue,
    version: row.version, consumedAt: row.consumed_at, createdAt: row.created_at,
  }) as ReactivationRule;
}

function parseReceipt(value: unknown, database: AppDatabase): CycleReactivationReceipt {
  const row = storedReceiptSchema.parse(value);
  const parsed = receiptInputSchema.parse({
    activationKey: row.activation_key, activationKind: row.activation_kind,
    personId: row.person_id, sourceCycleId: row.source_cycle_id,
    reactivationRuleId: row.reactivation_rule_id, sourceEventId: row.source_event_id,
    newCycleId: row.new_cycle_id,
    command: parseCanonicalJson(row.command_json, reactivationCommandEnvelopeSchema),
    result: parseCanonicalJson(row.result_json, reactivationResultEnvelopeSchema),
    createdAt: row.created_at,
  });
  assertReceiptRelations(database, parsed);
  return deepFreezeLifecycle(parsed) as CycleReactivationReceipt;
}

function assertReceiptRelations(
  database: AppDatabase,
  receipt: z.infer<typeof receiptInputSchema>,
): void {
  const evidenceViolations = collectReceiptEvidenceViolations(
    database, receipt as ReactivationReceiptEvidence,
  );
  if (evidenceViolations.length > 0) {
    throw new LifecycleEvidenceError(
      `Reactivation receipt relational evidence is invalid: ${evidenceViolations.join('; ')}`,
    );
  }
  const command = receipt.command.command;
  const result = receipt.result.result;
  const sourceCycle = database.raw.prepare(`
    SELECT person_id, prospect_id, workflow_status FROM sales_cycles WHERE id = ?
  `).get(receipt.sourceCycleId) as {
    person_id: string; prospect_id: string; workflow_status: string;
  } | undefined;
  const newCycle = database.raw.prepare(`
    SELECT person_id, prospect_id, entry_source_event_id FROM sales_cycles WHERE id = ?
  `).get(receipt.newCycleId) as {
    person_id: string; prospect_id: string; entry_source_event_id: string;
  } | undefined;
  const enrollment = database.raw.prepare(`
    SELECT id FROM cadence_enrollments
    WHERE sales_cycle_id = ? AND cadence_definition_id = ?
  `).get(receipt.newCycleId, command.cadence.definitionId);
  const sourceEventId = 'ruleType' in command
    ? command.entrySourceEventId
    : command.evidence.kind === 'source_event' ? command.evidence.sourceEventId : null;
  const source = sourceEventId === null ? undefined : database.raw.prepare(`
    SELECT person_id, prospect_id, channel FROM source_events WHERE id = ?
  `).get(sourceEventId) as {
    person_id: string; prospect_id: string | null; channel: string;
  } | undefined;
  const definition = database.raw.prepare(`
    SELECT family, version, content_hash FROM cadence_definitions WHERE id = ?
  `).get(command.cadence.definitionId) as {
    family: string; version: number; content_hash: string;
  } | undefined;
  const rule = 'ruleType' in command ? database.raw.prepare(`
    SELECT sales_cycle_id, rule_type FROM reactivation_rules WHERE id = ?
  `).get(command.ruleId) as { sales_cycle_id: string; rule_type: string } | undefined : undefined;
  const invalid = sourceCycle === undefined
    || sourceCycle.person_id !== receipt.personId
    || sourceCycle.prospect_id !== command.prospectId
    || sourceCycle.workflow_status !== 'closed'
    || newCycle === undefined
    || newCycle.person_id !== receipt.personId
    || newCycle.prospect_id !== command.prospectId
    || newCycle.entry_source_event_id !== result.cycle.entrySourceEventId
    || enrollment === undefined
    || source === undefined
    || source.person_id !== receipt.personId
    || (source.prospect_id !== null && source.prospect_id !== command.prospectId)
    || definition === undefined
    || definition.family !== command.cadence.family
    || definition.version !== command.cadence.version
    || definition.content_hash !== command.cadence.contentHash
    || ('ruleType' in command
      ? rule === undefined
        || rule.sales_cycle_id !== receipt.sourceCycleId
        || rule.rule_type !== command.ruleType
      : command.evidence.kind !== 'source_event'
        || source.channel !== command.evidence.channel);
  if (invalid) {
    throw new LifecycleEvidenceError('Reactivation receipt relational evidence is invalid.');
  }
}

function assertReceiptEquals(
  existing: CycleReactivationReceipt,
  input: z.infer<typeof receiptInputSchema>,
): void {
  if (
    existing.activationKind !== input.activationKind
    || existing.personId !== input.personId
    || existing.sourceCycleId !== input.sourceCycleId
    || existing.reactivationRuleId !== input.reactivationRuleId
    || existing.sourceEventId !== input.sourceEventId
    || existing.newCycleId !== input.newCycleId
    || serializeCanonical(existing.command) !== serializeCanonical(input.command)
    || serializeCanonical(existing.result) !== serializeCanonical(input.result)
    || existing.createdAt !== input.createdAt
  ) throw new LifecycleIdempotencyConflictError();
}
