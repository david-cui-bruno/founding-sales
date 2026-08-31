import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
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
const commandCommon = {
  personId: idSchema, prospectId: idSchema, sourceCycleId: idSchema,
  newCycleId: idSchema, activatedAt: utcTimestampSchema,
};
const ruleCommandCommon = {
  ...commandCommon, ruleId: idSchema, expectedRuleVersion: z.number().int().positive(),
  entrySourceEventId: idSchema,
};
const ruleCommandSchema = z.discriminatedUnion('ruleType', [
  z.object({
    ...ruleCommandCommon, ruleType: z.literal('seasonal:heating-oct1'),
    trigger: z.object({ kind: z.literal('due'), dueAt: utcTimestampSchema }).strict(),
  }).strict(),
  z.object({
    ...ruleCommandCommon, ruleType: z.literal('manual'),
    trigger: z.object({ kind: z.literal('due'), dueAt: utcTimestampSchema }).strict(),
  }).strict(),
  z.object({
    ...ruleCommandCommon, ruleType: z.literal('new-frbo-listing'),
    trigger: z.object({
      kind: z.literal('source_event'), eventType: z.literal('new-frbo-listing'),
      sourceEventId: idSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...ruleCommandCommon, ruleType: z.literal('lead-cert-expiry-window'),
    trigger: z.object({
      kind: z.literal('source_event'), eventType: z.literal('lead-cert-expiry-window'),
      sourceEventId: idSchema,
    }).strict(),
  }).strict(),
]);
const inboundCommandSchema = z.object({
  ...commandCommon, sourceEventId: idSchema,
}).strict();
const commandEnvelopeSchema = z.object({
  version: z.literal(1), command: z.union([ruleCommandSchema, inboundCommandSchema]),
}).strict();
const salesCycleSnapshotSchema = z.object({
  id: idSchema, personId: idSchema, prospectId: idSchema, entrySourceEventId: idSchema,
  stage: z.enum(['unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture']),
  workflowStatus: z.enum(['active', 'onboarding', 'closed']),
  currentNextActionId: idSchema.nullable(), stageEnteredAt: utcTimestampSchema,
  designPartnerFitness: z.number().int().min(0).max(5).nullable(),
  closeReason: z.enum([
    'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
    'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
    'cadence_exhausted', 'disqualified', 'opt_out', 'other',
  ]).nullable(),
  closeNotes: z.string().nullable(), onboardingStopReason: z.string().nullable(),
  closedAt: utcTimestampSchema.nullable(), version: z.number().int().positive(),
  createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema,
}).strict();
const resultEnvelopeSchema = z.object({
  version: z.literal(1),
  result: z.discriminatedUnion('activationKind', [
    z.object({
      kind: z.literal('reactivated'), activationKind: z.literal('rule'),
      cycle: salesCycleSnapshotSchema,
    }).strict(),
    z.object({
      kind: z.literal('reactivated'), activationKind: z.literal('inbound_response'),
      cycle: salesCycleSnapshotSchema,
    }).strict(),
  ]),
}).strict();
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
  command: commandEnvelopeSchema,
  result: resultEnvelopeSchema,
  createdAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  const commandIsRule = 'ruleType' in value.command.command;
  if ((value.activationKind === 'rule') !== commandIsRule
    || value.result.result.activationKind !== value.activationKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt command/result kind mismatch.' });
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
  command: unknown;
  result: unknown;
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
    const parsed = receiptInputSchema.parse(input);
    const existing = this.getReceipt(parsed.activationKey);
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
    return parseReceipt(row);
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
    return row === undefined ? null : parseReceipt(row);
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

function parseReceipt(value: unknown): CycleReactivationReceipt {
  const row = storedReceiptSchema.parse(value);
  return deepFreezeLifecycle({
    activationKey: row.activation_key, activationKind: row.activation_kind,
    personId: row.person_id, sourceCycleId: row.source_cycle_id,
    reactivationRuleId: row.reactivation_rule_id, sourceEventId: row.source_event_id,
    newCycleId: row.new_cycle_id,
    command: parseCanonicalJson(row.command_json, commandEnvelopeSchema),
    result: parseCanonicalJson(row.result_json, resultEnvelopeSchema),
    createdAt: row.created_at,
  }) as CycleReactivationReceipt;
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
