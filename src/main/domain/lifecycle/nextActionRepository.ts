import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleEvidenceError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import { collectActionSettlementViolations } from './actionSettlementValidator';
import { resolveInstalledCadenceActionBinding } from './cadenceActionBindingValidator';
import {
  deepFreezeLifecycle,
  type ActionSettlement,
  type CadenceActionBinding,
  type ExpectedActionIntentAndSla,
  type InboundSla,
  type InsertNextActionInput,
  type NextAction,
  type NextActionWorkIntent,
} from './lifecycleTypes';
import {
  actionSettlementSchema,
  actionStatusSchema,
  cadenceActionBindingSchema,
  idSchema,
  inboundSlaSchema,
  nonblankSchema,
  parseCanonicalJson,
  serializeCanonical,
  utcTimestampSchema,
  workIntentSchema,
} from './lifecycleValidation';

const insertActionSchema = z.object({
  id: idSchema, salesCycleId: idSchema, actionType: nonblankSchema,
  channel: nonblankSchema.nullable(), status: z.literal('pending'),
  timezone: nonblankSchema, allowedWindow: z.string().nullable(),
  workIntent: workIntentSchema, inboundSla: inboundSlaSchema,
  cadence: cadenceActionBindingSchema, createdAt: utcTimestampSchema,
}).strict();
const storedActionRowSchema = z.object({
  id: idSchema, sales_cycle_id: idSchema, action_type: nonblankSchema,
  channel: nonblankSchema.nullable(), status: actionStatusSchema,
  timezone: nonblankSchema, allowed_window: z.string().nullable(), work_intent: workIntentSchema,
  inbound_sla_kind: z.enum(['inbound_demo_permitted_minutes', 'direct_referral_elapsed']).nullable(),
  inbound_sla_due_at: utcTimestampSchema.nullable(), inbound_sla_source_event_id: idSchema.nullable(),
  inbound_sla_provenance_json: z.string().nullable(), cadence_enrollment_id: idSchema.nullable(),
  cadence_step_id: idSchema.nullable(), cadence_component_id: idSchema.nullable(),
  completion_activity_id: idSchema.nullable(), settlement_json: z.string().nullable(),
  version: z.number().int().safe().positive(), created_at: utcTimestampSchema,
  completed_at: utcTimestampSchema.nullable(), updated_at: utcTimestampSchema,
}).strict();

const actionColumns = `
  id, sales_cycle_id, action_type, channel, status, timezone,
  allowed_window, work_intent, inbound_sla_kind,
  inbound_sla_due_at, inbound_sla_source_event_id, inbound_sla_provenance_json,
  cadence_enrollment_id, cadence_step_id, cadence_component_id,
  completion_activity_id, settlement_json, version, created_at, completed_at, updated_at
`;

export type ReschedulePendingActionInput = ExpectedActionIntentAndSla & Readonly<{
  actionId: string;
  salesCycleId: string;
  expectedStatus: 'pending';
  expectedVersion: number;
  expectedCadence: CadenceActionBinding;
  updatedAt: string;
  timezone: string;
  allowedWindow: string;
  cadence: CadenceActionBinding;
}>;

export type SettleActionInput = ExpectedActionIntentAndSla & Readonly<{
  actionId: string;
  salesCycleId: string;
  expectedStatus: 'pending';
  expectedVersion: number;
  expectedCadence: CadenceActionBinding;
  status: 'completed' | 'cancelled' | 'impossible';
  completedAt: string;
  completionActivityId: string | null;
  settlement: ActionSettlement;
}>;

export class NextActionRepository {
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

