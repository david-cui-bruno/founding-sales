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
import type { DiscoveryScanPage } from './discoveryTypes';
import { PROSPECT_PRIORITY_ORDER_BY_SQL } from '../prioritization/priorityOrdering';

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

export type DiscoveryReadBucket = 'primary' | 'exploration' | 'judgment' | 'other';
const contextSchema = z.object({ personId: shape.personId, prospectId: shape.prospectId,
  salesCycleId: shape.salesCycleId, personName: z.string().min(1) }).strict();
// Same cycle choice as the collector: an open cycle wins, otherwise latest history.
const currentCycleSql = `(SELECT c.id FROM sales_cycles c WHERE c.person_id = p.person_id
  ORDER BY CASE WHEN c.workflow_status NOT IN ('closed', 'merged') THEN 0 ELSE 1 END,
    c.created_at DESC, c.id COLLATE BINARY DESC LIMIT 1)`;
const readRankingSql = `WITH priority_orderable AS (
  SELECT a.id, a.prospect_id, a.person_id, a.disposition,
    json_extract(a.assessment_json, '$.identitySupported') AS identity_supported,
    json_extract(a.assessment_json, '$.axes.fit.band') AS fit_band,
    json_extract(a.assessment_json, '$.axes.fit.completeness') AS fit_completeness,
    json_extract(a.assessment_json, '$.ranking.priority') AS effective_priority,
    json_extract(a.assessment_json, '$.ranking.earliestTriggerExpiresAt') AS earliest_trigger_expires_at,
    json_extract(a.assessment_json, '$.axes.timing.milliPoints') AS timing_millipoints,
    json_extract(a.assessment_json, '$.axes.fit.points') AS fit_points,
    json_extract(a.assessment_json, '$.axes.reachability') AS reachability,
    json_extract(a.assessment_json, '$.ranking.dataConfidence') AS data_confidence,
    json_extract(a.assessment_json, '$.ranking.lastContactAt') AS last_contact_at,
    json_extract(a.assessment_json, '$.ranking.latestSourceObservedAt') AS latest_source_observed_at,
    NULL AS cloud_source_percentile, NULL AS cloud_timing
  FROM discovery_current c JOIN discovery_assessments a ON a.id = c.assessment_id
), bucketed AS (SELECT *, CASE
  WHEN disposition = 'candidate' AND identity_supported = 1
    AND fit_band IN ('medium', 'high') AND effective_priority IS NOT NULL THEN 'primary'
  WHEN disposition = 'candidate' AND identity_supported = 1 AND effective_priority IS NULL
    AND (fit_points IS NULL OR (fit_band = 'low' AND fit_completeness = 'partial')) THEN 'exploration'
  WHEN disposition = 'judgment' THEN 'judgment' ELSE 'other' END AS bucket
  FROM priority_orderable)
`;

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

  /** Immutable JSON is strictly parsed again after SQL ranks the ENTIRE current set.
   * The pointer/assessment and owner indexes serve these pages; no ID-first LIMIT.
   * Non-primary pages use the accepted evidence/conversation/Person comparator.
   */
  listRankedCurrentPage(input: { bucket: DiscoveryReadBucket; offset: number; limit: number }): DiscoveryAssessment[] {
    const { bucket, offset, limit } = z.object({ bucket: z.enum(['primary', 'exploration', 'judgment', 'other']),
      offset: z.number().int().safe().nonnegative(), limit: z.number().int().min(1).max(50) }).strict().parse(input);
    return read(() => {
      const order = bucket === 'primary' ? PROSPECT_PRIORITY_ORDER_BY_SQL : `
        latest_source_observed_at IS NULL ASC, latest_source_observed_at DESC,
        last_contact_at IS NOT NULL ASC, last_contact_at ASC, person_id COLLATE BINARY ASC`;
      const rows = this.database.raw.prepare(`${readRankingSql}
        SELECT id, prospect_id FROM bucketed AS priority_orderable WHERE bucket = ?
        ORDER BY ${order}, id COLLATE BINARY ASC LIMIT ? OFFSET ?`).all(bucket, limit, offset) as { id: string; prospect_id: string }[];
      return rows.map(row => {
        const assessment = this.getCurrent(row.prospect_id);
        if (assessment?.id !== row.id) return corrupt();
        return assessment;
      });
    });
  }

  countReadOwners(): number {
    return read(() => z.object({ count: z.number().int().safe().nonnegative() }).strict().parse(
      this.database.raw.prepare(`SELECT count(*) AS count FROM prospects p
        WHERE EXISTS (SELECT 1 FROM sales_cycles c WHERE c.prospect_id = p.id AND c.person_id = p.person_id)`).get(),
    ).count);
  }

  getReadContext(personId: string): Required<z.infer<typeof contextSchema>> | null {
    const id = shape.personId.parse(personId);
    return read(() => {
      const row = this.database.raw.prepare(`SELECT p.person_id AS personId, p.id AS prospectId,
        c.id AS salesCycleId, n.display_name AS personName FROM prospects p
        JOIN persons n ON n.id = p.person_id JOIN sales_cycles c ON c.id = ${currentCycleSql}
        AND c.person_id = p.person_id AND c.prospect_id = p.id WHERE p.person_id = ?`).get(id);
      if (row === undefined) return null;
      const parsed = contextSchema.parse(row);
      return { personId: parsed.personId, prospectId: parsed.prospectId,
        salesCycleId: parsed.salesCycleId, personName: parsed.personName };
    });
  }

  /** Compare override evidence to freshly collected bytes, not the old current pointer. */
  overrideForFingerprint(prospectId: string, fingerprint: string): DiscoveryOverride | null {
    const latest = this.getLatestOverride(prospectId);
    if (latest === null) return null;
    const assessment = this.getAssessment(latest.assessmentId);
    if (assessment === null) return corrupt();
    return { ...latest, evidenceChanged: assessment.fingerprint !== shape.fingerprint.parse(fingerprint) };
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

  listScanPage(input: { afterProspectId: string | null; limit: number }): DiscoveryScanPage {
    const parsed = z.object({ afterProspectId: shape.prospectId.nullable(), limit: z.number().int().min(1).max(50) }).strict().parse(input);
    return read(() => {
      const rows = this.database.raw.prepare(`SELECT p.id, p.person_id, n.id AS owner_id FROM prospects p
        LEFT JOIN persons n ON n.id = p.person_id
        WHERE (? IS NULL OR p.id COLLATE BINARY > ?)
        ORDER BY p.id COLLATE BINARY ASC LIMIT ?`).all(parsed.afterProspectId, parsed.afterProspectId, parsed.limit);
      const prospectIds = rows.map(row => z.object({ id: shape.prospectId, person_id: shape.personId, owner_id: shape.personId })
        .strict().refine(value => value.person_id === value.owner_id).parse(row).id);
      const done = prospectIds.length < parsed.limit;
      return { prospectIds, cursor: done ? null : prospectIds.at(-1)!, done };
    });
  }

  readScanState(): { cursor: string | null; lastCompleteScanAt: string | null; lastCompleteLocalDate: string | null } {
    return read(() => {
      const rows = this.database.raw.prepare('SELECT * FROM discovery_scan_state').all();
      if (rows.length === 0) return { cursor: null, lastCompleteScanAt: null, lastCompleteLocalDate: null };
      if (rows.length !== 1) return corrupt();
      const row = scanRowSchema.parse(rows[0]);
      return { cursor: row.cursor, lastCompleteScanAt: row.last_complete_scan_at, lastCompleteLocalDate: row.last_complete_local_date };
    });
  }

  readScanCursor(): string | null { return this.readScanState().cursor; }

  completeScan(at: string, localDate: string): void {
    this.unitOfWork.assertWriteScope();
    const timestamp = shape.evaluatedAt.parse(at); const date = shape.localDate.parse(localDate);
    this.readScanState();
    this.database.raw.prepare(`INSERT INTO discovery_scan_state(singleton, cursor, last_complete_scan_at, last_complete_local_date)
      VALUES (1, NULL, ?, ?) ON CONFLICT(singleton) DO UPDATE SET cursor = NULL,
      last_complete_scan_at = excluded.last_complete_scan_at, last_complete_local_date = excluded.last_complete_local_date`).run(timestamp, date);
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
