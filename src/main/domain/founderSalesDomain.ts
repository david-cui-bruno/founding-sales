import { createHash } from 'node:crypto';

import Papa from 'papaparse';
import { z } from 'zod';

import type { AppDatabase } from '../db/database';
import type {
  BeginOutboundRequest,
  ConfirmTransitionRequest,
  LeadDetail,
  LeadDetailRequest,
} from '../../shared/contracts/leadDetailContract';
import {
  leadDetailSchema,
} from '../../shared/contracts/leadDetailContract';
import type {
  LeadBulkUpdateRequest,
  LeadFieldUpdateRequest,
  LeadRow,
  LeadsListRequest,
  LeadsListResponse,
} from '../../shared/contracts/leadsContract';
import {
  leadsListResponseSchema,
} from '../../shared/contracts/leadsContract';
import type { MutationReceipt } from '../../shared/contracts/commonContract';
import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import type {
  CompleteActionRequest,
  LogPastActivityRequest,
  PinActionRequest,
  SnoozeActionRequest,
  TodayItem,
  TodaySnapshot,
} from '../../shared/contracts/todayContract';
import { todaySnapshotSchema } from '../../shared/contracts/todayContract';
import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';
import { pipelineSnapshotSchema } from '../../shared/contracts/pipelineContract';
import type {
  ResolveReviewRequest,
  ReviewItem,
  ReviewListRequest,
  ReviewSnapshot,
} from '../../shared/contracts/reviewContract';
import { reviewSnapshotSchema } from '../../shared/contracts/reviewContract';
import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  MetricDrilldown,
  MetricDrilldownRequest,
  MetricId,
} from '../../shared/contracts/fridayContract';
import {
  fridayReportSchema,
  metricDrilldownSchema,
} from '../../shared/contracts/fridayContract';
import type {
  ImportCommitReceipt,
  ImportCommitRequest,
  ImportMapping,
  ImportPreview,
  ImportRemapRequest,
  ImportSource,
  ImportStatus,
  ImportStatusRequest,
} from '../../shared/contracts/importContract';
import {
  importCommitReceiptSchema,
  importPreviewSchema,
  importSourceSchema,
  importStatusSchema,
} from '../../shared/contracts/importContract';
import { FOUNDER_CHANNEL_POLICIES_V1 } from './cadence/cadenceScheduler';
import type { DomainServices } from './createDomainServices';
import type { Clock } from './support/clock';
import type { IdGenerator } from './support/idGenerator';
import { DEFAULT_TODAY_CAPACITY } from './today/todayTypes';
import type { TodayQueue } from './today/todayTypes';
import type { CreatePersonProspectCommand, IntakeSourceInput } from './source/sourceService';

const FOUNDER_JOB_REQUEST_TYPE = 'founder_job_request_v1';
const IMPORT_JOB_TYPE = 'lead_import_v1';

type Row = Record<string, unknown>;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  const initials = parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('');
  return initials.length > 0 ? initials : name.slice(0, 1).toUpperCase();
}

function priorityUp(priority: string): 'P0' | 'P1' | 'P2' | 'P3' {
  return priority.toUpperCase() as 'P0' | 'P1' | 'P2' | 'P3';
}

function actionChannel(actionType: string, channel: string | null): 'call' | 'text' | 'email' | 'review' | 'onboarding' {
  if (channel === 'phone' || actionType === 'call') return 'call';
  if (channel === 'text' || actionType === 'text') return 'text';
  if (channel === 'email' || actionType === 'email') return 'email';
  if (actionType.includes('onboard')) return 'onboarding';
  return 'review';
}

/**
 * The UI-facing transactional/query facade over the encrypted domain graph.
 * Reads are strict SQL projections into renderer DTOs; commands delegate to
 * the transactional services and return a MutationReceipt.
 */
function summaryOfActivity(row: Row): string {
  if (typeof row.metadata_json === 'string' && row.metadata_json.length > 0) {
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (typeof metadata.summary === 'string' && metadata.summary.length > 0) {
        return metadata.summary;
      }
    } catch {
      // Fall through to the synthesized summary.
    }
  }
  return `${String(row.direction)} ${String(row.kind)} via ${String(row.channel)}`;
}

