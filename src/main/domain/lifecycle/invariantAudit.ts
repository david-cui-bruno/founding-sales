import type { AppDatabase } from '../../db/database';
import type { ZodType } from 'zod';
import { BUILTIN_CADENCES } from '../cadence/builtinCadences';
import { readInstalledCadenceAggregate } from '../cadence/cadenceRepository';
import {
  FOUNDER_CHANNEL_POLICIES_V1, PLAYBOOK_CHANNEL_POLICIES_V2, nextStrictFutureOctoberOne,
} from '../cadence/cadenceScheduler';
import type { SourceEvent } from '../source/sourceTypes';
import { normalizeEmail, normalizePhone } from '../source/contactNormalization';
import {
  optOutProvenanceViolations,
  parseOptOutActivityMetadataJson,
  type OptOutEvidenceActivityFacts,
  type OptOutEvidenceNode,
} from '../optOut/optOutEvidenceValidator';
import type { OptOutTombstone } from '../optOut/optOutTypes';
import {
  collectOptOutClosureReceiptViolations,
  parseStoredOptOutClosureReceipt,
} from '../optOut/optOutClosureReceiptValidator';
import { deriveInboundSla } from './inboundSla';
import {
  reactivationCommandEnvelopeSchema,
  reactivationResultEnvelopeSchema,
  reactivationReviewPayloadSchema,
  reactivationReviewResolutionSchema,
} from './reactivationContracts';
import {
  collectReceiptEvidenceViolations,
  collectReviewEvidenceViolations,
  type ReactivationReceiptEvidence,
  type ReactivationReviewEvidence,
} from './reactivationEvidenceValidator';
import {
  collectActionSettlementViolations,
  type SettlementValidationAction,
} from './actionSettlementValidator';
import {
  collectInstalledCadenceActionBindingViolations,
} from './cadenceActionBindingValidator';
import { validateEffectiveCadencePlan } from './cadenceEffectivePlan';
import {
  actionSettlementSchema, inboundSlaSchema, utcTimestampSchema,
} from './lifecycleValidation';

export type DomainInvariantViolation = Readonly<{
  kind: string;
  recordId: string;
  message: string;
}>;

type Row = Record<string, unknown>;

