import { createHash } from 'node:crypto';

import Papa from 'papaparse';
import { z } from 'zod';

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
  leadsListRequestSchema,
  leadsListResponseSchema,
  type LeadBulkUpdateRequest,
  type LeadFieldUpdateRequest,
  type LeadRow,
  type LeadsListRequest,
  type LeadsListResponse,
} from '../../shared/contracts/leadsContract';
import {
  beginOutboundRequestSchema,
  confirmTransitionRequestSchema,
  leadDetailRequestSchema,
  leadDetailSchema,
  type BeginOutboundRequest,
  type ConfirmTransitionRequest,
  type LeadDetail,
  type LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';
import {
  completeActionRequestSchema,
  logPastActivityRequestSchema,
  pinActionRequestSchema,
  snoozeActionRequestSchema,
  todaySnapshotSchema,
  type CompleteActionRequest,
  type LogPastActivityRequest,
  type PinActionRequest,
  type SnoozeActionRequest,
  type TodayItem as TodayItemDto,
  type TodayLaneId,
  type TodaySnapshot,
} from '../../shared/contracts/todayContract';
import {
  pipelineSnapshotSchema,
  type PipelineSnapshot,
} from '../../shared/contracts/pipelineContract';
import {
  resolveReviewRequestSchema,
  reviewListRequestSchema,
  reviewSnapshotSchema,
  type ResolveReviewRequest,
  type ReviewItem,
  type ReviewListRequest,
  type ReviewSnapshot,
} from '../../shared/contracts/reviewContract';
import type {
  AttachTranscriptRequest,
  ConversationDetail,
  ConversationDetailRequest,
  ConversationsListRequest,
  ConversationsListResponse,
} from '../../shared/contracts/conversationsContract';
import type {
  AddEvidenceRequest,
  CaptureLearningRequest,
  LearningsListRequest,
  LearningsListResponse,
  UpdateLearningStatusRequest,
} from '../../shared/contracts/learningsContract';
import {
  attachTranscript,
  getConversationDetail,
  listConversations,
} from './conversations/conversationsDomain';
import {
  addLearningEvidence,
  captureLearning,
  listLearnings,
  updateLearningStatus,
} from './learnings/learningsDomain';
import {
  cancelJobRequestSchema,
  createJobRequestSchema,
  fillJobRequestSchema,
  fridayReportSchema,
  metricDrilldownRequestSchema,
  metricDrilldownSchema,
  type CancelJobRequest,
  type CreateJobRequest,
  type FillJobRequest,
  type FridayReport,
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
import { FOUNDER_CHANNEL_POLICIES_V1 } from './cadence/cadenceScheduler';
import type { DomainServices } from './createDomainServices';
import type {
  CreatePersonProspectCommand,
  IntakeContactInput,
  IntakeResult,
} from './source/sourceService';
import { normalizeEmail, normalizePhone } from './source/sourceService';
import type { Clock } from './support/clock';
import type { IdGenerator } from './support/idGenerator';
import type { TodayItem, TodayLane } from './today/todayTypes';

export const FOUNDER_JOB_REQUEST_TYPE = 'founder_job_request_v1' as const;
export const LEAD_IMPORT_JOB_TYPE = 'lead_import_v1' as const;
const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;

export type FounderSalesDomainErrorCode =
  | 'LEAD_NOT_FOUND'
  | 'CYCLE_NOT_FOUND'
  | 'CONTACT_METHOD_NOT_FOUND'
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
  sales_cycle_id: string;
  action_type: string;
  channel: string | null;
  status: string;
  due_at: string;
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
  preview: ImportPreview;
  columns: string[];
  rows: { rowNumber: number; values: Record<string, string> }[];
  sourceName: string;
};

const LANE_MAP: Readonly<Record<TodayLane, TodayLaneId>> = Object.freeze({
  won_onboarding: 'onboarding',
  inbound_interrupt: 'fresh_inbound',
  overdue: 'overdue',
  post_interview_offer: 'post_interview_offer',
  due_primary: 'due_cadence',
  new_p0: 'new_p0',
  p1: 'p1',
  exploration: 'exploration',
  later: 'later',
});

const PIPELINE_STAGE_ORDER = [
  'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
] as const;

const FALLBACK_PRIORITY_CONTEXT: LeadPriorityContext = Object.freeze({
  priority: 'P3',
  fitPoints: 0,
  fitBand: 'low',
  timingValue: 0,
  timingBand: 'cold',
  reachability: 'none',
  dataConfidence: 0,
});

function toPriorityContext(row: ProjectionRow | undefined): LeadPriorityContext {
  if (row === undefined) return FALLBACK_PRIORITY_CONTEXT;
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
export class FounderSalesDomain {
  private readonly services: DomainServices;
  private readonly database: AppDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly configuredTimezone: string | undefined;
  private readonly importPreviews = new Map<string, StoredImportPreview>();

  constructor(input: {
    services: DomainServices;
    database: AppDatabase;
    clock: Clock;
    ids: IdGenerator;
    timezone?: string;
  }) {
    this.services = input.services;
    this.database = input.database;
    this.clock = input.clock;
    this.ids = input.ids;
    this.configuredTimezone = input.timezone;
  }

  // ---------------------------------------------------------------- leads

  listLeadRows(input: LeadsListRequest): LeadsListResponse {
    const request = leadsListRequestSchema.parse(input);
    const now = this.clock.now();
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
      `cycle.current_next_action_id IS NOT NULL`,
      `action.status = 'pending'`,
      ...filters,
    ].join(' AND ');
    const orderBy = {
      priority: `CASE WHEN projection.priority IS NULL THEN 1 ELSE 0 END,
        projection.priority ASC, cycle.id ASC`,
      due_at: 'action.due_at ASC, cycle.id ASC',
      person_name: 'person.display_name ASC, cycle.id ASC',
      last_contact: `CASE WHEN prospect.last_contact_at IS NULL THEN 1 ELSE 0 END,
        prospect.last_contact_at DESC, cycle.id ASC`,
    }[request.sort];
    const baseSql = `
      FROM sales_cycles AS cycle
      JOIN persons AS person ON person.id = cycle.person_id
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
      JOIN next_actions AS action ON action.id = cycle.current_next_action_id
      LEFT JOIN prospect_priority_projection AS projection
        ON projection.prospect_id = cycle.prospect_id
      LEFT JOIN source_events AS source ON source.id = prospect.original_source_event_id
      WHERE ${where}
    `;
    const total = (this.database.raw.prepare(
      `SELECT COUNT(*) AS count ${baseSql}`,
    ).get(...parameters) as { count: number }).count;
    const offset = request.cursor === null ? 0 : Number.parseInt(request.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FounderSalesDomainError('IMPORT_PREVIEW_INVALID', 'The list cursor is invalid.');
    }
    const rows = this.database.raw.prepare(`
      SELECT
        cycle.id AS cycle_id, cycle.person_id, cycle.prospect_id, cycle.stage,
        person.display_name, person.opted_out,
        prospect.segment,
        source.channel AS source_channel,
        action.id AS action_id, action.action_type, action.channel AS action_channel,
        action.due_at, action.work_intent,
        projection.fit_points, projection.fit_band, projection.timing_millipoints,
        projection.timing_band, projection.reachability, projection.data_confidence,
        projection.priority,
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
        ) AS last_activity_at
      ${baseSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...parameters, request.limit, offset) as Array<{
      cycle_id: string; person_id: string; prospect_id: string; stage: LeadRow['stage'];
      display_name: string; opted_out: 0 | 1; segment: LeadRow['segment'];
      source_channel: LeadRow['source'] | null;
      action_id: string; action_type: string; action_channel: string | null;
      due_at: string; work_intent: string;
      fit_points: number | null; fit_band: ProjectionRow['fit_band'] | null;
      timing_millipoints: number | null; timing_band: ProjectionRow['timing_band'] | null;
      reachability: ProjectionRow['reachability'] | null; data_confidence: number | null;
      priority: ProjectionRow['priority'] | null;
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
        ? FALLBACK_PRIORITY_CONTEXT
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
      nextAction: {
        id: row.action_id,
        type: row.action_type,
        channel: actionChannel({
          actionType: row.action_type,
          channel: row.action_channel,
          workIntent: row.work_intent,
          onboarding: false,
        }),
        dueAt: row.due_at,
        label: actionLabel(row.action_type),
        overdue: row.due_at < now,
      },
      optedOut: row.opted_out === 1,
      lastActivityAt: row.last_activity_at,
    }));
    const nextOffset = offset + leadRows.length;
    return leadsListResponseSchema.parse({
      rows: leadRows,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      total,
      revision: this.currentRevision(),
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
      const linked = this.database.raw.prepare(`
        SELECT org.id AS id FROM prospect_organizations AS link
        JOIN organizations AS org ON org.id = link.organization_id
        WHERE link.prospect_id = ? ORDER BY org.id ASC LIMIT 1
      `).get(prospect.id) as { id: string } | undefined;
      if (request.value === null) {
        if (linked !== undefined) {
          this.database.raw.prepare(
            'DELETE FROM prospect_organizations WHERE prospect_id = ? AND organization_id = ?',
          ).run(prospect.id, linked.id);
        }
      } else if (linked !== undefined) {
        this.database.raw.prepare(
          'UPDATE organizations SET canonical_name = ?, updated_at = ? WHERE id = ?',
        ).run(request.value, now, linked.id);
      } else {
        const organization = this.services.identities.createOrganization({
          canonicalName: request.value,
        });
        this.services.identities.linkOrganization({
          prospectId: prospect.id, organizationId: organization.id,
        });
      }
    }
    const cycles = this.database.raw.prepare(
      'SELECT id FROM sales_cycles WHERE person_id = ? ORDER BY id ASC',
    ).all(person.id) as { id: string }[];
    return this.receipt([person.id], cycles.map(({ id }) => id));
  }

  getLeadDetail(input: LeadDetailRequest): LeadDetail {
    const request = leadDetailRequestSchema.parse(input);
    const now = this.clock.now();
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
    const prospect = this.database.raw.prepare(
      'SELECT id, segment, original_source_event_id FROM prospects WHERE id = ?',
    ).get(cycle.prospect_id) as {
      id: string; segment: LeadRow['segment']; original_source_event_id: string;
    } | undefined;
    if (prospect === undefined) {
      throw new FounderSalesDomainError('LEAD_NOT_FOUND', 'The prospect does not exist.');
    }
    const sourceChannel = (this.database.raw.prepare(
      'SELECT channel FROM source_events WHERE id = ?',
    ).get(prospect.original_source_event_id) as { channel: string } | undefined)?.channel ?? 'custom';
    const contacts = this.database.raw.prepare(`
      SELECT id, kind, normalized_value, validation_state
      FROM person_contact_methods WHERE person_id = ?
      ORDER BY kind ASC, normalized_value ASC, id ASC
    `).all(person.id) as {
      id: string; kind: 'phone' | 'email'; normalized_value: string; validation_state: string;
    }[];
    const contactDto = (row: typeof contacts[number]) => ({
      id: row.id, kind: row.kind, value: row.normalized_value,
      label: null as string | null, valid: row.validation_state === 'valid',
    });
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
      SELECT id, kind, occurred_at, observed_outcome, duration_seconds,
        recording_storage_ref, transcript_storage_ref, metadata_json
      FROM activities WHERE person_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 200
    `).all(person.id) as {
      id: string; kind: string; occurred_at: string; observed_outcome: string | null;
      duration_seconds: number | null; recording_storage_ref: string | null;
      transcript_storage_ref: string | null; metadata_json: string;
    }[];
    const history = this.database.raw.prepare(`
      SELECT id, to_stage, effective_at, confirmation_kind
      FROM stage_events WHERE sales_cycle_id = ?
      ORDER BY transition_sequence ASC
    `).all(cycle.id) as {
      id: string; to_stage: string; effective_at: string; confirmation_kind: string;
    }[];
    const priorityContext = toPriorityContext(projection);
    return leadDetailSchema.parse({
      personId: person.id,
      salesCycleId: cycle.id,
      personName: person.display_name,
      phones: contacts.filter((row) => row.kind === 'phone').map(contactDto),
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
      priorityReasons: projection === undefined ? [] : [
        `Fit ${priorityContext.fitBand} ${priorityContext.fitPoints}/30`,
        `Timing ${priorityContext.timingBand} ${priorityContext.timingValue}/40`,
        `Reachability ${priorityContext.reachability}`,
      ],
      nextAction: action === undefined || action.status !== 'pending' ? null : {
        id: action.id,
        type: action.action_type,
        channel: actionChannel({
          actionType: action.action_type,
          channel: action.channel,
          workIntent: action.work_intent,
          onboarding: cycle.workflow_status === 'onboarding',
        }),
        dueAt: action.due_at,
        label: actionLabel(action.action_type),
        overdue: action.due_at < now,
      },
      optedOut: person.opted_out === 1,
      cadence: cadence === null || action?.cadence_step_id == null ? null : {
        name: cadence.name,
        stepLabel: cadence.label,
        touchIndex: cadence.sequence + 1,
        touchLimit: cadence.attempt_cap,
      },
      activities: activities.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        occurredAt: activity.occurred_at,
        summary: jsonSummary(activity.metadata_json)
          ?? `${actionLabel(activity.kind)}${activity.observed_outcome === null ? '' : ` · ${activity.observed_outcome}`}`,
        outcome: activity.observed_outcome,
      })),
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

  beginOutbound(input: BeginOutboundRequest): MutationReceipt {
    const request = beginOutboundRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.person_id !== request.personId) {
        throw new FounderSalesDomainError('CYCLE_NOT_FOUND', 'The cycle belongs to another person.');
      }
      const contact = this.database.raw.prepare(`
        SELECT id, kind, normalized_value FROM person_contact_methods
        WHERE id = ? AND person_id = ?
      `).get(request.contactMethodId, request.personId) as {
        id: string; kind: 'phone' | 'email'; normalized_value: string;
      } | undefined;
      if (contact === undefined) {
        throw new FounderSalesDomainError(
          'CONTACT_METHOD_NOT_FOUND', 'The contact method does not belong to this person.',
        );
      }
      this.services.outboundPermission.assertMayExecuteOutbound({
        personId: request.personId,
        target: { kind: contact.kind, normalizedValue: contact.normalized_value },
      });
      this.services.events.appendActivity({
        id: this.ids.next(),
        personId: request.personId,
        prospectId: cycle.prospect_id,
        salesCycleId: cycle.id,
        kind: request.channel === 'call' ? 'call' : request.channel,
        direction: 'outbound',
        channel: request.channel === 'call' ? 'phone' : request.channel,
        occurredAt: now,
        observedOutcome: null,
        metadata: { formatVersion: 1, beganVia: 'founder_workflow_ui' },
      });
      return this.receipt([request.personId], [cycle.id]);
    });
  }

  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt {
    const request = confirmTransitionRequestSchema.parse(input);
    const now = this.clock.now();
    return this.services.unitOfWork.immediate(() => {
      const writer = this.services.lifecycle.scopedWriter();
      const cycle = this.requireCycle(request.salesCycleId);
      if (cycle.current_next_action_id === null) {
        throw new FounderSalesDomainError('ACTION_NOT_SUPPORTED', 'The cycle has no current action.');
      }
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
          expectedCurrentActionId: cycle.current_next_action_id,
          expectedProspectVersion: prospect.version,
          effectiveAt: now,
        });
      } else {
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

  // ---------------------------------------------------------------- today

  getToday(): TodaySnapshot {
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
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const cycleIds = queue.lanes.flatMap(({ items }) => items.map((item) => item.cycleId));
    const context = new Map<string, {
      display_name: string; stage: LeadRow['stage']; organization_name: string | null;
    }>();
    for (const cycleId of cycleIds) {
      const row = this.database.raw.prepare(`
        SELECT person.display_name, cycle.stage,
          (
            SELECT canonical_name FROM prospect_organizations AS link
            JOIN organizations AS org ON org.id = link.organization_id
            WHERE link.prospect_id = cycle.prospect_id
            ORDER BY org.id ASC LIMIT 1
          ) AS organization_name
        FROM sales_cycles AS cycle
        JOIN persons AS person ON person.id = cycle.person_id
        WHERE cycle.id = ?
      `).get(cycleId) as {
        display_name: string; stage: LeadRow['stage']; organization_name: string | null;
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
          id: item.action.id,
          type: item.action.actionType,
          channel: actionChannel({
            actionType: item.action.actionType,
            channel: item.action.channel,
            workIntent: item.action.workIntent,
            onboarding: lane === 'onboarding',
          }),
          dueAt: item.action.dueAt,
          label: actionLabel(item.action.actionType),
          overdue: item.action.dueAt < queue.generatedAt,
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
      };
    };
    const lanes = queue.lanes.map(({ lane, items }) => ({
      id: LANE_MAP[lane],
      items: items
        .map((item) => toDto(item, LANE_MAP[lane]))
        .filter((item): item is TodayItemDto => item !== null),
    }));
    return todaySnapshotSchema.parse({
      lanes,
      dialBudget: capacity.dialBudget,
      scheduledDials: queue.dialCount,
      conversationTarget: capacity.conversationTarget,
      reviewErrorCount: queue.diagnostics.length,
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

  snoozePrimaryAction(input: SnoozeActionRequest): MutationReceipt {
    const request = snoozeActionRequestSchema.parse(input);
    return this.manualPriorityControl({
      salesCycleId: request.salesCycleId,
      comparedSalesCycleId: request.comparedSalesCycleId,
      reason: request.reason,
      expiresAt: request.expiresAt,
      kind: 'snooze',
    });
  }

  pinWithinLane(input: PinActionRequest): MutationReceipt {
    const request = pinActionRequestSchema.parse(input);
    return this.manualPriorityControl({
      salesCycleId: request.salesCycleId,
      comparedSalesCycleId: request.comparedSalesCycleId,
      reason: request.reason,
      expiresAt: request.expiresAt,
      kind: 'pin',
    });
  }

  private manualPriorityControl(input: {
    salesCycleId: string;
    comparedSalesCycleId: string;
    reason: string;
    expiresAt: string;
    kind: 'pin' | 'snooze';
  }): MutationReceipt {
    const now = this.clock.now();
    const cycle = this.requireCycle(input.salesCycleId);
    const compared = this.requireCycle(input.comparedSalesCycleId);
    const controlled = this.readProjection(cycle.prospect_id);
    const other = this.readProjection(compared.prospect_id);
    if (controlled === undefined || other === undefined) {
      throw new FounderSalesDomainError(
        'PRIORITY_PROJECTION_MISSING',
        'Both compared prospects need a current priority projection.',
      );
    }
    const controlledSide = {
      prospectId: cycle.prospect_id,
      evaluationId: controlled.evaluation_id,
      projectionVersion: controlled.version,
    };
    const otherSide = {
      prospectId: compared.prospect_id,
      evaluationId: other.evaluation_id,
      projectionVersion: other.version,
    };
    const command = {
      controlId: this.ids.next(),
      preferenceEventId: this.ids.next(),
      controlledProspectId: cycle.prospect_id,
      comparison: input.kind === 'pin'
        ? { winner: controlledSide, loser: otherSide }
        : { winner: otherSide, loser: controlledSide },
      reason: input.reason,
      asOf: now,
      expiresAt: input.expiresAt,
    };
    if (input.kind === 'pin') this.services.prioritization.pinProspect(command);
    else this.services.prioritization.snoozeProspect(command);
    return this.receipt([cycle.person_id], [cycle.id]);
  }

  logPastActivity(input: LogPastActivityRequest): MutationReceipt {
    const request = logPastActivityRequestSchema.parse(input);
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
        kind: request.kind,
        direction: request.direction,
        channel: request.kind === 'call' || request.kind === 'voicemail' ? 'phone' : request.kind,
        occurredAt: request.occurredAt,
        observedOutcome: request.outcome,
        metadata: { formatVersion: 1, summary: request.summary, loggedVia: 'founder_workflow_ui' },
      });
      return this.receipt([request.personId], cycleIds);
    });
  }

  // ------------------------------------------------------------- pipeline

  getPipelineProjection(): PipelineSnapshot {
    const now = this.clock.now();
    const rows = this.database.raw.prepare(`
      SELECT
        cycle.id AS cycle_id, cycle.person_id, cycle.prospect_id, cycle.stage,
        cycle.workflow_status, cycle.stage_entered_at, cycle.close_reason,
        person.display_name,
        action.id AS action_id, action.action_type, action.channel AS action_channel,
        action.due_at, action.status AS action_status, action.work_intent,
        projection.fit_points, projection.fit_band, projection.timing_millipoints,
        projection.timing_band, projection.reachability, projection.data_confidence,
        projection.priority,
        (
          SELECT canonical_name FROM prospect_organizations AS link
          JOIN organizations AS org ON org.id = link.organization_id
          WHERE link.prospect_id = cycle.prospect_id
          ORDER BY org.id ASC LIMIT 1
        ) AS organization_name
      FROM sales_cycles AS cycle
      JOIN persons AS person ON person.id = cycle.person_id
      LEFT JOIN next_actions AS action ON action.id = cycle.current_next_action_id
      LEFT JOIN prospect_priority_projection AS projection
        ON projection.prospect_id = cycle.prospect_id
      ORDER BY cycle.stage_entered_at ASC, cycle.id ASC
    `).all() as Array<{
      cycle_id: string; person_id: string; prospect_id: string; stage: LeadRow['stage'];
      workflow_status: 'active' | 'onboarding' | 'closed'; stage_entered_at: string;
      close_reason: string | null; display_name: string;
      action_id: string | null; action_type: string | null; action_channel: string | null;
      due_at: string | null; action_status: string | null; work_intent: string | null;
      fit_points: number | null; fit_band: ProjectionRow['fit_band'] | null;
      timing_millipoints: number | null; timing_band: ProjectionRow['timing_band'] | null;
      reachability: ProjectionRow['reachability'] | null; data_confidence: number | null;
      priority: ProjectionRow['priority'] | null;
      organization_name: string | null;
    }>;
    const byStage = new Map<string, typeof rows>(
      PIPELINE_STAGE_ORDER.map((stage) => [stage, [] as typeof rows]),
    );
    for (const row of rows) byStage.get(row.stage)?.push(row);
    return pipelineSnapshotSchema.parse({
      stages: PIPELINE_STAGE_ORDER.map((stage) => ({
        stage,
        cards: byStage.get(stage)!.map((row) => ({
          personId: row.person_id,
          salesCycleId: row.cycle_id,
          personName: row.display_name,
          contextLabel: row.organization_name,
          stage: row.stage,
          stageEnteredAt: row.stage_entered_at,
          priorityContext: row.priority === null
            ? FALLBACK_PRIORITY_CONTEXT
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
          nextAction: row.action_id === null || row.action_status !== 'pending' ? null : {
            id: row.action_id,
            type: row.action_type!,
            channel: actionChannel({
              actionType: row.action_type!,
              channel: row.action_channel,
              workIntent: row.work_intent,
              onboarding: row.workflow_status === 'onboarding',
            }),
            dueAt: row.due_at!,
            label: actionLabel(row.action_type!),
            overdue: row.due_at! < now,
          },
          lostReasonCode: row.stage === 'lost_nurture' ? row.close_reason : null,
        })),
      })),
      revision: this.currentRevision(),
    });
  }

  // --------------------------------------------------------------- review

  listReviewItems(input: ReviewListRequest): ReviewSnapshot {
    const request = reviewListRequestSchema.parse(input);
    const rows = this.database.raw.prepare(`
      SELECT id, person_id, reason, payload_json, created_at
      FROM lifecycle_review_items WHERE status = 'open'
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(request.limit) as {
      id: string; person_id: string; reason: string; payload_json: string; created_at: string;
    }[];
    const items: ReviewItem[] = [];
    for (const row of rows) {
      let payload: {
        blocker?: string;
        command?: { evidence?: { kind?: string; handleKind?: string; normalizedValue?: string } };
      };
      try {
        payload = JSON.parse(row.payload_json) as typeof payload;
      } catch {
        payload = {};
      }
      if (payload.blocker === 'unknown_inbound_handle'
        && payload.command?.evidence?.kind === 'unknown_handle') {
        items.push({
          kind: 'unmatched_communication',
          reviewId: row.id,
          channel: payload.command.evidence.handleKind === 'email' ? 'email' : 'text',
          handle: payload.command.evidence.normalizedValue ?? '',
          occurredAt: row.created_at,
          summary: row.reason,
        });
      } else {
        items.push({
          kind: 'system_error',
          reviewId: row.id,
          invariant: payload.blocker ?? 'reactivation_blocked',
          summary: row.reason,
          personId: row.person_id,
        });
      }
    }
    const filtered = request.kinds.length === 0
      ? items
      : items.filter((item) => (request.kinds as string[]).includes(item.kind));
    const totalOpenCount = (this.database.raw.prepare(
      `SELECT COUNT(*) AS count FROM lifecycle_review_items WHERE status = 'open'`,
    ).get() as { count: number }).count;
    return reviewSnapshotSchema.parse({
      items: filtered,
      totalOpenCount,
      revision: this.currentRevision(),
    });
  }

  resolveReviewItem(input: ResolveReviewRequest): MutationReceipt {
    const request = resolveReviewRequestSchema.parse(input);
    if (request.kind !== 'unmatched_communication' || request.action !== 'promote') {
      throw new FounderSalesDomainError(
        'REVIEW_RESOLUTION_UNSUPPORTED',
        'This review kind has no V1 resolution command yet.',
      );
    }
    if (request.sourceEventId === null) {
      throw new FounderSalesDomainError(
        'REVIEW_RESOLUTION_UNSUPPORTED', 'Promotion requires the matched source event.',
      );
    }
    const now = this.clock.now();
    const review = this.database.raw.prepare(`
      SELECT id, activation_key, version, person_id, payload_json
      FROM lifecycle_review_items WHERE id = ? AND status = 'open'
    `).get(request.reviewId) as {
      id: string; activation_key: string; version: number; person_id: string; payload_json: string;
    } | undefined;
    if (review === undefined) {
      throw new FounderSalesDomainError('REVIEW_NOT_FOUND', 'The review item is not open.');
    }
    const source = this.database.raw.prepare(
      'SELECT channel FROM source_events WHERE id = ?',
    ).get(request.sourceEventId) as { channel: string } | undefined;
    const allowed = ['inbound_demo', 'referral', 'rireig', 'community'] as const;
    if (source === undefined || !(allowed as readonly string[]).includes(source.channel)) {
      throw new FounderSalesDomainError(
        'REVIEW_RESOLUTION_UNSUPPORTED', 'The source event cannot promote this review.',
      );
    }
    const payload = JSON.parse(review.payload_json) as {
      command: { cadence: unknown };
    };
    const result = this.services.lifecycle.promoteUnknownInboundReview({
      reviewId: review.id,
      activationKey: review.activation_key,
      expectedReviewVersion: request.expectedVersion,
      sourceEventId: request.sourceEventId,
      channel: source.channel as typeof allowed[number],
      activatedAt: now,
      cadence: payload.command.cadence as never,
    });
    const cycleIds = result.kind === 'reactivated' ? [result.cycle.id] : [];
    return this.receipt([review.person_id], cycleIds);
  }

  // ------------------------------------------------------- conversations

  listConversations(input: ConversationsListRequest): ConversationsListResponse {
    return listConversations(this.featureDeps(), input);
  }

  getConversationDetail(input: ConversationDetailRequest): ConversationDetail {
    return getConversationDetail(this.featureDeps(), input);
  }

  attachTranscript(input: AttachTranscriptRequest): MutationReceipt {
    // attachTranscript opens its own immediate transaction; wrapping it in
    // unitOfWork.immediate would nest BEGIN IMMEDIATE and fail.
    return attachTranscript(this.featureDeps(), input);
  }

  // ----------------------------------------------------------- learnings

  listLearnings(input: LearningsListRequest): LearningsListResponse {
    return listLearnings(this.featureDeps(), input);
  }

  captureLearning(input: CaptureLearningRequest): MutationReceipt {
    return captureLearning(this.featureDeps(), input);
  }

  addLearningEvidence(input: AddEvidenceRequest): MutationReceipt {
    return addLearningEvidence(this.featureDeps(), input);
  }

  updateLearningStatus(input: UpdateLearningStatusRequest): MutationReceipt {
    return updateLearningStatus(this.featureDeps(), input);
  }

  private featureDeps(): { database: AppDatabase; clock: Clock; ids: IdGenerator } {
    return { database: this.database, clock: this.clock, ids: this.ids };
  }

  // -------------------------------------------------------------- friday

  getFridayReport(): FridayReport {
    const asOf = this.clock.now();
    const settings = this.services.workspaceSettings.read();
    const timezone = this.configuredTimezone ?? settings.timezone;
    const { periodStartsAt, periodEndsAt } = this.fridayWindow(asOf, timezone);

    const stageCount = (stage: string): number => (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM stage_events
      WHERE to_stage = ? AND effective_at >= ? AND effective_at < ?
    `).get(stage, periodStartsAt, periodEndsAt) as { count: number }).count;
    const interviews = stageCount('interviewed');
    const offers = stageCount('offered');
    const wins = stageCount('won');

    const founderJobs = this.listFounderJobs();
    const inWindow = (timestamp: string | null): boolean => (
      timestamp !== null && timestamp >= periodStartsAt && timestamp < periodEndsAt
    );
    const requestedJobs = founderJobs.filter(
      (job) => job.status !== 'cancelled' && inWindow(job.requestedAt),
    );
    const filledJobs = founderJobs.filter(
      (job) => job.status === 'filled' && inWindow(job.contractorAcceptedAt),
    );

    const mrrCents = (this.database.raw.prepare(`
      SELECT COALESCE(SUM(projected_mrr_cents), 0) AS total FROM won_terms
      WHERE effective_at >= ? AND effective_at < ?
    `).get(periodStartsAt, periodEndsAt) as { total: number }).total;
    const foundingCustomers = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM won_terms
      WHERE founding_customer = 1 AND effective_at >= ? AND effective_at < ?
    `).get(periodStartsAt, periodEndsAt) as { count: number }).count;
    const fitness = this.database.raw.prepare(`
      SELECT AVG(design_partner_fitness) AS average FROM sales_cycles
      WHERE design_partner_fitness IS NOT NULL
    `).get() as { average: number | null };
    const overdueActions = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions
      WHERE status = 'pending' AND due_at < ?
    `).get(asOf) as { count: number }).count;
    const invalidActionCycles = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles AS cycle
      WHERE cycle.workflow_status IN ('active', 'onboarding') AND (
        cycle.current_next_action_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM next_actions AS action
          WHERE action.id = cycle.current_next_action_id AND action.status = 'pending'
        )
      )
    `).get() as { count: number }).count;

    const count = (id: MetricId, label: string, value: number, drilldownCount = 0): Metric => ({
      id, label, displayValue: String(value), numericValue: value,
      target: null, priorDelta: null, numerator: null, denominator: null, drilldownCount,
    });
    const rate = (id: MetricId, label: string, numerator: number, denominator: number): Metric => ({
      id,
      label,
      displayValue: denominator === 0 ? '—' : `${Math.round((numerator / denominator) * 100)}%`,
      numericValue: denominator === 0 ? null : numerator / denominator,
      target: null,
      priorDelta: null,
      numerator,
      denominator,
      drilldownCount: 0,
    });
    const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const metrics: Metric[] = [
      count('interviews', 'Interviews', interviews, interviews),
      count('offers', 'Offers', offers, offers),
      count('wins', 'Wins', wins, wins),
      rate('offer_rate', 'Offer rate', offers, interviews),
      rate('win_rate', 'Win rate', wins, offers),
      count('jobs_requested', 'Jobs requested', requestedJobs.length),
      count('jobs_filled', 'Jobs filled', filledJobs.length),
      rate('fill_rate', 'Fill rate', filledJobs.length, requestedJobs.length),
      {
        id: 'new_mrr', label: 'New MRR', displayValue: usd.format(mrrCents / 100),
        numericValue: mrrCents / 100, target: null, priorDelta: null,
        numerator: null, denominator: null, drilldownCount: 0,
      },
      count('founding_customers', 'Founding customers', foundingCustomers),
      {
        id: 'design_partner_fitness', label: 'Design partner fitness',
        displayValue: fitness.average === null ? '—' : fitness.average.toFixed(1),
        numericValue: fitness.average, target: null, priorDelta: null,
        numerator: null, denominator: null, drilldownCount: 0,
      },
      count('overdue_actions', 'Overdue actions', overdueActions),
      count('invalid_action_cycles', 'Invalid action cycles', invalidActionCycles),
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

  private fridayWindow(asOf: string, timezone: string): {
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
    const monday = shift(localDate, -daysSinceMonday);
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
    const parsed = this.parseTabular(request);
    const suggestedMapping = this.suggestMapping(parsed.columns);
    const validation = this.validateImportRows(parsed.rows, suggestedMapping);
    const preview = importPreviewSchema.parse({
      previewId: this.ids.next(),
      contentHash: createHash('sha256').update(request.content, 'utf8').digest('hex'),
      columns: parsed.columns,
      sampleRows: parsed.rows.slice(0, 20).map((row) => ({
        rowNumber: row.rowNumber,
        cells: parsed.columns.map((column) => row.values[column] ?? ''),
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
      rows: parsed.rows,
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
      errors: validation.errors,
      duplicateCandidates: validation.duplicateCandidates,
    });
    this.importPreviews.set(request.previewId, { ...stored, preview });
    return preview;
  }

  commitLeadImport(input: ImportCommitRequest): ImportCommitReceipt {
    const request = importCommitRequestSchema.parse(input);
    const stored = this.requirePreview(request.previewId, request.contentHash);
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

  private parseTabular(request: ImportSource): {
    columns: string[];
    rows: { rowNumber: number; values: Record<string, string> }[];
    errors: { rowNumber: number; field: string | null; code: string; message: string }[];
  } {
    const content = request.kind === 'spreadsheet_paste'
      ? request.content
      : request.content;
    const parsed = Papa.parse<Record<string, string>>(content.replace(/^\uFEFF/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      delimiter: request.kind === 'spreadsheet_paste' ? '\t' : undefined,
    });
    const columns = (parsed.meta.fields ?? []).map((field) => field.trim());
    const errors: { rowNumber: number; field: string | null; code: string; message: string }[] = [];
    if (columns.length === 0 || columns.some((column) => column.length === 0)) {
      errors.push({
        rowNumber: 1, field: null, code: 'INVALID_HEADER',
        message: 'Headers must be present and non-blank.',
      });
    }
    if (new Set(columns).size !== columns.length) {
      errors.push({
        rowNumber: 1, field: null, code: 'DUPLICATE_HEADER',
        message: 'Headers must be unique.',
      });
    }
    for (const parseError of parsed.errors.slice(0, 20)) {
      errors.push({
        rowNumber: (parseError.row ?? 0) + 2,
        field: null,
        code: 'PARSE_ERROR',
        message: parseError.message.slice(0, 200),
      });
    }
    const rows = parsed.data.map((values, index) => ({
      rowNumber: index + 2,
      values: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key.trim(), (value ?? '').trim()]),
      ),
    }));
    return { columns, rows, errors };
  }

  private suggestMapping(columns: string[]): ImportMapping {
    const byHeader: Record<string, ImportField> = {
      name: 'person_name', person: 'person_name', owner: 'person_name',
      phone: 'phone', mobile: 'phone', email: 'email',
      company: 'organization', organization: 'organization', org: 'organization',
      address: 'property_address', property: 'property_address',
      doors: 'doors', units: 'doors', source: 'source', segment: 'segment', notes: 'notes',
    };
    const mapping: Record<string, ImportField> = {};
    let hasName = false;
    for (const column of columns) {
      const suggested = byHeader[column.toLowerCase()] ?? 'ignore';
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

  // ------------------------------------------------------------- sourcing

  /** Durable poller cursor; null until the first completed poll. */
  getSourcingCursor(): { lastKey: string | null; polledAt: string | null } {
    const row = this.database.raw.prepare(
      'SELECT last_key, polled_at FROM sourcing_cursor WHERE id = 1',
    ).get() as { last_key: string | null; polled_at: string } | undefined;
    return row === undefined
      ? { lastKey: null, polledAt: null }
      : { lastKey: row.last_key, polledAt: row.polled_at };
  }

  /** Advance the cursor after one inbox object has fully processed. */
  recordSourcingPoll(input: { lastKey: string | null }): void {
    const lastKey = z.string().min(1).nullable().parse(input.lastKey);
    const now = this.clock.now();
    this.services.unitOfWork.immediate(() => {
      this.database.raw.prepare(`
        INSERT INTO sourcing_cursor (id, last_key, polled_at)
        VALUES (1, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          last_key = excluded.last_key,
          polled_at = excluded.polled_at
      `).run(lastKey, now);
    });
  }

  /**
   * One person-bearing cloud event through the standard intake pipeline.
   * `source_intake_receipts` (keyed `cloud:<idempotency_key>`) makes replays
   * no-ops; the cloud-entity link and the unreviewed cycle are created only
   * on first import.
   */
  importCloudSourceEvent(input: {
    command: CreatePersonProspectCommand;
    cloudEntityId: string | null;
  }): IntakeResult {
    const result = this.services.sources.createPersonProspect(input.command);
    if (result.disposition === 'created') {
      // A replayed cloud event returns the stored receipt with its original
      // 'created' disposition; the cycle from the first import already exists.
      const cycleExists = this.database.raw.prepare(
        'SELECT 1 FROM sales_cycles WHERE entry_source_event_id = ?',
      ).get(result.sourceEventId) !== undefined;
      if (!cycleExists) {
        this.services.lifecycle.createUnreviewedCycle({
          personId: result.personId,
          prospectId: result.prospectId,
          entrySourceEventId: result.sourceEventId,
          effectiveAt: this.clock.now(),
        });
      }
    }
    if (input.cloudEntityId !== null) {
      this.services.unitOfWork.immediate(() => {
        this.database.raw.prepare(`
          INSERT INTO cloud_entity_links (cloud_entity_id, person_id, linked_at)
          VALUES (?, ?, ?)
          ON CONFLICT (cloud_entity_id) DO NOTHING
        `).run(input.cloudEntityId, result.personId, this.clock.now());
      });
    }
    return result;
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
      SELECT id, sales_cycle_id, action_type, channel, status, due_at, version,
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