export class FounderSalesDomain {
  private readonly services: DomainServices;
  private readonly database: AppDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly timezone: string;

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
    this.timezone = input.timezone ?? this.services.workspaceSettings.read().timezone;
  }

  private revision(): number {
    const row = this.database.raw.pragma('data_version', { simple: true });
    return typeof row === 'number' && row >= 0 ? row : 0;
  }

  private receipt(personIds: string[], cycleIds: string[]): MutationReceipt {
    return mutationReceiptSchema.parse({
      revision: this.revision(),
      affectedPersonIds: [...new Set(personIds)].sort(),
      affectedSalesCycleIds: [...new Set(cycleIds)].sort(),
    });
  }

  private priorityContextFor(prospectId: string): LeadRow['priorityContext'] {
    const row = this.database.raw.prepare(`
      SELECT priority, fit_points, fit_band, timing_millipoints, timing_band,
             reachability, data_confidence
      FROM prospect_priority_projection WHERE prospect_id = ?
    `).get(prospectId) as Row | undefined;
    if (row === undefined) return null;
    return {
      priority: priorityUp(String(row.priority)),
      fitPoints: Number(row.fit_points),
      fitBand: String(row.fit_band) as 'low' | 'medium' | 'high',
      timingValue: Number(row.timing_millipoints) / 1_000,
      timingBand: String(row.timing_band) as 'cold' | 'warm' | 'hot',
      reachability: String(row.reachability) as 'direct' | 'indirect' | 'none',
      dataConfidence: Number(row.data_confidence),
    };
  }

  private nextActionFor(cycleId: string | null, currentActionId: string | null, asOf: string) {
    if (cycleId === null || currentActionId === null) return null;
    const row = this.database.raw.prepare(`
      SELECT id, action_type, channel, due_at, timezone FROM next_actions
      WHERE id = ? AND sales_cycle_id = ? AND status = 'pending'
    `).get(currentActionId, cycleId) as Row | undefined;
    if (row === undefined) return null;
    return {
      id: String(row.id),
      type: String(row.action_type),
      channel: actionChannel(String(row.action_type), row.channel === null ? null : String(row.channel)),
      dueAt: String(row.due_at),
      label: String(row.action_type).replace(/_/g, ' '),
      overdue: String(row.due_at) < asOf,
    };
  }

  listLeadRows(input: LeadsListRequest): LeadsListResponse {
    const asOf = this.clock.now();
    const rows = this.database.raw.prepare(`
      SELECT
        person.id AS person_id,
        person.display_name AS display_name,
        person.opted_out AS opted_out,
        prospect.id AS prospect_id,
        prospect.segment AS segment,
        source.channel AS channel,
        cycle.id AS cycle_id,
        cycle.stage AS stage,
        cycle.current_next_action_id AS current_action_id,
        (
          SELECT organization.canonical_name FROM prospect_organizations AS link
          JOIN organizations AS organization ON organization.id = link.organization_id
          WHERE link.prospect_id = prospect.id ORDER BY organization.canonical_name LIMIT 1
        ) AS organization,
        (
          SELECT property.address_line_1 FROM prospect_properties AS link
          JOIN properties AS property ON property.id = link.property_id
          WHERE link.prospect_id = prospect.id ORDER BY property.id LIMIT 1
        ) AS property_summary,
        (
          SELECT MAX(activity.occurred_at) FROM activities AS activity
          WHERE activity.person_id = person.id
        ) AS last_activity_at
      FROM prospects AS prospect
      JOIN persons AS person ON person.id = prospect.person_id
      JOIN source_events AS source ON source.id = prospect.original_source_event_id
      LEFT JOIN sales_cycles AS cycle
        ON cycle.person_id = person.id
        AND cycle.workflow_status IN ('active', 'onboarding')
      WHERE person.deleted_at IS NULL
      ORDER BY person.display_name COLLATE NOCASE, prospect.id COLLATE BINARY
    `).all() as Row[];

    const mapped: LeadRow[] = [];
    for (const row of rows) {
      const personName = String(row.display_name);
      if (input.query.length > 0
        && !personName.toLowerCase().includes(input.query.toLowerCase())) {
        continue;
      }
      const stage = row.stage === null ? 'unreviewed' : String(row.stage);
      if (input.stages.length > 0 && !input.stages.includes(stage as LeadRow['stage'])) continue;
      const priorityContext = this.priorityContextFor(String(row.prospect_id));
      if (input.priorities.length > 0
        && (priorityContext === null || !input.priorities.includes(priorityContext.priority))) {
        continue;
      }
      mapped.push({
        personId: String(row.person_id),
        salesCycleId: row.cycle_id === null ? String(row.prospect_id) : String(row.cycle_id),
        personName,
        initials: initialsOf(personName),
        organization: row.organization === null ? null : String(row.organization),
        propertySummary: row.property_summary === null ? null : String(row.property_summary),
        stage: stage as LeadRow['stage'],
        source: String(row.channel) as LeadRow['source'],
        segment: String(row.segment) as LeadRow['segment'],
        priorityContext,
        nextAction: this.nextActionFor(
          row.cycle_id === null ? null : String(row.cycle_id),
          row.current_action_id === null ? null : String(row.current_action_id),
          asOf,
        ),
        optedOut: Number(row.opted_out) === 1,
        lastActivityAt: row.last_activity_at === null ? null : String(row.last_activity_at),
      });
    }

    const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10) || 0;
    const page = mapped.slice(offset, offset + input.limit);
    const nextOffset = offset + input.limit;
    return leadsListResponseSchema.parse({
      rows: page,
      nextCursor: nextOffset < mapped.length ? String(nextOffset) : null,
      total: mapped.length,
      revision: this.revision(),
    });
  }

  updateLeadField(input: LeadFieldUpdateRequest): MutationReceipt {
    if (input.field === 'person_name') {
      this.services.unitOfWork.immediate(() => {
        const person = this.services.identities.getPerson(input.personId);
        if (person === null) throw new Error('The lead does not exist.');
        const result = this.database.raw.prepare(`
          UPDATE persons SET display_name = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(input.value, this.clock.now(), input.personId, person.version);
        if (result.changes === 0) throw new Error('The lead changed before this update.');
      });
      return this.receipt([input.personId], []);
    }
    // organization_label: create-or-link is a Task 11+ concern; store as alias label.
    this.services.unitOfWork.immediate(() => {
      const prospect = this.services.identities.getCanonicalProspect(input.personId);
      if (prospect === null) throw new Error('The lead does not exist.');
      if (input.value === null) return;
      const organization = this.services.identities.createOrganization({
        canonicalName: input.value,
      });
      this.services.identities.linkOrganization({
        prospectId: prospect.id,
        organizationId: organization.id,
        relationship: 'label',
      });
    });
    return this.receipt([input.personId], []);
  }

  bulkUpdateLeads(input: LeadBulkUpdateRequest): MutationReceipt {
    for (const personId of input.personIds) {
      if (input.field === 'person_name') {
        this.updateLeadField({ personId, field: 'person_name', value: input.value });
      } else {
        this.updateLeadField({ personId, field: 'organization_label', value: input.value ?? null });
      }
    }
    return this.receipt([...input.personIds], []);
  }

  getLeadDetail(input: LeadDetailRequest): LeadDetail {
    const asOf = this.clock.now();
    const person = this.services.identities.getPerson(input.personId);
    if (person === null) throw new Error('The lead does not exist.');
    const prospect = this.services.identities.getCanonicalProspect(input.personId);
    if (prospect === null) throw new Error('The lead has no canonical prospect.');
    const contacts = this.services.identities.listContactMethodsForPerson(input.personId);
    const cycleRow = this.database.raw.prepare(`
      SELECT id, stage, workflow_status, current_next_action_id
      FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active', 'onboarding')
    `).get(input.personId) as Row | undefined;
    const sourceRow = this.database.raw.prepare(`
      SELECT channel FROM source_events WHERE id = ?
    `).get(prospect.originalSourceEventId) as Row | undefined;
    const organizations = this.services.identities.listOrganizationsForProspect(prospect.id);
    const properties = this.services.identities.listPropertiesForProspect(prospect.id);
    const activityRows = this.database.raw.prepare(`
      SELECT id, kind, occurred_at, observed_outcome, channel, direction, metadata_json
      FROM activities WHERE person_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 50
    `).all(input.personId) as Row[];
    const stageEvents = cycleRow === undefined ? [] : this.database.raw.prepare(`
      SELECT id, from_stage, to_stage, effective_at FROM stage_events
      WHERE sales_cycle_id = ? ORDER BY transition_sequence
    `).all(String(cycleRow.id)) as Row[];
    const priorityReasons: string[] = [];
    const priorityContext = this.priorityContextFor(prospect.id);
    if (priorityContext !== null) {
      priorityReasons.push(
        `Fit ${priorityContext.fitBand} (${priorityContext.fitPoints}/30)`,
        `Timing ${priorityContext.timingBand} (${priorityContext.timingValue}/40)`,
        `Reachability ${priorityContext.reachability}`,
      );
    }
    return leadDetailSchema.parse({
      personId: person.id,
      salesCycleId: cycleRow === undefined ? null : String(cycleRow.id),
      personName: person.displayName,
      phones: contacts.filter((contact) => contact.kind === 'phone').map((contact) => ({
        id: contact.id,
        kind: 'phone' as const,
        value: contact.normalizedValue,
        label: contact.reachability === 'direct' ? 'Direct' : null,
        valid: contact.validationState === 'valid',
      })),
      emails: contacts.filter((contact) => contact.kind === 'email').map((contact) => ({
        id: contact.id,
        kind: 'email' as const,
        value: contact.normalizedValue,
        label: null as string | null,
        valid: contact.validationState === 'valid',
      })),
      organizationLabel: organizations[0]?.canonicalName ?? null,
      propertySummaries: properties.map((property) => property.addressLine1),
      stage: cycleRow === undefined ? null : String(cycleRow.stage) as LeadDetail['stage'],
      workflowStatus: cycleRow === undefined
        ? null
        : String(cycleRow.workflow_status) as LeadDetail['workflowStatus'],
      sourceLabel: sourceRow === undefined ? 'unknown' : String(sourceRow.channel),
      segment: prospect.segment,
      priorityContext,
      priorityReasons,
      nextAction: this.nextActionFor(
        cycleRow === undefined ? null : String(cycleRow.id),
        cycleRow === undefined || cycleRow.current_next_action_id === null
          ? null
          : String(cycleRow.current_next_action_id),
        asOf,
      ),
      optedOut: person.optedOut,
      cadence: null,
      activities: activityRows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind) as 'call',
        occurredAt: String(row.occurred_at),
        summary: summaryOfActivity(row),
        outcome: row.observed_outcome === null ? null : String(row.observed_outcome),
      })),
      conversations: [],
      properties: properties.map((property) => ({
        id: property.id,
        address: property.addressLine1,
        doors: property.doorCount,
        ownershipEvidence: null as string | null,
        liveVacancy: false,
      })),
      history: stageEvents.map((row) => ({
        id: String(row.id),
        occurredAt: String(row.effective_at),
        label: row.from_stage === null
          ? `Entered ${String(row.to_stage)}`
          : `${String(row.from_stage)} → ${String(row.to_stage)}`,
        detail: null as string | null,
      })),
      revision: this.revision(),
    });
  }

  beginOutbound(input: BeginOutboundRequest): MutationReceipt {
    this.services.unitOfWork.immediate(() => {
      const contact = this.services.identities
        .listContactMethodsForPerson(input.personId)
        .find((method) => method.id === input.contactMethodId);
      if (contact === undefined) {
        throw new Error('The outbound contact method does not exist for this person.');
      }
      this.services.outboundPermission.assertMayExecuteOutbound({
        personId: input.personId,
        target: { kind: contact.kind, normalizedValue: contact.normalizedValue },
      });
    });
    return this.receipt([input.personId], [input.salesCycleId]);
  }

  private cycleState(cycleId: string): {
    version: number;
    currentActionId: string;
    prospectVersion: number;
    personId: string;
  } {
    const row = this.database.raw.prepare(`
      SELECT cycle.version AS version, cycle.current_next_action_id AS action_id,
             cycle.person_id AS person_id, prospect.version AS prospect_version
      FROM sales_cycles AS cycle
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
      WHERE cycle.id = ?
    `).get(cycleId) as Row | undefined;
    if (row === undefined || row.action_id === null) {
      throw new Error('The sales cycle has no current action.');
    }
    return {
      version: Number(row.version),
      currentActionId: String(row.action_id),
      prospectVersion: Number(row.prospect_version),
      personId: String(row.person_id),
    };
  }

  confirmTransition(input: ConfirmTransitionRequest): MutationReceipt {
    const effectiveAt = this.clock.now();
    if (this.revision() < input.expectedRevision) {
      throw new Error('The workspace changed before this transition.');
    }
    const state = this.cycleState(input.salesCycleId);
    let cycle;
    if (input.transition === 'review_to_ready') {
      cycle = this.services.lifecycle.reviewToReady({
        cycleId: input.salesCycleId,
        expectedCycleVersion: state.version,
        expectedCurrentActionId: state.currentActionId,
        expectedProspectVersion: state.prospectVersion,
        effectiveAt,
      });
    } else if (input.transition === 'confirm_interviewed') {
      cycle = this.services.lifecycle.confirmInterviewed({
        cycleId: input.salesCycleId,
        expectedCycleVersion: state.version,
        expectedCurrentActionId: state.currentActionId,
        suggestionActivityId: input.suggestionActivityId,
        effectiveAt,
        confirmedAt: effectiveAt,
      });
    } else {
      cycle = this.services.lifecycle.confirmOffered({
        cycleId: input.salesCycleId,
        expectedCycleVersion: state.version,
        expectedCurrentActionId: state.currentActionId,
        suggestionActivityId: input.suggestionActivityId,
        effectiveAt,
        confirmedAt: effectiveAt,
      });
    }
    return this.receipt([cycle.personId], [cycle.id]);
  }

  getToday(): TodaySnapshot {
    const settings = this.services.workspaceSettings.read();
    const queue: TodayQueue = this.services.today.build({
      timezone: settings.timezone,
      capacity: {
        ...DEFAULT_TODAY_CAPACITY,
        dialBudget: settings.dailyDialCapacity,
        conversationTarget: settings.dailyConversationTarget,
        explorationSlots: settings.explorationSlots,
        resurfacingWindowSeconds: settings.resurfaceSuppressionDays * 86_400,
      },
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const laneMap: Record<string, TodayItem['lane']> = {
      won_onboarding: 'onboarding',
      inbound_interrupt: 'fresh_inbound',
      overdue: 'overdue',
      post_interview_offer: 'post_interview_offer',
      due_primary: 'due_cadence',
      new_p0: 'new_p0',
      p1: 'p1',
      exploration: 'exploration',
      later: 'later',
    };
    const personNames = new Map<string, string>();
    const nameOf = (personId: string): string => {
      const cached = personNames.get(personId);
      if (cached !== undefined) return cached;
      const person = this.services.identities.getPerson(personId);
      const name = person?.displayName ?? personId;
      personNames.set(personId, name);
      return name;
    };
    const lanes = queue.lanes.map((lane) => ({
      id: laneMap[lane.lane]!,
      items: lane.items.map((item) => ({
        id: `${item.cycleId}:${item.action.id}`,
        lane: laneMap[item.lane]!,
        personId: item.personId,
        salesCycleId: item.cycleId,
        personName: nameOf(item.personId),
        contextLabel: null as string | null,
        stage: 'ready' as const,
        priorityContext: item.priority === null ? null : {
          priority: priorityUp(item.priority.effectivePriority),
          fitPoints: item.priority.fitPoints,
          fitBand: item.priority.fitBand,
          timingValue: item.priority.timingMilliPoints / 1_000,
          timingBand: item.priority.timingBand,
          reachability: item.priority.reachability,
          dataConfidence: item.priority.dataConfidence,
        },
        action: {
          id: item.action.id,
          type: item.action.actionType,
          channel: actionChannel(item.action.actionType, item.action.channel),
          dueAt: item.action.dueAt,
          label: item.action.actionType.replace(/_/g, ' '),
          overdue: item.lane === 'overdue',
        },
        reason: item.laneReason.replace(/_/g, ' '),
        activeTriggers: item.selectedTriggerReasons
          .filter((reason) => reason.kind === 'trigger')
          .map((reason) => ({
            label: (reason as { triggerKey: string }).triggerKey.replace(/_/g, ' '),
            expiresAt: (reason as { recomputedExpiresAt: string | null }).recomputedExpiresAt,
          })),
        verifyFirst: item.verifyFirst === true,
        pinned: item.pinned,
        consentRequirement: null as string | null,
      })),
    }));
    return todaySnapshotSchema.parse({
      lanes,
      dialBudget: queue.capacity.dialBudget,
      scheduledDials: queue.queuedDiscretionaryDialCount,
      conversationTarget: queue.capacity.conversationTarget,
      reviewErrorCount: queue.diagnostics.length,
      revision: this.revision(),
    });
  }

  completePrimaryAction(input: CompleteActionRequest): MutationReceipt {
    const state = this.cycleState(input.salesCycleId);
    if (state.currentActionId !== input.actionId) {
      throw new Error('The current action changed before this completion.');
    }
    const actionRow = this.database.raw.prepare(`
      SELECT version FROM next_actions WHERE id = ? AND sales_cycle_id = ?
    `).get(input.actionId, input.salesCycleId) as Row | undefined;
    const enrollmentRow = this.database.raw.prepare(`
      SELECT version FROM cadence_enrollments
      WHERE sales_cycle_id = ? AND status = 'active'
    `).get(input.salesCycleId) as Row | undefined;
    if (actionRow === undefined) throw new Error('The current action does not exist.');
    const cycle = this.services.lifecycle.completeCurrentAction({
      cycleId: input.salesCycleId,
      expectedCycleVersion: state.version,
      expectedCurrentActionId: input.actionId,
      expectedActionVersion: Number(actionRow.version),
      expectedEnrollmentVersion: enrollmentRow === undefined ? 1 : Number(enrollmentRow.version),
      outcome: input.outcome as never,
      activityId: input.activityId,
      impossibleDisposition: null,
      evaluationAt: this.clock.now(),
      manualReactivationDueAt: null,
    });
    return this.receipt([cycle.personId], [cycle.id]);
  }

  private projectionOfCycle(salesCycleId: string): {
    prospectId: string;
    evaluationId: string;
    version: number;
  } {
    const row = this.database.raw.prepare(`
      SELECT projection.prospect_id AS prospect_id,
             projection.evaluation_id AS evaluation_id,
             projection.version AS version
      FROM sales_cycles AS cycle
      JOIN prospect_priority_projection AS projection
        ON projection.prospect_id = cycle.prospect_id
      WHERE cycle.id = ?
    `).get(salesCycleId) as Row | undefined;
    if (row === undefined) {
      throw new Error('The cycle has no current priority projection.');
    }
    return {
      prospectId: String(row.prospect_id),
      evaluationId: String(row.evaluation_id),
      version: Number(row.version),
    };
  }

  snoozePrimaryAction(input: SnoozeActionRequest): MutationReceipt {
    const asOf = this.clock.now();
    const controlled = this.projectionOfCycle(input.salesCycleId);
    const compared = this.projectionOfCycle(input.comparedSalesCycleId);
    this.services.prioritization.snoozeProspect({
      controlId: this.ids.next(),
      preferenceEventId: this.ids.next(),
      controlledProspectId: controlled.prospectId,
      comparison: {
        winner: {
          prospectId: compared.prospectId,
          evaluationId: compared.evaluationId,
          projectionVersion: compared.version,
        },
        loser: {
          prospectId: controlled.prospectId,
          evaluationId: controlled.evaluationId,
          projectionVersion: controlled.version,
        },
      },
      reason: input.reason,
      asOf,
      expiresAt: input.expiresAt,
    });
    return this.receipt([], [input.salesCycleId]);
  }

  pinWithinLane(input: PinActionRequest): MutationReceipt {
    const asOf = this.clock.now();
    const controlled = this.projectionOfCycle(input.salesCycleId);
    const compared = this.projectionOfCycle(input.comparedSalesCycleId);
    this.services.prioritization.pinProspect({
      controlId: this.ids.next(),
      preferenceEventId: this.ids.next(),
      controlledProspectId: controlled.prospectId,
      comparison: {
        winner: {
          prospectId: controlled.prospectId,
          evaluationId: controlled.evaluationId,
          projectionVersion: controlled.version,
        },
        loser: {
          prospectId: compared.prospectId,
          evaluationId: compared.evaluationId,
          projectionVersion: compared.version,
        },
      },
      reason: input.reason,
      asOf,
      expiresAt: input.expiresAt,
    });
    return this.receipt([], [input.salesCycleId]);
  }

  logPastActivity(input: LogPastActivityRequest): MutationReceipt {
    const channelByKind: Record<string, string> = {
      call: 'phone', voicemail: 'phone', text: 'text', email: 'email', note: 'manual',
    };
    const optedOut = this.database.raw.prepare(`
      SELECT 1 FROM opt_out_tombstones WHERE person_id = ?
    `).get(input.personId) !== undefined;
    if (optedOut && input.direction === 'outbound' && input.kind !== 'note') {
      this.services.optOut.recordPastOffAppTouch({
        personId: input.personId,
        reportedAt: this.clock.now(),
        activity: {
          id: this.ids.next(),
          personId: input.personId,
          kind: input.kind,
          direction: 'outbound',
          channel: channelByKind[input.kind]!,
          occurredAt: input.occurredAt,
          observedOutcome: input.outcome,
          metadata: { summary: input.summary },
        },
      });
    } else {
      this.services.unitOfWork.immediate(() => {
        this.services.events.appendActivity({
          id: this.ids.next(),
          personId: input.personId,
          salesCycleId: input.salesCycleId,
          kind: input.kind,
          direction: input.direction,
          channel: channelByKind[input.kind]!,
          occurredAt: input.occurredAt,
          observedOutcome: input.outcome,
          metadata: { summary: input.summary },
        });
      });
    }
    return this.receipt([input.personId], input.salesCycleId === null ? [] : [input.salesCycleId]);
  }

  getPipelineProjection(): PipelineSnapshot {
    const asOf = this.clock.now();
    const stages = [
      'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
    ] as const;
    const rows = this.database.raw.prepare(`
      SELECT
        cycle.id AS cycle_id,
        cycle.person_id AS person_id,
        cycle.prospect_id AS prospect_id,
        cycle.stage AS stage,
        cycle.stage_entered_at AS stage_entered_at,
        cycle.current_next_action_id AS current_action_id,
        cycle.close_reason AS close_reason,
        person.display_name AS display_name
      FROM sales_cycles AS cycle
      JOIN persons AS person ON person.id = cycle.person_id
      WHERE person.deleted_at IS NULL
      ORDER BY cycle.stage_entered_at, cycle.id COLLATE BINARY
    `).all() as Row[];
    const cards = rows.map((row) => ({
      personId: String(row.person_id),
      salesCycleId: String(row.cycle_id),
      personName: String(row.display_name),
      contextLabel: null as string | null,
      stage: String(row.stage) as PipelineSnapshot['stages'][number]['stage'],
      stageEnteredAt: String(row.stage_entered_at),
      priorityContext: this.priorityContextFor(String(row.prospect_id)),
      nextAction: this.nextActionFor(
        String(row.cycle_id),
        row.current_action_id === null ? null : String(row.current_action_id),
        asOf,
      ),
      lostReasonCode: row.close_reason === null ? null : String(row.close_reason),
    }));
    return pipelineSnapshotSchema.parse({
      stages: stages.map((stage) => ({
        stage,
        cards: cards.filter((card) => card.stage === stage),
      })),
      revision: this.revision(),
    });
  }

  listReviewItems(input: ReviewListRequest): ReviewSnapshot {
    const rows = this.database.raw.prepare(`
      SELECT id, activation_key, status, payload_json, version
      FROM lifecycle_review_items
      WHERE status = 'open'
      ORDER BY id COLLATE BINARY
      LIMIT ?
    `).all(input.limit) as Row[];
    const items: ReviewItem[] = [];
    for (const row of rows) {
      let personId: string | null = null;
      try {
        const payload = JSON.parse(String(row.payload_json)) as { command?: { personId?: string } };
        personId = payload.command?.personId ?? null;
      } catch {
        personId = null;
      }
      const item: ReviewItem = {
        kind: 'system_error',
        reviewId: String(row.id),
        invariant: String(row.activation_key),
        summary: 'A blocked reactivation requires founder review.',
        personId,
      };
      items.push(item);
    }
    const filtered = input.kinds.length === 0
      ? items
      : items.filter((item) => input.kinds.includes(item.kind));
    const openCount = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM lifecycle_review_items WHERE status = 'open'
    `).get() as { count: number }).count;
    return reviewSnapshotSchema.parse({
      items: filtered,
      totalOpenCount: openCount,
      revision: this.revision(),
    });
  }

  resolveReviewItem(input: ResolveReviewRequest): MutationReceipt {
    this.services.unitOfWork.immediate(() => {
      const row = this.database.raw.prepare(`
        SELECT id, version FROM lifecycle_review_items WHERE id = ?
      `).get(input.reviewId) as Row | undefined;
      if (row === undefined) throw new Error('The review item does not exist.');
      const resolution = input.kind === 'ambiguous_identity'
        ? { kind: 'resolved_identity', personId: input.personId }
        : { kind: 'resolved', action: input.action };
      const result = this.database.raw.prepare(`
        UPDATE lifecycle_review_items
        SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
        WHERE id = ? AND status = 'open' AND version = ?
      `).run(
        JSON.stringify(resolution),
        this.clock.now(),
        input.reviewId,
        input.expectedVersion,
      );
      if (result.changes === 0) throw new Error('The review item changed before this resolution.');
    });
    return this.receipt([], []);
  }

  private fridayWindow(asOf: string): { startsAt: string; endsAt: string } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    });
    const asOfDate = new Date(asOf);
    // Find the founder-local Monday 00:00 of the current week.
    const parts = formatter.formatToParts(asOfDate);
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
    const dayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
    const startDate = new Date(asOfDate.getTime() - Math.max(0, dayIndex) * 86_400_000);
    const dateOnly = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(startDate);
    const startsAt = `${dateOnly}T00:00:00.000Z`;
    const endsAt = new Date(Date.parse(startsAt) + 5 * 86_400_000).toISOString();
    return { startsAt, endsAt };
  }

  getFridayReport(): FridayReport {
    const asOf = this.clock.now();
    const window = this.fridayWindow(asOf);
    const countStage = (stage: string): number => (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM stage_events
      WHERE to_stage = ? AND effective_at >= ? AND effective_at < ?
    `).get(stage, window.startsAt, window.endsAt) as { count: number }).count;
    const jobs = this.listFounderJobs();
    const fillDenominator = jobs.filter((job) => job.status !== 'cancelled').length;
    const filled = jobs.filter((job) => job.status === 'filled').length;
    const sourceRows = (this.database.raw.prepare(`
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
      GROUP BY source.channel ORDER BY source.channel
    `).all(window.startsAt, window.endsAt) as Row[]).map((row) => ({
      source: String(row.source),
      interviews: Number(row.interviews),
      offers: Number(row.offers),
      wins: Number(row.wins),
    }));
    return fridayReportSchema.parse({
      periodStartsAt: window.startsAt,
      periodEndsAt: window.endsAt,
      asOf,
      metrics: this.buildFridayMetrics({
        interviews: countStage('interviewed'),
        offers: countStage('offered'),
        wins: countStage('won'),
        jobsRequested: jobs.length,
        jobsFilled: filled,
        fillDenominator,
      }),
      sourceRows,
      jobs,
      revision: this.revision(),
    });
  }

  private buildFridayMetrics(input: {
    interviews: number;
    offers: number;
    wins: number;
    jobsRequested: number;
    jobsFilled: number;
    fillDenominator: number;
  }): FridayReport['metrics'] {
    const count = (id: MetricId, label: string, value: number, target: number | null = null) => ({
      id, label, displayValue: String(value), numericValue: value, target,
      priorDelta: null as number | null, numerator: null as number | null,
      denominator: null as number | null, drilldownCount: value,
    });
    const rate = (
      id: MetricId,
      label: string,
      numerator: number,
      denominator: number,
    ) => {
      const value = denominator === 0 ? null : numerator / denominator;
      return {
        id, label,
        displayValue: value === null ? '—' : `${Math.round(value * 100)}%`,
        numericValue: value, target: null as number | null,
        priorDelta: null as number | null, numerator, denominator, drilldownCount: 0,
      };
    };
    const overdue = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions
      WHERE status = 'pending' AND due_at < ?
    `).get(this.clock.now()) as { count: number }).count;
    const invalidActionCycles = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles
      WHERE workflow_status IN ('active', 'onboarding') AND current_next_action_id IS NULL
    `).get() as { count: number }).count;
    const foundingCustomers = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles WHERE stage = 'won'
    `).get() as { count: number }).count;
    return [
      count('interviews', 'Interviews', input.interviews),
      count('offers', 'Offers', input.offers),
      count('wins', 'Wins', input.wins),
      rate('offer_rate', 'Offer rate', input.offers, input.interviews),
      rate('win_rate', 'Win rate', input.wins, input.offers),
      count('jobs_requested', 'Jobs requested', input.jobsRequested),
      count('jobs_filled', 'Jobs filled', input.jobsFilled),
      rate('fill_rate', 'Fill rate', input.jobsFilled, input.fillDenominator),
      count('new_mrr', 'New MRR', 0),
      count('founding_customers', 'Founding customers', foundingCustomers, 10),
      rate('design_partner_fitness', 'Design partner fitness', foundingCustomers, 10),
      count('overdue_actions', 'Overdue actions', overdue),
      count('invalid_action_cycles', 'Invalid action cycles', invalidActionCycles),
    ];
  }

  getMetricDrilldown(input: MetricDrilldownRequest): MetricDrilldown {
    const asOf = this.clock.now();
    const window = this.fridayWindow(asOf);
    const stageByMetric: Record<string, string> = {
      interviews: 'interviewed', offers: 'offered', wins: 'won',
    };
    const stage = stageByMetric[input.metricId];
    const rows = stage === undefined
      ? this.database.raw.prepare(`
          SELECT activity.id AS id, person.display_name AS label,
                 activity.occurred_at AS occurred_at, activity.observed_outcome AS detail
          FROM activities AS activity
          JOIN persons AS person ON person.id = activity.person_id
          WHERE activity.kind = 'call' AND activity.direction = 'outbound'
            AND activity.occurred_at >= ? AND activity.occurred_at < ?
          ORDER BY activity.occurred_at DESC LIMIT 100
        `).all(window.startsAt, window.endsAt) as Row[]
      : this.database.raw.prepare(`
          SELECT event.id AS id, person.display_name AS label,
                 event.effective_at AS occurred_at, event.to_stage AS detail
          FROM stage_events AS event
          JOIN sales_cycles AS cycle ON cycle.id = event.sales_cycle_id
          JOIN persons AS person ON person.id = cycle.person_id
          WHERE event.to_stage = ? AND event.effective_at >= ? AND event.effective_at < ?
          ORDER BY event.effective_at DESC LIMIT 100
        `).all(stage, window.startsAt, window.endsAt) as Row[];
    return metricDrilldownSchema.parse({
      metricId: input.metricId,
      label: input.metricId,
      rows: rows.map((row) => ({
        id: String(row.id),
        label: String(row.label),
        occurredAt: row.occurred_at === null ? null : String(row.occurred_at),
        detail: row.detail === null ? null : String(row.detail),
      })),
    });
  }

  private listFounderJobs(): FridayReport['jobs'] {
    const rows = this.database.raw.prepare(`
      SELECT id, payload_json, state FROM jobs WHERE type = ?
      ORDER BY created_at, id
    `).all(FOUNDER_JOB_REQUEST_TYPE) as Row[];
    const jobs: FridayReport['jobs'] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.payload_json)) as {
          salesCycleId: string | null;
          requestedAt: string;
          status: 'requested' | 'filled' | 'cancelled';
          contractorAcceptedAt: string | null;
        };
        jobs.push({
          id: String(row.id),
          salesCycleId: payload.salesCycleId,
          requestedAt: payload.requestedAt,
          status: payload.status,
          contractorAcceptedAt: payload.contractorAcceptedAt,
        });
      } catch {
        // Malformed founder-job payloads are skipped, never fatal to the report.
      }
    }
    return jobs;
  }

  createJobRequest(input: CreateJobRequest): MutationReceipt {
    this.services.jobs.enqueue({
      id: input.jobId,
      type: FOUNDER_JOB_REQUEST_TYPE,
      idempotencyKey: `${FOUNDER_JOB_REQUEST_TYPE}:${input.jobId}`,
      payload: {
        salesCycleId: input.salesCycleId,
        requestedAt: input.requestedAt,
        status: 'requested',
        contractorAcceptedAt: null,
      },
      at: this.clock.now(),
    });
    return this.receipt([], input.salesCycleId === null ? [] : [input.salesCycleId]);
  }

  private updateFounderJob(
    jobId: string,
    update: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    this.services.unitOfWork.immediate(() => {
      const row = this.database.raw.prepare(`
        SELECT payload_json FROM jobs WHERE id = ? AND type = ?
      `).get(jobId, FOUNDER_JOB_REQUEST_TYPE) as Row | undefined;
      if (row === undefined) throw new Error('The job request does not exist.');
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const next = update(payload);
      this.database.raw.prepare(`
        UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND type = ?
      `).run(JSON.stringify(next), this.clock.now(), jobId, FOUNDER_JOB_REQUEST_TYPE);
    });
  }

  markJobFilled(input: FillJobRequest): MutationReceipt {
    this.updateFounderJob(input.jobId, (payload) => {
      if (payload.status === 'cancelled') {
        throw new Error('A cancelled job request cannot be filled.');
      }
      return {
        ...payload,
        status: 'filled',
        contractorAcceptedAt: input.contractorAcceptedAt,
      };
    });
    return this.receipt([], []);
  }

  cancelJobRequest(input: CancelJobRequest): MutationReceipt {
    this.updateFounderJob(input.jobId, (payload) => ({
      ...payload,
      status: 'cancelled',
    }));
    return this.receipt([], []);
  }

  private readonly importPreviews = new Map<string, {
    contentHash: string;
    columns: string[];
    rows: { rowNumber: number; values: string[] }[];
    mapping: ImportMapping;
    expiresAt: string;
  }>();

  previewLeadImport(input: ImportSource): ImportPreview {
    const parsed = importSourceSchema.parse(input);
    const result = Papa.parse<string[]>(parsed.content.trim(), { skipEmptyLines: true });
    const [header, ...dataRows] = result.data;
    if (header === undefined || header.length === 0) {
      throw new Error('The import source has no header row.');
    }
    const columns = header.map((column) => column.trim());
    const rows = dataRows.map((values, index) => ({
      rowNumber: index + 2,
      values: values.map((value) => String(value ?? '')),
    }));
    const suggestion: Record<string, z.infer<typeof z.ZodString>> = {};
    const mapping: ImportMapping = {};
    for (const column of columns) {
      const lower = column.toLowerCase();
      if (lower.includes('name')) mapping[column] = 'person_name';
      else if (lower.includes('phone')) mapping[column] = 'phone';
      else if (lower.includes('email')) mapping[column] = 'email';
      else if (lower.includes('org')) mapping[column] = 'organization';
      else if (lower.includes('door')) mapping[column] = 'doors';
      else if (lower.includes('source')) mapping[column] = 'source';
      else if (lower.includes('address')) mapping[column] = 'property_address';
      else mapping[column] = 'ignore';
    }
    if (!Object.values(mapping).includes('person_name') && columns.length > 0) {
      mapping[columns[0]!] = 'person_name';
    }
    void suggestion;
    const contentHash = createHash('sha256').update(parsed.content).digest('hex');
    const previewId = this.ids.next();
    const asOfMillis = Date.parse(this.clock.now());
    const expiresAt = new Date(asOfMillis + 30 * 60_000).toISOString();
    const nameColumn = columns.findIndex((column) => mapping[column] === 'person_name');
    const phoneColumn = columns.findIndex((column) => mapping[column] === 'phone');
    const emailColumn = columns.findIndex((column) => mapping[column] === 'email');
    const errors: ImportPreview['errors'] = [];
    const duplicateCandidates: ImportPreview['duplicateCandidates'] = [];
    let validCount = 0;
    for (const row of rows) {
      const name = nameColumn >= 0 ? row.values[nameColumn]?.trim() ?? '' : '';
      if (name.length === 0) {
        errors.push({
          rowNumber: row.rowNumber,
          field: 'person_name',
          code: 'missing_name',
          message: 'The person name is required.',
        });
        continue;
      }
      validCount += 1;
      for (const [columnIndex, kind] of [
        [phoneColumn, 'phone' as const],
        [emailColumn, 'email' as const],
      ] as const) {
        if (columnIndex < 0) continue;
        const value = row.values[columnIndex]?.trim() ?? '';
        if (value.length === 0) continue;
        try {
          const matches = this.services.identities
            .findPeopleByNormalizedHandle(kind, value)
            .map((person) => person.id);
          if (matches.length > 0) {
            duplicateCandidates.push({
              rowNumber: row.rowNumber,
              personIds: matches,
              reason: `Existing ${kind} match`,
            });
          }
        } catch {
          errors.push({
            rowNumber: row.rowNumber,
            field: kind,
            code: `invalid_${kind}`,
            message: `The ${kind} value could not be normalized.`,
          });
        }
      }
    }
    this.importPreviews.set(previewId, { contentHash, columns, rows, mapping, expiresAt });
    return importPreviewSchema.parse({
      previewId,
      contentHash,
      columns,
      sampleRows: rows.slice(0, 20).map((row) => ({
        rowNumber: row.rowNumber,
        cells: row.values,
      })),
      suggestedMapping: mapping,
      rowCount: rows.length,
      validCount,
      errors,
      duplicateCandidates,
      expiresAt,
    });
  }

  remapLeadImport(input: ImportRemapRequest): ImportPreview {
    const preview = this.importPreviews.get(input.previewId);
    if (preview === undefined || preview.contentHash !== input.contentHash) {
      throw new Error('The import preview has expired or changed.');
    }
    preview.mapping = input.mapping;
    const columns = preview.columns;
    const nameColumn = columns.findIndex((column) => input.mapping[column] === 'person_name');
    let validCount = 0;
    const errors: ImportPreview['errors'] = [];
    for (const row of preview.rows) {
      const name = nameColumn >= 0 ? row.values[nameColumn]?.trim() ?? '' : '';
      if (name.length === 0) {
        errors.push({
          rowNumber: row.rowNumber,
          field: 'person_name',
          code: 'missing_name',
          message: 'The person name is required.',
        });
      } else {
        validCount += 1;
      }
    }
    return importPreviewSchema.parse({
      previewId: input.previewId,
      contentHash: preview.contentHash,
      columns,
      sampleRows: preview.rows.slice(0, 20).map((row) => ({
        rowNumber: row.rowNumber,
        cells: row.values,
      })),
      suggestedMapping: input.mapping,
      rowCount: preview.rows.length,
      validCount,
      errors,
      duplicateCandidates: [],
      expiresAt: preview.expiresAt,
    });
  }

  private intakeSource(
    jobId: string,
    rowNumber: number,
    source: ImportCommitRequest['source'],
  ): IntakeSourceInput {
    const base = {
      id: `${jobId}-row-${rowNumber}`,
      observedAt: this.clock.now(),
      sourceRecord: { importRow: rowNumber },
    };
    if (source.channel === 'custom') {
      return { ...base, channel: 'custom', customSourceReason: 'csv_import' };
    }
    if (source.channel === 'referral') {
      return {
        ...base,
        channel: 'referral',
        referral: source.referredByPersonId === null
          ? { kind: 'unknown', reason: 'not_provided' }
          : { kind: 'known', referredByPersonId: source.referredByPersonId },
      };
    }
    return { ...base, channel: source.channel };
  }

  commitLeadImport(input: ImportCommitRequest): ImportCommitReceipt {
    const preview = this.importPreviews.get(input.previewId);
    if (preview === undefined || preview.contentHash !== input.contentHash) {
      throw new Error('The import preview has expired or changed.');
    }
    const columns = preview.columns;
    const columnFor = (field: string): number => columns.findIndex(
      (column) => input.mapping[column] === field,
    );
    const nameColumn = columnFor('person_name');
    const phoneColumn = columnFor('phone');
    const emailColumn = columnFor('email');
    const organizationColumn = columnFor('organization');
    const doorsColumn = columnFor('doors');
    const addressColumn = columnFor('property_address');
    const jobId = this.ids.next();
    const commands: CreatePersonProspectCommand[] = [];
    for (const row of preview.rows) {
      const name = nameColumn >= 0 ? row.values[nameColumn]?.trim() ?? '' : '';
      if (name.length === 0) continue;
      const contacts: CreatePersonProspectCommand['contacts'] = [];
      const phone = phoneColumn >= 0 ? row.values[phoneColumn]?.trim() ?? '' : '';
      if (phone.length > 0) {
        contacts.push({ kind: 'phone', value: phone, reachability: 'direct', isPrimary: true });
      }
      const email = emailColumn >= 0 ? row.values[emailColumn]?.trim() ?? '' : '';
      if (email.length > 0) {
        contacts.push({ kind: 'email', value: email, reachability: 'indirect' });
      }
      const organization = organizationColumn >= 0
        ? row.values[organizationColumn]?.trim() ?? ''
        : '';
      const address = addressColumn >= 0 ? row.values[addressColumn]?.trim() ?? '' : '';
      const doorsRaw = doorsColumn >= 0 ? row.values[doorsColumn]?.trim() ?? '' : '';
      const doors = /^\d+$/.test(doorsRaw) ? Number.parseInt(doorsRaw, 10) : null;
      const common = {
        person: { displayName: name },
        contacts,
        organizations: organization.length === 0
          ? undefined
          : [{ canonicalName: organization }],
        properties: address.length === 0
          ? undefined
          : [{
            addressLine1: address,
            locality: 'Providence',
            region: 'RI',
            doorCount: doors,
          }],
      };
      const source = this.intakeSource(jobId, row.rowNumber, input.source);
      commands.push(source.channel === 'custom'
        ? { ...common, source, segment: 'warm' }
        : { ...common, source });
    }
    const results = this.services.sources.commitBatch(commands);
    const importedPersonIds = [...new Set(results.map((result) => result.personId))];
    const at = this.clock.now();
    const job = this.services.jobs.enqueue({
      id: jobId,
      type: IMPORT_JOB_TYPE,
      idempotencyKey: `${IMPORT_JOB_TYPE}:${input.contentHash}`,
      payload: { previewId: input.previewId, importedRowCount: results.length },
      at,
    });
    this.services.jobs.start(job.id);
    this.services.jobs.succeed(job.id, { importedRowCount: results.length });
    this.importPreviews.delete(input.previewId);
    return importCommitReceiptSchema.parse({
      jobId: job.id,
      importedPersonIds,
      importedRowCount: results.length,
      revision: this.revision(),
    });
  }

  getImportJob(input: ImportStatusRequest): ImportStatus {
    const row = this.services.jobs.get(input.jobId);
    if (row === null) throw new Error('The import job does not exist.');
    const state = row.state === 'cancelled' ? 'failed' : row.state;
    return importStatusSchema.parse({
      jobId: row.id,
      state: state as ImportStatus['state'],
      progressCurrent: row.progressCurrent,
      progressTotal: row.progressTotal,
      safeErrorCode: row.error?.code ?? null,
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

