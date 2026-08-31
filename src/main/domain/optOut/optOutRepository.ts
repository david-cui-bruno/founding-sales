import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { deepFreezeLifecycle, type SalesCycle } from '../lifecycle/lifecycleTypes';
import { parseCanonicalJson, serializeCanonical } from '../lifecycle/lifecycleValidation';
import { normalizeEmail, normalizePhone } from '../source/sourceService';
import {
  DomainRepositoryDatabaseMismatchError,
  OptOutPersistenceConflictError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  assertCanonicalOptOutProvenance,
  parseOptOutActivityMetadataJson,
  type OptOutEvidenceActivityFacts,
  type OptOutEvidenceNode,
} from './optOutEvidenceValidator';
import {
  optOutHandleKindSchema,
  optOutIdSchema,
  optOutObservedChannelSchema,
  optOutUtcTimestampSchema,
  type InsertOptOutHandleInput,
  type InsertOptOutTombstoneInput,
  type OptOutHandle,
  type OptOutHandleKind,
  type OptOutTombstone,
} from './optOutTypes';
import {
  applyOptOutResultSchema,
  optOutClosureCommandSchema,
  optOutClosureReceiptValueSchema,
  type OptOutClosureReceipt,
} from './optOutValidation';

const nonblankSchema = z.string().trim().min(1);
const tombstoneInputSchema = z.object({
  id: optOutIdSchema,
  personId: optOutIdSchema,
  requestedAt: optOutUtcTimestampSchema,
  observedChannel: optOutObservedChannelSchema,
  sourceActivityId: optOutIdSchema,
  evidenceRef: z.string().nullable(),
  policyVersion: nonblankSchema,
  createdAt: optOutUtcTimestampSchema,
}).strict();
const handleInputSchema = z.object({
  id: optOutIdSchema,
  tombstoneId: optOutIdSchema,
  kind: optOutHandleKindSchema,
  normalizedValue: nonblankSchema,
  createdAt: optOutUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  try {
    const normalized = normalize(value.kind, value.normalizedValue);
    if (normalized !== value.normalizedValue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalizedValue'],
        message: 'Stored opt-out handles must already be canonical.',
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['normalizedValue'],
      message: 'Stored opt-out handle is invalid.',
    });
  }
});
const storedTombstoneSchema = z.object({
  id: optOutIdSchema,
  person_id: optOutIdSchema,
  requested_at: optOutUtcTimestampSchema,
  observed_channel: optOutObservedChannelSchema,
  source_activity_id: optOutIdSchema,
  evidence_ref: z.string().nullable(),
  policy_version: nonblankSchema,
  created_at: optOutUtcTimestampSchema,
}).strict();
const storedHandleSchema = z.object({
  id: optOutIdSchema,
  tombstone_id: optOutIdSchema,
  kind: optOutHandleKindSchema,
  normalized_value: nonblankSchema,
  created_at: optOutUtcTimestampSchema,
}).strict();
const storedEvidenceActivitySchema = z.object({
  id: optOutIdSchema,
  person_id: optOutIdSchema,
  kind: nonblankSchema,
  direction: nonblankSchema,
  channel: nonblankSchema,
  occurred_at: optOutUtcTimestampSchema,
  observed_outcome: z.string().nullable(),
  adapter: nonblankSchema.nullable(),
  provider_idempotency_key: nonblankSchema.nullable(),
  provider_reference: z.string().nullable(),
  metadata_json: z.string(),
}).strict();
const storedClosureReceiptSchema = z.object({
  source_activity_id: optOutIdSchema,
  operation_kind: z.enum(['apply', 'propagate']),
  person_id: optOutIdSchema,
  tombstone_id: optOutIdSchema,
  source_tombstone_id: optOutIdSchema.nullable(),
  closed_cycle_id: optOutIdSchema.nullable(),
  terminal_stage_event_id: optOutIdSchema.nullable(),
  command_json: z.string().trim().min(1),
  result_json: z.string().trim().min(1),
  created_at: optOutUtcTimestampSchema,
}).strict();
const storedCycleSchema = z.object({
  id: optOutIdSchema, person_id: optOutIdSchema, prospect_id: optOutIdSchema,
  entry_source_event_id: optOutIdSchema,
  stage: z.enum([
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ]),
  workflow_status: z.enum(['active', 'onboarding', 'closed']),
  current_next_action_id: optOutIdSchema.nullable(),
  stage_entered_at: optOutUtcTimestampSchema,
  design_partner_fitness: z.number().int().min(0).max(5).nullable(),
  close_reason: z.enum([
    'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
    'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
    'cadence_exhausted', 'disqualified', 'opt_out', 'other',
  ]).nullable(),
  close_notes: z.string().nullable(), onboarding_stop_reason: z.string().nullable(),
  closed_at: optOutUtcTimestampSchema.nullable(), version: z.number().int().positive(),
  created_at: optOutUtcTimestampSchema, updated_at: optOutUtcTimestampSchema,
}).strict();

