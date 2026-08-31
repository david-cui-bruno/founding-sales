import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleInvariantError,
  OperationalCycleExistsError,
  StaleDomainWriteError,
} from '../support/domainErrors';
import {
  deepFreezeLifecycle,
  type InsertCycleInput,
  type CloseReadiness,
  type LostNurtureReason,
  type SalesCycle,
  type WonTerms,
} from './lifecycleTypes';
import {
  idSchema,
  lifecycleStageSchema,
  utcTimestampSchema,
  workflowStatusSchema,
  parseCanonicalJson,
  serializeCanonical,
} from './lifecycleValidation';

const lostReasonSchema = z.enum([
  'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
  'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
  'cadence_exhausted', 'disqualified', 'opt_out', 'other',
]);
const insertCycleSchema = z.object({
  id: idSchema, personId: idSchema, prospectId: idSchema, entrySourceEventId: idSchema,
  stage: lifecycleStageSchema.exclude(['lost_nurture']),
  workflowStatus: z.enum(['active', 'onboarding']), currentNextActionId: idSchema,
  stageEnteredAt: utcTimestampSchema, createdAt: utcTimestampSchema,
}).strict();
const storedCycleSchema = z.object({
  id: idSchema, person_id: idSchema, prospect_id: idSchema, entry_source_event_id: idSchema,
  stage: lifecycleStageSchema, workflow_status: workflowStatusSchema,
  current_next_action_id: idSchema.nullable(), stage_entered_at: utcTimestampSchema,
  design_partner_fitness: z.number().int().min(0).max(5).nullable(),
  close_reason: lostReasonSchema.nullable(), close_notes: z.string().nullable(),
  onboarding_stop_reason: z.string().nullable(), closed_at: utcTimestampSchema.nullable(),
  version: z.number().int().safe().positive(), created_at: utcTimestampSchema,
  updated_at: utcTimestampSchema,
}).strict();

const cycleColumns = `
  id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
  current_next_action_id, stage_entered_at, design_partner_fitness,
  close_reason, close_notes, onboarding_stop_reason, closed_at, version,
  created_at, updated_at
`;
const readinessStrengthSchema = z.enum(['unknown', 'weak', 'moderate', 'strong']);
const readinessSchema = z.object({
  version: z.literal(1),
  demonstratedPain: readinessDimensionSchema(),
  activeTimeline: readinessDimensionSchema(),
  decisionAuthority: readinessDimensionSchema(),
  willingnessToTryOrPay: readinessDimensionSchema(),
  concreteNextStep: readinessDimensionSchema(),
}).strict();

export type TransitionOpenProjectionInput = Readonly<{
  cycleId: string;
  expectedVersion: number;
  expectedStage: SalesCycle['stage'];
  expectedWorkflowStatus: 'active' | 'onboarding';
  expectedCurrentActionId: string;
  nextStage: SalesCycle['stage'];
  nextWorkflowStatus: 'active' | 'onboarding';
  nextActionId: string;
  stageEnteredAt: string;
}>;

export type CloseProjectionInput = Readonly<{
  cycleId: string;
  expectedVersion: number;
  expectedStage: SalesCycle['stage'];
  expectedWorkflowStatus: 'active' | 'onboarding';
  expectedCurrentActionId: string;
  finalStage: 'won' | 'lost_nurture';
  closedAt: string;
  closeReason: LostNurtureReason | null;
  closeNotes: string | null;
  onboardingStopReason: string | null;
}>;

export type ReplaceCurrentActionInput = Readonly<{
  cycleId: string;
  expectedVersion: number;
  expectedStage: SalesCycle['stage'];
  expectedWorkflowStatus: 'active' | 'onboarding';
  expectedCurrentActionId: string;
  nextActionId: string;
  updatedAt: string;
}>;

export class SalesCycleRepository {
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

