import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { normalizeEmail, normalizePhone } from '../source/sourceService';
import {
  DomainRepositoryDatabaseMismatchError,
  OptOutPersistenceConflictError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  assertCanonicalOptOutEvidence,
  type OptOutEvidenceActivityFacts,
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

const tombstoneColumns = `
  id, person_id, requested_at, observed_channel, source_activity_id,
  evidence_ref, policy_version, created_at
`;
const handleColumns = `id, tombstone_id, kind, normalized_value, created_at`;

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
  seen: ReadonlySet<string> = new Set(),
): OptOutTombstone {
  const row = storedTombstoneSchema.parse(value);
  if (seen.has(row.id)) throw new Error('Opt-out propagation evidence is cyclic.');
  const tombstone = Object.freeze({
    id: row.id, personId: row.person_id, requestedAt: row.requested_at,
    observedChannel: row.observed_channel, sourceActivityId: row.source_activity_id,
    evidenceRef: row.evidence_ref, policyVersion: row.policy_version, createdAt: row.created_at,
  });
  validateTombstoneEvidence(database, tombstone, new Set([...seen, row.id]));
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
  seen: ReadonlySet<string> = new Set(),
): void {
  const activityRow = database.raw.prepare(`
    SELECT id, person_id, kind, direction, channel, occurred_at, observed_outcome,
      adapter, provider_idempotency_key, provider_reference, metadata_json
    FROM activities WHERE id = ?
  `).get(tombstone.sourceActivityId);
  const activity = activityRow === undefined ? null : parseEvidenceActivity(activityRow);
  let sourceTombstone: OptOutTombstone | null = null;
  if (tombstone.observedChannel === 'identity_propagation'
    && tombstone.evidenceRef?.startsWith('tombstone:')) {
    const sourceId = tombstone.evidenceRef.slice('tombstone:'.length);
    const sourceRow = database.raw.prepare(`
      SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
    `).get(sourceId);
    if (sourceRow !== undefined) sourceTombstone = parseTombstone(database, sourceRow, seen);
  }
  assertCanonicalOptOutEvidence({ tombstone, activity, sourceTombstone });
}

function parseEvidenceActivity(value: unknown): OptOutEvidenceActivityFacts {
  const row = storedEvidenceActivitySchema.parse(value);
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata_json) as unknown;
  } catch {
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
    metadata,
  });
}