const tombstoneColumns = `
  id, person_id, requested_at, observed_channel, source_activity_id,
  evidence_ref, policy_version, created_at
`;
const handleColumns = `id, tombstone_id, kind, normalized_value, created_at`;
const closureReceiptColumns = `
  source_activity_id, operation_kind, person_id, tombstone_id, source_tombstone_id,
  closed_cycle_id, terminal_stage_event_id, command_json, result_json, created_at
`;
const cycleColumns = `
  id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
  current_next_action_id, stage_entered_at, design_partner_fitness, close_reason,
  close_notes, onboarding_stop_reason, closed_at, version, created_at, updated_at
`;

export class OptOutRepository {
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

  insertTombstone(input: InsertOptOutTombstoneInput): OptOutTombstone {
    this.unitOfWork.assertWriteScope();
    const parsed = tombstoneInputSchema.parse(input) as InsertOptOutTombstoneInput;
    const byId = this.getById(parsed.id);
    if (byId !== null) return exactTombstone(byId, parsed);
    const byPerson = this.getForPerson(parsed.personId);
    if (byPerson !== null) throw new OptOutPersistenceConflictError('tombstone', byPerson.id);
    validateTombstoneEvidence(this.database, parsed);
    const row = this.database.raw.prepare(`
      INSERT INTO opt_out_tombstones (
        id, person_id, requested_at, observed_channel, source_activity_id,
        evidence_ref, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${tombstoneColumns}
    `).get(
      parsed.id, parsed.personId, parsed.requestedAt, parsed.observedChannel,
      parsed.sourceActivityId, parsed.evidenceRef, parsed.policyVersion, parsed.createdAt,
    );
    return parseTombstone(this.database, row);
  }

  insertBlockedHandle(input: InsertOptOutHandleInput): OptOutHandle {
    this.unitOfWork.assertWriteScope();
    const parsed = handleInputSchema.parse(input) as InsertOptOutHandleInput;
    const byId = this.getHandleById(parsed.id);
    if (byId !== null) return exactHandle(byId, parsed);
    const existing = this.database.raw.prepare(`
      SELECT ${handleColumns} FROM opt_out_handles
      WHERE tombstone_id = ? AND kind = ? AND normalized_value = ?
    `).get(parsed.tombstoneId, parsed.kind, parsed.normalizedValue);
    if (existing !== undefined) {
      const canonical = parseHandle(existing);
      throw new OptOutPersistenceConflictError('handle', canonical.id);
    }
    const row = this.database.raw.prepare(`
      INSERT INTO opt_out_handles (
        id, tombstone_id, kind, normalized_value, created_at
      ) VALUES (?, ?, ?, ?, ?)
      RETURNING ${handleColumns}
    `).get(parsed.id, parsed.tombstoneId, parsed.kind, parsed.normalizedValue, parsed.createdAt);
    return parseHandle(row);
  }