  insertCycleWithDeferredAction(input: InsertCycleInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = insertCycleSchema.parse(input);
    if (this.getOperationalCycleForPerson(parsed.personId) !== null) {
      throw new OperationalCycleExistsError(parsed.personId);
    }
    const row = this.database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage,
        workflow_status, current_next_action_id, stage_entered_at,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      RETURNING ${cycleColumns}
    `).get(
      parsed.id, parsed.personId, parsed.prospectId, parsed.entrySourceEventId,
      parsed.stage, parsed.workflowStatus, parsed.currentNextActionId,
      parsed.stageEnteredAt, parsed.createdAt, parsed.createdAt,
    );
    return parseCycle(row);
  }

  transitionOpenProjection(input: TransitionOpenProjectionInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: idSchema, expectedVersion: z.number().int().safe().positive(),
      expectedStage: lifecycleStageSchema,
      expectedWorkflowStatus: z.enum(['active', 'onboarding']),
      expectedCurrentActionId: idSchema, nextStage: lifecycleStageSchema,
      nextWorkflowStatus: z.enum(['active', 'onboarding']), nextActionId: idSchema,
      stageEnteredAt: utcTimestampSchema,
    }).strict().parse(input);
    const row = this.database.raw.prepare(`
      UPDATE sales_cycles
      SET stage = ?, workflow_status = ?, current_next_action_id = ?,
          stage_entered_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND stage = ? AND workflow_status = ?
        AND current_next_action_id = ?
      RETURNING ${cycleColumns}
    `).get(
      parsed.nextStage, parsed.nextWorkflowStatus, parsed.nextActionId,
      parsed.stageEnteredAt, parsed.stageEnteredAt, parsed.cycleId,
      parsed.expectedVersion, parsed.expectedStage, parsed.expectedWorkflowStatus,
      parsed.expectedCurrentActionId,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseCycle(row);
  }

  replaceCurrentAction(input: ReplaceCurrentActionInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: idSchema, expectedVersion: z.number().int().safe().positive(),
      expectedStage: lifecycleStageSchema,
      expectedWorkflowStatus: z.enum(['active', 'onboarding']),
      expectedCurrentActionId: idSchema, nextActionId: idSchema,
      updatedAt: utcTimestampSchema,
    }).strict().parse(input);
    const row = this.database.raw.prepare(`
      UPDATE sales_cycles
      SET current_next_action_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND stage = ? AND workflow_status = ?
        AND current_next_action_id = ?
      RETURNING ${cycleColumns}
    `).get(
      parsed.nextActionId, parsed.updatedAt, parsed.cycleId, parsed.expectedVersion,
      parsed.expectedStage, parsed.expectedWorkflowStatus,
      parsed.expectedCurrentActionId,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseCycle(row);
  }

  closeProjection(input: CloseProjectionInput): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: idSchema, expectedVersion: z.number().int().safe().positive(),
      expectedStage: lifecycleStageSchema,
      expectedWorkflowStatus: z.enum(['active', 'onboarding']),
      expectedCurrentActionId: idSchema, finalStage: z.enum(['won', 'lost_nurture']),
      closedAt: utcTimestampSchema, closeReason: lostReasonSchema.nullable(),
      closeNotes: z.string().nullable(), onboardingStopReason: z.string().nullable(),
    }).strict().superRefine((value, context) => {
      if ((value.finalStage === 'lost_nurture') !== (value.closeReason !== null)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Lost-Nurture requires a reason.' });
      }
      if (value.closeReason === 'other' && (value.closeNotes?.trim().length ?? 0) === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Other requires notes.' });
      }
    }).parse(input);
    const row = this.database.raw.prepare(`
      UPDATE sales_cycles
      SET stage = ?, workflow_status = 'closed', current_next_action_id = NULL,
          stage_entered_at = CASE
            WHEN ? = 'won' AND stage = 'won' THEN stage_entered_at ELSE ? END,
          close_reason = ?, close_notes = ?,
          onboarding_stop_reason = ?, closed_at = ?, version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ? AND stage = ? AND workflow_status = ?
        AND current_next_action_id = ?
      RETURNING ${cycleColumns}
    `).get(
      parsed.finalStage, parsed.finalStage, parsed.closedAt,
      parsed.closeReason, parsed.closeNotes,
      parsed.onboardingStopReason, parsed.closedAt, parsed.closedAt, parsed.cycleId,
      parsed.expectedVersion, parsed.expectedStage, parsed.expectedWorkflowStatus,
      parsed.expectedCurrentActionId,
    );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseCycle(row);
  }

  getById(cycleId: string): SalesCycle | null {
    const id = idSchema.parse(cycleId);
    const row = this.database.raw.prepare(`SELECT ${cycleColumns} FROM sales_cycles WHERE id = ?`).get(id);
    return row === undefined ? null : parseCycle(row);
  }

  getOperationalCycleForPerson(personId: string): SalesCycle | null {
    const id = idSchema.parse(personId);
    const rows = this.database.raw.prepare(`
      SELECT ${cycleColumns} FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
      ORDER BY id ASC
    `).all(id);
    if (rows.length > 1) throw new LifecycleInvariantError('A Person has multiple operational cycles.');
    return rows[0] === undefined ? null : parseCycle(rows[0]);
  }

  assertCurrentActionPostcondition(cycleId: string): void {
    const cycle = this.getById(cycleId);
    if (cycle === null) throw new LifecycleInvariantError('SalesCycle does not exist.');
    const pending = this.database.raw.prepare<
      [string, string], { status: string; due_at: string }
    >(`
      SELECT status, due_at FROM next_actions WHERE id = ? AND sales_cycle_id = ?
    `).get(cycle.currentNextActionId ?? '', cycle.id);
    if (cycle.workflowStatus === 'closed') {
      if (cycle.currentNextActionId !== null) {
        throw new LifecycleInvariantError('A closed cycle cannot point to a current action.');
      }
      return;
    }
    if (
      cycle.currentNextActionId === null
      || pending?.status !== 'pending'
      || pending.due_at.trim().length === 0
    ) {
      throw new LifecycleInvariantError('An open cycle requires one own pending due-dated action.');
    }
  }

  setDesignPartnerFitness(input: {
    cycleId: string;
    expectedVersion: number;
    fitness: number;
    updatedAt: string;
  }): SalesCycle {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      cycleId: idSchema, expectedVersion: z.number().int().safe().positive(),
      fitness: z.number().int().min(0).max(5), updatedAt: utcTimestampSchema,
    }).strict().parse(input);
    const row = this.database.raw.prepare(`
      UPDATE sales_cycles SET design_partner_fitness = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING ${cycleColumns}
    `).get(parsed.fitness, parsed.updatedAt, parsed.cycleId, parsed.expectedVersion);
    if (row === undefined) throw new StaleDomainWriteError();
    return parseCycle(row);
  }

  setCloseReadiness(input: {
    salesCycleId: string;
    expectedVersion: number;
    readiness: CloseReadiness['readiness'];
    assessedAt: string;
  }): CloseReadiness {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      salesCycleId: idSchema, expectedVersion: z.number().int().safe().nonnegative(),
      readiness: readinessSchema, assessedAt: utcTimestampSchema,
    }).strict().parse(input);
    const painConfirmed = isModerate(parsed.readiness.demonstratedPain.value);
    const authority = isModerate(parsed.readiness.decisionAuthority.value);
    const concreteTrial = isModerate(parsed.readiness.concreteNextStep.value);
    const readinessJson = serializeCanonical(parsed.readiness);
    const existing = this.database.raw.prepare<
      [string], { version: number }
    >('SELECT version FROM sales_cycle_close_readiness WHERE sales_cycle_id = ?')
      .get(parsed.salesCycleId);
    const row = existing === undefined
      ? parsed.expectedVersion === 0
        ? this.database.raw.prepare(`
            INSERT INTO sales_cycle_close_readiness (
              sales_cycle_id, pain_confirmed, decision_authority_confirmed,
              concrete_trial_identified, readiness_json, version, assessed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            RETURNING sales_cycle_id, pain_confirmed, decision_authority_confirmed,
              concrete_trial_identified, readiness_json, version, assessed_at, updated_at
          `).get(
            parsed.salesCycleId, painConfirmed ? 1 : 0, authority ? 1 : 0,
            concreteTrial ? 1 : 0, readinessJson, parsed.assessedAt, parsed.assessedAt,
          )
        : undefined
      : this.database.raw.prepare(`
          UPDATE sales_cycle_close_readiness
          SET pain_confirmed = ?, decision_authority_confirmed = ?,
              concrete_trial_identified = ?, readiness_json = ?,
              version = version + 1, assessed_at = ?, updated_at = ?
          WHERE sales_cycle_id = ? AND version = ?
          RETURNING sales_cycle_id, pain_confirmed, decision_authority_confirmed,
            concrete_trial_identified, readiness_json, version, assessed_at, updated_at
        `).get(
          painConfirmed ? 1 : 0, authority ? 1 : 0, concreteTrial ? 1 : 0,
          readinessJson, parsed.assessedAt, parsed.assessedAt,
          parsed.salesCycleId, parsed.expectedVersion,
        );
    if (row === undefined) throw new StaleDomainWriteError();
    return parseReadiness(row);
  }

  insertWonTerms(input: Omit<WonTerms, 'projectedMrrCents' | 'projectionFormulaVersion'> & {
    projectedMrrCents: number;
    projectionFormulaVersion: 'founder_terms_v1';
  }): WonTerms {
    this.unitOfWork.assertWriteScope();
    const parsed = z.object({
      salesCycleId: idSchema, doorsCommitted: z.number().int().safe().nonnegative(),
      billingModel: z.enum(['per_door_monthly', 'flat_monthly', 'manual_projected_monthly']),
      unitRateCents: z.number().int().safe().nonnegative(),
      projectedMrrCents: z.number().int().safe().nonnegative(),
      projectionFormulaVersion: z.literal('founder_terms_v1'),
      manualProjectionReason: z.string().trim().min(1).nullable(),
      foundingCustomer: z.boolean(), effectiveAt: utcTimestampSchema,
      createdAt: utcTimestampSchema,
    }).strict().parse(input);
    const existing = this.getWonTerms(parsed.salesCycleId);
    if (existing !== null) {
      if (serializeCanonical(existing) === serializeCanonical(parsed)) return existing;
      throw new LifecycleInvariantError('Won terms already exist with different values.');
    }
    const row = this.database.raw.prepare(`
      INSERT INTO won_terms (
        sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
        projected_mrr_cents, projection_formula_version, manual_projection_reason,
        founding_customer, effective_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
        projected_mrr_cents, projection_formula_version, manual_projection_reason,
        founding_customer, effective_at, created_at
    `).get(
      parsed.salesCycleId, parsed.doorsCommitted, parsed.billingModel,
      parsed.unitRateCents, parsed.projectedMrrCents, parsed.projectionFormulaVersion,
      parsed.manualProjectionReason, parsed.foundingCustomer ? 1 : 0,
      parsed.effectiveAt, parsed.createdAt,
    );
    return parseWonTerms(row);
  }

  getWonTerms(salesCycleId: string): WonTerms | null {
    const id = idSchema.parse(salesCycleId);
    const row = this.database.raw.prepare(`
      SELECT sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
        projected_mrr_cents, projection_formula_version, manual_projection_reason,
        founding_customer, effective_at, created_at
      FROM won_terms WHERE sales_cycle_id = ?
    `).get(id);
    return row === undefined ? null : parseWonTerms(row);
  }
}

function parseCycle(value: unknown): SalesCycle {
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

function readinessDimensionSchema() {
  return z.object({
    value: readinessStrengthSchema,
    evidenceActivityIds: z.array(idSchema),
  }).strict();
}

function isModerate(value: z.infer<typeof readinessStrengthSchema>): boolean {
  return value === 'moderate' || value === 'strong';
}

function parseReadiness(value: unknown): CloseReadiness {
  const row = z.object({
    sales_cycle_id: idSchema,
    pain_confirmed: z.union([z.literal(0), z.literal(1)]),
    decision_authority_confirmed: z.union([z.literal(0), z.literal(1)]),
    concrete_trial_identified: z.union([z.literal(0), z.literal(1)]),
    readiness_json: z.string(), version: z.number().int().safe().positive(),
    assessed_at: utcTimestampSchema, updated_at: utcTimestampSchema,
  }).strict().parse(value);
  return deepFreezeLifecycle({
    salesCycleId: row.sales_cycle_id, painConfirmed: row.pain_confirmed === 1,
    decisionAuthorityConfirmed: row.decision_authority_confirmed === 1,
    concreteTrialIdentified: row.concrete_trial_identified === 1,
    readiness: parseCanonicalJson(row.readiness_json, readinessSchema),
    version: row.version, assessedAt: row.assessed_at, updatedAt: row.updated_at,
  }) as CloseReadiness;
}

function parseWonTerms(value: unknown): WonTerms {
  const row = z.object({
    sales_cycle_id: idSchema, doors_committed: z.number().int().safe().nonnegative(),
    billing_model: z.enum(['per_door_monthly', 'flat_monthly', 'manual_projected_monthly']),
    unit_rate_cents: z.number().int().safe().nonnegative(),
    projected_mrr_cents: z.number().int().safe().nonnegative(),
    projection_formula_version: z.literal('founder_terms_v1'),
    manual_projection_reason: z.string().nullable(),
    founding_customer: z.union([z.literal(0), z.literal(1)]),
    effective_at: utcTimestampSchema, created_at: utcTimestampSchema,
  }).strict().parse(value);
  return deepFreezeLifecycle({
    salesCycleId: row.sales_cycle_id, doorsCommitted: row.doors_committed,
    billingModel: row.billing_model, unitRateCents: row.unit_rate_cents,
    projectedMrrCents: row.projected_mrr_cents,
    projectionFormulaVersion: row.projection_formula_version,
    manualProjectionReason: row.manual_projection_reason,
    foundingCustomer: row.founding_customer === 1,
    effectiveAt: row.effective_at, createdAt: row.created_at,
  }) as WonTerms;
}
