import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleEvidenceError,
  LifecycleIdempotencyConflictError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { deepFreezeLifecycle, type LifecycleReviewItem } from './lifecycleTypes';
import {
  reactivationReviewPayloadSchema,
  reactivationReviewResolutionSchema,
  type ReactivationReviewPayload,
  type ReactivationReviewResolution,
} from './reactivationContracts';
import {
  idSchema,
  nonblankSchema,
  parseCanonicalJson,
  serializeCanonical,
  utcTimestampSchema,
} from './lifecycleValidation';

const storedReviewSchema = z.object({
  id: idSchema, activation_key: nonblankSchema, status: z.enum(['open', 'resolved']),
  person_id: idSchema, prospect_id: idSchema, source_cycle_id: idSchema,
  reactivation_rule_id: idSchema.nullable(), source_event_id: idSchema.nullable(),
  reason: nonblankSchema, payload_json: z.string(), resolution_json: z.string().nullable(),
  resolved_at: utcTimestampSchema.nullable(), version: z.number().int().safe().positive(),
  created_at: utcTimestampSchema, updated_at: utcTimestampSchema,
}).strict();
const reviewColumns = `
  id, activation_key, status, person_id, prospect_id, source_cycle_id,
  reactivation_rule_id, source_event_id, reason, payload_json, resolution_json,
  resolved_at, version, created_at, updated_at
`;

export type InsertLifecycleReviewInput = Readonly<{
  id: string;
  activationKey: string;
  personId: string;
  prospectId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  reason: string;
  payload: ReactivationReviewPayload;
  createdAt: string;
}>;

export class LifecycleReviewRepository {
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

  insertOrGetOpen(input: InsertLifecycleReviewInput): LifecycleReviewItem {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      id: idSchema, activationKey: nonblankSchema, personId: idSchema,
      prospectId: idSchema, sourceCycleId: idSchema, reactivationRuleId: idSchema.nullable(),
      sourceEventId: idSchema.nullable(), reason: nonblankSchema,
      payload: reactivationReviewPayloadSchema, createdAt: utcTimestampSchema,
    }).strict().parse(input) as InsertLifecycleReviewInput;
    assertReviewRelations(this.database, { ...parsed, resolution: null });
    const existing = this.getByActivationKey(parsed.activationKey);
    if (existing !== null) {
      if (
        existing.id !== parsed.id
        || existing.personId !== parsed.personId
        || existing.prospectId !== parsed.prospectId
        || existing.sourceCycleId !== parsed.sourceCycleId
        || existing.reactivationRuleId !== parsed.reactivationRuleId
        || existing.sourceEventId !== parsed.sourceEventId
        || existing.reason !== parsed.reason
        || serializeCanonical(existing.payload) !== serializeCanonical(parsed.payload)
      ) throw new LifecycleIdempotencyConflictError();
      return existing;
    }
    const row = this.database.raw.prepare(`
      INSERT INTO lifecycle_review_items (
        id, activation_key, status, person_id, prospect_id, source_cycle_id,
        reactivation_rule_id, source_event_id, reason, payload_json,
        resolution_json, resolved_at, version, created_at, updated_at
      ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)
      RETURNING ${reviewColumns}
    `).get(
      parsed.id, parsed.activationKey, parsed.personId, parsed.prospectId,
      parsed.sourceCycleId, parsed.reactivationRuleId, parsed.sourceEventId,
      parsed.reason, serializeCanonical(parsed.payload), parsed.createdAt, parsed.createdAt,
    );
    return parseReview(row, this.database);
  }

  resolve(input: {
    id: string;
    activationKey: string;
    expectedVersion: number;
    resolution: ReactivationReviewResolution;
    resolvedAt: string;
  }): LifecycleReviewItem {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      id: idSchema, activationKey: nonblankSchema,
      expectedVersion: z.number().int().safe().positive(),
      resolution: reactivationReviewResolutionSchema, resolvedAt: utcTimestampSchema,
    }).strict().parse(input);
    const existing = this.getByActivationKey(parsed.activationKey);
    if (existing === null || existing.id !== parsed.id) throw new StaleDomainWriteError();
    assertReviewRelations(this.database, {
      id: existing.id, activationKey: existing.activationKey,
      personId: existing.personId, prospectId: existing.prospectId,
      sourceCycleId: existing.sourceCycleId,
      reactivationRuleId: existing.reactivationRuleId,
      sourceEventId: existing.sourceEventId, reason: existing.reason,
      payload: existing.payload, createdAt: existing.createdAt,
      resolution: parsed.resolution,
    });
    const row = this.database.raw.prepare(`
      UPDATE lifecycle_review_items
      SET status = 'resolved', resolution_json = ?, resolved_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND activation_key = ? AND status = 'open' AND version = ?
      RETURNING ${reviewColumns}
    `).get(
      serializeCanonical(parsed.resolution), parsed.resolvedAt, parsed.resolvedAt,
      parsed.id, parsed.activationKey, parsed.expectedVersion,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseReview(row, this.database);
  }

  getByActivationKey(activationKey: string): LifecycleReviewItem | null {
    const key = nonblankSchema.parse(activationKey);
    const row = this.database.raw.prepare(`
      SELECT ${reviewColumns} FROM lifecycle_review_items WHERE activation_key = ?
    `).get(key);
    return row === undefined ? null : parseReview(row, this.database);
  }
}