export function auditDomainInvariants(input: {
  database: AppDatabase;
  asOf: string;
}): readonly DomainInvariantViolation[] {
  const asOf = utcTimestampSchema.parse(input.asOf);
  const violations: DomainInvariantViolation[] = [];
  const add = (kind: string, recordId: unknown, message: string): void => {
    violations.push(Object.freeze({ kind, recordId: String(recordId ?? '<missing>'), message }));
  };
  const rows = (sql: string): Row[] => {
    try {
      return input.database.raw.prepare(sql).all() as Row[];
    } catch (error) {
      add('audit_query_failed', sql.slice(0, 40), error instanceof Error ? error.message : 'query failed');
      return [];
    }
  };

  for (const row of rows(`
    SELECT person.id AS person_id, COUNT(prospect.id) AS count
    FROM persons AS person
    LEFT JOIN prospects AS prospect ON prospect.person_id = person.id
    GROUP BY person.id HAVING COUNT(prospect.id) <> 1
  `)) add('canonical_prospect_cardinality', row.person_id, 'Person must own exactly one canonical Prospect.');

  for (const row of rows(`
    SELECT person_id, COUNT(*) AS count FROM sales_cycles
    WHERE workflow_status IN ('active','onboarding')
    GROUP BY person_id HAVING COUNT(*) > 1
  `)) add('multiple_operational_cycles', row.person_id, 'Person has multiple operational SalesCycles.');

  for (const row of rows(`
    SELECT prospect_id FROM prospect_priority_projection
    WHERE priority = 'p0' AND reachability <> 'direct'
    ORDER BY prospect_id
  `)) add('p0_reachability_invalid', row.prospect_id, 'P0 projection requires Direct reachability.');
  for (const row of rows(`
    SELECT override.id
    FROM priority_overrides AS override
    LEFT JOIN prospect_priority_projection AS projection
      ON projection.prospect_id = override.prospect_id
    WHERE override.override_kind = 'priority' AND override.priority = 'p0'
      AND override.expires_at > ${sqlLiteral(asOf)}
      AND (projection.prospect_id IS NULL OR projection.reachability <> 'direct')
    ORDER BY override.id
  `)) add(
    'p0_override_reachability_invalid', row.id,
    'Effective P0 override requires a Direct current projection.',
  );

  const cycles = rows(`
    SELECT id, person_id, prospect_id, entry_source_event_id, stage, workflow_status, current_next_action_id,
      stage_entered_at, close_reason, close_notes, closed_at, design_partner_fitness,
      resurface_at, resurface_reason
    FROM sales_cycles ORDER BY id
  `);
  const actionRows = rows(`
    SELECT id, sales_cycle_id, action_type, channel, status, timezone, due_at,
      allowed_window, work_intent, inbound_sla_kind, inbound_sla_due_at,
      inbound_sla_source_event_id, inbound_sla_provenance_json,
      cadence_enrollment_id, cadence_step_id, cadence_component_id,
      completion_activity_id, settlement_json, completed_at, version, created_at, updated_at
    FROM next_actions ORDER BY id
  `);
  const actions = new Map(actionRows.map((row) => [String(row.id), row]));
  const wonTermCycleIds = new Set(rows(`
    SELECT sales_cycle_id FROM won_terms ORDER BY sales_cycle_id
  `).map(({ sales_cycle_id }) => String(sales_cycle_id)));
  const supportedIntents = new Set([
    'internal_review', 'inbound_response', 'promised_follow_up', 'discretionary_prospecting',
  ]);
  for (const action of actionRows) {
    if (!supportedIntents.has(String(action.work_intent))) {
      add('action_work_intent_invalid', action.id, 'Action work intent is unsupported.');
    }
    if (!isCanonicalUtc(action.due_at)) add('action_schedule_invalid', action.id, 'Action requires a canonical due date.');
    if (typeof action.timezone !== 'string'
      || action.timezone.trim().length === 0) {
      add('action_schedule_invalid', action.id, 'Action timezone is malformed.');
    }
    const cadenceParts = [
      action.cadence_enrollment_id, action.cadence_step_id, action.cadence_component_id,
    ];
    const present = cadenceParts.filter((value) => value !== null).length;
    if (present !== 0 && present !== 3) {
      add('action_cadence_binding_invalid', action.id, 'Cadence action binding is partial.');
    }
    const slaParts = [
      action.inbound_sla_kind, action.inbound_sla_due_at,
      action.inbound_sla_source_event_id, action.inbound_sla_provenance_json,
    ];
    const slaPresent = slaParts.filter((value) => value !== null).length;
    if ((String(action.work_intent) === 'inbound_response' && slaPresent !== 0 && slaPresent !== 4)
      || (String(action.work_intent) !== 'inbound_response' && slaPresent !== 0)) {
      add('action_inbound_sla_invalid', action.id, 'Inbound SLA union does not match work intent.');
    }
    if (!inboundSlaEvidenceValid(action, cycles, rows)) {
      add('action_inbound_sla_invalid', action.id, 'Inbound SLA provenance is malformed.');
    }
    const isPending = action.status === 'pending';
    const settlement = parseCanonicalWithSchema(action.settlement_json, actionSettlementSchema);
    if ((isPending && (action.completion_activity_id !== null
        || action.completed_at !== null || action.settlement_json !== null))
      || (!isPending && (!isCanonicalUtc(action.completed_at) || settlement === null))
      || (action.settlement_json !== null && settlement === null)) {
      add('action_settlement_invalid', action.id, 'Action status and immutable settlement conflict.');
    }
  }

  const definitionRows = rows(`
    SELECT id, family, version, attempt_cap, content_hash
    FROM cadence_definitions ORDER BY id
  `);
  for (const definition of definitionRows) {
    const builtin = BUILTIN_CADENCES.find(({ id }) => id === definition.id);
    if (builtin !== undefined && (
      definition.family !== builtin.family || definition.version !== builtin.version
      || definition.attempt_cap !== builtin.attemptCap
      || definition.content_hash !== builtin.contentHash
    )) {
      add(
        'cadence_definition_identity_invalid', definition.id,
        'Installed built-in cadence identity/hash is inconsistent.',
      );
    }
  }
  const stepRows = rows(`
    SELECT id, cadence_definition_id, sequence, breakup
    FROM cadence_steps ORDER BY cadence_definition_id, sequence, id
  `);
  const steps = new Map(stepRows.map((row) => [String(row.id), row]));
  const componentRows = rows(`
    SELECT id, cadence_step_id, channel FROM cadence_action_components ORDER BY id
  `);
  const components = new Map(componentRows.map((row) => [String(row.id), row]));
  const enrollmentRows = rows(`
    SELECT enrollment.id, enrollment.sales_cycle_id, enrollment.cadence_definition_id,
      enrollment.status, enrollment.current_step_id, enrollment.scheduled_step_count,
      enrollment.mode, enrollment.allowed_step_ids_json, definition.family,
      definition.version AS definition_version,
      definition.attempt_cap, definition.content_hash, enrollment.created_at
    FROM cadence_enrollments AS enrollment
    LEFT JOIN cadence_definitions AS definition ON definition.id = enrollment.cadence_definition_id
    ORDER BY enrollment.id
  `);
  const enrollments = new Map(enrollmentRows.map((row) => [String(row.id), row]));
  const activeByCycle = new Map<string, Row[]>();
  for (const enrollment of enrollmentRows) {
    if (enrollment.status === 'active') {
      const key = String(enrollment.sales_cycle_id);
      activeByCycle.set(key, [...(activeByCycle.get(key) ?? []), enrollment]);
    }
    let allowedStepIds: readonly string[] | null = null;
    let allowedPlanParseValid = true;
    if (enrollment.allowed_step_ids_json !== null) {
      try {
        const parsed = JSON.parse(String(enrollment.allowed_step_ids_json));
        if (!Array.isArray(parsed) || parsed.length === 0
          || parsed.some((id) => typeof id !== 'string')
          || canonicalJson(parsed) !== enrollment.allowed_step_ids_json) throw new Error();
        allowedStepIds = parsed;
      } catch {
        add('enrollment_allowed_plan_invalid', enrollment.id, 'Allowed plan JSON is malformed.');
        allowedPlanParseValid = false;
      }
    }
    if (allowedPlanParseValid) {
      try {
        const definition = readInstalledCadenceAggregate(
          input.database.raw, String(enrollment.cadence_definition_id),
        );
        if (definition === null) throw new Error('Cadence definition is missing.');
        validateEffectiveCadencePlan({
          definition,
          mode: enrollment.mode as 'standard' | 'inbound_over_cap_response',
          allowedStepIds,
          currentStepId: String(enrollment.current_step_id),
          scheduledStepCount: Number(enrollment.scheduled_step_count),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Effective cadence plan is invalid.';
        const kind = enrollment.mode === 'inbound_over_cap_response'
          ? 'enrollment_over_cap_identity_invalid'
          : message.includes('step count')
            ? 'enrollment_step_count_invalid'
            : 'enrollment_allowed_plan_invalid';
        add(kind, enrollment.id, message);
      }
    }
    if (['cadence_a', 'cadence_b', 'cadence_c'].includes(String(enrollment.family))
      && (typeof enrollment.attempt_cap !== 'number'
        || Number(enrollment.scheduled_step_count) > Number(enrollment.attempt_cap))) {
      add('enrollment_attempt_cap_invalid', enrollment.id, 'Enrollment exceeds its prospecting cap.');
    }
  }

  for (const action of actionRows) {
    const binding = action.cadence_enrollment_id === null
      ? null : enrollments.get(String(action.cadence_enrollment_id));
    const cadence = action.cadence_enrollment_id === null
      ? action.cadence_step_id === null && action.cadence_component_id === null
        ? {
            cadenceEnrollmentId: null, cadenceDefinitionId: null,
            cadenceStepId: null, cadenceComponentId: null,
          } as const
        : null
      : binding === undefined ? null : {
          cadenceEnrollmentId: String(action.cadence_enrollment_id),
          cadenceDefinitionId: String(binding.cadence_definition_id),
          cadenceStepId: String(action.cadence_step_id),
          cadenceComponentId: String(action.cadence_component_id),
        } as const;
    if (cadence === null || collectInstalledCadenceActionBindingViolations(input.database, {
      salesCycleId: String(action.sales_cycle_id), actionType: String(action.action_type),
      channel: action.channel === null ? null : String(action.channel), cadence,
    }).length > 0) {
      add('action_cadence_binding_invalid', action.id, 'Action cadence owner graph/channel is invalid.');
    }
    const settlement = parseCanonicalWithSchema(action.settlement_json, actionSettlementSchema);
    const settlementAction = settlement === null ? null
      : toSettlementValidationAction(action, binding ?? null, settlement);
    if (settlement !== null && (settlementAction === null
      || collectActionSettlementViolations(input.database, settlementAction).length > 0)) {
      add(
        'action_settlement_invalid', action.id,
        'Settlement definition, outcome, or Activity evidence provenance is invalid.',
      );
    }
  }

  for (const activity of rows(`
    SELECT id, sales_cycle_id, cadence_enrollment_id, cadence_step_id,
      cadence_component_id, channel FROM activities ORDER BY id
  `)) {
    const parts = [
      activity.cadence_enrollment_id, activity.cadence_step_id, activity.cadence_component_id,
    ];
    const present = parts.filter((value) => value !== null).length;
    const enrollment = activity.cadence_enrollment_id === null
      ? null : enrollments.get(String(activity.cadence_enrollment_id));
    const step = activity.cadence_step_id === null ? null : steps.get(String(activity.cadence_step_id));
    const component = activity.cadence_component_id === null
      ? null : components.get(String(activity.cadence_component_id));
    if ((present !== 0 && present !== 3)
      || (present === 3 && (
        activity.sales_cycle_id === null || enrollment === undefined
        || step === undefined || component === undefined
        || enrollment.sales_cycle_id !== activity.sales_cycle_id
        || step.cadence_definition_id !== enrollment.cadence_definition_id
        || component.cadence_step_id !== step.id || component.channel !== activity.channel
      ))) {
      add('activity_cadence_binding_invalid', activity.id, 'Activity cadence owner graph/channel is invalid.');
    }
  }

  for (const cycle of cycles) {
    const id = String(cycle.id);
    const isOpen = cycle.workflow_status === 'active' || cycle.workflow_status === 'onboarding';
    const workflowCompatible = (
      cycle.workflow_status === 'active'
        && ['unreviewed', 'ready', 'contacted', 'interviewed', 'offered'].includes(String(cycle.stage))
    ) || (cycle.workflow_status === 'onboarding' && cycle.stage === 'won')
      || (cycle.workflow_status === 'closed'
        && (cycle.stage === 'won' || cycle.stage === 'lost_nurture'));
    if (!workflowCompatible) {
      add('cycle_stage_workflow_invalid', id, 'Cycle stage/workflow state is incompatible.');
    }
    const action = cycle.current_next_action_id === null
      ? undefined : actions.get(String(cycle.current_next_action_id));
    if (isOpen
      && (action === undefined || action.sales_cycle_id !== cycle.id
      || action.status !== 'pending')) {
      add('current_action_invalid', id, 'Open cycle lacks one own pending current action.');
    }

    if ((cycle.resurface_at === null) !== (cycle.resurface_reason === null)
      || (cycle.resurface_at !== null && !isCanonicalUtc(cycle.resurface_at))
      || (cycle.resurface_reason !== null
        && cycle.resurface_reason !== 'snooze' && cycle.resurface_reason !== 'callback')) {
      add('cycle_resurface_invalid', id, 'Founder resurface marker is malformed.');
    }
    if (!isOpen && cycle.current_next_action_id !== null) {
      add('closed_cycle_pointer_invalid', id, 'Closed cycle retains a current action pointer.');
    }
    if (cycle.workflow_status === 'closed' && !isCanonicalUtc(cycle.closed_at)) {
      add('closed_cycle_timestamp_invalid', id, 'Closed cycle lacks a canonical close time.');
    }
    if (cycle.stage === 'lost_nurture') {
      if (typeof cycle.close_reason !== 'string'
        || (cycle.close_reason === 'other'
          && (typeof cycle.close_notes !== 'string' || cycle.close_notes.trim().length === 0))) {
        add('lost_nurture_reason_invalid', id, 'Lost-Nurture reason is incomplete.');
      }
      const rules = rows(`
        SELECT id, rule_type, due_at, matcher_json
        FROM reactivation_rules WHERE sales_cycle_id = ${sqlLiteral(id)} ORDER BY rule_type, id
      `);
      if (cycle.close_reason !== 'opt_out'
        && !reactivationCardinalityValid(id, enrollmentRows, rules)) {
        add('lost_nurture_reactivation_invalid', id, 'Non-opt-out Lost-Nurture has no reactivation rule.');
      }
      if (cycle.close_reason === 'opt_out' && rules.length !== 0) {
        add('lost_nurture_reactivation_invalid', id, 'Opt-out must have zero reactivation rules.');
      }
    }
    if (cycle.stage === 'won' && !wonTermCycleIds.has(id)) {
      add('won_terms_missing', id, 'Won cycle lacks immutable founding terms.');
    }
    const active = activeByCycle.get(id) ?? [];
    const expectedFamily = expectedActiveCadenceFamily(cycle.stage, cycle.workflow_status);
    const acceptedTerminalBridge = active.length === 0 && action?.cadence_enrollment_id === null
      && (
        (cycle.stage === 'interviewed' && action.work_intent === 'internal_review')
        || ((cycle.stage === 'ready' || cycle.stage === 'contacted')
          && (action.work_intent === 'inbound_response'
            || action.work_intent === 'promised_follow_up'
            || action.work_intent === 'internal_review'))
      );
    if (cycle.stage === 'unreviewed' && active.length !== 0) {
      add('stage_cadence_invalid', id, 'Unreviewed cycle cannot own an active cadence.');
    }
    if (expectedFamily !== null
      && !acceptedTerminalBridge
      && (active.length !== 1 || !expectedFamily.includes(String(active[0]?.family)))) {
      add('stage_cadence_invalid', id, 'Cycle stage does not own its exact active cadence.');
    }
    if (!isOpen && active.length !== 0) {
      add('closed_cycle_cadence_invalid', id, 'Closed cycle retains an active cadence.');
    }
    if (active.length === 1 && !acceptedTerminalBridge && action !== undefined
      && (action.cadence_enrollment_id !== active[0]!.id
        || action.cadence_step_id !== active[0]!.current_step_id)) {
      add('current_action_cadence_invalid', id, 'Current action does not match the active enrollment step.');
    }
    const stageEvents = rows(`
      SELECT from_stage, to_stage, effective_at, transition_sequence
      FROM stage_events WHERE sales_cycle_id = ${sqlLiteral(id)}
      ORDER BY transition_sequence
    `);
    auditStageChain(stageEvents, cycle, add);
    if (cycle.design_partner_fitness !== null
      && !stageEvents.some(({ to_stage }) => (
        to_stage === 'interviewed' || to_stage === 'offered' || to_stage === 'won'
      ))) {
      add(
        'design_partner_fitness_invalid',
        id,
        'Design-partner fitness requires immutable Interviewed history.',
      );
    }
  }

  for (const row of rows(`
    SELECT person.id FROM persons AS person
    JOIN sales_cycles AS cycle ON cycle.person_id = person.id
    WHERE person.opted_out = 1 AND cycle.workflow_status IN ('active','onboarding')
    ORDER BY person.id
  `)) add('opted_out_open_workflow', row.id, 'Opted-out Person retains an open workflow.');

  for (const row of rows(`
    SELECT DISTINCT cycle.person_id, action.id AS action_id
    FROM sales_cycles AS cycle
    JOIN next_actions AS action ON action.sales_cycle_id = cycle.id
    LEFT JOIN persons AS person ON person.id = cycle.person_id
    LEFT JOIN opt_out_tombstones AS tombstone ON tombstone.person_id = cycle.person_id
    WHERE (person.opted_out = 1 OR tombstone.id IS NOT NULL)
      AND action.status = 'pending' AND action.channel IS NOT NULL
    ORDER BY cycle.person_id, action.id
  `)) add(
    'opted_out_pending_outbound', row.action_id,
    'Opted-out Person retains pending outbound work.',
  );
  for (const row of rows(`
    SELECT DISTINCT enrollment.id
    FROM cadence_enrollments AS enrollment
    JOIN sales_cycles AS cycle ON cycle.id = enrollment.sales_cycle_id
    LEFT JOIN persons AS person ON person.id = cycle.person_id
    LEFT JOIN opt_out_tombstones AS tombstone ON tombstone.person_id = cycle.person_id
    WHERE (person.opted_out = 1 OR tombstone.id IS NOT NULL)
      AND enrollment.status = 'active'
    ORDER BY enrollment.id
  `)) add(
    'opted_out_active_cadence', row.id,
    'Opted-out Person retains an active cadence.',
  );

  const optOutRows = rows(`
    SELECT person.id, person.opted_out, person.opted_out_at,
      tombstone.id AS tombstone_id, tombstone.requested_at,
      tombstone.observed_channel, tombstone.source_activity_id,
      tombstone.evidence_ref, tombstone.policy_version, tombstone.created_at,
      activity.person_id AS activity_person_id, activity.kind AS activity_kind,
      activity.direction AS activity_direction, activity.channel AS activity_channel,
      activity.occurred_at AS activity_occurred_at,
      activity.observed_outcome AS activity_outcome,
      activity.adapter AS activity_adapter,
      activity.provider_idempotency_key AS activity_provider_key,
      activity.provider_reference AS activity_provider_reference,
      activity.metadata_json AS activity_metadata_json
    FROM persons AS person
    LEFT JOIN opt_out_tombstones AS tombstone ON tombstone.person_id = person.id
    LEFT JOIN activities AS activity ON activity.id = tombstone.source_activity_id
    WHERE person.opted_out = 1 OR tombstone.id IS NOT NULL
    ORDER BY person.id
  `);
  const evidenceByTombstoneId = new Map<string, OptOutEvidenceNode>();
  for (const row of optOutRows) {
    if (typeof row.tombstone_id === 'string') {
      evidenceByTombstoneId.set(row.tombstone_id, Object.freeze({
        tombstone: tombstoneFromAuditRow(row),
        activity: activityFromAuditRow(row),
      }));
    }
  }
  for (const row of optOutRows) {
    const hasTombstone = typeof row.tombstone_id === 'string';
    const projectionValid = hasTombstone && row.opted_out === 1
      && row.opted_out_at === row.requested_at;
    if (!projectionValid) {
      add('opt_out_projection_invalid', row.id, 'Person opt-out projection does not match its tombstone.');
    }
    if (!hasTombstone) continue;
    const root = evidenceByTombstoneId.get(String(row.tombstone_id))!;
    if (optOutProvenanceViolations({
      root,
      loadSource: (tombstoneId) => evidenceByTombstoneId.get(tombstoneId) ?? null,
    }).length !== 0) {
      add('opt_out_tombstone_invalid', row.tombstone_id, 'Opt-out tombstone evidence is malformed.');
    }
  }
  for (const row of rows(`
    SELECT handle.id, handle.kind, handle.normalized_value, handle.created_at
    FROM opt_out_handles AS handle ORDER BY handle.id
  `)) {
    let canonical = false;
    try {
      const normalized = row.kind === 'phone'
        ? normalizePhone(String(row.normalized_value))
        : row.kind === 'email' ? normalizeEmail(String(row.normalized_value)) : '';
      canonical = normalized === row.normalized_value;
    } catch {
      canonical = false;
    }
    if (!canonical || !isCanonicalUtc(row.created_at)) {
      add('opt_out_handle_invalid', row.id, 'Blocked handle is not canonical.');
    }
  }
  for (const row of rows(`
    SELECT contact.id
    FROM person_contact_methods AS contact
    JOIN opt_out_tombstones AS tombstone ON tombstone.person_id = contact.person_id
    WHERE NOT EXISTS (
      SELECT 1 FROM opt_out_handles AS handle
      WHERE handle.tombstone_id = tombstone.id
        AND handle.kind = contact.kind
        AND handle.normalized_value = contact.normalized_value
    )
    ORDER BY contact.id
  `)) add(
    'opt_out_handle_retention_invalid', row.id,
    'An opted-out Person contact method is missing from permanent handle retention.',
  );

  for (const row of rows(`
    SELECT source_activity_id, operation_kind, person_id, tombstone_id,
      source_tombstone_id, closed_cycle_id, terminal_stage_event_id,
      command_json, result_json, created_at
    FROM opt_out_closure_receipts ORDER BY source_activity_id
  `)) {
    try {
      const receipt = parseStoredOptOutClosureReceipt(row);
      if (collectOptOutClosureReceiptViolations(input.database, receipt).length !== 0) {
        add(
          'opt_out_closure_receipt_invalid',
          receipt.sourceActivityId,
          'Opt-out closure receipt is not a canonical lifecycle closure result.',
        );
      }
    } catch {
      add(
        'opt_out_closure_receipt_invalid',
        row.source_activity_id,
        'Opt-out closure receipt is malformed.',
      );
    }
  }

  const receipts = rows(`
    SELECT activation_key, activation_kind, person_id, source_cycle_id,
      reactivation_rule_id, source_event_id, new_cycle_id, command_json, result_json,
      created_at
    FROM cycle_reactivation_receipts ORDER BY activation_key
  `);
  const ruleRows = rows(`
    SELECT id, sales_cycle_id, rule_type, due_at, matcher_json, version,
      consumed_at, created_at FROM reactivation_rules ORDER BY id
  `);
  const workspaceTimezone = String(rows(`
    SELECT timezone FROM workspace_settings WHERE singleton = 1
  `)[0]?.timezone ?? '');
  const rulesById = new Map(ruleRows.map((row) => [String(row.id), row]));
  const receiptRuleIds = new Set(receipts
    .map(({ reactivation_rule_id }) => reactivation_rule_id)
    .filter((value): value is string => typeof value === 'string'));
  for (const receipt of receipts) {
    const isRule = receipt.activation_kind === 'rule';
    const expectedKey = isRule
      ? `rule:${String(receipt.reactivation_rule_id)}`
      : `inbound:${String(receipt.source_event_id)}`;
    const command = parseCanonicalWithSchema(
      receipt.command_json, reactivationCommandEnvelopeSchema,
    );
    const result = parseCanonicalWithSchema(
      receipt.result_json, reactivationResultEnvelopeSchema,
    );
    const sourceCycle = cycles.find(({ id }) => id === receipt.source_cycle_id);
    const commandValue = command?.command;
    const resultValue = result?.result;
    const rule = receipt.reactivation_rule_id === null
      ? undefined : rulesById.get(String(receipt.reactivation_rule_id));
    const sourceOwned = isRule
      ? receipt.reactivation_rule_id !== null && receipt.source_event_id === null
        && rule?.sales_cycle_id === receipt.source_cycle_id
      : receipt.reactivation_rule_id === null && receipt.source_event_id !== null
        && rows(`
          SELECT id FROM source_events
          WHERE id = ${sqlLiteral(String(receipt.source_event_id))}
            AND person_id = ${sqlLiteral(String(receipt.person_id))}
        `).length === 1;
    const target = cycles.find(({ id }) => id === receipt.new_cycle_id);
    const pinnedDefinition = commandValue === undefined ? undefined
      : definitionRows.find(({ id }) => id === commandValue.cadence.definitionId);
    const pinnedEnrollment = commandValue === undefined ? undefined
      : enrollmentRows.find(({ sales_cycle_id, cadence_definition_id }) => (
        sales_cycle_id === receipt.new_cycle_id
        && cadence_definition_id === commandValue.cadence.definitionId
      ));
    const aggregateOwned = commandValue !== undefined && resultValue !== undefined
      && resultValue.cycle.prospectId === commandValue.prospectId
      && target?.prospect_id === commandValue.prospectId
      && target.entry_source_event_id === resultValue.cycle.entrySourceEventId
      && pinnedDefinition?.family === commandValue.cadence.family
      && pinnedDefinition?.version === commandValue.cadence.version
      && pinnedDefinition?.content_hash === commandValue.cadence.contentHash
      && pinnedEnrollment !== undefined;
    const strictEvidenceInvalid = command === null || result === null
      || collectReceiptEvidenceViolations(input.database, {
        activationKey: String(receipt.activation_key),
        activationKind: receipt.activation_kind as ReactivationReceiptEvidence['activationKind'],
        personId: String(receipt.person_id), sourceCycleId: String(receipt.source_cycle_id),
        reactivationRuleId: receipt.reactivation_rule_id === null
          ? null : String(receipt.reactivation_rule_id),
        sourceEventId: receipt.source_event_id === null ? null : String(receipt.source_event_id),
        newCycleId: String(receipt.new_cycle_id), command, result,
        createdAt: String(receipt.created_at),
      }).length > 0;
    if (receipt.activation_key !== expectedKey || command === null || result === null
      || !sourceOwned || sourceCycle === undefined
      || sourceCycle.person_id !== receipt.person_id || sourceCycle.workflow_status !== 'closed'
      || !aggregateOwned || strictEvidenceInvalid
      || !reactivationReceiptEnvelopeMatches(
        receipt, command as unknown as Record<string, unknown>,
        result as unknown as Record<string, unknown>,
      )) {
      add('reactivation_receipt_invalid', receipt.activation_key, 'Reactivation receipt is malformed.');
    }
    if (target === undefined || target.person_id !== receipt.person_id) {
      add('reactivation_receipt_invalid', receipt.activation_key, 'Receipt target ownership is invalid.');
    }
  }
  for (const rule of ruleRows) {
    const cycle = cycles.find(({ id }) => id === rule.sales_cycle_id);
    if (!reactivationRuleRowValid(rule, workspaceTimezone)
      || cycle === undefined || cycle.stage !== 'lost_nurture' || cycle.workflow_status !== 'closed') {
      add('reactivation_rule_invalid', rule.id, 'Reactivation rule definition/ownership is malformed.');
    }
    if ((rule.consumed_at !== null) !== receiptRuleIds.has(String(rule.id))) {
      add('reactivation_consumption_invalid', rule.id, 'Consumed rule has no immutable receipt.');
    }
  }
  for (const review of rows(`
    SELECT id, activation_key, status, person_id, prospect_id, source_cycle_id,
      reason, payload_json, resolution_json, resolved_at, reactivation_rule_id, source_event_id,
      version, created_at, updated_at
    FROM lifecycle_review_items ORDER BY id
  `)) {
    const resolved = review.status === 'resolved';
    const payload = parseCanonicalWithSchema(review.payload_json, reactivationReviewPayloadSchema);
    const resolution = review.resolution_json === null ? null
      : parseCanonicalWithSchema(review.resolution_json, reactivationReviewResolutionSchema);
    const strictEvidenceInvalid = payload === null || (review.resolution_json !== null && resolution === null)
      || collectReviewEvidenceViolations(input.database, {
        id: String(review.id), activationKey: String(review.activation_key),
        status: review.status as ReactivationReviewEvidence['status'],
        personId: String(review.person_id), prospectId: String(review.prospect_id),
        sourceCycleId: String(review.source_cycle_id),
        reactivationRuleId: review.reactivation_rule_id === null
          ? null : String(review.reactivation_rule_id),
        sourceEventId: review.source_event_id === null ? null : String(review.source_event_id),
        reason: String(review.reason), payload: payload!, resolution,
        resolvedAt: review.resolved_at === null ? null : String(review.resolved_at),
        version: Number(review.version), createdAt: String(review.created_at),
        updatedAt: String(review.updated_at),
      }).length > 0;
    if (payload === null
      || resolved !== (review.resolution_json !== null && review.resolved_at !== null)
      || (review.resolution_json !== null && resolution === null)
      || (payload !== null && (
        payload.command.personId !== review.person_id
        || payload.command.prospectId !== review.prospect_id
        || payload.command.sourceCycleId !== review.source_cycle_id
        || payload.blocker !== review.reason
      )) || strictEvidenceInvalid) {
      add('lifecycle_review_invalid', review.id, 'Lifecycle Review envelope/state is malformed.');
    }
    if (review.status === 'open'
      && receipts.some(({ activation_key }) => activation_key === review.activation_key)) {
      add('lifecycle_review_invalid', review.id, 'Open Review conflicts with a committed receipt.');
    }
    const isRule = review.reactivation_rule_id !== null;
    const expectedKey = isRule
      ? `rule:${String(review.reactivation_rule_id)}`
      : review.source_event_id === null && payload !== null
        && 'evidence' in payload.command && payload.command.evidence.kind === 'unknown_handle'
        ? `inbound-handle:${payload.command.evidence.handleKind}:${payload.command.evidence.normalizedValue}`
        : `inbound:${String(review.source_event_id)}`;
    const sourceCycle = cycles.find(({ id }) => id === review.source_cycle_id);
    const unknownHandle = payload !== null && 'evidence' in payload.command
      && payload.command.evidence.kind === 'unknown_handle';
    const sourceValid = sourceCycle !== undefined && sourceCycle.person_id === review.person_id
      && sourceCycle.prospect_id === review.prospect_id
      && (isRule
        ? review.source_event_id === null
          && rulesById.get(String(review.reactivation_rule_id))?.sales_cycle_id === review.source_cycle_id
        : review.reactivation_rule_id === null
          && (unknownHandle ? review.source_event_id === null : review.source_event_id !== null));
    const resolutionValid = resolution === null || payload === null
      ? resolution === null
      : resolution.newCycleId === payload.command.newCycleId
        && canonicalJson(resolution.cadence) === canonicalJson(payload.command.cadence)
        && cycles.some(({ id: cycleId, person_id, prospect_id }) => (
          cycleId === resolution.newCycleId
          && person_id === review.person_id && prospect_id === review.prospect_id
        ))
        && enrollmentRows.some(({ sales_cycle_id, cadence_definition_id }) => (
          sales_cycle_id === resolution.newCycleId
          && cadence_definition_id === resolution.cadence.definitionId
        ));
    if (review.activation_key !== expectedKey || !sourceValid || !resolutionValid
      || (review.status === 'open' && isRule
        && rulesById.get(String(review.reactivation_rule_id))?.consumed_at !== null)) {
      add('lifecycle_review_invalid', review.id, 'Lifecycle Review ownership/cardinality is invalid.');
    }
  }

  for (const row of rows(`
    SELECT terms.sales_cycle_id, terms.doors_committed, terms.billing_model,
      terms.unit_rate_cents, terms.projected_mrr_cents, terms.projection_formula_version,
      terms.manual_projection_reason, terms.founding_customer, terms.effective_at, terms.created_at,
      cycle.stage, cycle.workflow_status
    FROM won_terms AS terms
    LEFT JOIN sales_cycles AS cycle ON cycle.id = terms.sales_cycle_id
    ORDER BY terms.sales_cycle_id
  `)) {
    const expected = row.billing_model === 'per_door_monthly'
      ? Number(row.doors_committed) * Number(row.unit_rate_cents)
      : row.billing_model === 'flat_monthly' ? Number(row.unit_rate_cents) : Number(row.projected_mrr_cents);
    if (row.stage !== 'won'
      || (row.workflow_status !== 'onboarding' && row.workflow_status !== 'closed')
      || !isNonnegativeSafeInteger(row.doors_committed)
      || !isNonnegativeSafeInteger(row.unit_rate_cents)
      || !isNonnegativeSafeInteger(row.projected_mrr_cents)
      || Number(row.projected_mrr_cents) !== expected
      || row.projection_formula_version !== 'founder_terms_v1'
      || (row.founding_customer !== 0 && row.founding_customer !== 1)
      || !isCanonicalUtc(row.effective_at) || !isCanonicalUtc(row.created_at)
      || (row.billing_model === 'manual_projected_monthly'
        && (typeof row.manual_projection_reason !== 'string'
          || row.manual_projection_reason.trim().length === 0))) {
      add('won_terms_invalid', row.sales_cycle_id, 'Won terms projection is inconsistent.');
    }
  }

  for (const row of rows(`
    SELECT sales_cycle_id, pain_confirmed, decision_authority_confirmed,
      concrete_trial_identified, readiness_json, version, assessed_at, updated_at
    FROM sales_cycle_close_readiness ORDER BY sales_cycle_id
  `)) {
    const readiness = parseCloseReadiness(row.readiness_json);
    const evidenceOwned = readiness !== null && readiness.dimensions.every((dimension) => (
      dimension.evidenceActivityIds.every((activityId) => rows(`
        SELECT id FROM activities
        WHERE id = ${sqlLiteral(activityId)}
          AND sales_cycle_id = ${sqlLiteral(String(row.sales_cycle_id))}
      `).length === 1)
    ));
    if (readiness === null || !evidenceOwned
      || !Number.isSafeInteger(row.version) || Number(row.version) <= 0
      || !isCanonicalUtc(row.assessed_at) || !isCanonicalUtc(row.updated_at)
      || row.pain_confirmed !== Number(readiness.demonstratedPain)
      || row.decision_authority_confirmed !== Number(readiness.decisionAuthority)
      || row.concrete_trial_identified !== Number(readiness.concreteNextStep)) {
      add('close_readiness_invalid', row.sales_cycle_id, 'Close-readiness projection/envelope is malformed.');
    }
  }

  violations.sort((left, right) => left.kind.localeCompare(right.kind)
    || left.recordId.localeCompare(right.recordId));
  return Object.freeze(violations);
}

function auditStageChain(
  events: Row[],
  cycle: Row,
  add: (kind: string, recordId: unknown, message: string) => void,
): void {
  let previous: string | null = null;
  let invalid = events.length === 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.transition_sequence !== index + 1 || event.from_stage !== previous
      || !isCanonicalUtc(event.effective_at)) invalid = true;
    if (!isLegalStageEdge(event.from_stage, event.to_stage, index === 0)) invalid = true;
    previous = String(event.to_stage);
  }
  const last = events.at(-1);
  if (last === undefined || last.to_stage !== cycle.stage
    || last.effective_at !== cycle.stage_entered_at) invalid = true;
  if (invalid) add('stage_event_chain_invalid', cycle.id, 'StageEvent chain does not match projection.');
}

