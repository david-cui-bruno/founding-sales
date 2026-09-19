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
import { ListCursorError, pageFromSnapshot } from './support/listCursor';

import { z } from 'zod';
import { buildPortfolioContext } from './portfolio/portfolioContext';
import { collectDiscoveryEvidence } from './discovery/discoveryEvidence';
import { communicationRecencySql, isLegacyOutboundRequest, outboundCommandFactSql } from './events/communicationEvidence';

import type { AppDatabase } from '../db/database';
import { type LeadPriorityContext, type PrimaryAction } from '../../shared/contracts/commonContract';
import { leadRowSchema, leadsListRequestSchema, leadsListResponseSchema, type LeadRow, type LeadsListRequest, type LeadsListResponse } from '../../shared/contracts/leadsContract';
import { leadDetailRequestSchema, leadDetailSchema, type ContactMethod, type FindContactEligibility, type LeadDetail, type LeadDetailRequest } from '../../shared/contracts/leadDetailContract';
import { type TodayItem as TodayItemDto, type TodayLaneId } from '../../shared/contracts/todayContract';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from './cadence/cadenceScheduler';
import { comparePhoneCandidates } from './contacts/contactPresentation';
import type { DomainServices } from './createDomainServices';
import type { Clock } from './support/clock';
import type { IdGenerator } from './support/idGenerator';
import type { TodayItem, TodayLane } from './today/todayTypes';
import { contactSnapshot } from '../communications/contactSnapshot';
import type { HandoffResult } from '../../shared/contracts/outboundContract';

export type FounderSalesDomainErrorCode =
  | 'LIST_CURSOR_INVALID'
  | 'LIST_CURSOR_STALE'
  | 'LEAD_NOT_FOUND'
  | 'CYCLE_NOT_FOUND'
  | 'CONTACT_METHOD_NOT_FOUND'
  | 'CONTACT_DNC_BLOCKED'
  | 'PRIORITY_PROJECTION_MISSING'
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_RESOLUTION_UNSUPPORTED';

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
 * parsed into strict DTOs; the surviving company-side commands compose the
 * transactional domain services and account repositories directly.
 */
export class FounderSalesDomain {
  private readonly services: DomainServices;
  private readonly database: AppDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly configuredTimezone: string | undefined;

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

  /** One deferred read snapshot, or the caller's existing snapshot. Never a write UoW. */
  private readListSnapshot<T>(read: () => T): T {
    try {
      return this.database.raw.inTransaction ? read() : this.database.raw.transaction(read).deferred();
    } catch (error) {
      if (error instanceof ListCursorError) throw new FounderSalesDomainError(error.code, error.code);
      throw error;
    }
  }

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
