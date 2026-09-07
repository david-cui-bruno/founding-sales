import { z } from 'zod';

import {
  beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryAssessmentSchema,
  discoveryOverrideSchema, overrideDiscoveryRequestSchema,
  type BeginDiscoveryReceipt, type BeginDiscoveryRequest, type DiscoveryAssessment,
  type DiscoveryOverride, type OverrideDiscoveryRequest,
} from '../../../shared/contracts/discoveryContract';
import type { AppDatabase } from '../../db/database';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';

const shape = discoveryAssessmentSchema.shape;
const jsonSchema = z.string().min(2).max(2_000_000);
const ownerShape = { person_id: shape.personId, prospect_id: shape.prospectId, sales_cycle_id: shape.salesCycleId };
const assessmentRowSchema = z.object({
  id: shape.id, ...ownerShape, fingerprint: shape.fingerprint, policy_version: shape.policyVersion,
  rule_version_id: shape.ruleVersionId, model_version: shape.modelVersion, evaluated_at: shape.evaluatedAt,
  expires_at: shape.expiresAt, local_date: shape.localDate, override_id: shape.overrideId,
  disposition: shape.disposition, assessment_json: jsonSchema,
}).strict();
const pointerSchema = z.object({
  prospect_id: shape.prospectId, assessment_id: shape.id, version: z.number().int().safe().positive(),
}).strict();
const overrideRowSchema = z.object({
  id: shape.id, assessment_id: shape.id, ...ownerShape, fingerprint: shape.fingerprint,
  decision: discoveryOverrideSchema.shape.decision, reason: discoveryOverrideSchema.shape.reason,
  created_at: discoveryOverrideSchema.shape.createdAt,
}).strict();
const preparationRowSchema = z.object({
  id: shape.id, assessment_id: shape.id, ...ownerShape, fingerprint: shape.fingerprint,
  action_id: beginDiscoveryReceiptSchema.shape.actionId, request_json: jsonSchema, receipt_json: jsonSchema,
}).strict();
const scanRowSchema = z.object({
  singleton: z.literal(1), cursor: shape.prospectId.nullable(),
  last_complete_scan_at: shape.evaluatedAt.nullable(), last_complete_local_date: shape.localDate.nullable(),
}).strict().refine(row => (row.last_complete_scan_at === null) === (row.last_complete_local_date === null));
const overrideInputSchema = overrideDiscoveryRequestSchema.extend({ createdAt: discoveryOverrideSchema.shape.createdAt });

const corrupt = (): never => { throw new Error('Discovery storage is corrupt.'); };
const conflict = (): never => { throw new Error('Discovery command conflicts with immutable history.'); };
const ownership = (): never => { throw new Error('Discovery ownership mismatch.'); };
function read<T>(operation: () => T): T {
  try { return operation(); } catch { return corrupt(); }
}
function serialize(value: unknown): string {
  return jsonSchema.parse(JSON.stringify(value));
}
function parseJson<T>(value: string, schema: z.ZodType<T>): T {
  const parsed = schema.parse(JSON.parse(jsonSchema.parse(value)));
  if (serialize(parsed) !== value) corrupt();
  return parsed;
}
function sameColumns(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.keys(expected).every(key => actual[key] === expected[key]);
}
function assessmentRow(value: DiscoveryAssessment) {
  return { id: value.id, person_id: value.personId, prospect_id: value.prospectId,
    sales_cycle_id: value.salesCycleId, fingerprint: value.fingerprint, policy_version: value.policyVersion,
    rule_version_id: value.ruleVersionId, model_version: value.modelVersion, evaluated_at: value.evaluatedAt,
    expires_at: value.expiresAt, local_date: value.localDate, override_id: value.overrideId,
    disposition: value.disposition, assessment_json: serialize(value) };
}