  insertClosureReceipt(input: OptOutClosureReceipt): OptOutClosureReceipt {
    this.unitOfWork.assertWriteScope();
    const parsed = optOutClosureReceiptValueSchema.parse(input) as OptOutClosureReceipt;
    const existing = this.getClosureReceiptForActivity(parsed.sourceActivityId);
    if (existing !== null) {
      if (serializeCanonical(existing) === serializeCanonical(parsed)) return existing;
      throw new OptOutPersistenceConflictError('closure_receipt', parsed.sourceActivityId);
    }
    validateClosureReceiptRelations(this.database, parsed);
    const row = this.database.raw.prepare(`
      INSERT INTO opt_out_closure_receipts (
        source_activity_id, operation_kind, person_id, tombstone_id, source_tombstone_id,
        closed_cycle_id, terminal_stage_event_id, command_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${closureReceiptColumns}
    `).get(
      parsed.sourceActivityId, parsed.operationKind, parsed.personId, parsed.tombstoneId,
      parsed.sourceTombstoneId, parsed.closedCycleId, parsed.terminalStageEventId,
      serializeCanonical(parsed.command), serializeCanonical(parsed.result), parsed.createdAt,
    );
    return parseClosureReceipt(this.database, row);
  }

  getClosureReceiptForActivity(sourceActivityId: string): OptOutClosureReceipt | null {
    const id = optOutIdSchema.parse(sourceActivityId);
    const row = this.database.raw.prepare(`
      SELECT ${closureReceiptColumns} FROM opt_out_closure_receipts
      WHERE source_activity_id = ?
    `).get(id);
    return row === undefined ? null : parseClosureReceipt(this.database, row);
  }

  getForPerson(personId: string): OptOutTombstone | null {
    const id = optOutIdSchema.parse(personId);
    const row = this.database.raw.prepare(`
      SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE person_id = ?
    `).get(id);
    return row === undefined ? null : parseTombstone(this.database, row);
  }

  getById(tombstoneId: string): OptOutTombstone | null {
    const id = optOutIdSchema.parse(tombstoneId);
    const row = this.database.raw.prepare(`
      SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
    `).get(id);
    return row === undefined ? null : parseTombstone(this.database, row);
  }

  listBlocksForHandle(kind: OptOutHandleKind, normalizedValue: string): OptOutTombstone[] {
    const parsedKind = optOutHandleKindSchema.parse(kind);
    const parsedValue = normalize(parsedKind, normalizedValue);
    return this.database.raw.prepare(`
      SELECT ${tombstoneColumns.split(',').map((column) => `tombstone.${column.trim()}`).join(', ')}
      FROM opt_out_handles AS handle
      JOIN opt_out_tombstones AS tombstone ON tombstone.id = handle.tombstone_id
      WHERE handle.kind = ? AND handle.normalized_value = ?
      ORDER BY tombstone.requested_at ASC, tombstone.id ASC
    `).all(parsedKind, parsedValue).map((row) => parseTombstone(this.database, row));
  }

  listHandles(tombstoneId: string): OptOutHandle[] {
    const id = optOutIdSchema.parse(tombstoneId);
    return this.database.raw.prepare(`
      SELECT ${handleColumns} FROM opt_out_handles
      WHERE tombstone_id = ?
      ORDER BY kind ASC, normalized_value ASC, id ASC
    `).all(id).map(parseHandle);
  }

  private getHandleById(handleId: string): OptOutHandle | null {
    const id = optOutIdSchema.parse(handleId);
    const row = this.database.raw.prepare(`
      SELECT ${handleColumns} FROM opt_out_handles WHERE id = ?
    `).get(id);
    return row === undefined ? null : parseHandle(row);
  }
}

function normalize(kind: OptOutHandleKind, value: string): string {
  return kind === 'phone' ? normalizePhone(value) : normalizeEmail(value);
}