function isLegalStageEdge(from: unknown, to: unknown, initial: boolean): boolean {
  if (initial) return from === null && (to === 'unreviewed' || to === 'ready' || to === 'contacted');
  const edges = new Set([
    'unreviewed>ready', 'unreviewed>lost_nurture',
    'ready>contacted', 'ready>lost_nurture',
    'contacted>interviewed', 'contacted>lost_nurture',
    'interviewed>offered', 'interviewed>lost_nurture',
    'offered>won', 'offered>lost_nurture',
  ]);
  return edges.has(`${String(from)}>${String(to)}`);
}

function expectedActiveCadenceFamily(stage: unknown, workflow: unknown): readonly string[] | null {
  if (workflow === 'closed' || stage === 'unreviewed') return null;
  if (stage === 'ready' || stage === 'contacted') return ['cadence_a', 'cadence_b', 'cadence_c'];
  if (stage === 'interviewed') return ['post_interview'];
  if (stage === 'offered') return ['post_offer'];
  if (stage === 'won' && workflow === 'onboarding') return ['onboarding'];
  return [];
}

function isCanonicalUtc(value: unknown): boolean {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function tombstoneFromAuditRow(row: Row): OptOutTombstone {
  return {
    id: String(row.tombstone_id), personId: String(row.id),
    requestedAt: String(row.requested_at),
    observedChannel: row.observed_channel as OptOutTombstone['observedChannel'],
    sourceActivityId: String(row.source_activity_id),
    evidenceRef: typeof row.evidence_ref === 'string' ? row.evidence_ref : null,
    policyVersion: String(row.policy_version), createdAt: String(row.created_at),
  };
}

function activityFromAuditRow(row: Row): OptOutEvidenceActivityFacts | null {
  if (typeof row.source_activity_id !== 'string' || typeof row.activity_person_id !== 'string') {
    return null;
  }
  const metadata = parseOptOutActivityMetadataJson(row.activity_metadata_json);
  return {
    id: row.source_activity_id,
    personId: row.activity_person_id,
    kind: String(row.activity_kind),
    direction: String(row.activity_direction),
    channel: String(row.activity_channel),
    occurredAt: String(row.activity_occurred_at),
    observedOutcome: typeof row.activity_outcome === 'string' ? row.activity_outcome : null,
    adapter: typeof row.activity_adapter === 'string' ? row.activity_adapter : null,
    providerIdempotencyKey: typeof row.activity_provider_key === 'string'
      ? row.activity_provider_key : null,
    providerReference: typeof row.activity_provider_reference === 'string'
      ? row.activity_provider_reference : null,
    metadata: metadata.metadata,
    metadataValid: metadata.success,
  };
}

function isStrictVersionedJson(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null
      && (parsed as { version?: unknown }).version === 1;
  } catch {
    return false;
  }
}