/** Construction-only. All writes belong to the exact composed database/UOW. */
export class DiscoveryRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork }) {
    if (input.database !== input.unitOfWork.database) throw new DomainRepositoryDatabaseMismatchError();
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database !== database || this.unitOfWork !== unitOfWork) throw new DomainRepositoryDatabaseMismatchError();
  }

  appendAssessment(input: DiscoveryAssessment): void {
    this.unitOfWork.assertWriteScope();
    const assessment = discoveryAssessmentSchema.parse(input);
    const row = assessmentRow(assessment);
    const existing = this.getAssessment(assessment.id);
    if (existing !== null) {
      if (serialize(existing) !== row.assessment_json) conflict();
      return;
    }
    this.assertOwner(assessment);
    this.assertAssessmentReferences(assessment);
    this.database.raw.prepare(`INSERT INTO discovery_assessments
      (id, person_id, prospect_id, sales_cycle_id, fingerprint, policy_version, rule_version_id,
       model_version, evaluated_at, expires_at, local_date, override_id, disposition, assessment_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.person_id, row.prospect_id, row.sales_cycle_id, row.fingerprint, row.policy_version,
      row.rule_version_id, row.model_version, row.evaluated_at, row.expires_at, row.local_date,
      row.override_id, row.disposition, row.assessment_json,
    );
  }

  getCurrent(prospectId: string): DiscoveryAssessment | null {
    const id = shape.prospectId.parse(prospectId);
    return read(() => {
      const value = this.database.raw.prepare('SELECT * FROM discovery_current WHERE prospect_id = ?').get(id);
      if (value === undefined) return null;
      const pointer = pointerSchema.parse(value);
      const assessment = this.getAssessment(pointer.assessment_id);
      if (assessment === null || assessment.prospectId !== id || pointer.prospect_id !== id) return corrupt();
      return assessment;
    });
  }

  setCurrent(prospectId: string, assessmentId: string): void {
    this.unitOfWork.assertWriteScope();
    const id = shape.prospectId.parse(prospectId); const target = shape.id.parse(assessmentId);
    const assessment = this.getAssessment(target);
    if (assessment === null || assessment.prospectId !== id) ownership();
    const current = this.getCurrent(id);
    if (current?.id === target) return;
    this.database.raw.prepare(`INSERT INTO discovery_current(prospect_id, assessment_id, version) VALUES (?, ?, ?)
      ON CONFLICT(prospect_id) DO UPDATE SET assessment_id = excluded.assessment_id, version = discovery_current.version + 1`)
      .run(id, target, 1);
  }

  appendOverride(input: OverrideDiscoveryRequest & { createdAt: string }): void {
    this.unitOfWork.assertWriteScope();
    const parsed = overrideInputSchema.parse(input);
    const existing = this.database.raw.prepare('SELECT * FROM discovery_overrides WHERE id = ?').get(parsed.commandId);
    if (existing !== undefined) {
      const row = read(() => this.parseOverride(existing));
      if (!sameColumns(row, { person_id: parsed.personId, assessment_id: parsed.assessmentId,
        fingerprint: parsed.expectedFingerprint, decision: parsed.decision, reason: parsed.reason, created_at: parsed.createdAt })) conflict();
      return;
    }
    const assessment = this.getAssessment(parsed.assessmentId);
    if (assessment === null || assessment.personId !== parsed.personId || assessment.fingerprint !== parsed.expectedFingerprint) ownership();
    this.database.raw.prepare(`INSERT INTO discovery_overrides
      (id, assessment_id, person_id, prospect_id, sales_cycle_id, fingerprint, decision, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.commandId, parsed.assessmentId, parsed.personId,
      assessment!.prospectId, assessment!.salesCycleId, parsed.expectedFingerprint, parsed.decision, parsed.reason, parsed.createdAt);
  }

  getLatestOverride(prospectId: string): DiscoveryOverride | null {
    const id = shape.prospectId.parse(prospectId);
    return read(() => {
      const value = this.database.raw.prepare(`SELECT * FROM discovery_overrides
        WHERE prospect_id = ? ORDER BY created_at DESC, id COLLATE BINARY DESC LIMIT 1`).get(id);
      if (value === undefined) return null;
      const row = this.parseOverride(value);
      const current = this.getCurrent(id);
      return discoveryOverrideSchema.parse({ id: row.id, assessmentId: row.assessment_id, decision: row.decision,
        reason: row.reason, createdAt: row.created_at, evidenceChanged: current !== null && current.fingerprint !== row.fingerprint });
    });
  }

  getPreparation(commandId: string): { request: BeginDiscoveryRequest; receipt: BeginDiscoveryReceipt } | null {
    const id = beginDiscoveryRequestSchema.shape.commandId.parse(commandId);
    return read(() => {
      const value = this.database.raw.prepare('SELECT * FROM discovery_preparations WHERE id = ?').get(id);
      if (value === undefined) return null;
      const row = preparationRowSchema.parse(value);
      const request = parseJson(row.request_json, beginDiscoveryRequestSchema);
      const receipt = parseJson(row.receipt_json, beginDiscoveryReceiptSchema);
      const assessment = this.validatePreparation(request, receipt);
      if (!sameColumns(row, { id: request.commandId, assessment_id: request.assessmentId, person_id: request.personId,
        prospect_id: assessment.prospectId, sales_cycle_id: request.salesCycleId,
        fingerprint: request.expectedFingerprint, action_id: receipt.actionId })) corrupt();
      return { request, receipt };
    });
  }

  appendPreparation(input: BeginDiscoveryRequest, result: BeginDiscoveryReceipt): void {
    this.unitOfWork.assertWriteScope();
    const request = beginDiscoveryRequestSchema.parse(input); const receipt = beginDiscoveryReceiptSchema.parse(result);
    const requestJson = serialize(request); const receiptJson = serialize(receipt);
    const existing = this.getPreparation(request.commandId);
    if (existing !== null) {
      if (serialize(existing.request) !== requestJson || serialize(existing.receipt) !== receiptJson) conflict();
      return;
    }
    const assessment = this.validatePreparation(request, receipt);
    this.database.raw.prepare(`INSERT INTO discovery_preparations
      (id, assessment_id, person_id, prospect_id, sales_cycle_id, fingerprint, action_id, request_json, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(request.commandId, request.assessmentId, request.personId,
      assessment.prospectId, request.salesCycleId, request.expectedFingerprint, receipt.actionId, requestJson, receiptJson);
  }

  readScanCursor(): string | null {
    return read(() => {
      const rows = this.database.raw.prepare('SELECT * FROM discovery_scan_state').all();
      if (rows.length === 0) return null;
      if (rows.length !== 1) return corrupt();
      return scanRowSchema.parse(rows[0]).cursor;
    });
  }

  writeScanCursor(cursor: string | null): void {
    this.unitOfWork.assertWriteScope();
    const parsed = shape.prospectId.nullable().parse(cursor);
    this.readScanCursor();
    this.database.raw.prepare(`INSERT INTO discovery_scan_state(singleton, cursor) VALUES (?, ?)
      ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor`).run(1, parsed);
  }

  private getAssessment(id: string, validateOverride = true): DiscoveryAssessment | null {
    return read(() => {
      const value = this.database.raw.prepare('SELECT * FROM discovery_assessments WHERE id = ?').get(id);
      if (value === undefined) return null;
      const row = assessmentRowSchema.parse(value);
      const assessment = parseJson(row.assessment_json, discoveryAssessmentSchema);
      if (!sameColumns(row, assessmentRow(assessment)) || assessment.id !== id) corrupt();
      this.assertOwner(assessment);
      this.assertAssessmentReferences(assessment, validateOverride);
      return assessment;
    });
  }

  private assertOwner(owner: Pick<DiscoveryAssessment, 'personId' | 'prospectId' | 'salesCycleId'>): void {
    // Compare raw relational values. Never parse through older trimming ID schemas.
    const prospect = this.database.raw.prepare('SELECT person_id FROM prospects WHERE id = ?').get(owner.prospectId) as { person_id: unknown } | undefined;
    const cycle = this.database.raw.prepare('SELECT person_id, prospect_id FROM sales_cycles WHERE id = ?').get(owner.salesCycleId) as { person_id: unknown; prospect_id: unknown } | undefined;
    const person = this.database.raw.prepare('SELECT id FROM persons WHERE id = ?').get(owner.personId);
    if (person === undefined || prospect?.person_id !== owner.personId || cycle?.person_id !== owner.personId || cycle?.prospect_id !== owner.prospectId) ownership();
  }

  private assertAssessmentReferences(assessment: DiscoveryAssessment, validateOverride = true): void {
    if (this.database.raw.prepare('SELECT id FROM prioritization_rule_versions WHERE id = ?').get(assessment.ruleVersionId) === undefined) ownership();
    if (validateOverride && assessment.overrideId !== null) {
      // No recursive traversal of history. Validate the referenced immutable row
      // and exact owner tuple without interpreting it as new source evidence.
      const row = this.parseOverride(this.database.raw.prepare('SELECT * FROM discovery_overrides WHERE id = ?').get(assessment.overrideId));
      if (row.assessment_id === assessment.id || row.person_id !== assessment.personId
        || row.prospect_id !== assessment.prospectId || row.sales_cycle_id !== assessment.salesCycleId) ownership();
    }
  }

  private parseOverride(value: unknown): z.infer<typeof overrideRowSchema> {
    const row = overrideRowSchema.parse(value);
    const assessment = this.getAssessment(row.assessment_id, false);
    if (assessment === null || assessment.personId !== row.person_id || assessment.prospectId !== row.prospect_id
      || assessment.salesCycleId !== row.sales_cycle_id || assessment.fingerprint !== row.fingerprint) corrupt();
    return row;
  }

  private validatePreparation(request: BeginDiscoveryRequest, receipt: BeginDiscoveryReceipt): DiscoveryAssessment {
    const assessment = this.getAssessment(request.assessmentId);
    if (assessment === null || assessment.personId !== request.personId || assessment.salesCycleId !== request.salesCycleId
      || assessment.fingerprint !== request.expectedFingerprint || receipt.personId !== request.personId
      || receipt.salesCycleId !== request.salesCycleId || receipt.assessmentId !== request.assessmentId) return ownership();
    const action = this.database.raw.prepare('SELECT sales_cycle_id FROM next_actions WHERE id = ?').get(receipt.actionId) as { sales_cycle_id: unknown } | undefined;
    if (action?.sales_cycle_id !== request.salesCycleId) ownership();
    return assessment;
  }
}
