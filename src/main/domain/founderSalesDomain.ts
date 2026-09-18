import type { AdmitCompanyDraftEmail, OpenCompanyDraft, SaveCompanyDraft } from '../../shared/contracts/localCompanyDraftContract';
import type { ConfirmTerritoryClearance, RevokeTerritoryClearance } from '../../shared/contracts/territoryClearanceContract';
import { TerritoryClearanceRepository } from './compliance/territoryClearanceRepository';
import type { AdmitCompanyPhoneRoute } from '../../shared/contracts/localCompanyPhoneRouteContract';
import { LocalCompanyDraftRepository } from './accounts/localCompanyDraftRepository';
import type { UpdateCompanyResearchSettingsRequest } from '../../shared/contracts/localCompanyResearchSettingsContract';
import { LocalCompanyIntake } from './accounts/localCompanyIntake';
import { AccountRepository } from './accounts/accountRepository';
import type { AccountEvidenceReceipt } from '../../shared/contracts/accountContract';
import type { LocalCompanyInput, LocalCompanyCreateRequest } from '../../shared/contracts/localCompanyIntakeContract';
import { updateCallSettingsRequestSchema, type UpdateCallSettingsRequest, localCommitmentsSnapshotSchema, type LocalCommitmentsSnapshot, type LinkCompanyPersonRequest } from '../../shared/contracts/localWorkspaceContract';
import { LegacyWorkflowTransition, type WorkflowTransitionCommand } from './workspace/legacyWorkflowTransition';
import { countMilestones, readAcquisitionFacts } from './campaign/acquisitionReport';
import { projectAccountPipeline } from './campaign/accountPipelineProjection';
import type { AcquisitionWindow } from '../../shared/contracts/acquisitionReportContract';
import type { AccountOutboundRequest, AccountCallReport, AccountCallRange } from '../../shared/contracts/accountOutboundContract';
import { createHash } from 'node:crypto';
import { ListCursorError, pageFromSnapshot } from './support/listCursor';

import { parseCsvSource, type CsvParseError } from '../imports/csvParser';
import { z } from 'zod';
import { buildPortfolioContext } from './portfolio/portfolioContext';
import { DiscoveryWorkerCommands, type DiscoveryResearchRequest } from '../discovery/discoveryWorker';
import type { DiscoveryScanPage } from './discovery/discoveryTypes';
import { collectDiscoveryEvidence } from './discovery/discoveryEvidence';
import type { BeginDiscoveryRequest, OverrideDiscoveryRequest, DiscoveryClaim } from '../../shared/contracts/discoveryContract';
import { communicationRecencySql, isLegacyOutboundRequest, outboundCommandFactSql } from './events/communicationEvidence';
import type { Activity } from './events/eventTypes';

import type { AppDatabase } from '../db/database';
import type { JobRecord } from '../jobs/jobTypes';
import {
  mutationReceiptSchema,
  type MutationReceipt,
  type LeadPriorityContext,
  type PrimaryAction,
} from '../../shared/contracts/commonContract';
import {
  leadBulkUpdateRequestSchema,
  leadFieldUpdateRequestSchema,
  leadRowSchema,
  leadsListRequestSchema,
  leadsListResponseSchema,
  type LeadBulkUpdateRequest,
  type LeadFieldUpdateRequest,
  type LeadRow,
  type LeadsListRequest,
  type LeadsListResponse,
} from '../../shared/contracts/leadsContract';
import {
  confirmTransitionRequestSchema,
  dismissLeadRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
  type ConfirmTransitionRequest,
  type ContactMethod,
  type DismissLeadRequest,
  type FindContactEligibility,
  type LeadDetail,
  type LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';
import {
  addLeadNoteRequestSchema,
  completeActionRequestSchema,
  logCallOutcomeRequestSchema,
  logPastActivityRequestSchema,
  markActivityInErrorRequestSchema,
  snoozeActionRequestSchema,
  todaySnapshotSchema,
  type AddLeadNoteRequest,
  type CompleteActionRequest,
  type LogCallOutcomeRequest,
  type LogPastActivityRequest,
  type MarkActivityInErrorRequest,
  type SnoozeActionRequest,
  type TodayItem as TodayItemDto,
  type TodayLaneId,
  type TodaySnapshot,
} from '../../shared/contracts/todayContract';
import {
  cancelJobRequestSchema,
  createJobRequestSchema,
  fillJobRequestSchema,
  fridayReportRequestSchema,
  fridayReportSchema,
  metricDrilldownRequestSchema,
  metricDrilldownSchema,
  type CancelJobRequest,
  type CreateJobRequest,
  type FillJobRequest,
  type FridayReport,
  type FridayReportRequest,
  type Metric,
  type MetricDrilldown,
  type MetricDrilldownRequest,
  type MetricId,
} from '../../shared/contracts/fridayContract';
import {
  importCommitReceiptSchema,
  importCommitRequestSchema,
  importPreviewSchema,
  importRemapRequestSchema,
  importSourceSchema,
  importStatusRequestSchema,
  importStatusSchema,
  type ImportCommitReceipt,
  type ImportCommitRequest,
  type ImportField,
  type ImportMapping,
  type ImportPreview,
  type ImportRemapRequest,
  type ImportSource,
  type ImportStatus,
  type ImportStatusRequest,
} from '../../shared/contracts/importContract';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from './cadence/cadenceScheduler';
import { comparePhoneCandidates } from './contacts/contactPresentation';
import type { DomainServices } from './createDomainServices';
import type {
  CreatePersonProspectCommand,
  IntakeContactInput,
} from './source/sourceService';
import { normalizeEmail, normalizePhone } from './source/contactNormalization';
import type { Clock } from './support/clock';
import type { IdGenerator } from './support/idGenerator';
import type { TodayItem, TodayLane } from './today/todayTypes';
import { resolveLocalDayInterval } from './today/todayOrdering';
import { OutboundAuthorizationError } from './support/domainErrors';
import { contactSnapshot } from '../communications/contactSnapshot';
import type { OutboundDomainPort, Preparation } from '../communications/outboundPorts';
import {
  handoffResultSchema, outboundRequestSchema, outboundReceiptSchema,
  type OutboundRequest, type OutboundReceipt, type OutboundReason, type HandoffResult,
} from '../../shared/contracts/outboundContract';
import { OutboundCommandEvidenceError, outboundCommandResult } from './outbound/outboundCommandRepository';

export const FOUNDER_JOB_REQUEST_TYPE = 'founder_job_request_v1' as const;
export const LEAD_IMPORT_JOB_TYPE = 'lead_import_v1' as const;
const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Dismissed leads get the mandatory manual re-look one year out. */
const DISMISS_REACTIVATION_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

export type FounderSalesDomainErrorCode =
  | 'LIST_CURSOR_INVALID'
  | 'LIST_CURSOR_STALE'
  | 'LEAD_NOT_FOUND'
  | 'CYCLE_NOT_FOUND'
  | 'CONTACT_METHOD_NOT_FOUND'
  | 'CONTACT_DNC_BLOCKED'
  | 'ACTION_NOT_SUPPORTED'
  | 'PRIORITY_PROJECTION_MISSING'
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_RESOLUTION_UNSUPPORTED'
  | 'JOB_NOT_FOUND'
  | 'IMPORT_PREVIEW_INVALID'
  | 'IMPORT_VALIDATION_FAILED';

/** Safe, renderer-presentable domain error: no SQL, paths, or key material. */
export class FounderSalesDomainError extends Error {
  readonly code: FounderSalesDomainErrorCode;

  constructor(code: FounderSalesDomainErrorCode, message: string) {
    super(message);
    this.name = 'FounderSalesDomainError';
    this.code = code;
  }
}

type CycleRow = {
  id: string;
  person_id: string;
  prospect_id: string;
  stage: LeadRow['stage'];
  workflow_status: 'active' | 'onboarding' | 'closed';
  current_next_action_id: string | null;
  stage_entered_at: string;
  close_reason: string | null;
  version: number;
};

type ActionRow = {
  id: string;
  due_at: string;
  sales_cycle_id: string;
  action_type: string;
  channel: string | null;
  status: string;
  version: number;
  work_intent: string;
  cadence_enrollment_id: string | null;
  cadence_step_id: string | null;
  cadence_component_id: string | null;
};

type ProjectionRow = {
  prospect_id: string;
  fit_points: number;
  fit_band: 'low' | 'medium' | 'high';
  timing_millipoints: number;
  timing_band: 'cold' | 'warm' | 'hot';
  reachability: 'direct' | 'indirect' | 'none';
  data_confidence: number;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  version: number;
  evaluation_id: string;
};

type StoredImportPreview = {
  readonly parseErrors: readonly Readonly<CsvParseError>[];
  preview: ImportPreview;
  columns: string[];
  rows: { rowNumber: number; values: Record<string, string> }[];
  sourceName: string;
};

/**
 * One unflushed outcome-outbox row (plan Task 4). Enums, ids, and
 * timestamps only: this shape feeds the strict upstream upload schema.
 */
export type CloudOutcomeRow = {
  id: string;
  cloudEntityId: string;
  label: 'interviewed' | 'offered' | 'won' | 'lost' | 'override';
  lossReasonCode: string | null;
  overrideDirection: 'up' | 'down' | null;
  observedAt: string;
};

/** One unflushed suppression outbox row (normalized handle, closed reason). */
export type SuppressionOutboxRow = {
  handleId: string;
  kind: 'phone' | 'email';
  normalizedValue: string;
  reason: 'opt_out' | 'wrong_person' | 'founder_block';
  observedAt: string;
};

/** Everything the enrichment request writer needs for one person. */
export type EnrichmentCandidate = {
  cloudEntityId: string | null;
  ownerFullName: string;
  situsAddress: {
    line1: string;
    locality: string;
    region: string;
    postalCode: string | null;
  } | null;
  lastRequestedAt: string | null;
  qualificationState: 'unreviewed' | 'eligible' | 'disqualified' | 'merge_review';
  fitBand: 'low' | 'medium' | 'high' | null;
  identityReady: boolean;
  hasUsableDirectContact: boolean;
  suppressionBlocked: boolean;
};

/** Ordered domain gates shared by the detail projection and upload boundary.
 * Credentials are checked only by the writer, never probed by a detail read.
 */
export function getFindContactEligibility(
  candidate: EnrichmentCandidate,
  now: string,
): FindContactEligibility {
  let refusalReason: FindContactEligibility['refusalReason'] = null;
  if (candidate.qualificationState !== 'eligible') refusalReason = 'qualification_required';
  else if (candidate.fitBand !== 'medium' && candidate.fitBand !== 'high') refusalReason = 'fit_gate_failed';
  else if (!candidate.identityReady || candidate.cloudEntityId === null
    || candidate.situsAddress === null || candidate.ownerFullName.trim().length === 0) {
    refusalReason = 'identity_or_address_missing';
  } else if (candidate.hasUsableDirectContact) refusalReason = 'direct_contact_exists';
  else if (candidate.suppressionBlocked !== false) refusalReason = 'suppression_blocked';
  else if (candidate.lastRequestedAt !== null
    && Date.parse(now) - Date.parse(candidate.lastRequestedAt) < 30 * 24 * 60 * 60 * 1000) {
    refusalReason = 'rate_limited';
  }
  return { eligible: refusalReason === null, refusalReason };
}

const LANE_MAP: Readonly<Record<TodayLane, TodayLaneId>> = Object.freeze({
  won_onboarding: 'onboarding',
  inbound_interrupt: 'fresh_inbound',
  due_primary: 'due_cadence',
  new_p0: 'new_p0',
  p1: 'p1',
  exploration: 'exploration',
  later: 'later',
});
function toPriorityContext(row: ProjectionRow | undefined): LeadPriorityContext | null {
  if (row === undefined) return null;
  return {
    priority: row.priority.toUpperCase() as LeadPriorityContext['priority'],
    fitPoints: row.fit_points,
    fitBand: row.fit_band,
    timingValue: row.timing_millipoints / 1000,
    timingBand: row.timing_band,
    reachability: row.reachability,
    dataConfidence: row.data_confidence,
  };
}

function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 4)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  return initials.length > 0 ? initials.slice(0, 4) : '?';
}

function actionChannel(input: {
  actionType: string;
  channel: string | null;
  workIntent: string | null;
  onboarding: boolean;
}): PrimaryAction['channel'] {
  if (input.onboarding) return 'onboarding';
  if (input.actionType === 'review_lead' || input.workIntent === 'internal_review') return 'review';
  switch (input.channel) {
    case 'phone':
    case 'voicemail':
      return 'call';
    case 'text':
      return 'text';
    case 'email':
      return 'email';
    default:
      return 'call';
  }
}