  insertNextAction(input: InsertNextActionInput): NextAction {
    this.unitOfWork.assertWriteScope();
    const parsed = insertActionSchema.parse(input) as InsertNextActionInput;
    assertIntentAndSla(parsed.workIntent, parsed.inboundSla);
    if (parsed.actionType === 'resolve_contact_method' && parsed.channel !== null) {
      throw new LifecycleEvidenceError('Contact-method resolution is internal channel-null work.');
    }
    resolveInstalledCadenceActionBinding(this.database, {
      salesCycleId: parsed.salesCycleId, actionType: parsed.actionType,
      channel: parsed.channel, cadence: parsed.cadence,
    });
    this.assertInboundSlaOwnership(parsed.salesCycleId, parsed.workIntent, parsed.inboundSla);
    const inbound = encodeInboundSla(parsed.inboundSla);
    const row = this.database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, timezone,
        allowed_window, work_intent, inbound_sla_kind,
        inbound_sla_due_at, inbound_sla_source_event_id, inbound_sla_provenance_json,
        cadence_enrollment_id, cadence_step_id, cadence_component_id,
        completion_activity_id, settlement_json, version, created_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, NULL, ?)
      RETURNING ${actionColumns}
    `).get(
      parsed.id, parsed.salesCycleId, parsed.actionType, parsed.channel,
      parsed.timezone, parsed.allowedWindow, parsed.workIntent,
      inbound.kind, inbound.dueAt, inbound.sourceEventId, inbound.provenanceJson,
      parsed.cadence.cadenceEnrollmentId, parsed.cadence.cadenceStepId,
      parsed.cadence.cadenceComponentId, parsed.createdAt, parsed.createdAt,
    );
    return this.parseAction(row);
  }

  reschedulePendingAction(input: ReschedulePendingActionInput): NextAction {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      actionId: idSchema, salesCycleId: idSchema, expectedStatus: z.literal('pending'),
      expectedVersion: z.number().int().safe().positive(),
      expectedWorkIntent: workIntentSchema, expectedInboundSla: inboundSlaSchema,
      expectedCadence: cadenceActionBindingSchema,
      updatedAt: utcTimestampSchema,
      timezone: nonblankSchema, allowedWindow: nonblankSchema,
      cadence: cadenceActionBindingSchema,
    }).strict().parse(input) as ReschedulePendingActionInput;
    assertIntentAndSla(parsed.expectedWorkIntent, parsed.expectedInboundSla);
    if (serializeCanonical(parsed.cadence) !== serializeCanonical(parsed.expectedCadence)) {
      throw new LifecycleEvidenceError('Reschedule cannot move cadence ownership.');
    }
    const current = this.getById(parsed.actionId);
    if (current === null || current.salesCycleId !== parsed.salesCycleId
      || current.status !== parsed.expectedStatus || current.version !== parsed.expectedVersion
      || current.workIntent !== parsed.expectedWorkIntent
      || serializeCanonical(current.inboundSla) !== serializeCanonical(parsed.expectedInboundSla)
      || serializeCanonical(current.cadence) !== serializeCanonical(parsed.expectedCadence)) {
      throw new StaleDomainWriteError();
    }
    const expectedInbound = encodeInboundSla(parsed.expectedInboundSla);
    const row = this.database.raw.prepare(`
      UPDATE next_actions
      SET timezone = ?, allowed_window = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND sales_cycle_id = ? AND status = ? AND version = ?
        AND work_intent = ?
        AND inbound_sla_kind IS ? AND inbound_sla_due_at IS ?
        AND inbound_sla_source_event_id IS ? AND inbound_sla_provenance_json IS ?
        AND cadence_enrollment_id IS ? AND cadence_step_id IS ? AND cadence_component_id IS ?
      RETURNING ${actionColumns}
    `).get(
      parsed.timezone, parsed.allowedWindow, parsed.updatedAt,
      parsed.actionId, parsed.salesCycleId, parsed.expectedStatus, parsed.expectedVersion,
      parsed.expectedWorkIntent, expectedInbound.kind,
      expectedInbound.dueAt, expectedInbound.sourceEventId, expectedInbound.provenanceJson,
      parsed.expectedCadence.cadenceEnrollmentId, parsed.expectedCadence.cadenceStepId,
      parsed.expectedCadence.cadenceComponentId,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return this.parseAction(row);
  }

  settleAction(input: SettleActionInput): NextAction {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      actionId: idSchema, salesCycleId: idSchema, expectedStatus: z.literal('pending'),
      expectedVersion: z.number().int().safe().positive(),
      expectedWorkIntent: workIntentSchema, expectedInboundSla: inboundSlaSchema,
      expectedCadence: cadenceActionBindingSchema,
      status: z.enum(['completed', 'cancelled', 'impossible']),
      completedAt: utcTimestampSchema, completionActivityId: idSchema.nullable(),
      settlement: actionSettlementSchema,
    }).strict().parse(input) as SettleActionInput;
    assertIntentAndSla(parsed.expectedWorkIntent, parsed.expectedInboundSla);
    if (
      parsed.settlement.workIntent !== parsed.expectedWorkIntent
      || serializeCanonical(parsed.settlement.inboundSla) !== serializeCanonical(parsed.expectedInboundSla)
      || serializeCanonical(parsed.settlement.cadence) !== serializeCanonical(parsed.expectedCadence)
    ) {
      throw new LifecycleEvidenceError('Settlement must retain immutable action evidence.');
    }
    const current = this.getById(parsed.actionId);
    if (current === null || current.salesCycleId !== parsed.salesCycleId
      || current.status !== parsed.expectedStatus || current.version !== parsed.expectedVersion
      || current.workIntent !== parsed.expectedWorkIntent
      || serializeCanonical(current.inboundSla) !== serializeCanonical(parsed.expectedInboundSla)
      || serializeCanonical(current.cadence) !== serializeCanonical(parsed.expectedCadence)) {
      throw new StaleDomainWriteError();
    }
    const settlementViolations = collectActionSettlementViolations(this.database, {
      ...current,
      status: parsed.status,
      completionActivityId: parsed.completionActivityId,
      settlement: parsed.settlement,
    });
    if (settlementViolations.length > 0) {
      throw new LifecycleEvidenceError(settlementViolations.join(' '));
    }
    const expectedInbound = encodeInboundSla(parsed.expectedInboundSla);
    const settlementJson = serializeCanonical(parsed.settlement);
    const row = this.database.raw.prepare(`
      UPDATE next_actions
      SET status = ?, completion_activity_id = ?, settlement_json = ?,
          completed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND sales_cycle_id = ? AND status = ? AND version = ?
        AND work_intent = ? AND inbound_sla_kind IS ? AND inbound_sla_due_at IS ?
        AND inbound_sla_source_event_id IS ? AND inbound_sla_provenance_json IS ?
        AND cadence_enrollment_id IS ? AND cadence_step_id IS ? AND cadence_component_id IS ?
      RETURNING ${actionColumns}
    `).get(
      parsed.status, parsed.completionActivityId, settlementJson, parsed.completedAt,
      parsed.completedAt, parsed.actionId, parsed.salesCycleId, parsed.expectedStatus,
      parsed.expectedVersion, parsed.expectedWorkIntent, expectedInbound.kind,
      expectedInbound.dueAt, expectedInbound.sourceEventId, expectedInbound.provenanceJson,
      parsed.expectedCadence.cadenceEnrollmentId, parsed.expectedCadence.cadenceStepId,
      parsed.expectedCadence.cadenceComponentId,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return this.parseAction(row);
  }

  getById(actionId: string): NextAction | null {
    const id = idSchema.parse(actionId);
    const row = this.database.raw.prepare(`SELECT ${actionColumns} FROM next_actions WHERE id = ?`).get(id);
    return row === undefined ? null : this.parseAction(row);
  }

  listForCycle(salesCycleId: string): readonly NextAction[] {
    const id = idSchema.parse(salesCycleId);
    return Object.freeze(this.database.raw.prepare(`
      SELECT ${actionColumns} FROM next_actions WHERE sales_cycle_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(id).map((row) => this.parseAction(row)));
  }

  listPendingOutboundForPerson(personId: string): readonly NextAction[] {
    const id = idSchema.parse(personId);
    return Object.freeze(this.database.raw.prepare(`
      SELECT ${actionColumns.split(',').map((column) => `action.${column.trim()}`).join(', ')}
      FROM next_actions AS action
      JOIN sales_cycles AS cycle ON cycle.id = action.sales_cycle_id
      WHERE cycle.person_id = ? AND action.status = 'pending' AND action.channel IS NOT NULL
      ORDER BY action.id ASC
    `).all(id).map((row) => this.parseAction(row)));
  }

  private parseAction(value: unknown): NextAction {
    return parseAction(value, this.database);
  }

  private assertInboundSlaOwnership(
    salesCycleId: string,
    workIntent: NextActionWorkIntent,
    inboundSla: InboundSla,
  ): void {
    if (workIntent !== 'inbound_response' && inboundSla.kind !== 'none') {
      throw new LifecycleEvidenceError('Only inbound-response work may carry inbound SLA evidence.');
    }
    if (inboundSla.kind === 'none') return;
    const row = this.database.raw.prepare<
      [string, string], { channel: string; observed_at: string }
    >(`
      SELECT source.channel, source.observed_at
      FROM source_events AS source
      JOIN sales_cycles AS cycle ON cycle.person_id = source.person_id
      WHERE source.id = ? AND cycle.id = ?
    `).get(inboundSla.sourceEventId, salesCycleId);
    const expectedChannel = inboundSla.kind === 'inbound_demo_permitted_minutes'
      ? 'inbound_demo'
      : 'referral';
    if (
      row === undefined
      || row.channel !== expectedChannel
      || row.observed_at !== inboundSla.provenance.sourceObservedAt
    ) {
      throw new LifecycleEvidenceError('Inbound SLA evidence is not owned source evidence.');
    }
  }
}

