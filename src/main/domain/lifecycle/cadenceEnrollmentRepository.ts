import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { EnrollmentMutation } from '../cadence/cadencePlanner';
import type { CadenceAggregate } from '../cadence/cadenceTypes';
import type { CadenceRepository } from '../cadence/cadenceRepository';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleEvidenceError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { validateEffectiveCadencePlan } from './cadenceEffectivePlan';
import { deepFreezeLifecycle, type CadenceEnrollment } from './lifecycleTypes';
import {
  idSchema,
  parseCanonicalJson,
  serializeCanonical,
  utcTimestampSchema,
} from './lifecycleValidation';

const modeSchema = z.enum(['standard', 'inbound_over_cap_response']);
const statusSchema = z.enum(['active', 'completed', 'stopped']);
const allowedStepsSchema = z.array(idSchema).min(1);
const storedEnrollmentSchema = z.object({
  id: idSchema, sales_cycle_id: idSchema, cadence_definition_id: idSchema,
  status: statusSchema, anchor_at: utcTimestampSchema, current_step_id: idSchema.nullable(),
  scheduled_step_count: z.number().int().safe().nonnegative(), mode: modeSchema,
  allowed_step_ids_json: z.string().nullable(), stop_reason: z.string().nullable(),
  version: z.number().int().safe().positive(), created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();
const enrollmentColumns = `
  id, sales_cycle_id, cadence_definition_id, status, anchor_at, current_step_id,
  scheduled_step_count, mode, allowed_step_ids_json, stop_reason, version,
  created_at, updated_at
`;

export type InsertCadenceEnrollmentInput = Readonly<{
  id: string;
  salesCycleId: string;
  definitionId: string;
  anchorAt: string;
  currentStepId: string;
  scheduledStepCount: number;
  status: 'active';
  mode: 'standard' | 'inbound_over_cap_response';
  allowedStepIds: readonly string[] | null;
  createdAt: string;
}>;

export type ApplyCadenceEnrollmentMutationInput = Readonly<{
  enrollmentId: string;
  salesCycleId: string;
  expectedVersion: number;
  expectedDefinitionId: string;
  expectedCurrentStepId: string;
  expectedScheduledStepCount: number;
  expectedStatus: 'active';
  expectedMode: 'standard' | 'inbound_over_cap_response';
  expectedAllowedStepIds: readonly string[] | null;
  mutation: EnrollmentMutation;
  updatedAt: string;
}>;

export class CadenceEnrollmentRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly cadences: CadenceRepository;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    cadences: CadenceRepository;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.cadences.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.cadences = input.cadences;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  insertCadenceEnrollment(input: InsertCadenceEnrollmentInput): CadenceEnrollment {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      id: idSchema, salesCycleId: idSchema, definitionId: idSchema,
      anchorAt: utcTimestampSchema, currentStepId: idSchema,
      scheduledStepCount: z.number().int().safe().positive(), status: z.literal('active'),
      mode: modeSchema, allowedStepIds: z.array(idSchema).min(1).nullable(),
      createdAt: utcTimestampSchema,
    }).strict().parse(input) as InsertCadenceEnrollmentInput;
    const definition = this.requireDefinition(parsed.definitionId);
    validateEffectiveCadencePlan({
      definition, mode: parsed.mode, allowedStepIds: parsed.allowedStepIds,
      currentStepId: parsed.currentStepId, scheduledStepCount: parsed.scheduledStepCount,
    });
    const allowedJson = parsed.allowedStepIds === null
      ? null
      : serializeCanonical([...parsed.allowedStepIds]);
    const row = this.database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
        stop_reason, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      RETURNING ${enrollmentColumns}
    `).get(
      parsed.id, parsed.salesCycleId, parsed.definitionId, parsed.anchorAt,
      parsed.currentStepId, parsed.scheduledStepCount, parsed.mode,
      allowedJson, parsed.createdAt, parsed.createdAt,
    );
    return this.parseEnrollment(row);
  }

  applyCadenceEnrollmentMutation(
    input: ApplyCadenceEnrollmentMutationInput,
  ): CadenceEnrollment {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      enrollmentId: idSchema, salesCycleId: idSchema,
      expectedVersion: z.number().int().safe().positive(), expectedDefinitionId: idSchema,
      expectedCurrentStepId: idSchema,
      expectedScheduledStepCount: z.number().int().safe().nonnegative(),
      expectedStatus: z.literal('active'), expectedMode: modeSchema,
      expectedAllowedStepIds: z.array(idSchema).min(1).nullable(),
      mutation: z.object({
        kind: z.enum(['start', 'advance_component', 'advance_step', 'retry', 'resolve', 'stop', 'complete']),
        definitionId: idSchema, currentStepId: idSchema,
        scheduledStepCountDelta: z.union([z.literal(0), z.literal(1)]),
        status: statusSchema, stopReason: z.string().nullable(),
      }).strict(),
      updatedAt: utcTimestampSchema,
    }).strict().parse(input) as ApplyCadenceEnrollmentMutationInput;
    if (parsed.mutation.definitionId !== parsed.expectedDefinitionId) {
      throw new LifecycleEvidenceError('A cadence mutation cannot change definition ownership.');
    }
    const definition = this.requireDefinition(parsed.expectedDefinitionId);
    validateEffectiveCadencePlan({
      definition, mode: parsed.expectedMode, allowedStepIds: parsed.expectedAllowedStepIds,
      currentStepId: parsed.expectedCurrentStepId,
      scheduledStepCount: parsed.expectedScheduledStepCount,
    });
    const nextCount = parsed.expectedScheduledStepCount + parsed.mutation.scheduledStepCountDelta;
    validateEffectiveCadencePlan({
      definition, mode: parsed.expectedMode, allowedStepIds: parsed.expectedAllowedStepIds,
      currentStepId: parsed.mutation.currentStepId, scheduledStepCount: nextCount,
    });
    if (
      (parsed.mutation.status === 'active') !== (parsed.mutation.stopReason === null)
    ) {
      throw new LifecycleEvidenceError('Active enrollment mutations cannot carry a stop reason.');
    }
    const expectedAllowedJson = parsed.expectedAllowedStepIds === null
      ? null
      : serializeCanonical([...parsed.expectedAllowedStepIds]);
    const row = this.database.raw.prepare(`
      UPDATE cadence_enrollments
      SET current_step_id = ?, scheduled_step_count = ?, status = ?, stop_reason = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND sales_cycle_id = ? AND version = ?
        AND cadence_definition_id = ? AND current_step_id = ?
        AND scheduled_step_count = ? AND status = ? AND mode = ?
        AND allowed_step_ids_json IS ?
      RETURNING ${enrollmentColumns}
    `).get(
      parsed.mutation.currentStepId, nextCount, parsed.mutation.status,
      parsed.mutation.stopReason, parsed.updatedAt, parsed.enrollmentId,
      parsed.salesCycleId, parsed.expectedVersion, parsed.expectedDefinitionId,
      parsed.expectedCurrentStepId, parsed.expectedScheduledStepCount,
      parsed.expectedStatus, parsed.expectedMode, expectedAllowedJson,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return this.parseEnrollment(row);
  }

  getById(enrollmentId: string): CadenceEnrollment | null {
    const id = idSchema.parse(enrollmentId);
    const row = this.database.raw.prepare(`
      SELECT ${enrollmentColumns} FROM cadence_enrollments WHERE id = ?
    `).get(id);
    return row === undefined ? null : this.parseEnrollment(row);
  }

  getActiveForCycle(salesCycleId: string): CadenceEnrollment | null {
    const id = idSchema.parse(salesCycleId);
    const rows = this.database.raw.prepare(`
      SELECT ${enrollmentColumns} FROM cadence_enrollments
      WHERE sales_cycle_id = ? AND status = 'active' ORDER BY id ASC
    `).all(id);
    if (rows.length > 1) throw new LifecycleEvidenceError('A cycle has multiple active cadences.');
    return rows[0] === undefined ? null : this.parseEnrollment(rows[0]);
  }

  listForCycle(salesCycleId: string): readonly CadenceEnrollment[] {
    const id = idSchema.parse(salesCycleId);
    return Object.freeze(this.database.raw.prepare(`
      SELECT ${enrollmentColumns} FROM cadence_enrollments
      WHERE sales_cycle_id = ? ORDER BY created_at ASC, id ASC
    `).all(id).map((row) => this.parseEnrollment(row)));
  }

  private requireDefinition(id: string): CadenceAggregate {
    const definition = this.cadences.getById(id);
    if (definition === null) throw new LifecycleEvidenceError('Cadence definition is not installed.');
    return definition;
  }

  private parseEnrollment(value: unknown): CadenceEnrollment {
    const row = storedEnrollmentSchema.parse(value);
    const allowedStepIds = row.allowed_step_ids_json === null
      ? null
      : parseCanonicalJson(row.allowed_step_ids_json, allowedStepsSchema);
    const definition = this.requireDefinition(row.cadence_definition_id);
    if (row.current_step_id !== null) {
      validateEffectiveCadencePlan({
        definition, mode: row.mode, allowedStepIds,
        currentStepId: row.current_step_id, scheduledStepCount: row.scheduled_step_count,
      });
    }
    return deepFreezeLifecycle({
      id: row.id, salesCycleId: row.sales_cycle_id,
      cadenceDefinitionId: row.cadence_definition_id, status: row.status,
      anchorAt: row.anchor_at, currentStepId: row.current_step_id,
      scheduledStepCount: row.scheduled_step_count, mode: row.mode,
      allowedStepIds, stopReason: row.stop_reason, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }) as CadenceEnrollment;
  }
}