function parseReview(value: unknown, database: AppDatabase): LifecycleReviewItem {
  const row = storedReviewSchema.parse(value);
  const parsed = {
    id: row.id, activationKey: row.activation_key, status: row.status,
    personId: row.person_id, prospectId: row.prospect_id,
    sourceCycleId: row.source_cycle_id, reactivationRuleId: row.reactivation_rule_id,
    sourceEventId: row.source_event_id, reason: row.reason,
    payload: parseCanonicalJson(row.payload_json, reactivationReviewPayloadSchema),
    resolution: row.resolution_json === null
      ? null
      : parseCanonicalJson(row.resolution_json, reactivationReviewResolutionSchema),
    resolvedAt: row.resolved_at, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  } as const;
  assertReviewRelations(database, parsed);
  return deepFreezeLifecycle(parsed) as LifecycleReviewItem;
}

function assertReviewRelations(
  database: AppDatabase,
  review: Readonly<{
    id: string; activationKey: string; personId: string; prospectId: string;
    sourceCycleId: string; reactivationRuleId: string | null; sourceEventId: string | null;
    reason: string; payload: ReactivationReviewPayload;
    resolution: ReactivationReviewResolution | null; createdAt: string;
  }>,
): void {
  const command = review.payload.command;
  const sourceCycle = database.raw.prepare(`
    SELECT person_id, prospect_id, workflow_status FROM sales_cycles WHERE id = ?
  `).get(review.sourceCycleId) as {
    person_id: string; prospect_id: string; workflow_status: string;
  } | undefined;
  const definition = database.raw.prepare(`
    SELECT family, version, content_hash FROM cadence_definitions WHERE id = ?
  `).get(command.cadence.definitionId) as {
    family: string; version: number; content_hash: string;
  } | undefined;
  let evidenceValid = false;
  if ('ruleType' in command) {
    const rule = database.raw.prepare(`
      SELECT sales_cycle_id, rule_type FROM reactivation_rules WHERE id = ?
    `).get(command.ruleId) as { sales_cycle_id: string; rule_type: string } | undefined;
    const source = database.raw.prepare(`
      SELECT person_id, prospect_id FROM source_events WHERE id = ?
    `).get(command.entrySourceEventId) as {
      person_id: string; prospect_id: string | null;
    } | undefined;
    evidenceValid = review.activationKey === `rule:${command.ruleId}`
      && review.reactivationRuleId === command.ruleId && review.sourceEventId === null
      && rule?.sales_cycle_id === review.sourceCycleId && rule.rule_type === command.ruleType
      && source?.person_id === review.personId
      && (source.prospect_id === null || source.prospect_id === review.prospectId);
  } else if (command.evidence.kind === 'source_event') {
    const source = database.raw.prepare(`
      SELECT person_id, prospect_id, channel FROM source_events WHERE id = ?
    `).get(command.evidence.sourceEventId) as {
      person_id: string; prospect_id: string | null; channel: string;
    } | undefined;
    evidenceValid = review.activationKey === `inbound:${command.evidence.sourceEventId}`
      && review.reactivationRuleId === null
      && review.sourceEventId === command.evidence.sourceEventId
      && source?.person_id === review.personId
      && (source.prospect_id === null || source.prospect_id === review.prospectId)
      && source.channel === command.evidence.channel;
  } else {
    evidenceValid = review.activationKey
        === `inbound-handle:${command.evidence.handleKind}:${command.evidence.normalizedValue}`
      && review.reactivationRuleId === null && review.sourceEventId === null;
  }
  let resolutionValid = true;
  if (review.resolution !== null) {
    const target = database.raw.prepare(`
      SELECT person_id, prospect_id, entry_source_event_id FROM sales_cycles WHERE id = ?
    `).get(review.resolution.newCycleId) as {
      person_id: string; prospect_id: string; entry_source_event_id: string;
    } | undefined;
    const enrollment = database.raw.prepare(`
      SELECT id FROM cadence_enrollments
      WHERE sales_cycle_id = ? AND cadence_definition_id = ?
    `).get(review.resolution.newCycleId, command.cadence.definitionId);
    const expectedKind = 'ruleType' in command ? 'rule' : 'inbound_response';
    resolutionValid = review.resolution.newCycleId === command.newCycleId
      && review.resolution.activationKind === expectedKind
      && serializeCanonical(review.resolution.cadence) === serializeCanonical(command.cadence)
      && target?.person_id === review.personId && target.prospect_id === review.prospectId
      && enrollment !== undefined;
  }
  if (command.personId !== review.personId || command.prospectId !== review.prospectId
    || command.sourceCycleId !== review.sourceCycleId
    || command.activatedAt !== review.createdAt
    || review.reason !== review.payload.blocker
    || sourceCycle === undefined || sourceCycle.person_id !== review.personId
    || sourceCycle.prospect_id !== review.prospectId || sourceCycle.workflow_status !== 'closed'
    || definition === undefined || definition.family !== command.cadence.family
    || definition.version !== command.cadence.version
    || definition.content_hash !== command.cadence.contentHash
    || !evidenceValid || !resolutionValid) {
    throw new LifecycleEvidenceError('Lifecycle Review relational evidence is invalid.');
  }
}