function assertIntentAndSla(workIntent: NextActionWorkIntent, inboundSla: InboundSla): void {
  if (workIntent !== 'inbound_response' && inboundSla.kind !== 'none') {
    throw new LifecycleEvidenceError('Non-inbound work must have no inbound SLA.');
  }
}

function encodeInboundSla(value: InboundSla): {
  kind: string | null; dueAt: string | null; sourceEventId: string | null; provenanceJson: string | null;
} {
  return value.kind === 'none'
    ? { kind: null, dueAt: null, sourceEventId: null, provenanceJson: null }
    : {
        kind: value.kind, dueAt: value.dueAt, sourceEventId: value.sourceEventId,
        provenanceJson: serializeCanonical(value.provenance),
      };
}

function parseAction(value: unknown, database: AppDatabase): NextAction {
  const row = storedActionRowSchema.parse(value);
  const inboundSla = decodeInboundSla(row);
  const cadence = cadenceActionBindingSchema.parse({
    cadenceEnrollmentId: row.cadence_enrollment_id,
    cadenceDefinitionId: row.cadence_enrollment_id === null
      ? null
      : requireCadenceDefinitionId(database.raw, row.cadence_enrollment_id),
    cadenceStepId: row.cadence_step_id,
    cadenceComponentId: row.cadence_component_id,
  });
  const settlement = row.settlement_json === null
    ? null
    : parseCanonicalJson(row.settlement_json, actionSettlementSchema);
  if (row.work_intent !== 'inbound_response' && inboundSla.kind !== 'none') {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Stored work intent and inbound SLA conflict.' }]);
  }
  if (settlement !== null && (
    settlement.workIntent !== row.work_intent
    || serializeCanonical(settlement.inboundSla) !== serializeCanonical(inboundSla)
    || serializeCanonical(settlement.cadence) !== serializeCanonical(cadence)
  )) {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Stored settlement evidence conflicts.' }]);
  }
  const parsed = {
    id: row.id, salesCycleId: row.sales_cycle_id, actionType: row.action_type,
    channel: row.channel, status: row.status, timezone: row.timezone,
    allowedWindow: row.allowed_window, workIntent: row.work_intent,
    inboundSla, cadence, completionActivityId: row.completion_activity_id,
    settlement, version: row.version, createdAt: row.created_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  } as NextAction;
  resolveInstalledCadenceActionBinding(database, {
    salesCycleId: parsed.salesCycleId, actionType: parsed.actionType,
    channel: parsed.channel, cadence: parsed.cadence,
  });
  const stateValid = row.status === 'pending'
    ? row.completed_at === null && settlement === null && row.completion_activity_id === null
    : row.completed_at !== null && settlement !== null;
  const settlementViolations = collectActionSettlementViolations(database, parsed);
  if (!stateValid || settlementViolations.length > 0) {
    throw new LifecycleEvidenceError([
      ...(stateValid ? [] : ['Stored action status/completion columns conflict.']),
      ...settlementViolations,
    ].join(' '));
  }
  return deepFreezeLifecycle(parsed) as NextAction;
}