function parseTombstone(
  database: AppDatabase,
  value: unknown,
): OptOutTombstone {
  const tombstone = parseStoredTombstone(value);
  validateTombstoneEvidence(database, tombstone);
  return tombstone;
}

function parseHandle(value: unknown): OptOutHandle {
  const row = storedHandleSchema.parse(value);
  const normalized = normalize(row.kind, row.normalized_value);
  if (normalized !== row.normalized_value) throw new Error('Stored opt-out handle is not canonical.');
  return Object.freeze({
    id: row.id, tombstoneId: row.tombstone_id, kind: row.kind,
    normalizedValue: row.normalized_value, createdAt: row.created_at,
  });
}

function exactTombstone(
  existing: OptOutTombstone,
  input: InsertOptOutTombstoneInput,
): OptOutTombstone {
  if (JSON.stringify(existing) !== JSON.stringify(input)) {
    throw new OptOutPersistenceConflictError('tombstone', existing.id);
  }
  return existing;
}

function exactHandle(existing: OptOutHandle, input: InsertOptOutHandleInput): OptOutHandle {
  if (JSON.stringify(existing) !== JSON.stringify(input)) {
    throw new OptOutPersistenceConflictError('handle', existing.id);
  }
  return existing;
}

function validateTombstoneEvidence(
  database: AppDatabase,
  tombstone: OptOutTombstone,
): void {
  assertCanonicalOptOutProvenance({
    root: { tombstone, activity: loadEvidenceActivity(database, tombstone.sourceActivityId) },
    loadSource: (tombstoneId) => loadEvidenceNode(database, tombstoneId),
  });
}

function parseEvidenceActivity(value: unknown): OptOutEvidenceActivityFacts {
  const row = storedEvidenceActivitySchema.parse(value);
  const metadata = parseOptOutActivityMetadataJson(row.metadata_json);
  if (!metadata.success) {
    throw new Error('Stored opt-out Activity metadata is invalid JSON.');
  }
  return Object.freeze({
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    direction: row.direction,
    channel: row.channel,
    occurredAt: row.occurred_at,
    observedOutcome: row.observed_outcome,
    adapter: row.adapter,
    providerIdempotencyKey: row.provider_idempotency_key,
    providerReference: row.provider_reference,
    metadata: metadata.metadata,
  });
}

function loadEvidenceActivity(
  database: AppDatabase,
  activityId: string,
): OptOutEvidenceActivityFacts | null {
  const row = database.raw.prepare(`
    SELECT id, person_id, kind, direction, channel, occurred_at, observed_outcome,
      adapter, provider_idempotency_key, provider_reference, metadata_json
    FROM activities WHERE id = ?
  `).get(activityId);
  return row === undefined ? null : parseEvidenceActivity(row);
}

function loadEvidenceNode(database: AppDatabase, tombstoneId: string): OptOutEvidenceNode | null {
  const row = database.raw.prepare(`
    SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
  `).get(tombstoneId);
  if (row === undefined) return null;
  const tombstone = parseStoredTombstone(row);
  return Object.freeze({
    tombstone,
    activity: loadEvidenceActivity(database, tombstone.sourceActivityId),
  });
}

function parseStoredTombstone(value: unknown): OptOutTombstone {
  const row = storedTombstoneSchema.parse(value);
  return Object.freeze({
    id: row.id, personId: row.person_id, requestedAt: row.requested_at,
    observedChannel: row.observed_channel, sourceActivityId: row.source_activity_id,
    evidenceRef: row.evidence_ref, policyVersion: row.policy_version, createdAt: row.created_at,
  });
}