function isCanonicalVersionedJson(value: unknown): boolean {
  if (!isStrictVersionedJson(value) || typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return canonicalJson(parsed) === value;
  } catch {
    return false;
  }
}

function parseCanonicalVersionedObject(value: unknown): Record<string, unknown> | null {
  if (!isCanonicalVersionedJson(value) || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseActionInboundSla(action: Row): ReturnType<typeof inboundSlaSchema.parse> | null {
  if (action.inbound_sla_kind === null) {
    return action.inbound_sla_due_at === null
      && action.inbound_sla_source_event_id === null
      && action.inbound_sla_provenance_json === null
      ? { kind: 'none', dueAt: null, sourceEventId: null, provenance: null }
      : null;
  }
  if (typeof action.inbound_sla_provenance_json !== 'string') return null;
  try {
    const provenance = JSON.parse(action.inbound_sla_provenance_json) as unknown;
    const parsed = inboundSlaSchema.safeParse({
      kind: action.inbound_sla_kind, dueAt: action.inbound_sla_due_at,
      sourceEventId: action.inbound_sla_source_event_id, provenance,
    });
    return parsed.success && canonicalJson(parsed.data.provenance)
      === action.inbound_sla_provenance_json ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseCloseReadiness(value: unknown): {
  demonstratedPain: boolean;
  decisionAuthority: boolean;
  concreteNextStep: boolean;
  dimensions: readonly { evidenceActivityIds: readonly string[] }[];
} | null {
  const parsed = parseCanonicalVersionedObject(value);
  if (parsed === null || parsed.version !== 1) return null;
  const keys = [
    'demonstratedPain', 'activeTimeline', 'decisionAuthority',
    'willingnessToTryOrPay', 'concreteNextStep',
  ] as const;
  if (Object.keys(parsed).sort().join('|') !== [...keys, 'version'].sort().join('|')) return null;
  const dimensions: Array<{ value: string; evidenceActivityIds: readonly string[] }> = [];
  for (const key of keys) {
    const dimension = parsed[key];
    if (!isRecord(dimension)
      || Object.keys(dimension).sort().join('|') !== 'evidenceActivityIds|value'
      || !['unknown', 'weak', 'moderate', 'strong'].includes(String(dimension.value))
      || !Array.isArray(dimension.evidenceActivityIds)
      || dimension.evidenceActivityIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
      || new Set(dimension.evidenceActivityIds).size !== dimension.evidenceActivityIds.length) {
      return null;
    }
    dimensions.push({
      value: String(dimension.value), evidenceActivityIds: dimension.evidenceActivityIds,
    });
  }
  const confirmed = (key: typeof keys[number]): boolean => {
    const strength = String((parsed[key] as Record<string, unknown>).value);
    return strength === 'moderate' || strength === 'strong';
  };
  return {
    demonstratedPain: confirmed('demonstratedPain'),
    decisionAuthority: confirmed('decisionAuthority'),
    concreteNextStep: confirmed('concreteNextStep'),
    dimensions,
  };
}

function reactivationRuleRowValid(rule: Row, timezone: string): boolean {
  if (rule.version !== 1 || !isCanonicalUtc(rule.created_at)
    || (rule.consumed_at !== null && !isCanonicalUtc(rule.consumed_at))) return false;
  if (rule.rule_type === 'manual') {
    return isCanonicalUtc(rule.due_at) && rule.matcher_json === null
      && String(rule.due_at) > String(rule.created_at);
  }
  if (rule.rule_type === 'seasonal:heating-oct1') {
    if (!isCanonicalUtc(rule.due_at) || rule.matcher_json !== null) return false;
    try {
      return rule.due_at === nextStrictFutureOctoberOne({
        evaluationAt: String(rule.created_at), timezone,
      }).dueAt;
    } catch {
      return false;
    }
  }
  if (rule.rule_type !== 'new-frbo-listing'
    && rule.rule_type !== 'lead-cert-expiry-window') return false;
  const matcher = parseCanonicalVersionedObject(rule.matcher_json);
  return rule.due_at === null && matcher !== null
    && Object.keys(matcher).sort().join('|') === 'eventType|personWide|version'
    && matcher.eventType === rule.rule_type && matcher.personWide === true;
}

function reactivationReceiptEnvelopeMatches(
  receipt: Row,
  commandEnvelope: Record<string, unknown>,
  resultEnvelope: Record<string, unknown>,
): boolean {
  const command = commandEnvelope.command;
  const result = resultEnvelope.result;
  if (!isRecord(command) || !isRecord(result) || result.kind !== 'reactivated'
    || result.activationKind !== receipt.activation_kind || !isRecord(result.cycle)
    || !isRecord(result.cadence) || !isRecord(command.cadence)
    || result.cycle.id !== receipt.new_cycle_id || result.cycle.personId !== receipt.person_id
    || command.personId !== receipt.person_id || command.sourceCycleId !== receipt.source_cycle_id
    || command.newCycleId !== receipt.new_cycle_id || !isCanonicalUtc(command.activatedAt)
    || canonicalJson(result.cadence) !== canonicalJson(command.cadence)) return false;
  if (receipt.activation_kind === 'rule') {
    return command.ruleId === receipt.reactivation_rule_id
      && typeof command.ruleType === 'string'
      && command.entrySourceEventId === result.cycle.entrySourceEventId
      && isRecord(command.trigger)
      && (command.trigger.kind === 'due' || command.trigger.kind === 'source_event');
  }
  return isRecord(command.evidence) && command.evidence.kind === 'source_event'
    && command.evidence.sourceEventId === receipt.source_event_id
    && result.cycle.entrySourceEventId === receipt.source_event_id
    && !('ruleId' in command) && !('ruleType' in command);
}

function parseCanonicalWithSchema<T>(value: unknown, schema: ZodType<T>): T | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value) as unknown);
    return parsed.success && canonicalJson(parsed.data) === value ? parsed.data : null;
  } catch {
    return null;
  }
}