function requireCadenceDefinitionId(
  database: AppDatabase['raw'],
  enrollmentId: string,
): string {
  const result = database.prepare<[string], { cadence_definition_id: string }>(
    'SELECT cadence_definition_id FROM cadence_enrollments WHERE id = ?',
  ).get(enrollmentId);
  return idSchema.parse(result?.cadence_definition_id);
}

function decodeInboundSla(row: z.infer<typeof storedActionRowSchema>): InboundSla {
  if (row.inbound_sla_kind === null) {
    return deepFreezeLifecycle({ kind: 'none', dueAt: null, sourceEventId: null, provenance: null });
  }
  if (
    row.inbound_sla_due_at === null
    || row.inbound_sla_source_event_id === null
    || row.inbound_sla_provenance_json === null
  ) {
    return inboundSlaSchema.parse({ kind: row.inbound_sla_kind });
  }
  if (row.inbound_sla_kind === 'inbound_demo_permitted_minutes') {
    const provenance = parseCanonicalJson(row.inbound_sla_provenance_json, z.object({
      version: z.literal(1), sourceEventId: idSchema, sourceObservedAt: utcTimestampSchema,
      calculation: z.literal('permitted_minutes'), minutes: z.literal(15),
      policyId: nonblankSchema, computedDueAt: utcTimestampSchema,
    }).strict());
    return inboundSlaSchema.parse({
      kind: row.inbound_sla_kind, dueAt: row.inbound_sla_due_at,
      sourceEventId: row.inbound_sla_source_event_id, provenance,
    });
  }
  const provenance = parseCanonicalJson(row.inbound_sla_provenance_json, z.object({
    version: z.literal(1), sourceEventId: idSchema, sourceObservedAt: utcTimestampSchema,
    calculation: z.literal('elapsed_hours'), hours: z.literal(48),
    policyId: z.null(), computedDueAt: utcTimestampSchema,
  }).strict());
  return inboundSlaSchema.parse({
    kind: row.inbound_sla_kind, dueAt: row.inbound_sla_due_at,
    sourceEventId: row.inbound_sla_source_event_id, provenance,
  });
}