function parseClosureReceipt(database: AppDatabase, value: unknown): OptOutClosureReceipt {
  const row = storedClosureReceiptSchema.parse(value);
  const receipt = optOutClosureReceiptValueSchema.parse({
    sourceActivityId: row.source_activity_id,
    operationKind: row.operation_kind,
    personId: row.person_id,
    tombstoneId: row.tombstone_id,
    sourceTombstoneId: row.source_tombstone_id,
    closedCycleId: row.closed_cycle_id,
    terminalStageEventId: row.terminal_stage_event_id,
    command: parseCanonicalJson(row.command_json, optOutClosureCommandSchema),
    result: parseCanonicalJson(row.result_json, applyOptOutResultSchema),
    createdAt: row.created_at,
  }) as OptOutClosureReceipt;
  validateClosureReceiptRelations(database, receipt);
  return deepFreezeLifecycle(receipt) as OptOutClosureReceipt;
}

function validateClosureReceiptRelations(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
): void {
  const activity = database.raw.prepare(`
    SELECT id, person_id FROM activities WHERE id = ?
  `).get(receipt.sourceActivityId) as { id: string; person_id: string } | undefined;
  if (activity?.person_id !== receipt.personId) {
    throw new Error('Opt-out closure receipt Activity ownership is invalid.');
  }
  const tombstoneRow = database.raw.prepare(`
    SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
  `).get(receipt.tombstoneId);
  if (tombstoneRow === undefined) {
    throw new Error('Opt-out closure receipt tombstone is missing.');
  }
  const tombstone = parseTombstone(database, tombstoneRow);
  if (serializeCanonical(tombstone) !== serializeCanonical(receipt.result.tombstone)) {
    throw new Error('Opt-out closure receipt tombstone snapshot is invalid.');
  }
  if (receipt.sourceTombstoneId !== null) {
    const source = database.raw.prepare(`
      SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
    `).get(receipt.sourceTombstoneId);
    if (source === undefined) throw new Error('Opt-out closure source tombstone is missing.');
    parseTombstone(database, source);
  }
  if (receipt.closedCycleId !== null) {
    const cycleRow = database.raw.prepare(`
      SELECT ${cycleColumns} FROM sales_cycles WHERE id = ?
    `).get(receipt.closedCycleId);
    if (cycleRow === undefined) throw new Error('Opt-out closure receipt cycle is missing.');
    const cycle = parseStoredCycle(cycleRow);
    if (serializeCanonical(cycle) !== serializeCanonical(receipt.result.cycle)) {
      throw new Error('Opt-out closure receipt cycle snapshot is invalid.');
    }
  }
  if (receipt.terminalStageEventId !== null) {
    const terminal = database.raw.prepare(`
      SELECT id, sales_cycle_id FROM stage_events WHERE id = ?
    `).get(receipt.terminalStageEventId) as { id: string; sales_cycle_id: string } | undefined;
    if (terminal?.sales_cycle_id !== receipt.closedCycleId) {
      throw new Error('Opt-out closure receipt terminal event ownership is invalid.');
    }
  }
  const retainedHandles = new Map(database.raw.prepare(`
    SELECT ${handleColumns} FROM opt_out_handles WHERE tombstone_id = ?
  `).all(receipt.tombstoneId).map((row) => {
    const handle = parseHandle(row);
    return [handle.id, handle] as const;
  }));
  for (const handle of receipt.result.handles) {
    if (serializeCanonical(retainedHandles.get(handle.id)) !== serializeCanonical(handle)) {
      throw new Error('Opt-out closure receipt handle snapshot is invalid.');
    }
  }
}

function parseStoredCycle(value: unknown): SalesCycle {
  const row = storedCycleSchema.parse(value);
  return deepFreezeLifecycle({
    id: row.id, personId: row.person_id, prospectId: row.prospect_id,
    entrySourceEventId: row.entry_source_event_id, stage: row.stage,
    workflowStatus: row.workflow_status, currentNextActionId: row.current_next_action_id,
    stageEnteredAt: row.stage_entered_at, designPartnerFitness: row.design_partner_fitness,
    closeReason: row.close_reason, closeNotes: row.close_notes,
    onboardingStopReason: row.onboarding_stop_reason, closedAt: row.closed_at,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  }) as SalesCycle;
}