function inboundSlaEvidenceValid(
  action: Row,
  cycles: readonly Row[],
  rows: (sql: string) => Row[],
): boolean {
  const rawParts = [
    action.inbound_sla_kind, action.inbound_sla_due_at,
    action.inbound_sla_source_event_id, action.inbound_sla_provenance_json,
  ];
  const present = rawParts.filter((value) => value !== null).length;
  if (present === 0) return true;
  if (present !== 4 || action.work_intent !== 'inbound_response') return false;
  if (typeof action.inbound_sla_provenance_json !== 'string') return false;
  let provenance: unknown;
  try {
    provenance = JSON.parse(action.inbound_sla_provenance_json);
  } catch {
    return false;
  }
  const inbound = inboundSlaSchema.safeParse({
    kind: action.inbound_sla_kind, dueAt: action.inbound_sla_due_at,
    sourceEventId: action.inbound_sla_source_event_id, provenance,
  });
  if (!inbound.success || canonicalJson(inbound.data.provenance)
      !== action.inbound_sla_provenance_json) return false;
  const cycle = cycles.find(({ id }) => id === action.sales_cycle_id);
  if (cycle === undefined) return false;
  const source = rows(`
    SELECT id, person_id, prospect_id, sales_cycle_id, channel, observed_at,
      evidence_ref, referred_by_person_id, referrer_unknown_reason, created_at
    FROM source_events
    WHERE id = ${sqlLiteral(String(action.inbound_sla_source_event_id))}
  `)[0];
  const expectedChannel = inbound.data.kind === 'inbound_demo_permitted_minutes'
    ? 'inbound_demo' : 'referral';
  if (source === undefined || source.person_id !== cycle.person_id) return false;
  if (source.channel !== expectedChannel
    || source.observed_at !== inbound.data.provenance.sourceObservedAt
    || typeof action.timezone !== 'string') return false;
  try {
    const expected = deriveInboundSla({
      id: String(source.id), personId: String(source.person_id),
      prospectId: source.prospect_id === null ? null : String(source.prospect_id),
      salesCycleId: source.sales_cycle_id === null ? null : String(source.sales_cycle_id),
      channel: source.channel as SourceEvent['channel'],
      observedAt: String(source.observed_at), sourceRecord: {},
      evidenceRef: source.evidence_ref === null ? null : String(source.evidence_ref),
      referral: null, customSourceReason: null, createdAt: String(source.created_at),
    }, action.timezone, inbound.data.provenance?.policyId === PLAYBOOK_CHANNEL_POLICIES_V2.text.id
      ? PLAYBOOK_CHANNEL_POLICIES_V2 : FOUNDER_CHANNEL_POLICIES_V1);
    return canonicalJson(expected) === canonicalJson(inbound.data);
  } catch {
    return false;
  }
}

