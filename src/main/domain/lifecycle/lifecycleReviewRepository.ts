import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleIdempotencyConflictError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { deepFreezeLifecycle, type LifecycleReviewItem } from './lifecycleTypes';
import {
  idSchema,
  nonblankSchema,
  parseCanonicalJson,
  serializeCanonical,
  utcTimestampSchema,
} from './lifecycleValidation';

const versionedEnvelopeSchema = z.object({ version: z.literal(1) }).passthrough();
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
  payload: unknown;
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
      payload: versionedEnvelopeSchema, createdAt: utcTimestampSchema,
    }).strict().parse(input);
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
    return parseReview(row);
  }

  resolve(input: {
    id: string;
    activationKey: string;
    expectedVersion: number;
    resolution: unknown;
    resolvedAt: string;
  }): LifecycleReviewItem {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      id: idSchema, activationKey: nonblankSchema,
      expectedVersion: z.number().int().safe().positive(),
      resolution: versionedEnvelopeSchema, resolvedAt: utcTimestampSchema,
    }).strict().parse(input);
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
    return parseReview(row);
  }

  getByActivationKey(activationKey: string): LifecycleReviewItem | null {
    const key = nonblankSchema.parse(activationKey);
    const row = this.database.raw.prepare(`
      SELECT ${reviewColumns} FROM lifecycle_review_items WHERE activation_key = ?
    `).get(key);
    return row === undefined ? null : parseReview(row);
  }
}

function parseReview(value: unknown): LifecycleReviewItem {
  const row = storedReviewSchema.parse(value);
  return deepFreezeLifecycle({
    id: row.id, activationKey: row.activation_key, status: row.status,
    personId: row.person_id, prospectId: row.prospect_id,
    sourceCycleId: row.source_cycle_id, reactivationRuleId: row.reactivation_rule_id,
    sourceEventId: row.source_event_id, reason: row.reason,
    payload: parseCanonicalJson(row.payload_json, versionedEnvelopeSchema),
    resolution: row.resolution_json === null
      ? null
      : parseCanonicalJson(row.resolution_json, versionedEnvelopeSchema),
    resolvedAt: row.resolved_at, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }) as LifecycleReviewItem;
}
