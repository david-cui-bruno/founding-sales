import { legacyReviewParkingEligibilitySql } from '../workspace/legacyWorkflowTransition';
import { z } from 'zod';
import { communicationRecencySql } from '../events/communicationEvidence';

import type { AppDatabase } from '../../db/database';
import {
  DomainRepositoryDatabaseMismatchError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { todaySelectedCallReceiptV1Schema } from '../optOut/optOutTypes';
import type { InboundSla, NextActionWorkIntent } from '../lifecycle/lifecycleTypes';
import type {
  ParsedTodayCandidate,
  TodayCandidateLoadResult,
  TodayDiagnostic,
  TodayDiagnosticKind,
} from './todayTypes';

// Immutable receipt + exact current action/version prevents parking future reviews or obligations.
function manifestParkedReviewSql(cycle: 'c' | 'cycle'): string {
  return `(${legacyReviewParkingEligibilitySql(cycle)}) AND EXISTS (
    SELECT 1 FROM workflow_transition_receipts receipt, json_each(receipt.result_json,'$.parkedReviewActions') parked
    JOIN next_actions current ON current.id=${cycle}.current_next_action_id
    WHERE json_extract(receipt.result_json,'$.mode')='meeting_first'
      AND json_extract(parked.value,'$.id')=current.id
      AND json_extract(parked.value,'$.cycleId')=${cycle}.id
      AND json_extract(parked.value,'$.version')=current.version)`;
}

const idSchema = z.string().trim().min(1);
const utcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

const baseRowSchema = z.object({
  segment: z.enum(['hot', 'cold', 'warm']),
  action_due_at: utcTimestampSchema.nullable(),
  callback_activity_id: idSchema.nullable(),
  callback_due_at: utcTimestampSchema.nullable(),
  cycle_id: idSchema,
  person_id: idSchema,
  prospect_id: idSchema,
  stage: z.enum([
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ]),
  workflow_status: z.enum(['active', 'onboarding']),
  current_next_action_id: idSchema.nullable(),
  stage_entered_at: utcTimestampSchema,
  resurface_at: z.string().nullable(),
  resurface_reason: z.string().nullable(),
  action_id: idSchema.nullable(),
  action_cycle_id: idSchema.nullable(),
  action_type: z.string().nullable(),
  action_channel: z.string().nullable(),
  action_status: z.enum(['pending', 'completed', 'cancelled', 'impossible']).nullable(),
  action_timezone: z.string().nullable(),
  action_allowed_window: z.string().nullable(),
  action_work_intent: z.string().nullable(),
  action_inbound_sla_kind: z.string().nullable(),
  action_inbound_sla_due_at: z.string().nullable(),
  action_inbound_sla_source_event_id: z.string().nullable(),
  action_inbound_sla_provenance_json: z.string().nullable(),
  action_cadence_enrollment_id: z.string().nullable(),
  action_cadence_step_id: z.string().nullable(),
  action_cadence_component_id: z.string().nullable(),
  enrollment_id: z.string().nullable(),
  enrollment_status: z.string().nullable(),
  enrollment_definition_id: z.string().nullable(),
  definition_family: z.string().nullable(),
  step_sequence: z.number().int().nullable(),
  last_activity_id: z.string().nullable(),
  last_activity_kind: z.string().nullable(),
  last_activity_occurred_at: z.string().nullable(),
  last_activity_observed_outcome: z.string().nullable(),
}).strict();

const inboundProvenanceSchema = z.union([
  z.object({
    version: z.literal(1),
    sourceEventId: idSchema,
    sourceObservedAt: utcTimestampSchema,
    calculation: z.literal('permitted_minutes'),
    minutes: z.literal(15),
    policyId: z.string().min(1),
    computedDueAt: utcTimestampSchema,
  }).strict(),
  z.object({
    version: z.literal(1),
    sourceEventId: idSchema,
    sourceObservedAt: utcTimestampSchema,
    calculation: z.literal('elapsed_hours'),
    hours: z.literal(48),
    policyId: z.null(),
    computedDueAt: utcTimestampSchema,
  }).strict(),
]);

const WORK_INTENTS: readonly NextActionWorkIntent[] = [
  'internal_review', 'inbound_response', 'promised_follow_up', 'discretionary_prospecting',
];

const ACTIVITY_KINDS = [
  'call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system',
] as const;

const CADENCE_FAMILIES = ['cadence_a', 'cadence_b', 'cadence_c', 'post_interview', 'post_offer', 'onboarding'] as const;

function diagnostic(
  cycleId: string | null,
  personId: string | null,
  kind: TodayDiagnosticKind,
  relatedIds: readonly string[],
): TodayCandidateLoadResult {
  return {
    kind: 'diagnostic',
    diagnostic: { cycleId, personId, kind, relatedIds },
  };
}

/**
 * Read-only Today repository. Drives from operational SalesCycles, LEFT JOINs
 * only the authoritative current action pointer, optional active cadence
 * graph, and a correlated display Activity. Never scans all pending actions,
 * never orders semantically, and never limits by capacity.
 */
export class TodayRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
  }) {
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

  hasActiveWarm(): boolean {
    return (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM sales_cycles c
      JOIN prospects p ON p.id = c.prospect_id JOIN persons person ON person.id = c.person_id
      WHERE c.workflow_status IN ('active','onboarding') AND p.segment = 'warm'
        AND NOT EXISTS (SELECT 1 FROM next_actions parked WHERE parked.id=c.current_next_action_id AND parked.action_type='parked_legacy')
        AND NOT (${manifestParkedReviewSql('c')})
        AND person.opted_out = 0 AND person.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM opt_out_tombstones t WHERE t.person_id = person.id)
      `).get() as { count: number }).count > 0;
  }

  listOperationalCandidates(): readonly TodayCandidateLoadResult[] {
    const rows = this.database.raw.prepare(`
      SELECT
        prospect.segment, action.due_at AS action_due_at,
        callback.id AS callback_activity_id, callback.callback_at AS callback_due_at,
        cycle.id AS cycle_id,
        cycle.person_id AS person_id,
        cycle.prospect_id AS prospect_id,
        cycle.stage AS stage,
        cycle.workflow_status AS workflow_status,
        cycle.current_next_action_id AS current_next_action_id,
        cycle.stage_entered_at AS stage_entered_at,
        cycle.resurface_at AS resurface_at,
        cycle.resurface_reason AS resurface_reason,
        action.id AS action_id,
        action.sales_cycle_id AS action_cycle_id,
        action.action_type AS action_type,
        action.channel AS action_channel,
        action.status AS action_status,
        action.timezone AS action_timezone,
        action.allowed_window AS action_allowed_window,
        action.work_intent AS action_work_intent,
        action.inbound_sla_kind AS action_inbound_sla_kind,
        action.inbound_sla_due_at AS action_inbound_sla_due_at,
        action.inbound_sla_source_event_id AS action_inbound_sla_source_event_id,
        action.inbound_sla_provenance_json AS action_inbound_sla_provenance_json,
        action.cadence_enrollment_id AS action_cadence_enrollment_id,
        action.cadence_step_id AS action_cadence_step_id,
        action.cadence_component_id AS action_cadence_component_id,
        enrollment.id AS enrollment_id,
        enrollment.status AS enrollment_status,
        enrollment.cadence_definition_id AS enrollment_definition_id,
        definition.family AS definition_family,
        step.sequence AS step_sequence,
        last_activity.id AS last_activity_id,
        last_activity.kind AS last_activity_kind,
        last_activity.occurred_at AS last_activity_occurred_at,
        last_activity.observed_outcome AS last_activity_observed_outcome
      FROM sales_cycles AS cycle
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id
      JOIN persons AS person ON person.id = cycle.person_id
      LEFT JOIN next_actions AS action
        ON action.id = cycle.current_next_action_id
        AND action.sales_cycle_id = cycle.id
      LEFT JOIN cadence_enrollments AS enrollment
        ON enrollment.id = action.cadence_enrollment_id
        AND enrollment.sales_cycle_id = cycle.id
      LEFT JOIN cadence_definitions AS definition
        ON definition.id = enrollment.cadence_definition_id
      LEFT JOIN cadence_steps AS step
        ON step.id = action.cadence_step_id
        AND step.cadence_definition_id = enrollment.cadence_definition_id
      LEFT JOIN activities AS callback ON callback.rowid = (
        SELECT MAX(promise.rowid) FROM activities promise
        WHERE promise.sales_cycle_id = cycle.id AND promise.person_id = cycle.person_id
          AND promise.callback_at IS NOT NULL AND promise.kind = 'call'
      ) AND NOT EXISTS (SELECT 1 FROM activity_amendments amendment WHERE amendment.activity_id = callback.id)
        AND NOT EXISTS (SELECT 1 FROM activities fulfilled WHERE fulfilled.sales_cycle_id = cycle.id
            AND fulfilled.person_id = cycle.person_id AND fulfilled.kind = 'call'
            AND fulfilled.direction = 'outbound' AND fulfilled.observed_outcome IS NOT NULL
            AND fulfilled.rowid > callback.rowid AND fulfilled.occurred_at >= callback.callback_at
            AND fulfilled.callback_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM activity_amendments amendment WHERE amendment.activity_id = fulfilled.id))
      LEFT JOIN activities AS last_activity
        ON last_activity.id = (
          SELECT candidate.id FROM activities AS candidate
          WHERE candidate.sales_cycle_id = cycle.id
            AND ${communicationRecencySql}
          ORDER BY candidate.occurred_at DESC, candidate.id DESC
          LIMIT 1
        )
      WHERE cycle.workflow_status IN ('active', 'onboarding')
        AND (action.action_type IS NULL OR action.action_type <> 'parked_legacy')
        AND NOT (${manifestParkedReviewSql('cycle')})
        AND person.opted_out = 0
        AND person.deleted_at IS NULL
      ORDER BY cycle.id COLLATE BINARY
    `).all();
    return Object.freeze(rows.map((value) => this.parseRow(value)));
  }

  private parseRow(value: unknown): TodayCandidateLoadResult {
    const parsed = baseRowSchema.safeParse(value);
    if (!parsed.success) {
      const cycleId = typeof (value as { cycle_id?: unknown }).cycle_id === 'string'
        ? (value as { cycle_id: string }).cycle_id
        : null;
      return diagnostic(cycleId, null, 'invalid_current_action', []);
    }
    const row = parsed.data;
    if (row.current_next_action_id === null) {
      return diagnostic(row.cycle_id, row.person_id, 'missing_current_action', []);
    }
    if (row.action_id === null) {
      return diagnostic(
        row.cycle_id, row.person_id, 'invalid_current_action', [row.current_next_action_id],
      );
    }
    if (row.action_cycle_id !== row.cycle_id) {
      return diagnostic(
        row.cycle_id, row.person_id, 'current_action_owner_mismatch', [row.action_id],
      );
    }
    if (row.action_status !== 'pending') {
      return diagnostic(
        row.cycle_id, row.person_id, 'invalid_current_action', [row.action_id],
      );
    }
    if (row.action_work_intent === null
      || !(WORK_INTENTS as readonly string[]).includes(row.action_work_intent)) {
      return diagnostic(row.cycle_id, row.person_id, 'invalid_work_intent', [row.action_id]);
    }
    const workIntent = row.action_work_intent as NextActionWorkIntent;
    if (row.action_timezone === null || !isValidTimezone(row.action_timezone)) {
      return diagnostic(row.cycle_id, row.person_id, 'invalid_timezone', [row.action_id]);
    }
    let resurfaceAt: string | null = null;
    let resurfaceReason: 'snooze' | 'callback' | null = null;
    if (row.resurface_at !== null || row.resurface_reason !== null) {
      if (row.resurface_at === null
        || !utcTimestampSchema.safeParse(row.resurface_at).success
        || (row.resurface_reason !== 'snooze' && row.resurface_reason !== 'callback')) {
        return diagnostic(row.cycle_id, row.person_id, 'invalid_resurface', [row.cycle_id]);
      }
      resurfaceAt = row.resurface_at;
      resurfaceReason = row.resurface_reason;
    }

    const inboundSla = this.decodeInboundSla(row);
    if (inboundSla === null) {
      return diagnostic(row.cycle_id, row.person_id, 'invalid_inbound_sla', [row.action_id]);
    }
    if (workIntent !== 'inbound_response' && inboundSla.kind !== 'none') {
      return diagnostic(row.cycle_id, row.person_id, 'invalid_inbound_sla', [row.action_id]);
    }

    let cadence: ParsedTodayCandidate['cadence'] = null;
    if (row.action_cadence_enrollment_id !== null) {
      if (
        row.enrollment_id === null
        || row.enrollment_definition_id === null
        || row.definition_family === null
        || !(CADENCE_FAMILIES as readonly string[]).includes(row.definition_family)
        || row.action_cadence_step_id === null
        || row.step_sequence === null
        || row.action_cadence_component_id === null
      ) {
        return diagnostic(
          row.cycle_id, row.person_id, 'cadence_owner_graph_mismatch',
          [row.action_id, row.action_cadence_enrollment_id],
        );
      }
      cadence = {
        enrollmentId: row.enrollment_id,
        definitionId: row.enrollment_definition_id,
        family: row.definition_family as ParsedTodayCandidate['cadence'] extends infer C
          ? C extends { family: infer F } ? F : never
          : never,
        stepId: row.action_cadence_step_id,
        stepSequence: row.step_sequence,
        componentId: row.action_cadence_component_id,
      } as ParsedTodayCandidate['cadence'];
    }

    let lastActivity: ParsedTodayCandidate['lastActivity'] = null;
    if (row.last_activity_id !== null) {
      if (
        row.last_activity_kind === null
        || !(ACTIVITY_KINDS as readonly string[]).includes(row.last_activity_kind)
        || row.last_activity_occurred_at === null
        || !utcTimestampSchema.safeParse(row.last_activity_occurred_at).success
      ) {
        return diagnostic(
          row.cycle_id, row.person_id, 'invalid_last_activity', [row.last_activity_id],
        );
      }
      lastActivity = {
        id: row.last_activity_id,
        kind: row.last_activity_kind as (typeof ACTIVITY_KINDS)[number],
        occurredAt: row.last_activity_occurred_at,
        observedOutcome: row.last_activity_observed_outcome,
      };
    }

    if (row.action_due_at === null) return diagnostic(row.cycle_id, row.person_id, 'invalid_timestamp', [row.action_id]);
    const candidate: ParsedTodayCandidate = {
      segment: row.segment,
      commitment: row.callback_activity_id !== null && row.callback_due_at !== null
        ? { kind: 'callback', activityId: row.callback_activity_id, dueAt: row.callback_due_at }
        : ['interviewed', 'offered', 'won'].includes(row.stage) ? { kind: 'post_stage' } : null,
      cycleId: row.cycle_id,
      personId: row.person_id,
      prospectId: row.prospect_id,
      stage: row.stage,
      workflowStatus: row.workflow_status,
      action: {
        dueAt: row.action_due_at,
        id: row.action_id,
        workIntent,
        actionType: row.action_type ?? '',
        channel: row.action_channel,
        timezone: row.action_timezone,
        allowedWindow: row.action_allowed_window,
        inboundSla,
      },
      cadence,
      priority: null,
      priorityState: 'missing',
      selectedTriggerReasons: [],
      verifyFirst: null,
      lastActivity,
      stageEnteredAt: row.stage_entered_at,
      resurfaceAt,
      resurfaceReason,
      inlineDiagnostics: [],
    };
    if (candidate.action.actionType.length === 0) {
      return diagnostic(row.cycle_id, row.person_id, 'invalid_current_action', [row.action_id]);
    }
    return { kind: 'candidate', candidate };
  }

  private decodeInboundSla(row: z.infer<typeof baseRowSchema>): InboundSla | null {
    if (row.action_inbound_sla_kind === null) {
      if (row.action_inbound_sla_due_at !== null
        || row.action_inbound_sla_source_event_id !== null
        || row.action_inbound_sla_provenance_json !== null) {
        return null;
      }
      return { kind: 'none', dueAt: null, sourceEventId: null, provenance: null };
    }
    if (
      (row.action_inbound_sla_kind !== 'inbound_demo_permitted_minutes'
        && row.action_inbound_sla_kind !== 'direct_referral_elapsed')
      || row.action_inbound_sla_due_at === null
      || !utcTimestampSchema.safeParse(row.action_inbound_sla_due_at).success
      || row.action_inbound_sla_source_event_id === null
      || row.action_inbound_sla_provenance_json === null
    ) {
      return null;
    }
    let provenance: z.infer<typeof inboundProvenanceSchema>;
    try {
      provenance = inboundProvenanceSchema.parse(
        JSON.parse(row.action_inbound_sla_provenance_json) as unknown,
      );
    } catch {
      return null;
    }
    if (
      provenance.sourceEventId !== row.action_inbound_sla_source_event_id
      || provenance.computedDueAt !== row.action_inbound_sla_due_at
    ) {
      return null;
    }
    const expectedCalculation = row.action_inbound_sla_kind === 'inbound_demo_permitted_minutes'
      ? 'permitted_minutes'
      : 'elapsed_hours';
    if (provenance.calculation !== expectedCalculation) return null;
    return {
      kind: row.action_inbound_sla_kind,
      dueAt: row.action_inbound_sla_due_at,
      sourceEventId: row.action_inbound_sla_source_event_id,
      provenance,
    } as InboundSla;
  }

  /**
   * Counts immutable outbound call Activities in the founder-local day whose
   * strict TodaySelectedCallReceiptV1 names a discretionary call. Provider or
   * idempotency replay counts once because each Activity row is unique.
   */
  loadCompletedDiscretionaryDialUsage(input: {
    dayStartAt: string;
    dayEndAt: string;
    timezone: string;
    localDate: string;
  }): {
    activityIds: readonly string[];
    count: number;
    diagnostics: readonly {
      activityId: string;
      cycleId: string | null;
      kind: 'invalid_selected_call_receipt';
    }[];
  } {
    const parsed = z.object({
      dayStartAt: utcTimestampSchema,
      dayEndAt: utcTimestampSchema,
      timezone: z.string().min(1),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).strict().parse(input);
    const rows = this.database.raw.prepare(`
      SELECT
        activity.id AS id,
        activity.sales_cycle_id AS sales_cycle_id,
        activity.kind AS kind,
        activity.direction AS direction,
        activity.metadata_json AS metadata_json,
        action.id AS action_id,
        action.sales_cycle_id AS action_cycle_id,
        action.action_type AS action_type,
        action.work_intent AS action_work_intent
      FROM activities AS activity
      LEFT JOIN next_actions AS action
        ON action.id = json_extract(
          activity.metadata_json, '$.todaySelectedCallReceipt.currentActionId'
        )
      WHERE activity.occurred_at >= ? AND activity.occurred_at < ?
        AND json_extract(activity.metadata_json, '$.todaySelectedCallReceipt') IS NOT NULL
      ORDER BY activity.id
    `).all(parsed.dayStartAt, parsed.dayEndAt);
    const activityIds: string[] = [];
    const diagnostics: {
      activityId: string;
      cycleId: string | null;
      kind: 'invalid_selected_call_receipt';
    }[] = [];
    for (const value of rows) {
      const row = z.object({
        id: idSchema,
        sales_cycle_id: z.string().nullable(),
        kind: z.string(),
        direction: z.string(),
        metadata_json: z.string(),
        action_id: z.string().nullable(),
        action_cycle_id: z.string().nullable(),
        action_type: z.string().nullable(),
        action_work_intent: z.string().nullable(),
      }).strict().parse(value);
      const invalid = (): void => {
        diagnostics.push({
          activityId: row.id,
          cycleId: row.sales_cycle_id,
          kind: 'invalid_selected_call_receipt',
        });
      };
      let receipt: z.infer<typeof todaySelectedCallReceiptV1Schema>;
      try {
        const metadata = JSON.parse(row.metadata_json) as { todaySelectedCallReceipt?: unknown };
        receipt = todaySelectedCallReceiptV1Schema.parse(metadata.todaySelectedCallReceipt);
      } catch {
        invalid();
        continue;
      }
      if (row.kind !== 'call' || row.direction !== 'outbound') {
        invalid();
        continue;
      }
      if (receipt.queueTimezone !== parsed.timezone || receipt.queueLocalDate !== parsed.localDate) {
        invalid();
        continue;
      }
      if (
        row.action_id === null
        || row.action_cycle_id === null
        || row.action_cycle_id !== row.sales_cycle_id
        || row.action_type !== 'call'
        || row.action_work_intent !== 'discretionary_prospecting'
      ) {
        invalid();
        continue;
      }
      activityIds.push(row.id);
    }
    return Object.freeze({
      activityIds: Object.freeze(activityIds),
      count: activityIds.length,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export type { TodayDiagnostic };
