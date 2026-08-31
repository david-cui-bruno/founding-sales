import type { AppDatabase } from '../../db/database';

export type DomainInvariantViolation = Readonly<{
  kind: string;
  recordId: string;
  message: string;
}>;

type Row = Record<string, unknown>;

export function auditDomainInvariants(input: {
  database: AppDatabase;
}): readonly DomainInvariantViolation[] {
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

  const cycles = rows(`
    SELECT id, person_id, prospect_id, stage, workflow_status, current_next_action_id,
      stage_entered_at, close_reason, close_notes, closed_at, design_partner_fitness
    FROM sales_cycles ORDER BY id
  `);
  const actionRows = rows(`
    SELECT id, sales_cycle_id, action_type, channel, status, due_at, timezone,
      allowed_window, work_intent, inbound_sla_kind, inbound_sla_due_at,
      inbound_sla_source_event_id, inbound_sla_provenance_json,
      cadence_enrollment_id, cadence_step_id, cadence_component_id
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
    if (!isCanonicalUtc(action.due_at) || typeof action.timezone !== 'string'
      || action.timezone.trim().length === 0) {
      add('action_schedule_invalid', action.id, 'Action due time/timezone is malformed.');
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
    if (slaPresent === 4 && !isStrictVersionedJson(action.inbound_sla_provenance_json)) {
      add('action_inbound_sla_invalid', action.id, 'Inbound SLA provenance is malformed.');
    }
  }

  const enrollmentRows = rows(`
    SELECT enrollment.id, enrollment.sales_cycle_id, enrollment.cadence_definition_id,
      enrollment.status, enrollment.current_step_id, enrollment.scheduled_step_count,
      enrollment.mode, enrollment.allowed_step_ids_json, definition.family,
      definition.attempt_cap
    FROM cadence_enrollments AS enrollment
    LEFT JOIN cadence_definitions AS definition ON definition.id = enrollment.cadence_definition_id
    ORDER BY enrollment.id
  `);
  const activeByCycle = new Map<string, Row[]>();
  for (const enrollment of enrollmentRows) {
    if (enrollment.status === 'active') {
      const key = String(enrollment.sales_cycle_id);
      activeByCycle.set(key, [...(activeByCycle.get(key) ?? []), enrollment]);
    }
    const definitionSteps = rows(`
      SELECT id FROM cadence_steps
      WHERE cadence_definition_id = ${sqlLiteral(String(enrollment.cadence_definition_id))}
      ORDER BY sequence
    `).map(({ id }) => String(id));
    let effective = definitionSteps;
    if (enrollment.allowed_step_ids_json !== null) {
      try {
        const parsed = JSON.parse(String(enrollment.allowed_step_ids_json));
        if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) throw new Error();
        effective = parsed;
      } catch {
        add('enrollment_allowed_plan_invalid', enrollment.id, 'Allowed plan JSON is malformed.');
        effective = [];
      }
    }
    const position = effective.indexOf(String(enrollment.current_step_id));
    if (position < 0 || enrollment.scheduled_step_count !== position + 1
      || (enrollment.mode === 'inbound_over_cap_response'
        && (effective.length !== 1 || enrollment.scheduled_step_count !== 1))) {
      add('enrollment_step_count_invalid', enrollment.id, 'Enrollment count does not match effective-plan position.');
    }
  }

  for (const cycle of cycles) {
    const id = String(cycle.id);
    const isOpen = cycle.workflow_status === 'active' || cycle.workflow_status === 'onboarding';
    const action = cycle.current_next_action_id === null
      ? undefined : actions.get(String(cycle.current_next_action_id));
    if (isOpen && (action === undefined || action.sales_cycle_id !== cycle.id
      || action.status !== 'pending')) {
      add('current_action_invalid', id, 'Open cycle lacks one own pending current action.');
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
      const rules = rows(`SELECT id FROM reactivation_rules WHERE sales_cycle_id = ${sqlLiteral(id)}`);
      if (cycle.close_reason !== 'opt_out' && rules.length === 0) {
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
    if (expectedFamily !== null
      && !acceptedTerminalBridge
      && (active.length !== 1 || !expectedFamily.includes(String(active[0]?.family)))) {
      add('stage_cadence_invalid', id, 'Cycle stage does not own its exact active cadence.');
    }
    if (!isOpen && active.length !== 0) {
      add('closed_cycle_cadence_invalid', id, 'Closed cycle retains an active cadence.');
    }
    if (cycle.stage === 'unreviewed'
      && (action?.work_intent !== 'internal_review' || action.action_type !== 'review_lead')) {
      add('unreviewed_action_invalid', id, 'Unreviewed cycle lacks durable internal review work.');
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

  const receipts = rows(`
    SELECT activation_key, activation_kind, person_id, source_cycle_id,
      reactivation_rule_id, source_event_id, new_cycle_id, command_json, result_json
    FROM cycle_reactivation_receipts ORDER BY activation_key
  `);
  const receiptRuleIds = new Set(receipts
    .map(({ reactivation_rule_id }) => reactivation_rule_id)
    .filter((value): value is string => typeof value === 'string'));
  for (const receipt of receipts) {
    const isRule = receipt.activation_kind === 'rule';
    const expectedKey = isRule
      ? `rule:${String(receipt.reactivation_rule_id)}`
      : `inbound:${String(receipt.source_event_id)}`;
    if (receipt.activation_key !== expectedKey
      || !isCanonicalVersionedJson(receipt.command_json)
      || !isCanonicalVersionedJson(receipt.result_json)) {
      add('reactivation_receipt_invalid', receipt.activation_key, 'Reactivation receipt is malformed.');
    }
    const target = cycles.find(({ id }) => id === receipt.new_cycle_id);
    if (target === undefined || target.person_id !== receipt.person_id) {
      add('reactivation_receipt_invalid', receipt.activation_key, 'Receipt target ownership is invalid.');
    }
  }
  for (const rule of rows(`
    SELECT id, consumed_at FROM reactivation_rules ORDER BY id
  `)) {
    if (rule.consumed_at !== null && !receiptRuleIds.has(String(rule.id))) {
      add('reactivation_consumption_invalid', rule.id, 'Consumed rule has no immutable receipt.');
    }
  }
  for (const review of rows(`
    SELECT id, activation_key, status, payload_json, resolution_json, resolved_at,
      reactivation_rule_id, source_event_id
    FROM lifecycle_review_items ORDER BY id
  `)) {
    const resolved = review.status === 'resolved';
    if (!isCanonicalVersionedJson(review.payload_json)
      || resolved !== (review.resolution_json !== null && review.resolved_at !== null)
      || (review.resolution_json !== null && !isCanonicalVersionedJson(review.resolution_json))) {
      add('lifecycle_review_invalid', review.id, 'Lifecycle Review envelope/state is malformed.');
    }
    if (review.status === 'open'
      && receipts.some(({ activation_key }) => activation_key === review.activation_key)) {
      add('lifecycle_review_invalid', review.id, 'Open Review conflicts with a committed receipt.');
    }
  }

  for (const row of rows(`
    SELECT terms.sales_cycle_id, terms.doors_committed, terms.billing_model,
      terms.unit_rate_cents, terms.projected_mrr_cents, terms.manual_projection_reason
    FROM won_terms AS terms ORDER BY terms.sales_cycle_id
  `)) {
    const expected = row.billing_model === 'per_door_monthly'
      ? Number(row.doors_committed) * Number(row.unit_rate_cents)
      : row.billing_model === 'flat_monthly' ? Number(row.unit_rate_cents) : Number(row.projected_mrr_cents);
    if (Number(row.projected_mrr_cents) !== expected
      || (row.billing_model === 'manual_projected_monthly'
        && (typeof row.manual_projection_reason !== 'string'
          || row.manual_projection_reason.trim().length === 0))) {
      add('won_terms_invalid', row.sales_cycle_id, 'Won terms projection is inconsistent.');
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
    'ready>contacted', 'ready>interviewed', 'ready>lost_nurture',
    'contacted>interviewed', 'contacted>lost_nurture',
    'interviewed>offered', 'interviewed>lost_nurture',
    'offered>won', 'offered>lost_nurture', 'won>lost_nurture',
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