function actionLabel(actionType: string): string {
  const label = actionType.replace(/_/g, ' ');
  return label.length > 0 ? label[0]!.toUpperCase() + label.slice(1) : 'Action';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function jsonSummary(metadataJson: string): string | null {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed !== null && typeof parsed === 'object'
      && typeof (parsed as { summary?: unknown }).summary === 'string') {
      return (parsed as { summary: string }).summary;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The renderer-facing founder-sales facade. Reads are direct SQL projections
 * parsed into strict DTOs; every command composes the transactional domain
 * services and returns a MutationReceipt whose revision is a monotonically
 * increasing per-connection change counter.
 */
export class FounderSalesDomain implements OutboundDomainPort {
  private readonly services: DomainServices;
  private readonly database: AppDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly discoveryWorkerCommands: DiscoveryWorkerCommands;
  private readonly configuredTimezone: string | undefined;
  private readonly importPreviews = new Map<string, StoredImportPreview>();

  constructor(input: {
    services: DomainServices;
    database: AppDatabase;
    clock: Clock;
    ids: IdGenerator;
    timezone?: string;
  }) {
    input.services.outboundCommands.assertBoundTo(input.database, input.services.unitOfWork);
    input.services.outboundPermission.assertBoundTo(input.database, input.services.unitOfWork);
    input.services.identities.assertBoundTo(input.database, input.services.unitOfWork);
    this.discoveryWorkerCommands = new DiscoveryWorkerCommands(input);
    this.services = input.services;
    this.database = input.database;
    this.clock = input.clock;
    this.ids = input.ids;
    this.configuredTimezone = input.timezone;
  }

  admitCompanyDraftEmail(input: AdmitCompanyDraftEmail) { return new AccountRepository({ database: this.database, clock: this.clock, ids: this.ids }).admitReviewedBusinessEmail(input); }
  /** Territory clearance (design D4): records the founder's per-state attestation with its citation and review date. Never dials. */
  confirmTerritoryClearance(input: ConfirmTerritoryClearance) { return new TerritoryClearanceRepository({ database: this.database, clock: this.clock }).confirm(input); }
  revokeTerritoryClearance(input: RevokeTerritoryClearance) { return new TerritoryClearanceRepository({ database: this.database, clock: this.clock }).revoke(input); }
  admitCompanyPhoneRoute(input: AdmitCompanyPhoneRoute) { return new AccountRepository({ database: this.database, clock: this.clock, ids: this.ids }).admitReviewedBusinessPhone(input); }
  openCompanyDraft(input: OpenCompanyDraft) { return new LocalCompanyDraftRepository({ database: this.database, clock: this.clock, ids: this.ids }).open(input); }
  saveCompanyDraft(input: SaveCompanyDraft) { return new LocalCompanyDraftRepository({ database: this.database, clock: this.clock, ids: this.ids }).save(input); }
  reviewLocalCompany(input: LocalCompanyInput) {
    return new LocalCompanyIntake({ database: this.database, clock: this.clock, ids: this.ids }).review(input);
  }
  createLocalCompany(input: LocalCompanyCreateRequest) {
    return new LocalCompanyIntake({ database: this.database, clock: this.clock, ids: this.ids }).create(input);
  }
  getLocalCompanyCreateStatus(input: LocalCompanyCreateRequest) {
    return new LocalCompanyIntake({ database: this.database, clock: this.clock, ids: this.ids }).status(input);
  }

  linkLocalCompanyPerson(input: LinkCompanyPersonRequest): AccountEvidenceReceipt {
    return new AccountRepository({ database: this.database, clock: this.clock, ids: this.ids }).admitReviewedPersonLink(input);
  }

  transitionWorkflow(command: WorkflowTransitionCommand) {
    return new LegacyWorkflowTransition({ database: this.database, unitOfWork: this.services.unitOfWork, clock: this.clock, ids: this.ids }).transitionWorkflow(command);
  }
  acquisitionReport(window: AcquisitionWindow) { return countMilestones(readAcquisitionFacts(this.database), window); }
  accountPipeline() {
    const accounts = this.database.raw.prepare('SELECT id FROM pm_accounts ORDER BY id').all() as { id: string }[];
    return projectAccountPipeline(accounts, readAcquisitionFacts(this.database));
  }

  // Account-only delegates never route account identities through person authorization.
  inspectAccountOutboundCommand(request: AccountOutboundRequest) { return this.services.accountOutreach.inspect(request); }
  getAccountOutboundOwnerGeneration(request: AccountOutboundRequest) { return this.services.accountOutreach.ownerGeneration(request); }
  prepareAccountOutboundDispatch(request: AccountOutboundRequest, ownerGeneration: string | null) {
    return this.services.accountOutreach.reserve(request, ownerGeneration);
  }
  recordAccountOutboundRefusal(request: AccountOutboundRequest, reason: string) { return this.services.accountOutreach.recordRefusal(request, reason); }
  recordAccountOutboundResult(request: AccountOutboundRequest, result: HandoffResult) { return this.services.accountOutreach.recordDispatch(request, result); }
  reportAccountCallOutcome(report: AccountCallReport) { return this.services.accountOutreach.reportCallOutcome(report); }
  listActualCallAttempts(range: AccountCallRange) { return this.services.accountOutreach.listActualCallAttempts(range); }

  // ---------------------------------------------------------------- leads

  listLeadRows(input: LeadsListRequest): LeadsListResponse {
    const request = leadsListRequestSchema.parse(input);
    return this.readListSnapshot(() => {
      const filters: string[] = [];
      const parameters: unknown[] = [];
      if (request.query.length > 0) {
        filters.push(`person.display_name LIKE ? ESCAPE '\\'`);
        parameters.push(`%${escapeLike(request.query)}%`);
      }
      if (request.stages.length > 0) {
        filters.push(`cycle.stage IN (${request.stages.map(() => '?').join(', ')})`);
        parameters.push(...request.stages);
      }
      if (request.priorities.length > 0) {
        filters.push(`projection.priority IN (${request.priorities.map(() => '?').join(', ')})`);
        parameters.push(...request.priorities.map((priority) => priority.toLowerCase()));
      }
      const where = [
        `cycle.workflow_status IN ('active','onboarding')`,
        ...filters,
      ].join(' AND ');
      const orderBy = {
        // Within one priority band, cloud-scored leads outrank unscored ones
        // using the WITHIN-SOURCE percentile (F10): raw cloud axes from
        // different acquisition sources observe different signal subsets and
        // are not comparable, so a raw cross-source sort lets one source
        // monopolize the top. Percentile DESC with NULLs last, then raw cloud
        // timing as the residual within-source tiebreaker. Cloud keys stay
        // tiebreakers only: they never reorder the local priority bands, and
        // the percentile is ordering-only (rows keep showing raw fit/timing).
        priority: `CASE WHEN projection.priority IS NULL THEN 1 ELSE 0 END,
          projection.priority ASC,
          CASE WHEN cloud_rank.cloud_source_percentile IS NULL THEN 1 ELSE 0 END,
          cloud_rank.cloud_source_percentile DESC,
          CASE WHEN prospect.cloud_timing IS NULL THEN 1 ELSE 0 END,
          prospect.cloud_timing DESC,
          cycle.id ASC`,
        person_name: 'person.display_name ASC, cycle.id ASC',
        last_contact: `CASE WHEN prospect.last_contact_at IS NULL THEN 1 ELSE 0 END,
          prospect.last_contact_at DESC, cycle.id ASC`,
      }[request.sort];
      const baseSql = `
        FROM sales_cycles AS cycle
        JOIN persons AS person ON person.id = cycle.person_id
        JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
        LEFT JOIN next_actions AS action ON action.id = cycle.current_next_action_id
        LEFT JOIN prospect_priority_projection AS projection
          ON projection.prospect_id = cycle.prospect_id
        LEFT JOIN source_events AS source ON source.id = prospect.original_source_event_id
        LEFT JOIN (
          SELECT
            scored.id AS prospect_id,
            100.0 * CUME_DIST() OVER (
              PARTITION BY origin.channel
              ORDER BY COALESCE(scored.cloud_fit, 0) + COALESCE(scored.cloud_timing, 0)
            ) AS cloud_source_percentile
          FROM prospects AS scored
          JOIN source_events AS origin
            ON origin.id = scored.original_source_event_id
          WHERE scored.cloud_fit IS NOT NULL OR scored.cloud_timing IS NOT NULL
        ) AS cloud_rank ON cloud_rank.prospect_id = cycle.prospect_id
        WHERE ${where}
      `;
      const rows = this.database.raw.prepare(`
        SELECT
          cycle.id AS cycle_id, cycle.person_id, cycle.prospect_id, cycle.stage,
          person.display_name, person.opted_out,
          prospect.segment,
          source.channel AS source_channel,
          action.id AS action_id, action.action_type, action.channel AS action_channel,
          action.status AS action_status, action.work_intent, action.due_at AS action_due_at,
          projection.fit_points, projection.fit_band, projection.timing_millipoints,
          projection.timing_band, projection.reachability, projection.data_confidence,
          projection.priority,
          prospect.cloud_fit, prospect.cloud_timing,
          (
            SELECT canonical_name FROM prospect_organizations AS link
            JOIN organizations AS org ON org.id = link.organization_id
            WHERE link.prospect_id = cycle.prospect_id
            ORDER BY org.id ASC LIMIT 1
          ) AS organization_name,
          (
            SELECT property.address_line_1 || ', ' || property.locality
            FROM prospect_properties AS link
            JOIN properties AS property ON property.id = link.property_id
            WHERE link.prospect_id = cycle.prospect_id
            ORDER BY property.id ASC LIMIT 1
          ) AS property_summary,
          (
            SELECT MAX(occurred_at) FROM activities
            WHERE activities.person_id = cycle.person_id
              AND ${communicationRecencySql}
          ) AS last_activity_at
        ${baseSql}
        ORDER BY ${orderBy}
      `).all(...parameters) as Array<{
        cycle_id: string; person_id: string; prospect_id: string; stage: LeadRow['stage'];
        display_name: string; opted_out: 0 | 1; segment: LeadRow['segment'];
        source_channel: LeadRow['source'] | null;
        action_id: string | null; action_type: string | null; action_channel: string | null;
        action_status: string | null; work_intent: string | null; action_due_at: string | null;
        fit_points: number | null; fit_band: ProjectionRow['fit_band'] | null;
        timing_millipoints: number | null; timing_band: ProjectionRow['timing_band'] | null;
        reachability: ProjectionRow['reachability'] | null; data_confidence: number | null;
        priority: ProjectionRow['priority'] | null;
        cloud_fit: number | null; cloud_timing: number | null;
        organization_name: string | null; property_summary: string | null;
        last_activity_at: string | null;
      }>;
      const leadRows: LeadRow[] = rows.map((row) => ({
        personId: row.person_id,
        salesCycleId: row.cycle_id,
        personName: row.display_name,
        initials: initialsOf(row.display_name),
        organization: row.organization_name,
        propertySummary: row.property_summary,
        stage: row.stage,
        source: row.source_channel ?? 'custom',
        segment: row.segment,
        priorityContext: row.priority === null
          ? null
          : toPriorityContext({
            prospect_id: row.prospect_id,
            fit_points: row.fit_points!,
            fit_band: row.fit_band!,
            timing_millipoints: row.timing_millipoints!,
            timing_band: row.timing_band!,
            reachability: row.reachability!,
            data_confidence: row.data_confidence!,
            priority: row.priority,
            version: 1,
            evaluation_id: '',
          }),
        cloudScores: row.cloud_fit === null || row.cloud_timing === null
          ? null
          : { fit: row.cloud_fit, timing: row.cloud_timing },
        nextAction: row.action_id === null || row.action_status !== 'pending' ? null : {
          id: row.action_id,
          dueAt: row.action_due_at,
          type: row.action_type!,
          channel: actionChannel({
            actionType: row.action_type!,
            channel: row.action_channel,
            workIntent: row.work_intent,
            onboarding: false,
          }),
          label: actionLabel(row.action_type!),
        },
        optedOut: row.opted_out === 1,
        lastActivityAt: row.last_activity_at,
      }));
      const projection = z.array(leadRowSchema).parse(leadRows);
      const page = pageFromSnapshot({
        scope: 'leads',
        queryKey: JSON.stringify({ scope: 'leads', query: request.query,
          stages: [...new Set(request.stages)].sort(), priorities: [...new Set(request.priorities)].sort(),
          sort: request.sort, limit: request.limit }),
        snapshotKey: JSON.stringify(projection), rows: projection,
        cursor: request.cursor, limit: request.limit,
      });
      return leadsListResponseSchema.parse({
        rows: page.rows,
        nextCursor: page.nextCursor,
        total: projection.length,
        revision: this.currentRevision(),
      });
    });
  }

  updateLeadField(input: LeadFieldUpdateRequest): MutationReceipt {
    const request = leadFieldUpdateRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => this.applyLeadField(request));
  }

  bulkUpdateLeads(input: LeadBulkUpdateRequest): MutationReceipt {
    const request = leadBulkUpdateRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => {
      const persons = new Set<string>();
      const cycles = new Set<string>();
      for (const personId of request.personIds) {
        const receipt = this.applyLeadField({
          personId,
          field: request.field,
          value: request.value,
        } as LeadFieldUpdateRequest);
        receipt.affectedPersonIds.forEach((id) => persons.add(id));
        receipt.affectedSalesCycleIds.forEach((id) => cycles.add(id));
      }
      return this.receipt([...persons].sort(), [...cycles].sort());
    });
  }

  private applyLeadField(request: LeadFieldUpdateRequest): MutationReceipt {
    const now = this.clock.now();
    const person = this.database.raw.prepare(
      'SELECT id, version FROM persons WHERE id = ?',
    ).get(request.personId) as { id: string; version: number } | undefined;
    if (person === undefined) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
    }
    if (request.field === 'person_name') {
      const changed = this.database.raw.prepare(`
        UPDATE persons SET display_name = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(request.value, now, person.id, person.version);
      if (changed.changes !== 1) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person changed concurrently.');
      }
    } else {
      const prospect = this.database.raw.prepare(
        'SELECT id FROM prospects WHERE person_id = ?',
      ).get(person.id) as { id: string } | undefined;
      if (prospect === undefined) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person has no prospect.');
      }
      this.assignProspectOrganization(prospect.id, request.value);
    }
    const cycles = this.database.raw.prepare(
      'SELECT id FROM sales_cycles WHERE person_id = ? ORDER BY id ASC',
    ).all(person.id) as { id: string }[];
    return this.receipt([person.id], cycles.map(({ id }) => id));
  }

  /** Assign membership, never rename an identity shared with other prospects. */
  private assignProspectOrganization(prospectId: string, value: string | null): void {
    const normalize = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const ambiguous = () => new FounderSalesDomainError(
      'ACTION_NOT_SUPPORTED', 'The organization assignment is ambiguous.',
    );
    const links = this.database.raw.prepare(`
      SELECT organization_id AS id FROM prospect_organizations
      WHERE prospect_id = ? LIMIT 2
    `).all(prospectId) as { id: string }[];
    if (links.length > 1) throw ambiguous();
    const currentId = links[0]?.id;
    let targetId: string | undefined;
    if (value !== null) {
      const normalized = normalize(value);
      if (normalized.length === 0) {
        throw new FounderSalesDomainError(
          'ACTION_NOT_SUPPORTED', 'The organization assignment must not be blank.',
        );
      }
      // SQLite lower/trim cannot implement intake's Unicode NFKC semantics.
      // Include legacy canonical names and deduplicate identities, not matching labels.
      const candidates = this.database.raw.prepare(`
        SELECT id, canonical_name AS name FROM organizations
        UNION ALL
        SELECT organization_id AS id, alias AS name FROM organization_aliases
      `).all() as { id: string; name: string }[];
      const matches = new Set(candidates
        .filter(({ name }) => normalize(name) === normalized)
        .map(({ id }) => id));
      if (matches.size > 1) throw ambiguous();
      targetId = matches.values().next().value;
      if (targetId === undefined) {
        const organization = this.services.identities.createOrganization({
          canonicalName: value.normalize('NFKC').trim().replace(/\s+/g, ' '),
        });
        targetId = organization.id;
        this.services.identities.addOrganizationAlias({ organizationId: targetId, alias: normalized });
      }
    }
    if (currentId === targetId) return;
    if (currentId !== undefined) {
      this.database.raw.prepare(
        'DELETE FROM prospect_organizations WHERE prospect_id = ? AND organization_id = ?',
      ).run(prospectId, currentId);
    }
    if (targetId !== undefined) {
      // An old company's role is not evidence of a role at the new company.
      this.services.identities.linkOrganization({ prospectId, organizationId: targetId });
    }
  }

  getLeadDetail(input: LeadDetailRequest): LeadDetail {
    const request = leadDetailRequestSchema.parse(input);
    const person = this.database.raw.prepare(
      'SELECT id, display_name, opted_out FROM persons WHERE id = ?',
    ).get(request.personId) as {
      id: string; display_name: string; opted_out: 0 | 1;
    } | undefined;
    if (person === undefined) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
    }
    const cycle = this.database.raw.prepare(`
      SELECT id, person_id, prospect_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, close_reason, version
      FROM sales_cycles WHERE person_id = ?
      ORDER BY CASE workflow_status WHEN 'closed' THEN 1 ELSE 0 END, created_at DESC, id DESC
      LIMIT 1
    `).get(person.id) as CycleRow | undefined;
    if (cycle === undefined) {
      throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The person has no sales cycle.');
    }
    const prospect = this.database.raw.prepare(`
      SELECT id, segment, original_source_event_id,
        cloud_fit, cloud_timing, cloud_score_reasons_json, cloud_scored_at
      FROM prospects WHERE id = ?
    `).get(cycle.prospect_id) as {
      id: string; segment: LeadRow['segment']; original_source_event_id: string;
      cloud_fit: number | null; cloud_timing: number | null;
      cloud_score_reasons_json: string | null; cloud_scored_at: string | null;
    } | undefined;
    if (prospect === undefined) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The prospect does not exist.');
    }
    const sourceChannel = (this.database.raw.prepare(
      'SELECT channel FROM source_events WHERE id = ?',
    ).get(prospect.original_source_event_id) as { channel: string } | undefined)?.channel ?? 'custom';
    const cloudLink = this.database.raw.prepare(
      'SELECT cloud_entity_id FROM cloud_entity_links WHERE person_id = ?',
    ).get(person.id) as { cloud_entity_id: string } | undefined;
    const contacts = this.database.raw.prepare(`
      SELECT id, kind, normalized_value, validation_state, reachability, is_primary,
        source_label, vendor_rank, phone_kind, ownership_state, evidence_observed_at,
        compliance_expires_at, updated_at
      FROM person_contact_methods WHERE person_id = ?
      ORDER BY kind ASC, normalized_value ASC, id ASC
    `).all(person.id) as {
      id: string; kind: ContactMethod['kind']; normalized_value: string;
      validation_state: ContactMethod['validationState']; reachability: ContactMethod['reachability'];
      is_primary: 0 | 1; // Legacy evidence only, never a presentation or authorization decision.
      source_label: string | null; vendor_rank: number | null;
      phone_kind: ContactMethod['phoneKind']; ownership_state: ContactMethod['ownershipState'];
      evidence_observed_at: string | null;
      compliance_expires_at: string | null; updated_at: string;
    }[];
    const refusalReason = (row: typeof contacts[number], channel: 'call' | 'text') => {
      const decision = this.services.unitOfWork.immediate(() =>
        this.services.outboundPermission.inspectOutbound({
          personId: person.id, contactMethodId: row.id, channel, now: this.clock.now(),
        }),
      );
      return decision.kind === 'allowed' ? null : decision.reasonCode;
    };
    const contactDto = (row: typeof contacts[number]): ContactMethod => {
      const contact: Omit<ContactMethod, 'compliance'> = {
        id: row.id, kind: row.kind, value: row.normalized_value,
        contactSnapshot: contactSnapshot({ id: row.id, personId: person.id, kind: row.kind,
          normalizedValue: row.normalized_value, validationState: row.validation_state, updatedAt: row.updated_at }),
        label: null, valid: row.validation_state === 'valid',
        validationState: row.validation_state, reachability: row.reachability,
        sourceLabel: row.source_label, vendorRank: row.vendor_rank, phoneKind: row.phone_kind,
        ownershipState: row.ownership_state, evidenceObservedAt: row.evidence_observed_at,
      };
      if (row.kind === 'email') {
        return { ...contact, compliance: null };
      }
      const callRefusalReason = refusalReason(row, 'call');
      const textRefusalReason = refusalReason(row, 'text');
      const reasons = [callRefusalReason, textRefusalReason];
      const expiry = row.compliance_expires_at === null
        ? null
        : new Date(row.compliance_expires_at);
      const hasValidFutureExpiry = expiry !== null
        && Number.isFinite(expiry.getTime())
        && expiry.toISOString() === row.compliance_expires_at
        && row.compliance_expires_at > this.clock.now();
      const bothChannelsAllowed = callRefusalReason === null && textRefusalReason === null;
      const status = reasons.includes('federal_dnc_listed') ? 'federal_dnc_listed'
        : reasons.includes('tcpa_blocked') ? 'tcpa_blocked'
          : reasons.some((reason) => reason === 'federal_status_unknown'
            || reason === 'tcpa_status_unknown') ? 'compliance_unknown'
            : reasons.includes('federal_evidence_stale') ? 'scrub_expired'
              : reasons.includes('federal_area_code_mismatch') ? 'area_code_not_covered'
                : reasons.some((reason) => reason === 'jurisdiction_unknown'
                  || reason === 'jurisdiction_blocked'
                  || reason === 'state_registration_missing'
                  || reason === 'state_dnc_subscription_missing'
                  || reason === 'state_consent_rule_unknown') ? 'state_clearance_required'
                  : reasons.includes('outside_recipient_window') ? 'outside_recipient_window'
                    : bothChannelsAllowed && hasValidFutureExpiry
                      ? 'verified_clear'
                      : 'compliance_unknown';
      const labels = {
        federal_dnc_listed: 'Federal DNC listed',
        tcpa_blocked: 'TCPA blocked',
        compliance_unknown: 'Compliance unknown',
        scrub_expired: 'Scrub expired',
        area_code_not_covered: 'Area code not covered',
        state_clearance_required: 'State clearance required',
        outside_recipient_window: 'Outside recipient calling window',
      } as const;
      const expiresAt = status === 'verified_clear' ? row.compliance_expires_at : null;
      const label = status === 'verified_clear'
        ? `Verified clear until ${new Date(expiresAt!).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        })}`
        : labels[status];
      return {
        ...contact,
        compliance: { status, label, expiresAt, callRefusalReason, textRefusalReason },
      };
    };
    const organization = this.database.raw.prepare(`
      SELECT org.canonical_name AS name FROM prospect_organizations AS link
      JOIN organizations AS org ON org.id = link.organization_id
      WHERE link.prospect_id = ? ORDER BY org.id ASC LIMIT 1
    `).get(prospect.id) as { name: string } | undefined;
    const properties = this.database.raw.prepare(`
      SELECT property.id, property.address_line_1, property.locality, property.door_count
      FROM prospect_properties AS link
      JOIN properties AS property ON property.id = link.property_id
      WHERE link.prospect_id = ? ORDER BY property.id ASC
    `).all(prospect.id) as {
      id: string; address_line_1: string; locality: string; door_count: number | null;
    }[];
    const projection = this.readProjection(prospect.id);
    const action = cycle.current_next_action_id === null
      ? undefined
      : this.readAction(cycle.current_next_action_id);
    const cadence = action?.cadence_enrollment_id == null
      ? null
      : (this.database.raw.prepare(`
        SELECT definition.name, definition.attempt_cap, step.label, step.sequence
        FROM cadence_enrollments AS enrollment
        JOIN cadence_definitions AS definition ON definition.id = enrollment.cadence_definition_id
        JOIN cadence_steps AS step ON step.id = ?
        WHERE enrollment.id = ?
      `).get(action.cadence_step_id, action.cadence_enrollment_id) as {
        name: string; attempt_cap: number; label: string; sequence: number;
      } | undefined) ?? null;
    const activities = this.database.raw.prepare(`
      SELECT id, kind, direction, adapter, provider_idempotency_key, provider_reference,
        call_outcome, occurred_at, observed_outcome, duration_seconds,
        recording_storage_ref, transcript_storage_ref, metadata_json, note_text,
        EXISTS (
          SELECT 1 FROM activity_amendments AS amendment
          WHERE amendment.activity_id = activities.id
            AND amendment.amendment_kind = 'marked_in_error'
        ) AS marked_in_error
      FROM activities WHERE person_id = ?
        AND NOT COALESCE(${outboundCommandFactSql}, 0)
      ORDER BY occurred_at DESC, id DESC LIMIT 200
    `).all(person.id) as {
      id: string; kind: string; direction: string; adapter: string | null;
      provider_idempotency_key: string | null; provider_reference: string | null; call_outcome: string | null;
      occurred_at: string; observed_outcome: string | null;
      duration_seconds: number | null; recording_storage_ref: string | null;
      transcript_storage_ref: string | null; metadata_json: string;
      note_text: string | null; marked_in_error: 0 | 1;
    }[];
    const history = this.database.raw.prepare(`
      SELECT id, to_stage, effective_at, confirmation_kind
      FROM stage_events WHERE sales_cycle_id = ?
      ORDER BY transition_sequence ASC
    `).all(cycle.id) as {
      id: string; to_stage: string; effective_at: string; confirmation_kind: string;
    }[];
    const priorityContext = toPriorityContext(projection);
    const cloudReasons = ((): { signal: string; contribution: number }[] => {
      if (prospect.cloud_score_reasons_json === null) return [];
      try {
        const parsed = JSON.parse(prospect.cloud_score_reasons_json) as unknown;
        return Array.isArray(parsed)
          ? (parsed as { signal: string; contribution: number }[]).slice(0, 3)
          : [];
      } catch {
        return [];
      }
    })();
    return leadDetailSchema.parse({
      ...buildPortfolioContext(this.database, person.id),
      personId: person.id,
      salesCycleId: cycle.id,
      personName: person.display_name,
      phones: contacts.filter((row) => row.kind === 'phone').map(contactDto).sort(comparePhoneCandidates),
      emails: contacts.filter((row) => row.kind === 'email').map(contactDto),
      organizationLabel: organization?.name ?? null,
      propertySummaries: properties.map(
        (property) => `${property.address_line_1}, ${property.locality}`,
      ),
      stage: cycle.stage,
      workflowStatus: cycle.workflow_status,
      sourceLabel: sourceChannel,
      segment: prospect.segment,
      priorityContext,
      cloudScores: prospect.cloud_fit === null || prospect.cloud_timing === null
        ? null
        : {
          scores: { fit: prospect.cloud_fit, timing: prospect.cloud_timing },
          reasons: cloudReasons,
          scoredAt: prospect.cloud_scored_at,
        },
      cloudLinked: cloudLink !== undefined,
      findContactEligibility: getFindContactEligibility(
        this.getEnrichmentRequestCandidate({ personId: person.id }), this.clock.now(),
      ),
      priorityReasons: priorityContext === null ? [] : [
        `Fit ${priorityContext.fitBand} ${priorityContext.fitPoints}/30`,
        `Timing ${priorityContext.timingBand} ${priorityContext.timingValue}/40`,
        `Reachability ${priorityContext.reachability}`,
      ],
      nextAction: action === undefined || action.status !== 'pending' ? null : {
        id: action.id,
        dueAt: action.due_at,
        type: action.action_type,
        channel: actionChannel({
          actionType: action.action_type,
          channel: action.channel,
          workIntent: action.work_intent,
          onboarding: cycle.workflow_status === 'onboarding',
        }),
        label: actionLabel(action.action_type),
      },
      optedOut: person.opted_out === 1,
      cadence: cadence === null || action?.cadence_step_id == null ? null : {
        name: cadence.name,
        stepLabel: cadence.label,
        touchIndex: cadence.sequence + 1,
        touchLimit: cadence.attempt_cap,
      },
      outboundAttempts: this.services.outboundCommands.listRecent(person.id, 20),
      activities: activities.map((activity) => {
        let metadata: unknown;
        try { metadata = JSON.parse(activity.metadata_json); } catch { metadata = null; }
        const legacy = isLegacyOutboundRequest({
          kind: activity.kind, direction: activity.direction, observedOutcome: activity.observed_outcome,
          adapter: activity.adapter, providerIdempotencyKey: activity.provider_idempotency_key,
          providerReference: activity.provider_reference, durationSeconds: activity.duration_seconds,
          recordingStorageRef: activity.recording_storage_ref, transcriptStorageRef: activity.transcript_storage_ref,
          callOutcome: activity.call_outcome, metadata,
        });
        return {
          id: activity.id,
          kind: legacy ? 'system' : activity.kind,
          occurredAt: activity.occurred_at,
          summary: legacy ? 'Legacy outbound request, occurrence unverified' : activity.note_text
            ?? jsonSummary(activity.metadata_json)
            ?? `${actionLabel(activity.kind)}${activity.observed_outcome === null ? '' : ` · ${activity.observed_outcome}`}`,
          outcome: activity.observed_outcome,
          markedInError: activity.marked_in_error === 1,
        };
      }),
      conversations: activities
        .filter((activity) => activity.kind === 'call' && activity.duration_seconds !== null)
        .map((activity) => ({
          id: activity.id,
          occurredAt: activity.occurred_at,
          durationSeconds: activity.duration_seconds!,
          recordingAvailable: activity.recording_storage_ref !== null,
          transcriptAvailable: activity.transcript_storage_ref !== null,
          reviewCount: 0,
        })),
      properties: properties.map((property) => ({
        id: property.id,
        address: `${property.address_line_1}, ${property.locality}`,
        doors: property.door_count,
        ownershipEvidence: null as string | null,
        liveVacancy: false,
      })),
      history: history.map((event) => ({
        id: event.id,
        occurredAt: event.effective_at,
        label: actionLabel(event.to_stage),
        detail: event.confirmation_kind,
      })),
      revision: this.currentRevision(),
    });
  }

  inspectOutboundCommand(input: OutboundRequest): OutboundReceipt | null {
    const request = outboundRequestSchema.parse(input);
    const state = this.services.outboundCommands.read(request);
    return state === null ? null : this.outboundReceipt(request, outboundCommandResult(state));
  }

  prepareOutboundDispatch(input: OutboundRequest): Preparation {
    const request = outboundRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => {
      // Repeat lookup inside the serialized write boundary. Unresolved is unknown, not permission to retry.
      const previous = this.inspectOutboundCommand(request);
      if (previous !== null) return { kind: 'receipt', receipt: previous };
      const { cycle, prospect, contact } = this.requireOutboundIdentity(request);
      const refuse = (reason: OutboundReason): Preparation => ({
        kind: 'receipt', receipt: this.appendOutboundRefusal(request, cycle.prospect_id, reason),
      });
      if (prospect.qualificationState !== 'eligible'
        || !((cycle.workflow_status === 'active' && ['ready', 'contacted', 'interviewed', 'offered'].includes(cycle.stage))
          || (cycle.workflow_status === 'onboarding' && cycle.stage === 'won'))) {
        return refuse('cycle_not_executable');
      }
      if (contactSnapshot(contact) !== request.expectedContactSnapshot) return refuse('stale_contact');
      const expectedKind = request.channel === 'email' ? 'email' : 'phone';
      if (contact.kind !== expectedKind) return refuse('channel_contact_kind_mismatch');
      // No production Text/Gmail dispatch port exists. Never reinterpret these as a Phone handoff.
      if (request.channel !== 'call') return refuse('channel_unavailable');
      const canonicalPhone = contact.normalizedValue;
      if (/^\+[1-9][0-9]{7,14}$/.exec(canonicalPhone)?.[0] !== canonicalPhone) return refuse('invalid_target');
      // Fresh authority, not inspector advice or a clock read made before entering the UOW.
      const now = this.clock.now();
      try {
        this.services.outboundPermission.assertMayExecuteOutbound({
          personId: request.personId, contactMethodId: contact.id, channel: 'call', now,
        });
      } catch (error) {
        if (!(error instanceof OutboundAuthorizationError)) throw error;
        return refuse(error.reasonCode);
      }
      for (const phase of ['requested', 'dispatching'] as const) {
        this.services.outboundCommands.append({ request, phase, reasonCode: null, occurredAt: now }, cycle.prospect_id);
      }
      return Object.freeze({ kind: 'dispatch', canonicalPhone,
        mutation: this.receipt([request.personId], [request.salesCycleId]) });
    });
  }

  recordOutboundRefusal(input: OutboundRequest, reason: OutboundReason): OutboundReceipt {
    const request = outboundRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => {
      const previous = this.inspectOutboundCommand(request);
      if (previous !== null) return previous;
      const { cycle } = this.requireOutboundIdentity(request);
      return this.appendOutboundRefusal(request, cycle.prospect_id, reason);
    });
  }

  recordOutboundResult(input: OutboundRequest, result: HandoffResult): OutboundReceipt {
    const request = outboundRequestSchema.parse(input);
    const parsed = handoffResultSchema.parse(result);
    return this.services.unitOfWork.immediate(() => {
      const previous = this.services.outboundCommands.read(request);
      if (previous === null || previous.phase === 'requested'
        || parsed.reasonCode === 'command_conflict' || parsed.reasonCode === 'command_evidence_invalid') {
        throw new OutboundCommandEvidenceError('command_evidence_invalid');
      }
      if (previous.phase !== 'dispatching') {
        if (previous.phase !== parsed.status || previous.reasonCode !== parsed.reasonCode) {
          throw new OutboundCommandEvidenceError('command_evidence_invalid');
        }
        return this.outboundReceipt(request, outboundCommandResult(previous));
      }
      const cycle = this.requireCycle(request.salesCycleId);
      this.services.outboundCommands.append({ request, phase: parsed.status,
        reasonCode: parsed.reasonCode, occurredAt: this.clock.now() }, cycle.prospect_id);
      return this.outboundReceipt(request, { status: parsed.status, reasonCode: parsed.reasonCode });
    });
  }

  private requireOutboundIdentity(request: OutboundRequest) {
    this.services.unitOfWork.assertWriteScope();
    const person = this.services.identities.getPerson(request.personId);
    if (person === null || person.deletedAt !== null) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
    }
    const cycle = this.requireCycle(request.salesCycleId);
    const prospect = this.database.raw.prepare(`SELECT person_id AS personId, qualification_state AS qualificationState
      FROM prospects WHERE id = ?`).get(cycle.prospect_id) as { personId: string; qualificationState: string } | undefined;
    if (cycle.person_id !== request.personId || prospect === undefined || prospect.personId !== request.personId) {
      throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The sales cycle does not belong to this person.');
    }
    // Identity display reads trim text. Final authority must compare and validate
    // the exact stored tuple, never silently repair a malformed target before use.
    const contact = this.database.raw.prepare(`SELECT id, person_id AS personId, kind,
      normalized_value AS normalizedValue, validation_state AS validationState, updated_at AS updatedAt
      FROM person_contact_methods WHERE id = ?`).get(request.contactMethodId) as Parameters<typeof contactSnapshot>[0] | undefined;
    if (contact === undefined || contact.personId !== request.personId) {
      throw new FounderSalesDomainError('CONTACT_METHOD_NOT_FOUND', 'The contact method does not belong to this person.');
    }
    return { cycle, prospect, contact };
  }

  private appendOutboundRefusal(request: OutboundRequest, prospectId: string, reasonCode: OutboundReason): OutboundReceipt {
    this.services.unitOfWork.assertWriteScope();
    const status = ['channel_unavailable', 'phone_route_unverified', 'inbound_safety_unwired', 'workspace_inactive'].includes(reasonCode)
      ? 'unavailable' : 'refused';
    const result = handoffResultSchema.parse({ status, reasonCode });
    const occurredAt = this.clock.now();
    this.services.outboundCommands.append({ request, phase: 'requested', reasonCode: null, occurredAt }, prospectId);
    this.services.outboundCommands.append({ request, phase: result.status, reasonCode: result.reasonCode, occurredAt }, prospectId);
    return this.outboundReceipt(request, { status: result.status, reasonCode: result.reasonCode });
  }

  private outboundReceipt(request: OutboundRequest, result: HandoffResult): OutboundReceipt {
    const receipt = outboundReceiptSchema.parse({ ...result, commandId: request.commandId, channel: request.channel,
      mutation: this.receipt([request.personId], [request.salesCycleId]) });
    return { ...receipt, reasonCode: receipt.reasonCode };
  }

  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt {
    const request = confirmTransitionRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const writer = this.services.lifecycle.scopedWriter();
      const cycle = this.requireCycle(request.salesCycleId);
      if (request.transition === 'review_to_ready') {
        const prospect = this.database.raw.prepare(
          'SELECT version FROM prospects WHERE id = ?',
        ).get(cycle.prospect_id) as { version: number } | undefined;
        if (prospect === undefined) {
          throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The prospect does not exist.');
        }
        writer.reviewToReady({
          cycleId: cycle.id,
          expectedCycleVersion: cycle.version,
          expectedProspectVersion: prospect.version,
          effectiveAt: now,
        });
      } else {
        if (cycle.current_next_action_id === null) {
          throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'The cycle has no current action.');
        }
        const command = {
          cycleId: cycle.id,
          expectedCycleVersion: cycle.version,
          expectedCurrentActionId: cycle.current_next_action_id,
          suggestionActivityId: request.suggestionActivityId,
          effectiveAt: now,
          confirmedAt: now,
        };
        if (request.transition === 'confirm_interviewed') writer.confirmInterviewed(command);
        else writer.confirmOffered(command);
      }
      return this.receipt([cycle.person_id], [cycle.id]);
    });
  }

  /**
   * Founder dismissal from the review flow: one guarded command that
   * disqualifies the prospect behind the exact gate reason and closes the
   * cycle into Lost-Nurture. Append-only: it reuses the existing
   * closeLostNurture path (reactivation planning included) end to end.
   */
  dismissLead(input: DismissLeadRequest): MutationReceipt {
    const request = dismissLeadRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.person_id !== request.personId) {
        throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
      }
      const prospect = this.database.raw.prepare(
        'SELECT version FROM prospects WHERE id = ?',
      ).get(cycle.prospect_id) as { version: number } | undefined;
      if (prospect === undefined) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The prospect does not exist.');
      }
      this.services.lifecycle.scopedWriter().closeLostNurture({
        cycleId: cycle.id,
        expectedCycleVersion: cycle.version,
        expectedCurrentActionId: cycle.current_next_action_id,
        reason: 'disqualified',
        qualificationGateReason: request.qualificationGateReason,
        notes: null,
        effectiveAt: now,
        // Unreviewed cycles have no cadence family, and every non-opt-out
        // Lost-Nurture must carry reactivation work, so a dismissal plans
        // the mandatory manual re-look one year out.
        manualReactivationDueAt: new Date(
          Date.parse(now) + DISMISS_REACTIVATION_DELAY_MS,
        ).toISOString(),
        expectedProspectVersion: prospect.version,
      });
      return this.receipt([cycle.person_id], [cycle.id]);
    });
  }

  // ---------------------------------------------------------------- today

  getCompanyResearchSettings() { return this.services.workspaceSettings.readCompanyResearchSettings(); }

  updateCompanyResearchSettings(input: UpdateCompanyResearchSettingsRequest) {
    return this.services.unitOfWork.immediate(() => this.services.workspaceSettings.updateCompanyResearchSettingsCas(input, this.clock.now()));
  }

  getCallSettings() { return this.services.workspaceSettings.readMeetingFirstAccountCallSettings(); }

  updateCallSettings(input: UpdateCallSettingsRequest) {
    const parsed = updateCallSettingsRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() =>
      this.services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({ expectedRevision: parsed.expectedRevision, newCallSlots: parsed.newCallSlots, totalCallCapacity: parsed.totalCallCapacity, updatedAt: this.clock.now() }));
  }

  getDaily() { return this.services.daily.get(); }

  getLocalCommitments(): LocalCommitmentsSnapshot {
    const { queue, toDto } = this.buildTodayProjection();
    const items: LocalCommitmentsSnapshot['items'] = [];
    for (const { lane, items: candidates } of queue.lanes) {
      for (const candidate of candidates) {
        // Use the scheduler's exact protected-work membership, not intent labels or reason prose.
        const protectedWork = candidate.commitment != null || candidate.segment === 'warm'
          || lane === 'won_onboarding' || lane === 'inbound_interrupt';
        const founderReturn = candidate.resurfaceAt !== null
          && (candidate.resurfaceReason === 'snooze' || candidate.resurfaceReason === 'callback')
          && Date.parse(candidate.resurfaceAt) <= Date.parse(queue.generatedAt);
        if (!protectedWork && !founderReturn) continue;
        const kind: LocalCommitmentsSnapshot['items'][number]['kind'] = lane === 'won_onboarding' ? 'onboarding'
          : candidate.commitment?.kind === 'callback' && candidate.action.dueAt === candidate.commitment.dueAt ? 'callback'
          : candidate.commitment != null ? 'post_stage'
          : lane === 'inbound_interrupt' ? 'inbound_response'
          : founderReturn ? 'founder_resurface' : 'warm_relationship';
        const item = toDto(candidate, LANE_MAP[lane]);
        if (item !== null) items.push({ kind, item });
      }
    }
    // Unsent local company drafts are their own additive continuation, never a person item. The optional field is
    // present only when a draft exists, so exact-shape readers of an empty feed are unchanged. An unreadable draft
    // list is reported as incomplete local work rather than hidden or invented.
    let localDrafts: LocalCommitmentsSnapshot['localDrafts'], draftReadErrors = 0;
    try {
      const drafts = new LocalCompanyDraftRepository({ database: this.database, clock: this.clock, ids: this.ids }).listUnsent();
      if (drafts.length) localDrafts = drafts;
    } catch { draftReadErrors = 1; }
    return localCommitmentsSnapshotSchema.parse({ scope: 'local_database', generatedAt: queue.generatedAt,
      revision: this.currentRevision(), reviewErrorCount: queue.diagnostics.length + draftReadErrors, items, ...(localDrafts ? { localDrafts } : {}) });
  }

  private buildTodayProjection() {
    const settings = this.services.workspaceSettings.read();
    const timezone = this.configuredTimezone ?? settings.timezone;
    const capacity = {
      dialBudget: settings.dailyDialCapacity,
      conversationTarget: settings.dailyConversationTarget,
      explorationSlots: settings.explorationSlots,
      resurfacingWindowSeconds: settings.resurfaceSuppressionDays * 86_400,
    };
    const queue = this.services.today.build({
      timezone,
      capacity,
      channelPolicies: PLAYBOOK_CHANNEL_POLICIES_V2,
    });
    const cycleIds = queue.lanes.flatMap(({ items }) => items.map((item) => item.cycleId));
    const context = new Map<string, {
      display_name: string; stage: LeadRow['stage']; organization_name: string | null;
      cloud_fit: number | null; cloud_timing: number | null;
    }>();
    for (const cycleId of cycleIds) {
      const row = this.database.raw.prepare(`
        SELECT person.display_name, cycle.stage,
          prospect.cloud_fit, prospect.cloud_timing,
          (
            SELECT canonical_name FROM prospect_organizations AS link
            JOIN organizations AS org ON org.id = link.organization_id
            WHERE link.prospect_id = cycle.prospect_id
            ORDER BY org.id ASC LIMIT 1
          ) AS organization_name
        FROM sales_cycles AS cycle
        JOIN persons AS person ON person.id = cycle.person_id
        JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
        WHERE cycle.id = ?
      `).get(cycleId) as {
        display_name: string; stage: LeadRow['stage']; organization_name: string | null;
        cloud_fit: number | null; cloud_timing: number | null;
      } | undefined;
      if (row !== undefined) context.set(cycleId, row);
    }
    const seen = new Set<string>();
    const toDto = (item: TodayItem, lane: TodayLaneId): TodayItemDto | null => {
      if (seen.has(item.cycleId)) return null;
      seen.add(item.cycleId);
      const row = context.get(item.cycleId);
      if (row === undefined) return null;
      const priorityContext = item.priority === null
        ? toPriorityContext(this.readProjection(item.prospectId))
        : {
          priority: item.priority.effectivePriority.toUpperCase() as LeadPriorityContext['priority'],
          fitPoints: item.priority.fitPoints,
          fitBand: item.priority.fitBand,
          timingValue: item.priority.timingMilliPoints / 1000,
          timingBand: item.priority.timingBand,
          reachability: item.priority.reachability,
          dataConfidence: item.priority.dataConfidence,
        };
      return {
        id: item.cycleId,
        lane,
        personId: item.personId,
        salesCycleId: item.cycleId,
        personName: row.display_name,
        contextLabel: row.organization_name,
        stage: row.stage,
        priorityContext,
        action: {
          dueAt: item.action.dueAt ?? null,
          id: item.action.id,
          type: item.action.actionType,
          channel: actionChannel({
            actionType: item.action.actionType,
            channel: item.action.channel,
            workIntent: item.action.workIntent,
            onboarding: lane === 'onboarding',
          }),
          label: item.laneReason === 'callback_promised_today' ? 'Call back'
            : item.action.actionType === 'review_lead' ? 'Contact' : actionLabel(item.action.actionType),
        },
        reason: item.laneReason,
        activeTriggers: item.selectedTriggerReasons
          .filter((reason) => reason.kind === 'trigger')
          .map((reason) => ({
            label: reason.kind === 'trigger' ? reason.triggerKey : 'trigger',
            expiresAt: reason.kind === 'trigger' ? reason.recomputedExpiresAt : null,
          })),
        verifyFirst: item.verifyFirst ?? false,
        pinned: item.pinned,
        consentRequirement: null,
        cloudScores: row.cloud_fit === null || row.cloud_timing === null
          ? null
          : { fit: row.cloud_fit, timing: row.cloud_timing },
      };
    };
    return { queue, toDto, timezone, capacity };
  }

  getToday(): TodaySnapshot {
    const { queue, toDto, timezone, capacity } = this.buildTodayProjection();
    const lanes = queue.lanes.map(({ lane, items, overflowCount }) => ({
      id: LANE_MAP[lane],
      items: items
        .map((item) => toDto(item, LANE_MAP[lane]))
        .filter((item): item is TodayItemDto => item !== null),
      overflowCount,
    }));
    // Backlog copy (audit 4.5): how many unreviewed leads carry cloud signal.
    const cloudSignalCount = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM sales_cycles AS cycle
      JOIN persons AS person ON person.id = cycle.person_id
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
      WHERE cycle.stage = 'unreviewed' AND cycle.workflow_status = 'active'
        AND person.opted_out = 0 AND person.deleted_at IS NULL
        AND prospect.cloud_fit IS NOT NULL AND prospect.cloud_timing IS NOT NULL
    `).get() as { count: number }).count;
    // Queue-done copy (audit 4.7): real conversations logged in this local day.
    const dayInterval = resolveLocalDayInterval({
      generatedAt: this.clock.now(), timezone,
    });
    const conversationsHeld = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE kind = 'call' AND direction = 'outbound'
        AND call_outcome IN ('spoke', 'interview_booked')
        AND occurred_at >= ? AND occurred_at < ?
    `).get(dayInterval.localDayStartAt, dayInterval.localDayEndAt) as { count: number }).count;
    return todaySnapshotSchema.parse({
      lanes,
      dialBudget: capacity.dialBudget,
      scheduledDials: queue.queuedDiscretionaryDialCount,
      conversationTarget: capacity.conversationTarget,
      reviewErrorCount: queue.diagnostics.length,
      unreviewedBacklogCount: queue.unreviewedBacklogCount,
      unreviewedCloudSignalCount: cloudSignalCount,
      conversationsHeld,
      revision: this.currentRevision(),
    });
  }

  completePrimaryAction(input: CompleteActionRequest): MutationReceipt {
    const request = completeActionRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const writer = this.services.lifecycle.scopedWriter();
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.current_next_action_id !== request.actionId) {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'The action is no longer current.');
      }
      const action = this.readAction(request.actionId);
      if (action === undefined || action.cadence_enrollment_id === null
        || action.cadence_step_id === null || action.cadence_component_id === null) {
        throw new FounderSalesDomainError(
          'ACTION_NOT_SUPPORTED',
          'Only cadence-bound primary actions complete through this command.',
        );
      }
      const enrollment = this.database.raw.prepare(
        'SELECT version FROM cadence_enrollments WHERE id = ?',
      ).get(action.cadence_enrollment_id) as { version: number } | undefined;
      if (enrollment === undefined) {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'The cadence enrollment is missing.');
      }
      let activityId = request.activityId;
      let impossibleDisposition: { reason: 'other'; notes: string | null } | null = null;
      if (request.outcome === 'marked_impossible') {
        activityId = null;
        impossibleDisposition = { reason: 'other', notes: null };
      } else if (activityId === null) {
        const kind = action.action_type === 'voicemail' ? 'voicemail'
          : action.action_type === 'text' ? 'text'
            : action.action_type === 'email' ? 'email' : 'call';
        const appended = this.services.events.appendActivity({
          id: this.ids.next(),
          personId: cycle.person_id,
          prospectId: cycle.prospect_id,
          salesCycleId: cycle.id,
          cadenceEnrollmentId: action.cadence_enrollment_id,
          cadenceStepId: action.cadence_step_id,
          cadenceComponentId: action.cadence_component_id,
          kind,
          direction: 'outbound',
          channel: action.channel ?? kind,
          occurredAt: now,
          observedOutcome: request.outcome,
          metadata: { formatVersion: 1, completedVia: 'founder_workflow_ui' },
        });
        activityId = appended.id;
      }
      writer.completeCurrentAction({
        cycleId: cycle.id,
        expectedCycleVersion: cycle.version,
        expectedCurrentActionId: action.id,
        expectedActionVersion: action.version,
        expectedEnrollmentVersion: enrollment.version,
        outcome: request.outcome,
        activityId,
        impossibleDisposition,
        evaluationAt: now,
        manualReactivationDueAt: null,
      });
      return this.receipt([cycle.person_id], [cycle.id]);
    });
  }

  /**
   * Snooze writes the founder-chosen `resurface_at` on the cycle: it leaves
   * Today entirely until that instant and re-enters with the reason
   * 'Snoozed until today'. No priority-comparison event is recorded; this
   * is queue control, not a preference signal.
   */
  snoozePrimaryAction(input: SnoozeActionRequest): MutationReceipt {
    const request = snoozeActionRequestSchema.parse(input);
    const now = this.clock.now();
    if (request.resurfaceAt <= now) {
      throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'Snooze must resurface in the future.');
    }
    return this.services.unitOfWork.immediate(() => {
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.workflow_status === 'closed') {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'A closed cycle cannot snooze.');
      }
      this.setCycleResurface(cycle, request.resurfaceAt, 'snooze', now);
      return this.receipt([cycle.person_id], [cycle.id]);
    });
  }

  /** CAS write of the cycle's resurface marker under the current version. */
  private setCycleResurface(
    cycle: CycleRow,
    resurfaceAt: string | null,
    resurfaceReason: 'snooze' | 'callback' | null,
    updatedAt: string,
  ): void {
    const changed = this.database.raw.prepare(`
      UPDATE sales_cycles
      SET resurface_at = ?, resurface_reason = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND workflow_status IN ('active','onboarding')
    `).run(resurfaceAt, resurfaceReason, updatedAt, cycle.id, cycle.version);
    if (changed.changes !== 1) {
      throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle changed concurrently.');
    }
    if (resurfaceAt !== null && cycle.current_next_action_id !== null) {
      const independentPostStage = resurfaceReason === 'callback'
        && ['interviewed', 'offered', 'won'].includes(cycle.stage);
      const actionChanged = this.database.raw.prepare(`
        UPDATE next_actions
        SET due_at = CASE WHEN ? AND action_type <> 'call' THEN due_at ELSE ? END,
          due_source = CASE WHEN ? AND action_type <> 'call' THEN due_source ELSE ? END,
          version = version + 1, updated_at = ?
        WHERE id = ? AND sales_cycle_id = ? AND status = 'pending'
      `).run(Number(independentPostStage), resurfaceAt, Number(independentPostStage),
        resurfaceReason === 'callback' ? 'recorded_callback' : 'founder_resurface',
        updatedAt, cycle.current_next_action_id, cycle.id);
      if (actionChanged.changes !== 1) {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'The current action changed concurrently.');
      }
    }
  }

  private manualReplay(request: {
    outboundCommandId?: string; personId: string; salesCycleId: string | null;
    kind: string; direction: string; occurredAt: string; outcome: string | null;
    summary?: string; callbackAt?: string | null;
  }, loggedVia: 'founder_workflow_ui' | 'call_outcome'): MutationReceipt | null {
    if (request.outboundCommandId === undefined) return null;
    const conflict = () => new FounderSalesDomainError('ACTION_NOT_SUPPORTED',
      'Manual command association conflicts with existing evidence. Use an explicit amendment.');
    if (request.salesCycleId === null || request.direction !== 'outbound'
      || (request.kind !== 'call' && request.kind !== 'text' && request.kind !== 'email')) throw conflict();
    let existing: Activity | null;
    try {
      existing = this.services.outboundCommands.resolveManualAssociation({ commandId: request.outboundCommandId,
        personId: request.personId, salesCycleId: request.salesCycleId, channel: request.kind });
    } catch (error) {
      if (error instanceof OutboundCommandEvidenceError) throw conflict();
      throw error;
    }
    if (existing === null) return null;
    const metadata = existing.metadata as { loggedVia: string; summary?: string; callbackAt?: string | null };
    if (existing.occurredAt !== request.occurredAt || existing.observedOutcome !== request.outcome
      || (existing.callbackAt ?? metadata.callbackAt ?? null) !== (request.callbackAt ?? null) || metadata.loggedVia !== loggedVia
      || metadata.summary !== request.summary) throw conflict();
    return this.receipt([request.personId], [request.salesCycleId]);
  }

  private manualAudit(request: {
    personId: string; occurredAt: string; kind: string; direction: string; outboundCommandId?: string;
  }): Record<string, unknown> {
    // Current suppression is not proof of historical legality. Only a persisted
    // effective prohibition at/before the reported outbound touch proves that block.
    const tombstones = this.database.raw.prepare(`SELECT person_id, requested_at FROM opt_out_tombstones AS tombstone
      WHERE tombstone.person_id = ? OR EXISTS (
        SELECT 1 FROM opt_out_handles AS handle JOIN person_contact_methods AS contact
          ON contact.kind = handle.kind AND contact.normalized_value = handle.normalized_value
        WHERE handle.tombstone_id = tombstone.id AND contact.person_id = ?
      )`).all(request.personId, request.personId) as { person_id: string; requested_at: string }[];
    // A currently shared/reassigned handle establishes a current block, not who
    // owned the reported target in the past. No historical target is supplied here.
    const prohibited = request.direction === 'outbound' && ['call', 'voicemail', 'text', 'email'].includes(request.kind)
      && tombstones.some((row) => row.person_id === request.personId && Number.isFinite(Date.parse(row.requested_at))
        && Date.parse(row.requested_at) <= Date.parse(request.occurredAt));
    return {
      loggedManually: true, currentBlockPresent: tombstones.length > 0,
      prohibitedPastTouchReported: prohibited, prohibitionAssessment: prohibited ? 'prohibited' : 'unknown',
      ...(request.outboundCommandId === undefined ? {} : { outboundCommandId: request.outboundCommandId }),
    };
  }

  logPastActivity(input: LogPastActivityRequest): MutationReceipt {
    const request = logPastActivityRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => {
      const replay = this.manualReplay({ ...request, salesCycleId: request.salesCycleId, outcome: request.outcome }, 'founder_workflow_ui');
      if (replay !== null) return replay;
      const person = this.database.raw.prepare(
        'SELECT id FROM persons WHERE id = ?',
      ).get(request.personId) as { id: string } | undefined;
      if (person === undefined) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
      }
      let cycleIds: string[] = [];
      if (request.salesCycleId !== null) {
        const cycle = this.requireCycle(request.salesCycleId);
        if (cycle.person_id !== request.personId) {
          throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
        }
        cycleIds = [cycle.id];
      }
      const prospect = this.database.raw.prepare(
        'SELECT id FROM prospects WHERE person_id = ?',
      ).get(request.personId) as { id: string } | undefined;
      this.services.events.appendActivity({
        id: this.ids.next(),
        personId: request.personId,
        prospectId: prospect?.id ?? null,
        salesCycleId: request.salesCycleId,
        kind: request.kind,
        direction: request.direction,
        channel: request.kind === 'call' || request.kind === 'voicemail' ? 'phone' : request.kind,
        occurredAt: request.occurredAt,
        observedOutcome: request.outcome,
        adapter: request.outboundCommandId === undefined ? null : 'callie_manual_outbound_v1',
        providerIdempotencyKey: request.outboundCommandId ?? null,
        metadata: { formatVersion: 1, summary: request.summary, loggedVia: 'founder_workflow_ui',
          ...this.manualAudit(request) },
      });
      return this.receipt([request.personId], cycleIds);
    });
  }

  /**
   * Founder note: THE one place prose is allowed. The text lives in the
   * local encrypted activities.note_text column only; it is never uploaded
   * anywhere and never leaves this machine.
   */
  addLeadNote(input: AddLeadNoteRequest): MutationReceipt {
    const request = addLeadNoteRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const person = this.database.raw.prepare(
        'SELECT id FROM persons WHERE id = ?',
      ).get(request.personId) as { id: string } | undefined;
      if (person === undefined) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
      }
      let cycleIds: string[] = [];
      if (request.salesCycleId !== null) {
        const cycle = this.requireCycle(request.salesCycleId);
        if (cycle.person_id !== request.personId) {
          throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
        }
        cycleIds = [cycle.id];
      }
      const prospect = this.database.raw.prepare(
        'SELECT id FROM prospects WHERE person_id = ?',
      ).get(request.personId) as { id: string } | undefined;
      this.services.events.appendActivity({
        id: this.ids.next(),
        personId: request.personId,
        prospectId: prospect?.id ?? null,
        salesCycleId: request.salesCycleId,
        kind: 'note',
        direction: 'internal',
        channel: 'note',
        occurredAt: now,
        observedOutcome: null,
        noteText: request.text,
        metadata: { formatVersion: 1, loggedVia: 'founder_note' },
      });
      return this.receipt([request.personId], cycleIds);
    });
  }

  /**
   * Structured call outcome. `callbackAt` sets the cycle's resurface marker
   * ('Callback you promised for today' on re-entry). `opted_out` routes
   * through the existing person-wide opt-out closure using this call
   * activity as founder-confirmed evidence.
   */
  logCallOutcome(input: LogCallOutcomeRequest): MutationReceipt {
    const request = logCallOutcomeRequestSchema.parse(input);
    const now = this.clock.now();
    const manualRequest = { ...request, kind: 'call', direction: 'outbound' };
    const validateCallback = () => {
      if (request.callbackAt !== null && request.callbackAt <= now) {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'A promised callback must be in the future.');
      }
    };
    if (request.outcome === 'opted_out') {
      // Resolve synchronously before optOut.apply, which owns the sole atomic UOW.
      const replay = this.manualReplay(manualRequest, 'call_outcome');
      if (replay !== null) return replay;
      validateCallback();
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.person_id !== request.personId) {
        throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
      }
      const prospect = this.database.raw.prepare(
        'SELECT id FROM prospects WHERE person_id = ?',
      ).get(request.personId) as { id: string } | undefined;
      const activityId = this.ids.next();
      this.services.optOut.apply({
        personId: request.personId,
        tombstoneId: this.ids.next(),
        requestedAt: now,
        policyVersion: 'founder_opt_out_v1',
        decision: { kind: 'founder_confirmed', channel: 'call' },
        evidence: {
          kind: 'append_activity',
          activity: {
            id: activityId,
            personId: request.personId,
            prospectId: prospect?.id ?? null,
            salesCycleId: request.salesCycleId,
            kind: 'call',
            direction: 'outbound',
            channel: 'phone',
            occurredAt: request.occurredAt,
            observedOutcome: 'opted_out',
            adapter: request.outboundCommandId === undefined ? null : 'callie_manual_outbound_v1',
            providerIdempotencyKey: request.outboundCommandId ?? null,
            metadata: { formatVersion: 1, loggedVia: 'call_outcome', callbackAt: request.callbackAt,
              ...this.manualAudit(manualRequest) },
          },
        },
        terminalStageEventId: cycle.workflow_status === 'onboarding' && cycle.stage === 'won'
          ? null
          : this.ids.next(),
      });
      return this.receipt([request.personId], [request.salesCycleId]);
    }
    return this.services.unitOfWork.immediate(() => {
      const replay = this.manualReplay(manualRequest, 'call_outcome');
      if (replay !== null) return replay;
      validateCallback();
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.person_id !== request.personId) {
        throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
      }
      const prospect = this.database.raw.prepare(
        'SELECT id FROM prospects WHERE person_id = ?',
      ).get(request.personId) as { id: string } | undefined;
      this.services.events.appendActivity({
        id: this.ids.next(),
        personId: request.personId,
        prospectId: prospect?.id ?? null,
        salesCycleId: cycle.id,
        kind: 'call',
        direction: 'outbound',
        channel: 'phone',
        occurredAt: request.occurredAt,
        observedOutcome: request.outcome,
        callOutcome: request.outcome,
        callbackAt: request.callbackAt,
        adapter: request.outboundCommandId === undefined ? null : 'callie_manual_outbound_v1',
        providerIdempotencyKey: request.outboundCommandId ?? null,
        metadata: { formatVersion: 1, loggedVia: 'call_outcome', ...this.manualAudit(manualRequest) },
      });
      if (request.callbackAt !== null && cycle.workflow_status !== 'closed') {
        this.setCycleResurface(cycle, request.callbackAt, 'callback', now);
      }
      return this.receipt([request.personId], [cycle.id]);
    });
  }

  /**
   * Amendment event (audit 2.7): appends an immutable 'marked_in_error'
   * amendment referencing the prior activity. Nothing is deleted; renderers
   * strike the activity through at render time.
   */
  markActivityInError(input: MarkActivityInErrorRequest): MutationReceipt {
    const request = markActivityInErrorRequestSchema.parse(input);
    return this.services.unitOfWork.immediate(() => {
      const activity = this.database.raw.prepare(
        'SELECT id, person_id, sales_cycle_id FROM activities WHERE id = ?',
      ).get(request.activityId) as {
        id: string; person_id: string; sales_cycle_id: string | null;
      } | undefined;
      if (activity === undefined || activity.person_id !== request.personId) {
        throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The activity does not belong to this person.');
      }
      this.services.events.appendActivityAmendment({
        id: this.ids.next(),
        activityId: activity.id,
        amendmentKind: 'marked_in_error',
        correction: { formatVersion: 1, markedInError: true },
        reason: request.reason,
      });
      return this.receipt(
        [request.personId],
        activity.sales_cycle_id === null ? [] : [activity.sales_cycle_id],
      );
    });
  }

  /** One deferred read snapshot, or the caller's existing snapshot. Never a write UoW. */
  private readListSnapshot<T>(read: () => T): T {
    try {
      return this.database.raw.inTransaction ? read() : this.database.raw.transaction(read).deferred();
    } catch (error) {
      if (error instanceof ListCursorError) throw new FounderSalesDomainError(error.code, error.code);
      throw error;
    }
  }

  // -------------------------------------------------------------- friday

  getFridayReport(input?: FridayReportRequest): FridayReport {
    const request = fridayReportRequestSchema.parse(input ?? { weekOffset: 0 });
    const asOf = this.clock.now();
    const settings = this.services.workspaceSettings.read();
    const timezone = this.configuredTimezone ?? settings.timezone;
    const { periodStartsAt, periodEndsAt } = this.fridayWindow(
      asOf, timezone, request.weekOffset,
    );
    const priorWindow = this.fridayWindow(asOf, timezone, request.weekOffset - 1);

    const founderJobs = this.listFounderJobs();
    const current = this.fridayWindowTotals(periodStartsAt, periodEndsAt, founderJobs);
    const prior = this.fridayWindowTotals(
      priorWindow.periodStartsAt, priorWindow.periodEndsAt, founderJobs,
    );

    const fitness = this.database.raw.prepare(`
      SELECT AVG(design_partner_fitness) AS average FROM sales_cycles
      WHERE design_partner_fitness IS NOT NULL
    `).get() as { average: number | null };
    const cyclesWithoutNextStep = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles AS cycle
      WHERE cycle.workflow_status IN ('active', 'onboarding')
        AND cycle.stage <> 'unreviewed'
        AND (
          cycle.current_next_action_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM next_actions AS action
            WHERE action.id = cycle.current_next_action_id AND action.status = 'pending'
          )
        )
    `).get() as { count: number }).count;
    const invalidActionCycles = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles AS cycle
      WHERE cycle.workflow_status IN ('active', 'onboarding') AND (
        cycle.current_next_action_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM next_actions AS action
          WHERE action.id = cycle.current_next_action_id AND action.status = 'pending'
        )
      )
    `).get() as { count: number }).count;

    // Weekly deltas compare this window to the one immediately before it.
    // Point-in-time metrics (fitness, overdue, invalid cycles) have no
    // meaningful weekly value, so their delta stays null.
    const count = (
      id: MetricId, label: string, value: number,
      priorValue: number | null, drilldownCount = 0,
    ): Metric => ({
      id, label, displayValue: String(value), numericValue: value,
      target: null,
      priorDelta: priorValue === null ? null : value - priorValue,
      numerator: null, denominator: null, drilldownCount,
    });
    const rate = (
      id: MetricId, label: string, numerator: number, denominator: number,
      priorNumerator: number, priorDenominator: number,
    ): Metric => ({
      id,
      label,
      displayValue: denominator === 0 ? '—' : `${Math.round((numerator / denominator) * 100)}%`,
      numericValue: denominator === 0 ? null : numerator / denominator,
      target: null,
      priorDelta: denominator === 0 || priorDenominator === 0
        ? null
        : numerator / denominator - priorNumerator / priorDenominator,
      numerator,
      denominator,
      drilldownCount: 0,
    });
    const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const metrics: Metric[] = [
      count('interviews', 'Interviews', current.interviews, prior.interviews, current.interviews),
      count('offers', 'Offers', current.offers, prior.offers, current.offers),
      count('wins', 'Wins', current.wins, prior.wins, current.wins),
      rate(
        'offer_rate', 'Offer rate', current.offers, current.interviews,
        prior.offers, prior.interviews,
      ),
      rate('win_rate', 'Win rate', current.wins, current.offers, prior.wins, prior.offers),
      count('jobs_requested', 'Jobs requested', current.requestedJobs, prior.requestedJobs),
      count('jobs_filled', 'Jobs filled', current.filledJobs, prior.filledJobs),
      rate(
        'fill_rate', 'Fill rate', current.filledJobs, current.requestedJobs,
        prior.filledJobs, prior.requestedJobs,
      ),
      {
        id: 'new_mrr', label: 'New MRR', displayValue: usd.format(current.mrrCents / 100),
        numericValue: current.mrrCents / 100, target: null,
        priorDelta: (current.mrrCents - prior.mrrCents) / 100,
        numerator: null, denominator: null, drilldownCount: 0,
      },
      count(
        'founding_customers', 'Founding customers',
        current.foundingCustomers, prior.foundingCustomers,
      ),
      {
        id: 'design_partner_fitness', label: 'Design partner fitness',
        displayValue: fitness.average === null ? '—' : fitness.average.toFixed(1),
        numericValue: fitness.average, target: null, priorDelta: null,
        numerator: null, denominator: null, drilldownCount: 0,
      },
      count('cycles_without_next_step', 'Cycles without next step', cyclesWithoutNextStep, null),
      count('invalid_action_cycles', 'Invalid action cycles', invalidActionCycles, null),
    ];
    const sourceRows = this.database.raw.prepare(`
      SELECT source.channel AS source,
        SUM(CASE WHEN event.to_stage = 'interviewed' THEN 1 ELSE 0 END) AS interviews,
        SUM(CASE WHEN event.to_stage = 'offered' THEN 1 ELSE 0 END) AS offers,
        SUM(CASE WHEN event.to_stage = 'won' THEN 1 ELSE 0 END) AS wins
      FROM stage_events AS event
      JOIN sales_cycles AS cycle ON cycle.id = event.sales_cycle_id
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
      JOIN source_events AS source ON source.id = prospect.original_source_event_id
      WHERE event.effective_at >= ? AND event.effective_at < ?
        AND event.to_stage IN ('interviewed', 'offered', 'won')
      GROUP BY source.channel ORDER BY source.channel ASC
    `).all(periodStartsAt, periodEndsAt) as {
      source: string; interviews: number; offers: number; wins: number;
    }[];
    return fridayReportSchema.parse({
      periodStartsAt,
      periodEndsAt,
      asOf,
      metrics,
      sourceRows,
      jobs: founderJobs,
      revision: this.currentRevision(),
    });
  }

  /** Window-scoped funnel, job, and revenue totals for one Monday week. */
  private fridayWindowTotals(
    periodStartsAt: string,
    periodEndsAt: string,
    founderJobs: {
      status: 'requested' | 'filled' | 'cancelled';
      requestedAt: string;
      contractorAcceptedAt: string | null;
    }[],
  ): {
    interviews: number;
    offers: number;
    wins: number;
    requestedJobs: number;
    filledJobs: number;
    mrrCents: number;
    foundingCustomers: number;
  } {
    const stageCount = (stage: string): number => (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM stage_events
      WHERE to_stage = ? AND effective_at >= ? AND effective_at < ?
    `).get(stage, periodStartsAt, periodEndsAt) as { count: number }).count;
    const inWindow = (timestamp: string | null): boolean => (
      timestamp !== null && timestamp >= periodStartsAt && timestamp < periodEndsAt
    );
    const mrrCents = (this.database.raw.prepare(`
      SELECT COALESCE(SUM(projected_mrr_cents), 0) AS total FROM won_terms
      WHERE effective_at >= ? AND effective_at < ?
    `).get(periodStartsAt, periodEndsAt) as { total: number }).total;
    const foundingCustomers = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM won_terms
      WHERE founding_customer = 1 AND effective_at >= ? AND effective_at < ?
    `).get(periodStartsAt, periodEndsAt) as { count: number }).count;
    return {
      interviews: stageCount('interviewed'),
      offers: stageCount('offered'),
      wins: stageCount('won'),
      requestedJobs: founderJobs.filter(
        (job) => job.status !== 'cancelled' && inWindow(job.requestedAt),
      ).length,
      filledJobs: founderJobs.filter(
        (job) => job.status === 'filled' && inWindow(job.contractorAcceptedAt),
      ).length,
      mrrCents,
      foundingCustomers,
    };
  }

  getMetricDrilldown(input: MetricDrilldownRequest): MetricDrilldown {
    const request = metricDrilldownRequestSchema.parse(input);
    const stageFor: Partial<Record<MetricId, string>> = {
      interviews: 'interviewed', offers: 'offered', wins: 'won',
    };
    const stage = stageFor[request.metricId];
    const rows = stage === undefined ? [] : (this.database.raw.prepare(`
      SELECT event.id, event.effective_at, cycle.id AS cycle_id,
        cycle.person_id, person.display_name
      FROM stage_events AS event
      JOIN sales_cycles AS cycle ON cycle.id = event.sales_cycle_id
      JOIN persons AS person ON person.id = cycle.person_id
      WHERE event.to_stage = ?
      ORDER BY event.effective_at DESC, event.id DESC LIMIT 100
    `).all(stage) as {
      id: string; effective_at: string; cycle_id: string;
      person_id: string; display_name: string;
    }[]).map((row) => ({
      id: row.id,
      personId: row.person_id,
      salesCycleId: row.cycle_id,
      label: row.display_name,
      occurredAt: row.effective_at,
      detail: null as string | null,
    }));
    return metricDrilldownSchema.parse({
      metricId: request.metricId,
      label: actionLabel(request.metricId),
      rows,
    });
  }

  /**
   * V1 stores founder job requests as jobs rows with the dedicated
   * `founder_job_request_v1` type: requested = queued, filled = succeeded
   * with the acceptance timestamp in the result payload, cancelled =
   * cancelled. The idempotency key is derived from the caller job ID so
   * repeated creates cannot duplicate rows.
   */
  createJobRequest(input: CreateJobRequest): MutationReceipt {
    const request = createJobRequestSchema.parse(input);
    if (request.salesCycleId !== null) this.requireCycle(request.salesCycleId);
    this.services.jobs.enqueue({
      id: request.jobId,
      type: FOUNDER_JOB_REQUEST_TYPE,
      idempotencyKey: `founder-job:${request.jobId}`,
      payload: {
        formatVersion: 1,
        jobId: request.jobId,
        salesCycleId: request.salesCycleId,
        requestedAt: request.requestedAt,
      },
      at: this.clock.now(),
    });
    return this.receipt([], request.salesCycleId === null ? [] : [request.salesCycleId]);
  }

  markJobFilled(input: FillJobRequest): MutationReceipt {
    const request = fillJobRequestSchema.parse(input);
    const job = this.requireFounderJob(request.jobId);
    if (job.state === 'queued') {
      this.services.jobs.start(job.id);
      this.services.jobs.succeed(job.id, {
        formatVersion: 1,
        contractorAcceptedAt: request.contractorAcceptedAt,
      });
    } else if (job.state !== 'succeeded') {
      throw new FounderSalesDomainError('JOB_NOT_FOUND', 'The job request cannot be filled.');
    }
    return this.receipt([], []);
  }

  cancelJobRequest(input: CancelJobRequest): MutationReceipt {
    const request = cancelJobRequestSchema.parse(input);
    const job = this.requireFounderJob(request.jobId);
    if (job.state === 'queued') {
      this.services.jobs.cancel(job.id);
    } else if (job.state !== 'cancelled') {
      throw new FounderSalesDomainError('JOB_NOT_FOUND', 'Only requested jobs can be cancelled.');
    }
    return this.receipt([], []);
  }

  private requireFounderJob(jobId: string): JobRecord {
    const job = this.services.jobs.get(jobId);
    if (job === null || job.type !== FOUNDER_JOB_REQUEST_TYPE) {
      throw new FounderSalesDomainError('JOB_NOT_FOUND', 'The founder job request does not exist.');
    }
    return job;
  }

  private listFounderJobs(): {
    id: string;
    salesCycleId: string | null;
    requestedAt: string;
    status: 'requested' | 'filled' | 'cancelled';
    contractorAcceptedAt: string | null;
  }[] {
    const rows = this.database.raw.prepare(`
      SELECT id, state, payload_json, result_json FROM jobs
      WHERE type = ? ORDER BY created_at ASC, id ASC
    `).all(FOUNDER_JOB_REQUEST_TYPE) as {
      id: string; state: string; payload_json: string; result_json: string | null;
    }[];
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as {
        salesCycleId: string | null; requestedAt: string;
      };
      const result = row.result_json === null
        ? null
        : JSON.parse(row.result_json) as { contractorAcceptedAt?: string };
      return {
        id: row.id,
        salesCycleId: payload.salesCycleId,
        requestedAt: payload.requestedAt,
        status: row.state === 'succeeded' ? 'filled' as const
          : row.state === 'cancelled' ? 'cancelled' as const : 'requested' as const,
        contractorAcceptedAt: result?.contractorAcceptedAt ?? null,
      };
    });
  }

  private fridayWindow(asOf: string, timezone: string, weekOffset = 0): {
    periodStartsAt: string;
    periodEndsAt: string;
  } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const localDate = formatter.format(new Date(asOf));
    const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    const shift = (date: string, days: number): string => {
      const [year, month, day] = date.split('-').map(Number);
      return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
    };
    const monday = shift(localDate, -daysSinceMonday + weekOffset * 7);
    const saturday = shift(monday, 5);
    return {
      periodStartsAt: this.localMidnightUtc(monday, timezone),
      periodEndsAt: this.localMidnightUtc(saturday, timezone),
    };
  }

  private localMidnightUtc(localDate: string, timezone: string): string {
    const [year, month, day] = localDate.split('-').map(Number);
    let guess = Date.UTC(year!, month! - 1, day!);
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const offset = this.timezoneOffsetMillis(guess, timezone);
      const corrected = Date.UTC(year!, month! - 1, day!) - offset;
      if (corrected === guess) break;
      guess = corrected;
    }
    return new Date(guess).toISOString();
  }

  private timezoneOffsetMillis(utcMillis: number, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMillis));
    const part = (type: Intl.DateTimeFormatPartTypes): number => (
      Number(parts.find((candidate) => candidate.type === type)?.value ?? '0')
    );
    const asUtc = Date.UTC(
      part('year'), part('month') - 1, part('day'),
      part('hour'), part('minute'), part('second'),
    );
    return asUtc - utcMillis;
  }

  // --------------------------------------------------------------- import

  previewLeadImport(input: ImportSource): ImportPreview {
    const request = importSourceSchema.parse(input);
    const parsed = parseCsvSource(request.content, request.kind);
    const uniqueColumns = [...new Set(parsed.columns)];
    const suggestedMapping = this.suggestMapping(uniqueColumns);
    const rows = parsed.rows.map((row) => ({
      rowNumber: row.rowNumber,
      values: Object.fromEntries(uniqueColumns.map((column) => [
        column, row.values[parsed.columns.indexOf(column)] ?? '',
      ])),
    }));
    const validation = this.validateImportRows(rows, suggestedMapping);
    const preview = importPreviewSchema.parse({
      previewId: this.ids.next(),
      contentHash: createHash('sha256').update(request.content, 'utf8').digest('hex'),
      columns: parsed.columns,
      sampleRows: parsed.rows.slice(0, 20).map((row) => ({
        rowNumber: row.rowNumber,
        cells: row.values,
      })),
      suggestedMapping,
      rowCount: parsed.rows.length,
      validCount: validation.validCount,
      errors: [...parsed.errors, ...validation.errors],
      duplicateCandidates: validation.duplicateCandidates,
      expiresAt: new Date(Date.parse(this.clock.now()) + IMPORT_PREVIEW_TTL_MS).toISOString(),
    });
    this.importPreviews.set(preview.previewId, {
      preview,
      columns: parsed.columns,
      rows,
      parseErrors: Object.freeze(parsed.errors.map((error) => Object.freeze({ ...error }))),
      sourceName: request.sourceName,
    });
    return preview;
  }

  remapLeadImport(input: ImportRemapRequest): ImportPreview {
    const request = importRemapRequestSchema.parse(input);
    const stored = this.requirePreview(request.previewId, request.contentHash);
    const validation = this.validateImportRows(stored.rows, request.mapping);
    const preview = importPreviewSchema.parse({
      ...stored.preview,
      suggestedMapping: request.mapping,
      validCount: validation.validCount,
      errors: [...stored.parseErrors, ...validation.errors],
      duplicateCandidates: validation.duplicateCandidates,
    });
    this.importPreviews.set(request.previewId, { ...stored, preview });
    return preview;
  }

  commitLeadImport(input: ImportCommitRequest): ImportCommitReceipt {
    const request = importCommitRequestSchema.parse(input);
    const stored = this.requirePreview(request.previewId, request.contentHash);
    if (stored.parseErrors.length > 0) {
      throw new FounderSalesDomainError(
        'IMPORT_VALIDATION_FAILED',
        'The import has blocking parse errors; nothing was written.',
      );
    }
    const validation = this.validateImportRows(stored.rows, request.mapping);
    if (validation.errors.length > 0) {
      throw new FounderSalesDomainError(
        'IMPORT_VALIDATION_FAILED',
        'The import has blocking row errors; nothing was written.',
      );
    }
    const skipRows = new Set(
      request.duplicateDecisions
        .filter((decision) => decision.decision === 'skip')
        .map((decision) => decision.rowNumber),
    );
    const now = this.clock.now();
    const commands: CreatePersonProspectCommand[] = [];
    for (const row of stored.rows) {
      if (skipRows.has(row.rowNumber)) continue;
      commands.push(this.toIntakeCommand({
        row: row.values,
        mapping: request.mapping,
        channel: request.source.channel,
        referredByPersonId: request.source.referredByPersonId,
        observedAt: now,
        sourceName: stored.sourceName,
        contentHash: request.contentHash,
        rowNumber: row.rowNumber,
      }));
    }
    const results = this.services.sources.commitBatch(commands);
    // Fresh unreviewed prospects enter the fixed lifecycle immediately so the
    // Leads grid and Today review lane can see them.
    for (const result of results) {
      if (result.disposition !== 'created') continue;
      this.services.lifecycle.createUnreviewedCycle({
        personId: result.personId,
        prospectId: result.prospectId,
        entrySourceEventId: result.sourceEventId,
        effectiveAt: now,
      });
    }
    const importedPersonIds = [...new Set(results.map((result) => result.personId))];
    const job = this.services.jobs.enqueue({
      id: this.ids.next(),
      type: LEAD_IMPORT_JOB_TYPE,
      idempotencyKey: `import:${request.contentHash}`,
      payload: {
        formatVersion: 1,
        sourceName: stored.sourceName,
        contentHash: request.contentHash,
        rowCount: commands.length,
      },
      progressTotal: commands.length,
      at: now,
    });
    if (job.state === 'queued') {
      this.services.jobs.start(job.id);
      this.services.jobs.reportProgress(job.id, commands.length, commands.length);
      this.services.jobs.succeed(job.id, {
        formatVersion: 1,
        importedPersonIds,
        importedRowCount: commands.length,
      });
    }
    this.importPreviews.delete(request.previewId);
    return importCommitReceiptSchema.parse({
      jobId: job.id,
      importedPersonIds,
      importedRowCount: commands.length,
      revision: this.currentRevision(),
    });
  }

  getImportJob(input: ImportStatusRequest): ImportStatus {
    const request = importStatusRequestSchema.parse(input);
    const job = this.services.jobs.get(request.jobId);
    if (job === null || job.type !== LEAD_IMPORT_JOB_TYPE) {
      throw new FounderSalesDomainError('JOB_NOT_FOUND', 'The import job does not exist.');
    }
    return importStatusSchema.parse({
      jobId: job.id,
      state: job.state === 'cancelled' ? 'failed' : job.state,
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal,
      safeErrorCode: job.error?.code ?? null,
    });
  }

  private requirePreview(previewId: string, contentHash: string): StoredImportPreview {
    const stored = this.importPreviews.get(previewId);
    if (stored === undefined
      || stored.preview.contentHash !== contentHash
      || stored.preview.expiresAt < this.clock.now()) {
      this.importPreviews.delete(previewId);
      throw new FounderSalesDomainError(
        'IMPORT_PREVIEW_INVALID',
        'The import preview is expired or changed; restart the import.',
      );
    }
    return stored;
  }

  private suggestMapping(columns: string[]): ImportMapping {
    const byHeader: Record<string, ImportField> = {
      name: 'person_name', person: 'person_name', owner: 'person_name',
      phone: 'phone', mobile: 'phone', email: 'email',
      company: 'organization', organization: 'organization', org: 'organization',
      address: 'property_address', property: 'property_address',
      doors: 'doors', units: 'doors', source: 'source', segment: 'segment', notes: 'notes',
    };
    const mapping: Record<string, ImportField> = Object.create(null);
    let hasName = false;
    for (const column of columns) {
      const header = column.toLowerCase();
      const suggested = Object.hasOwn(byHeader, header) ? byHeader[header]! : 'ignore';
      if (suggested === 'person_name') {
        mapping[column] = hasName ? 'ignore' : 'person_name';
        hasName = true;
      } else {
        mapping[column] = suggested;
      }
    }
    if (!hasName && columns.length > 0) mapping[columns[0]!] = 'person_name';
    return mapping;
  }

  private validateImportRows(
    rows: { rowNumber: number; values: Record<string, string> }[],
    mapping: ImportMapping,
  ): {
    validCount: number;
    errors: { rowNumber: number; field: string | null; code: string; message: string }[];
    duplicateCandidates: { rowNumber: number; personIds: string[]; reason: string }[];
  } {
    const errors: { rowNumber: number; field: string | null; code: string; message: string }[] = [];
    const duplicateCandidates: { rowNumber: number; personIds: string[]; reason: string }[] = [];
    let validCount = 0;
    const fieldColumns = (field: ImportField): string[] => (
      Object.entries(mapping)
        .filter(([, mapped]) => mapped === field)
        .map(([column]) => column)
    );
    for (const row of rows) {
      let rowValid = true;
      const name = fieldColumns('person_name')
        .map((column) => row.values[column] ?? '')
        .find((value) => value.length > 0);
      if (name === undefined) {
        errors.push({
          rowNumber: row.rowNumber, field: 'person_name', code: 'MISSING_NAME',
          message: 'Every row needs a person name.',
        });
        rowValid = false;
      }
      for (const column of fieldColumns('phone')) {
        const value = row.values[column] ?? '';
        if (value.length === 0) continue;
        try {
          const normalized = normalizePhone(value);
          const matches = this.services.identities.findPeopleByNormalizedHandle('phone', normalized);
          if (matches.length > 0) {
            duplicateCandidates.push({
              rowNumber: row.rowNumber,
              personIds: matches.map((person) => person.id),
              reason: 'An existing person already uses this phone number.',
            });
          }
        } catch {
          errors.push({
            rowNumber: row.rowNumber, field: 'phone', code: 'INVALID_PHONE',
            message: 'The phone number is not a valid US or E.164 number.',
          });
          rowValid = false;
        }
      }
      for (const column of fieldColumns('email')) {
        const value = row.values[column] ?? '';
        if (value.length === 0) continue;
        try {
          const normalized = normalizeEmail(value);
          const matches = this.services.identities.findPeopleByNormalizedHandle('email', normalized);
          if (matches.length > 0) {
            duplicateCandidates.push({
              rowNumber: row.rowNumber,
              personIds: matches.map((person) => person.id),
              reason: 'An existing person already uses this email.',
            });
          }
        } catch {
          errors.push({
            rowNumber: row.rowNumber, field: 'email', code: 'INVALID_EMAIL',
            message: 'The email address is invalid.',
          });
          rowValid = false;
        }
      }
      for (const column of fieldColumns('segment')) {
        const value = row.values[column] ?? '';
        if (value.length > 0 && !['hot', 'cold', 'warm'].includes(value)) {
          errors.push({
            rowNumber: row.rowNumber, field: 'segment', code: 'INVALID_SEGMENT',
            message: 'Segment must be hot, cold, or warm.',
          });
          rowValid = false;
        }
      }
      if (rowValid) validCount += 1;
    }
    return { validCount, errors, duplicateCandidates };
  }

  private toIntakeCommand(input: {
    row: Record<string, string>;
    mapping: ImportMapping;
    channel: ImportCommitRequest['source']['channel'];
    referredByPersonId: string | null;
    observedAt: string;
    sourceName: string;
    contentHash: string;
    rowNumber: number;
  }): CreatePersonProspectCommand {
    const values = (field: ImportField): string[] => (
      Object.entries(input.mapping)
        .filter(([, mapped]) => mapped === field)
        .map(([column]) => input.row[column] ?? '')
        .filter((value) => value.length > 0)
    );
    const displayName = values('person_name')[0]!;
    const contacts: IntakeContactInput[] = [
      ...values('phone').map((value, index): IntakeContactInput => ({
        kind: 'phone', value, reachability: 'direct', isPrimary: index === 0,
      })),
      ...values('email').map((value, index): IntakeContactInput => ({
        kind: 'email', value, reachability: 'direct', isPrimary: index === 0,
      })),
    ];
    const organizations = values('organization').map((canonicalName) => ({ canonicalName }));
    const segmentValue = values('segment')[0];
    const segment = segmentValue === 'hot' || segmentValue === 'cold' || segmentValue === 'warm'
      ? segmentValue
      : 'warm';
    const base = {
      person: { displayName },
      contacts,
      organizations,
      properties: [] as never[],
    };
    const sourceCommon = {
      id: this.ids.next(),
      observedAt: input.observedAt,
      sourceRecord: {
        formatVersion: 1,
        importSourceName: input.sourceName,
        contentHash: input.contentHash,
        rowNumber: input.rowNumber,
      },
    };
    if (input.channel === 'custom') {
      return {
        ...base,
        source: { ...sourceCommon, channel: 'custom', customSourceReason: 'csv_import' },
        segment,
      };
    }
    if (input.channel === 'referral') {
      return {
        ...base,
        source: {
          ...sourceCommon,
          channel: 'referral',
          referral: input.referredByPersonId === null
            ? { kind: 'unknown' as const, reason: 'legacy_import' as const }
            : { kind: 'known' as const, referredByPersonId: input.referredByPersonId },
        },
      };
    }
    return {
      ...base,
      source: { ...sourceCommon, channel: input.channel },
    };
  }

  scanDiscoveryPage(input: { afterProspectId: string | null; limit: number }) { return this.discoveryWorkerCommands.scanDiscoveryPage(input); }
  enqueueDiscoveryPage(page: DiscoveryScanPage) { return this.discoveryWorkerCommands.enqueueDiscoveryPage(page); }
  scanAndEnqueueDiscoveryPage() { return this.discoveryWorkerCommands.scanAndEnqueueDiscoveryPage(); }
  discoveryWorkDelay() { return this.discoveryWorkerCommands.discoveryWorkDelay(); }
  processNextDiscoveryJob() { return this.discoveryWorkerCommands.processNextDiscoveryJob(); }
  processDiscoveryJob(jobId: string) { return this.discoveryWorkerCommands.processDiscoveryJob(jobId); }
  processPriorityRefreshJob(jobId: string) { return this.discoveryWorkerCommands.processPriorityRefreshJob(jobId); }

  prepareDiscoveryResearch() { return this.discoveryWorkerCommands.prepareDiscoveryResearch(); }
  completeDiscoveryResearch(request: DiscoveryResearchRequest, claims: readonly DiscoveryClaim[]) { return this.discoveryWorkerCommands.completeDiscoveryResearch(request, claims); }
  failDiscoveryResearch(request: DiscoveryResearchRequest, code: 'invalid_research' | 'research_timeout' | 'research_failed') { return this.discoveryWorkerCommands.failDiscoveryResearch(request, code); }

  getDiscovery() { return this.services.discovery.get(); }
  getDiscoveryBrief(personId: string) { return this.services.discovery.getBrief(personId); }
  beginDiscovery(input: BeginDiscoveryRequest) { return this.services.discovery.begin(input); }
  overrideDiscovery(input: OverrideDiscoveryRequest) { return this.services.discovery.override(input); }
  assessDiscoveryProspect(prospectId: string) { return this.services.discovery.assess(prospectId); }

  /**
   * Everything the enrichment request writer needs for one person: the
   * cloud entity link, the situs address of the first linked property that
   * satisfies the vendor schema (line1 + locality + 2-letter region), the
   * owner name, per-entity rate-limit timestamp, and persisted eligibility.
   */
  getEnrichmentRequestCandidate(input: { personId: string }): EnrichmentCandidate {
    if (this.database.raw.inTransaction) return this.readEnrichmentRequestCandidate(input);
    this.database.raw.exec('BEGIN');
    try { return this.readEnrichmentRequestCandidate(input); }
    finally { this.database.raw.exec('ROLLBACK'); }
  }

  private readEnrichmentRequestCandidate(input: { personId: string }): EnrichmentCandidate {
    const parsed = z.object({ personId: z.string().min(1) }).strict().parse(input);
    const person = this.database.raw.prepare(
      'SELECT id, display_name, deleted_at, opted_out, provenance_json FROM persons WHERE id = ?',
    ).get(parsed.personId) as {
      id: string; display_name: string; deleted_at: string | null; opted_out: 0 | 1;
      provenance_json: string | null;
    } | undefined;
    if (person === undefined) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The person does not exist.');
    }
    const link = this.database.raw.prepare(
      'SELECT cloud_entity_id FROM cloud_entity_links WHERE person_id = ?',
    ).get(person.id) as { cloud_entity_id: string } | undefined;
    // A person has one persisted prospect. Do not infer qualification from stage.
    const prospect = this.database.raw.prepare(`
      SELECT id, qualification_state FROM prospects WHERE person_id = ?
    `).get(person.id) as {
      id: string; qualification_state: EnrichmentCandidate['qualificationState'];
    } | undefined;
    const properties = this.database.raw.prepare(`
      SELECT property.address_line_1, property.locality, property.region,
        property.postal_code
      FROM prospect_properties AS link
      JOIN properties AS property ON property.id = link.property_id
      JOIN prospects AS prospect ON prospect.id = link.prospect_id
      JOIN sales_cycles AS cycle ON cycle.prospect_id = prospect.id
      WHERE cycle.person_id = ?
      ORDER BY property.id ASC
    `).all(person.id) as {
      address_line_1: string; locality: string; region: string;
      postal_code: string | null;
    }[];
    const situs = properties.find((property) => (
      property.address_line_1.trim().length > 0
      && property.locality.trim().length > 0
      && property.region.trim().length === 2
    ));
    const lastRequested = link === undefined ? undefined
      : this.database.raw.prepare(
        'SELECT last_requested_at FROM sourcing_enrichment_requests WHERE cloud_entity_id = ?',
      ).get(link.cloud_entity_id) as { last_requested_at: string } | undefined;
    const usableContact = this.database.raw.prepare(`
      SELECT id FROM person_contact_methods WHERE person_id = ?
        AND ownership_state = 'verified_person' AND validation_state = 'valid'
        AND reachability != 'none' LIMIT 1
    `).get(person.id);
    let suppressionBlocked = true;
    try {
      suppressionBlocked = person.opted_out !== 0
        || this.services.outboundPermission.inspectPerson(person.id).kind !== 'allowed';
    } catch {
      // Unresolved membership is not permission. Do not duplicate opt-out policy.
    }
    let identitySupported = false;
    try {
      const provenance = z.object({ needsIdentity: z.boolean().optional() }).passthrough().nullable()
        .parse(person.provenance_json === null ? null : JSON.parse(person.provenance_json));
      if (prospect !== undefined && provenance?.needsIdentity !== true
        && !/^unknown owner\b/i.test(person.display_name.trim())) {
        const evidence = collectDiscoveryEvidence({ database: this.database, services: this.services,
          prospectId: prospect.id, asOf: this.clock.now() });
        identitySupported = evidence.identitySupported && !evidence.unresolvedIdentity && evidence.conflicts.length === 0;
      }
    } catch {
      // Unverifiable or malformed ownership is never paid-enrichment authority.
    }
    return {
      cloudEntityId: link === undefined ? null : link.cloud_entity_id,
      ownerFullName: person.display_name,
      situsAddress: situs === undefined ? null : {
        line1: situs.address_line_1.trim(),
        locality: situs.locality.trim(),
        region: situs.region.trim(),
        postalCode: situs.postal_code === null || situs.postal_code.trim().length === 0
          ? null
          : situs.postal_code.trim(),
      },
      lastRequestedAt: lastRequested === undefined ? null : lastRequested.last_requested_at,
      qualificationState: prospect?.qualification_state ?? 'unreviewed',
      fitBand: prospect === undefined ? null : this.readProjection(prospect.id)?.fit_band ?? null,
      identityReady: identitySupported && person.deleted_at === null && person.display_name.trim().length > 0
        && prospect !== undefined && prospect.qualification_state !== 'merge_review',
      hasUsableDirectContact: usableContact !== undefined,
      suppressionBlocked,
    };
  }

  /** Upserts the per-entity rate-limit timestamp after a successful upload. */
  recordEnrichmentRequested(input: { cloudEntityId: string }): void {
    const parsed = z.object({ cloudEntityId: z.string().min(1) }).strict().parse(input);
    const now = this.clock.now();
    this.services.unitOfWork.immediate(() => {
      this.database.raw.prepare(`
        INSERT INTO sourcing_enrichment_requests (cloud_entity_id, last_requested_at)
        VALUES (?, ?)
        ON CONFLICT (cloud_entity_id) DO UPDATE SET last_requested_at = excluded.last_requested_at
      `).run(parsed.cloudEntityId, now);
    });
  }

  // -------------------------------------------------------------- support

  private requireCycle(salesCycleId: string): CycleRow {
    const cycle = this.database.raw.prepare(`
      SELECT id, person_id, prospect_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, close_reason, version
      FROM sales_cycles WHERE id = ?
    `).get(salesCycleId) as CycleRow | undefined;
    if (cycle === undefined) {
      throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The sales cycle does not exist.');
    }
    return cycle;
  }

  private readAction(actionId: string): ActionRow | undefined {
    return this.database.raw.prepare(`
      SELECT id, due_at, sales_cycle_id, action_type, channel, status, version,
        work_intent, cadence_enrollment_id, cadence_step_id, cadence_component_id
      FROM next_actions WHERE id = ?
    `).get(actionId) as ActionRow | undefined;
  }

  private readProjection(prospectId: string): ProjectionRow | undefined {
    return this.database.raw.prepare(`
      SELECT prospect_id, fit_points, fit_band, timing_millipoints, timing_band,
        reachability, data_confidence, priority, version, evaluation_id
      FROM prospect_priority_projection WHERE prospect_id = ?
    `).get(prospectId) as ProjectionRow | undefined;
  }

  /**
   * Monotonically increasing per-connection revision derived from SQLite's
   * total change counter. Every committed mutation advances it.
   */
  private currentRevision(): number {
    return (this.database.raw.prepare(
      'SELECT total_changes() AS count',
    ).get() as { count: number }).count;
  }

  private receipt(personIds: string[], cycleIds: string[]): MutationReceipt {
    return mutationReceiptSchema.parse({
      revision: this.currentRevision(),
      affectedPersonIds: personIds,
      affectedSalesCycleIds: cycleIds,
    });
  }
}

export function createFounderSalesDomain(input: {
  services: DomainServices;
  database: AppDatabase;
  clock: Clock;
  ids: IdGenerator;
  timezone?: string;
}): FounderSalesDomain {
  return new FounderSalesDomain(input);
}
