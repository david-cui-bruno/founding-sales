import type { AppDatabase } from '../../db/database';
import {
  parseCanonicalJson, serializeCanonical, utcTimestampSchema,
} from './lifecycleValidation';
import {
  reactivationCommandEnvelopeSchema,
  reactivationResultEnvelopeSchema,
  type ReactivationCommandEnvelope,
  type ReactivationResultEnvelope,
  type ReactivationReviewPayload,
  type ReactivationReviewResolution,
} from './reactivationContracts';

export type ReactivationReceiptEvidence = Readonly<{
  activationKey: string;
  activationKind: 'rule' | 'inbound_response';
  personId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  newCycleId: string;
  command: ReactivationCommandEnvelope;
  result: ReactivationResultEnvelope;
  createdAt: string;
}>;

export type ReactivationReviewEvidence = Readonly<{
  id: string;
  activationKey: string;
  status: 'open' | 'resolved';
  personId: string;
  prospectId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  reason: string;
  payload: ReactivationReviewPayload;
  resolution: ReactivationReviewResolution | null;
  resolvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

type Row = Record<string, unknown>;

export function collectReceiptEvidenceViolations(
  database: AppDatabase,
  receipt: ReactivationReceiptEvidence,
): readonly string[] {
  const violations: string[] = [];
  const command = receipt.command.command;
  const result = receipt.result.result;
  const isRule = 'ruleType' in command;
  const expectedStage = isRule ? 'ready' : 'contacted';
  const activatedAt = command.activatedAt;
  requireCanonicalTimestamp(activatedAt, 'command activatedAt', violations);
  requireCanonicalTimestamp(receipt.createdAt, 'receipt createdAt', violations);
  const entrySourceEventId = isRule
    ? command.entrySourceEventId
    : command.evidence.kind === 'source_event' ? command.evidence.sourceEventId : null;
  if (entrySourceEventId === null) {
    violations.push('receipt command does not carry durable SourceEvent evidence');
    return Object.freeze(violations);
  }

  const sourceCycle = one(database, `
    SELECT person_id, prospect_id, workflow_status, stage_entered_at,
      closed_at, created_at, updated_at FROM sales_cycles WHERE id = ?
  `, receipt.sourceCycleId);
  requireCanonicalRowTimestamps(sourceCycle, [
    'stage_entered_at', 'closed_at', 'created_at', 'updated_at',
  ], 'source SalesCycle', violations);
  if (sourceCycle?.person_id !== receipt.personId
    || sourceCycle.prospect_id !== command.prospectId
    || sourceCycle.workflow_status !== 'closed') {
    violations.push('source SalesCycle ownership/terminal state is invalid');
  }
  const definition = one(database, `
    SELECT family, version, content_hash FROM cadence_definitions WHERE id = ?
  `, command.cadence.definitionId);
  if (definition?.family !== command.cadence.family
    || definition.version !== command.cadence.version
    || definition.content_hash !== command.cadence.contentHash) {
    violations.push('pinned cadence aggregate identity is invalid');
  }
  const source = one(database, `
    SELECT person_id, prospect_id, channel, observed_at, source_record_json, created_at
    FROM source_events WHERE id = ?
  `, entrySourceEventId);
  const sourceObservedAt = requireCanonicalTimestamp(
    source?.observed_at, 'entry SourceEvent observedAt', violations,
  );
  requireCanonicalTimestamp(source?.created_at, 'entry SourceEvent createdAt', violations);
  if (source?.person_id !== receipt.personId
    || (source.prospect_id !== null && source.prospect_id !== command.prospectId)
    || sourceObservedAt === null || sourceObservedAt > activatedAt) {
    violations.push('entry SourceEvent ownership or temporal evidence is invalid');
  }

  const target = one(database, `
    SELECT person_id, prospect_id, entry_source_event_id, stage_entered_at,
      closed_at, created_at, updated_at
    FROM sales_cycles WHERE id = ?
  `, receipt.newCycleId);
  requireCanonicalRowTimestamps(target, [
    'stage_entered_at', 'created_at', 'updated_at',
  ], 'target SalesCycle', violations);
  if (target?.closed_at !== null && target?.closed_at !== undefined) {
    requireCanonicalTimestamp(target.closed_at, 'target SalesCycle closedAt', violations);
  }
  if (target?.person_id !== receipt.personId
    || target.prospect_id !== command.prospectId
    || target.entry_source_event_id !== entrySourceEventId
    || target.created_at !== activatedAt) {
    violations.push('target SalesCycle immutable ownership/creation evidence is invalid');
  }
  const snapshot = result.cycle;
  if (snapshot.id !== receipt.newCycleId || snapshot.personId !== receipt.personId
    || snapshot.prospectId !== command.prospectId
    || snapshot.entrySourceEventId !== entrySourceEventId
    || snapshot.stage !== expectedStage || snapshot.workflowStatus !== 'active'
    || snapshot.currentNextActionId === null || snapshot.stageEnteredAt !== activatedAt
    || snapshot.designPartnerFitness !== null || snapshot.closeReason !== null
    || snapshot.closeNotes !== null || snapshot.onboardingStopReason !== null
    || snapshot.closedAt !== null || snapshot.version !== 1
    || snapshot.createdAt !== activatedAt || snapshot.updatedAt !== activatedAt) {
    violations.push('immutable initial SalesCycle result snapshot is invalid');
  }
  const initialEvent = one(database, `
    SELECT from_stage, to_stage, effective_at, confirmed_at, confirmation_kind,
      transition_sequence, created_at
    FROM stage_events WHERE sales_cycle_id = ? AND transition_sequence = 1
  `, receipt.newCycleId);
  requireCanonicalRowTimestamps(initialEvent, [
    'effective_at', 'confirmed_at', 'created_at',
  ], 'initial StageEvent', violations);
  if (initialEvent?.from_stage !== null || initialEvent.to_stage !== expectedStage
    || initialEvent.effective_at !== activatedAt || initialEvent.confirmed_at !== activatedAt
    || initialEvent.confirmation_kind !== 'mechanical'
    || initialEvent.transition_sequence !== 1) {
    violations.push('initial StageEvent evidence is missing or invalid');
  }
  const action = snapshot.currentNextActionId === null ? undefined : one(database, `
    SELECT sales_cycle_id, status, cadence_enrollment_id, cadence_step_id,
      cadence_component_id, due_at, sla_due_at, created_at, completed_at, updated_at
    FROM next_actions WHERE id = ?
  `, snapshot.currentNextActionId);
  requireCanonicalRowTimestamps(action, [
    'due_at', 'created_at', 'updated_at',
  ], 'initial NextAction', violations);
  for (const field of ['sla_due_at', 'completed_at'] as const) {
    if (action?.[field] !== null && action?.[field] !== undefined) {
      requireCanonicalTimestamp(action[field], `initial NextAction ${field}`, violations);
    }
  }
  const enrollment = action?.cadence_enrollment_id === null || action === undefined
    ? undefined : one(database, `
      SELECT sales_cycle_id, cadence_definition_id, anchor_at, scheduled_step_count,
        mode, allowed_step_ids_json, created_at, updated_at
      FROM cadence_enrollments WHERE id = ?
    `, action.cadence_enrollment_id);
  requireCanonicalRowTimestamps(enrollment, [
    'anchor_at', 'created_at', 'updated_at',
  ], 'initial CadenceEnrollment', violations);
  const firstStep = one(database, `
    SELECT id FROM cadence_steps WHERE cadence_definition_id = ?
    ORDER BY sequence ASC, id ASC LIMIT 1
  `, command.cadence.definitionId);
  const firstComponent = firstStep === undefined ? undefined : one(database, `
    SELECT id FROM cadence_action_components WHERE cadence_step_id = ?
    ORDER BY sequence ASC, id ASC LIMIT 1
  `, firstStep.id);
  if (action?.sales_cycle_id !== receipt.newCycleId
    || action.created_at !== activatedAt
    || action.cadence_step_id !== firstStep?.id
    || action.cadence_component_id !== firstComponent?.id
    || enrollment?.sales_cycle_id !== receipt.newCycleId
    || enrollment.cadence_definition_id !== command.cadence.definitionId
    || enrollment.anchor_at !== activatedAt || enrollment.mode !== 'standard'
    || enrollment.allowed_step_ids_json !== null
    || typeof enrollment.scheduled_step_count !== 'number'
    || enrollment.scheduled_step_count < 1
    || enrollment.created_at !== activatedAt) {
    violations.push('initial action/enrollment ownership, count, or plan evidence is invalid');
  }

  if (receipt.createdAt !== activatedAt
    || result.activationKind !== receipt.activationKind
    || serializeCanonical(result.cadence) !== serializeCanonical(command.cadence)) {
    violations.push('receipt activation timestamp/kind/cadence is invalid');
  }
  if (isRule) {
    const rule = one(database, `
      SELECT sales_cycle_id, rule_type, due_at, matcher_json, version,
        consumed_at, created_at FROM reactivation_rules WHERE id = ?
    `, command.ruleId);
    requireCanonicalTimestamp(rule?.created_at, 'reactivation rule createdAt', violations);
    requireCanonicalTimestamp(rule?.consumed_at, 'reactivation rule consumedAt', violations);
    if (rule?.due_at !== null && rule?.due_at !== undefined) {
      requireCanonicalTimestamp(rule.due_at, 'reactivation rule dueAt', violations);
    }
    const expectedMatcher = command.trigger.kind === 'source_event'
      ? serializeCanonical({
        version: 1, eventType: command.trigger.eventType, personWide: true,
      }) : null;
    const expectedChannel = command.ruleType === 'new-frbo-listing' ? 'frbo'
      : command.ruleType === 'lead-cert-expiry-window' ? 'registry' : null;
    const namedTrigger = command.trigger.kind !== 'source_event'
      || namedSourceTrigger(source?.source_record_json, command.trigger.eventType);
    if (receipt.activationKey !== `rule:${command.ruleId}`
      || receipt.reactivationRuleId !== command.ruleId || receipt.sourceEventId !== null
      || rule?.sales_cycle_id !== receipt.sourceCycleId
      || rule.rule_type !== command.ruleType
      || rule.version !== command.expectedRuleVersion
      || rule.consumed_at !== activatedAt
      || !isCanonicalTimestamp(rule.created_at) || rule.created_at > activatedAt
      || (command.trigger.kind === 'due'
        ? rule.due_at !== command.trigger.dueAt || rule.matcher_json !== null
          || activatedAt < command.trigger.dueAt
        : rule.due_at !== null || rule.matcher_json !== expectedMatcher
          || command.trigger.sourceEventId !== entrySourceEventId
          || source?.channel !== expectedChannel
          || sourceObservedAt === null || sourceObservedAt < rule.created_at
          || !namedTrigger)) {
      violations.push('reactivation rule type/version/matcher/temporal proof is invalid');
    }
  } else if (command.evidence.kind !== 'source_event'
    || receipt.activationKey !== `inbound:${command.evidence.sourceEventId}`
    || receipt.reactivationRuleId !== null
    || receipt.sourceEventId !== command.evidence.sourceEventId
    || source?.channel !== command.evidence.channel) {
    violations.push('inbound receipt key/channel evidence is invalid');
  }
  return Object.freeze(violations);
}

export function collectReviewEvidenceViolations(
  database: AppDatabase,
  review: ReactivationReviewEvidence,
): readonly string[] {
  const violations: string[] = [];
  const command = review.payload.command;
  const unknown = 'evidence' in command && command.evidence.kind === 'unknown_handle';
  requireCanonicalTimestamp(command.activatedAt, 'Review command activatedAt', violations);
  requireCanonicalTimestamp(review.createdAt, 'Review createdAt', violations);
  requireCanonicalTimestamp(review.updatedAt, 'Review updatedAt', violations);
  if (review.resolvedAt !== null) {
    requireCanonicalTimestamp(review.resolvedAt, 'Review resolvedAt', violations);
  }
  const expectedKey = 'ruleType' in command ? `rule:${command.ruleId}`
    : command.evidence.kind === 'source_event'
      ? `inbound:${command.evidence.sourceEventId}`
      : `inbound-handle:${command.evidence.handleKind}:${command.evidence.normalizedValue}`;
  if (review.activationKey !== expectedKey || command.personId !== review.personId
    || command.prospectId !== review.prospectId || command.sourceCycleId !== review.sourceCycleId
    || command.activatedAt !== review.createdAt || review.reason !== review.payload.blocker
    || review.status !== (review.resolution === null ? 'open' : 'resolved')
    || (review.resolution === null) !== (review.resolvedAt === null)
    || (review.status === 'open' ? review.version !== 1 : review.version !== 2)
    || (review.status === 'open' ? review.updatedAt !== review.createdAt : review.updatedAt !== review.resolvedAt)) {
    violations.push('Review envelope, CAS version, or timestamp state is invalid');
  }
  const sourceCycle = one(database, `
    SELECT person_id, prospect_id, workflow_status, stage_entered_at,
      closed_at, created_at, updated_at FROM sales_cycles WHERE id = ?
  `, review.sourceCycleId);
  requireCanonicalRowTimestamps(sourceCycle, [
    'stage_entered_at', 'closed_at', 'created_at', 'updated_at',
  ], 'Review source SalesCycle', violations);
  if (sourceCycle?.person_id !== review.personId
    || sourceCycle.prospect_id !== review.prospectId
    || sourceCycle.workflow_status !== 'closed') {
    violations.push('Review source SalesCycle ownership is invalid');
  }
  const definition = one(database, `
    SELECT family, version, content_hash FROM cadence_definitions WHERE id = ?
  `, command.cadence.definitionId);
  if (definition?.family !== command.cadence.family
    || definition.version !== command.cadence.version
    || definition.content_hash !== command.cadence.contentHash) {
    violations.push('Review cadence aggregate identity is invalid');
  }
  if (unknown) {
    if (review.reactivationRuleId !== null || review.sourceEventId !== null
      || review.payload.blocker !== 'unknown_inbound_handle') {
      violations.push('unknown-handle Review columns/blocker are invalid');
    }
  } else if ('ruleType' in command) {
    const rule = one(database, `
      SELECT sales_cycle_id, rule_type, due_at, version, consumed_at, created_at
      FROM reactivation_rules WHERE id = ?
    `, command.ruleId);
    requireCanonicalTimestamp(rule?.created_at, 'Review rule createdAt', violations);
    if (rule?.due_at !== null && rule?.due_at !== undefined) {
      requireCanonicalTimestamp(rule.due_at, 'Review rule dueAt', violations);
    }
    if (rule?.consumed_at !== null && rule?.consumed_at !== undefined) {
      requireCanonicalTimestamp(rule.consumed_at, 'Review rule consumedAt', violations);
    }
    if (review.reactivationRuleId !== command.ruleId || review.sourceEventId !== null
      || rule?.sales_cycle_id !== review.sourceCycleId
      || rule.rule_type !== command.ruleType || rule.version !== command.expectedRuleVersion) {
      violations.push('rule Review evidence is invalid');
    }
  } else if ('evidence' in command && command.evidence.kind === 'source_event') {
    const source = one(database, `
      SELECT person_id, prospect_id, channel, observed_at, created_at
      FROM source_events WHERE id = ?
    `, command.evidence.sourceEventId);
    const sourceObservedAt = requireCanonicalTimestamp(
      source?.observed_at, 'Review SourceEvent observedAt', violations,
    );
    requireCanonicalTimestamp(source?.created_at, 'Review SourceEvent createdAt', violations);
    if (review.reactivationRuleId !== null
      || review.sourceEventId !== command.evidence.sourceEventId
      || source?.person_id !== review.personId
      || (source.prospect_id !== null && source.prospect_id !== review.prospectId)
      || source.channel !== command.evidence.channel
      || sourceObservedAt === null || sourceObservedAt > command.activatedAt) {
      violations.push('inbound Review SourceEvent evidence is invalid');
    }
  }
  if (review.resolution !== null) {
    const receiptKey = review.resolution.kind === 'promoted_unknown_inbound'
      ? `inbound:${review.resolution.sourceEventId}` : review.activationKey;
    const stored = one(database, `
      SELECT activation_key, activation_kind, person_id, source_cycle_id,
        reactivation_rule_id, source_event_id, new_cycle_id, command_json,
        result_json, created_at
      FROM cycle_reactivation_receipts WHERE activation_key = ?
    `, receiptKey);
    const receipt = parseStoredReceipt(stored);
    if (receipt === null
      || receipt.personId !== review.personId
      || receipt.sourceCycleId !== review.sourceCycleId
      || receipt.newCycleId !== review.resolution.newCycleId
      || serializeCanonical(receipt.command.command.cadence)
        !== serializeCanonical(review.resolution.cadence)
      || (review.resolution.kind === 'promoted_unknown_inbound'
        ? !unknown || receipt.sourceEventId !== review.resolution.sourceEventId
          || review.resolvedAt !== receipt.createdAt
        : unknown || receipt.activationKind !== review.resolution.activationKind)) {
      violations.push('resolved Review does not match its immutable activation receipt');
    } else {
      violations.push(...collectReceiptEvidenceViolations(database, receipt));
    }
  }
  return Object.freeze(violations);
}

function parseStoredReceipt(row: Row | undefined): ReactivationReceiptEvidence | null {
  if (row === undefined || typeof row.command_json !== 'string'
    || typeof row.result_json !== 'string') return null;
  try {
    return {
      activationKey: String(row.activation_key),
      activationKind: row.activation_kind as ReactivationReceiptEvidence['activationKind'],
      personId: String(row.person_id), sourceCycleId: String(row.source_cycle_id),
      reactivationRuleId: row.reactivation_rule_id === null
        ? null : String(row.reactivation_rule_id),
      sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
      newCycleId: String(row.new_cycle_id),
      command: parseCanonicalJson(row.command_json, reactivationCommandEnvelopeSchema),
      result: parseCanonicalJson(row.result_json, reactivationResultEnvelopeSchema),
      createdAt: String(row.created_at),
    };
  } catch {
    return null;
  }
}

function namedSourceTrigger(value: unknown, eventType: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const envelope = JSON.parse(value) as { sourceRecord?: unknown };
    const record = envelope.sourceRecord;
    if (typeof record !== 'object' || record === null) return false;
    const trigger = (record as { reactivationTrigger?: unknown }).reactivationTrigger;
    return typeof trigger === 'object' && trigger !== null
      && (trigger as { version?: unknown }).version === 1
      && (trigger as { eventType?: unknown }).eventType === eventType
      && Object.keys(trigger).sort().join('|') === 'eventType|version';
  } catch {
    return false;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return utcTimestampSchema.safeParse(value).success;
}

function requireCanonicalTimestamp(
  value: unknown,
  label: string,
  violations: string[],
): string | null {
  const parsed = utcTimestampSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  violations.push(`${label} is blank or noncanonical`);
  return null;
}

function requireCanonicalRowTimestamps(
  row: Row | undefined,
  fields: readonly string[],
  label: string,
  violations: string[],
): void {
  if (row === undefined) return;
  for (const field of fields) {
    requireCanonicalTimestamp(row[field], `${label} ${field}`, violations);
  }
}

function one(database: AppDatabase, sql: string, ...params: unknown[]): Row | undefined {
  return database.raw.prepare(sql).get(...params) as Row | undefined;
}