function toSettlementValidationAction(
  action: Row,
  enrollment: Row | null,
  settlement: ReturnType<typeof actionSettlementSchema.parse>,
): SettlementValidationAction | null {
  const status = action.status;
  const workIntent = action.work_intent;
  if (!['pending', 'completed', 'cancelled', 'impossible'].includes(String(status))
    || !['internal_review', 'inbound_response', 'promised_follow_up', 'discretionary_prospecting']
      .includes(String(workIntent))) return null;
  const inboundSla = parseActionInboundSla(action);
  if (inboundSla === null) return null;
  const cadence = action.cadence_enrollment_id === null
    ? {
        cadenceEnrollmentId: null, cadenceDefinitionId: null,
        cadenceStepId: null, cadenceComponentId: null,
      } as const
    : enrollment === null ? null : {
        cadenceEnrollmentId: String(action.cadence_enrollment_id),
        cadenceDefinitionId: String(enrollment.cadence_definition_id),
        cadenceStepId: String(action.cadence_step_id),
        cadenceComponentId: String(action.cadence_component_id),
      } as const;
  if (cadence === null) return null;
  return {
    id: String(action.id), salesCycleId: String(action.sales_cycle_id),
    actionType: String(action.action_type),
    channel: action.channel === null ? null : String(action.channel),
    status: status as SettlementValidationAction['status'],
    workIntent: workIntent as SettlementValidationAction['workIntent'],
    inboundSla, cadence,
    completionActivityId: action.completion_activity_id === null
      ? null : String(action.completion_activity_id),
    settlement: settlement as SettlementValidationAction['settlement'],
  };
}

function reactivationCardinalityValid(
  cycleId: string,
  enrollments: readonly Row[],
  rules: readonly Row[],
): boolean {
  const history = enrollments.filter(({ sales_cycle_id }) => sales_cycle_id === cycleId);
  const last = [...history].sort((left, right) => (
    String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id))
  )).at(-1);
  const family = String(last?.family ?? 'none');
  const types = rules.map(({ rule_type }) => String(rule_type)).sort();
  const exact = (...expected: string[]): boolean => (
    canonicalJson(types) === canonicalJson([...expected].sort())
  );
  if (family === 'cadence_a') {
    return exact('seasonal:heating-oct1', 'new-frbo-listing')
      || exact('manual')
      || exact('seasonal:heating-oct1', 'new-frbo-listing', 'manual');
  }
  if (family === 'cadence_b') {
    return exact('seasonal:heating-oct1', 'lead-cert-expiry-window')
      || exact('manual')
      || exact('seasonal:heating-oct1', 'lead-cert-expiry-window', 'manual');
  }
  return exact('manual');
}

function isNonnegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
