import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import { deepFreezeLifecycle, type SalesCycle } from '../lifecycle/lifecycleTypes';
import { parseCanonicalJson, serializeCanonical } from '../lifecycle/lifecycleValidation';
import { normalizeEmail, normalizePhone } from '../source/sourceService';
import { LifecycleEvidenceError } from '../support/domainErrors';
import {
  optOutProvenanceViolations,
  parseOptOutActivityMetadataJson,
  type OptOutEvidenceActivityFacts,
  type OptOutEvidenceNode,
} from './optOutEvidenceValidator';
import {
  optOutHandleKindSchema,
  optOutIdSchema,
  optOutObservedChannelSchema,
  optOutUtcTimestampSchema,
  type OptOutHandle,
  type OptOutTombstone,
} from './optOutTypes';
import {
  applyOptOutResultSchema,
  optOutClosureCommandSchema,
  optOutClosureReceiptValueSchema,
  type OptOutClosureReceipt,
} from './optOutValidation';

const nonblankSchema = z.string().trim().min(1);
const closureReceiptRowSchema = z.object({
  source_activity_id: optOutIdSchema,
  operation_kind: z.enum(['apply', 'propagate']),
  person_id: optOutIdSchema,
  tombstone_id: optOutIdSchema,
  source_tombstone_id: optOutIdSchema.nullable(),
  closed_cycle_id: optOutIdSchema.nullable(),
  terminal_stage_event_id: optOutIdSchema.nullable(),
  command_json: z.string().trim().min(1),
  result_json: z.string().trim().min(1),
  created_at: optOutUtcTimestampSchema,
}).strict();
const tombstoneRowSchema = z.object({
  id: optOutIdSchema, person_id: optOutIdSchema, requested_at: optOutUtcTimestampSchema,
  observed_channel: optOutObservedChannelSchema, source_activity_id: optOutIdSchema,
  evidence_ref: z.string().nullable(), policy_version: z.literal('founder_opt_out_v1'),
  created_at: optOutUtcTimestampSchema,
}).strict();
const handleRowSchema = z.object({
  id: optOutIdSchema, tombstone_id: optOutIdSchema, kind: optOutHandleKindSchema,
  normalized_value: nonblankSchema, created_at: optOutUtcTimestampSchema,
}).strict();
const activityRowSchema = z.object({
  id: optOutIdSchema, person_id: optOutIdSchema, prospect_id: optOutIdSchema.nullable(),
  sales_cycle_id: optOutIdSchema.nullable(), cadence_enrollment_id: optOutIdSchema.nullable(),
  cadence_step_id: optOutIdSchema.nullable(), cadence_component_id: optOutIdSchema.nullable(),
  kind: nonblankSchema,
  direction: nonblankSchema, channel: nonblankSchema, occurred_at: optOutUtcTimestampSchema,
  duration_seconds: z.number().int().safe().nonnegative().nullable(),
  observed_outcome: z.string().nullable(), adapter: nonblankSchema.nullable(),
  provider_idempotency_key: nonblankSchema.nullable(), provider_reference: z.string().nullable(),
  consent_policy_record_id: optOutIdSchema.nullable(), recording_storage_ref: nonblankSchema.nullable(),
  transcript_storage_ref: nonblankSchema.nullable(), metadata_json: z.string(),
  created_at: optOutUtcTimestampSchema,
}).strict();

type LoadedOptOutActivity = OptOutEvidenceActivityFacts & Readonly<{
  prospectId: string | null;
  salesCycleId: string | null;
  cadenceEnrollmentId: string | null;
  cadenceStepId: string | null;
  cadenceComponentId: string | null;
  durationSeconds: number | null;
  consentPolicyRecordId: string | null;
  recordingStorageRef: string | null;
  transcriptStorageRef: string | null;
  createdAt: string;
}>;
const cycleRowSchema = z.object({
  id: optOutIdSchema, person_id: optOutIdSchema, prospect_id: optOutIdSchema,
  entry_source_event_id: optOutIdSchema,
  stage: z.enum([
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ]),
  workflow_status: z.enum(['active', 'onboarding', 'closed']),
  current_next_action_id: optOutIdSchema.nullable(), stage_entered_at: optOutUtcTimestampSchema,
  design_partner_fitness: z.number().int().min(0).max(5).nullable(),
  close_reason: z.enum([
    'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
    'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
    'cadence_exhausted', 'disqualified', 'opt_out', 'other',
  ]).nullable(),
  close_notes: z.string().nullable(), onboarding_stop_reason: z.string().nullable(),
  closed_at: optOutUtcTimestampSchema.nullable(), version: z.number().int().safe().positive(),
  created_at: optOutUtcTimestampSchema, updated_at: optOutUtcTimestampSchema,
}).strict();
const stageEventRowSchema = z.object({
  id: optOutIdSchema, sales_cycle_id: optOutIdSchema,
  from_stage: z.enum([
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ]).nullable(),
  to_stage: z.enum([
    'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
  ]),
  effective_at: optOutUtcTimestampSchema, confirmed_at: optOutUtcTimestampSchema,
  confirmation_kind: z.enum(['mechanical', 'founder', 'backfill']),
  transition_sequence: z.number().int().safe().positive(),
  backfill_provenance_json: z.string().nullable(), created_at: optOutUtcTimestampSchema,
}).strict();
const wonTermsRowSchema = z.object({
  sales_cycle_id: optOutIdSchema, doors_committed: z.number().int().safe().nonnegative(),
  billing_model: z.enum(['per_door_monthly', 'flat_monthly', 'manual_projected_monthly']),
  unit_rate_cents: z.number().int().safe().nonnegative(),
  projected_mrr_cents: z.number().int().safe().nonnegative(),
  projection_formula_version: z.literal('founder_terms_v1'),
  manual_projection_reason: z.string().nullable(),
  founding_customer: z.union([z.literal(0), z.literal(1)]),
  effective_at: optOutUtcTimestampSchema, created_at: optOutUtcTimestampSchema,
}).strict();

const tombstoneColumns = `
  id, person_id, requested_at, observed_channel, source_activity_id,
  evidence_ref, policy_version, created_at
`;
const cycleColumns = `
  id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
  current_next_action_id, stage_entered_at, design_partner_fitness, close_reason,
  close_notes, onboarding_stop_reason, closed_at, version, created_at, updated_at
`;

/** Parse the immutable row and require canonical JSON before semantic validation. */
export function parseStoredOptOutClosureReceipt(value: unknown): OptOutClosureReceipt {
  const row = closureReceiptRowSchema.parse(value);
  return deepFreezeLifecycle(optOutClosureReceiptValueSchema.parse({
    sourceActivityId: row.source_activity_id,
    operationKind: row.operation_kind,
    personId: row.person_id,
    tombstoneId: row.tombstone_id,
    sourceTombstoneId: row.source_tombstone_id,
    closedCycleId: row.closed_cycle_id,
    terminalStageEventId: row.terminal_stage_event_id,
    command: parseCanonicalJson(row.command_json, optOutClosureCommandSchema),
    result: parseCanonicalJson(row.result_json, applyOptOutResultSchema),
    createdAt: row.created_at,
  })) as OptOutClosureReceipt;
}

/**
 * The one semantic boundary for closure receipts. It deliberately returns stable
 * reason codes so repositories can fail closed while audits can remain corruption tolerant.
 */
export function collectOptOutClosureReceiptViolations(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
): readonly string[] {
  const violations: string[] = [];
  const add = (reason: string): void => {
    if (!violations.includes(reason)) violations.push(reason);
  };
  const effectiveAt = receipt.command.kind === 'apply'
    ? receipt.command.input.requestedAt
    : receipt.command.input.evidenceActivity.occurredAt;

  const activity = loadActivity(database, receipt.sourceActivityId);
  if (activity === null || activity.personId !== receipt.personId
    || activity.observedOutcome !== 'opted_out') add('source_activity');
  if (activity !== null && !commandActivityMatches(receipt, activity)) add('command_activity');
  if (activity !== null && (activity.occurredAt > effectiveAt
    || activity.createdAt > receipt.createdAt)) add('activity_chronology');

  const tombstone = loadTombstone(database, receipt.tombstoneId);
  if (tombstone === null
    || serializeCanonical(tombstone) !== serializeCanonical(receipt.result.tombstone)) {
    add('tombstone_snapshot');
  }
  if (tombstone !== null) {
    const rootActivity = loadActivity(database, tombstone.sourceActivityId);
    const provenance = optOutProvenanceViolations({
      root: Object.freeze({ tombstone, activity: rootActivity }),
      loadSource: (id) => loadEvidenceNode(database, id),
    });
    if (provenance.length !== 0) add('tombstone_provenance');
    if (tombstone.createdAt > receipt.createdAt || tombstone.requestedAt > receipt.createdAt) {
      add('tombstone_chronology');
    }
  }
  if (!receipt.result.alreadyApplied && tombstone !== null) {
    if (tombstone.id !== requestedTombstoneId(receipt)
      || tombstone.sourceActivityId !== receipt.sourceActivityId
      || tombstone.requestedAt !== expectedTombstoneRequestedAt(database, receipt)
      || tombstone.policyVersion !== 'founder_opt_out_v1'
      || tombstone.observedChannel !== expectedObservedChannel(receipt)) {
      add('new_tombstone_semantics');
    }
  }
  if (receipt.createdAt < effectiveAt) add('receipt_chronology');

  const person = database.raw.prepare(`
    SELECT opted_out, opted_out_at FROM persons WHERE id = ?
  `).get(receipt.personId) as { opted_out: number; opted_out_at: string | null } | undefined;
  if (person?.opted_out !== 1 || tombstone === null || person.opted_out_at !== tombstone.requestedAt) {
    add('person_projection');
  }

  if (receipt.operationKind === 'propagate') {
    const source = receipt.sourceTombstoneId === null
      ? null : loadTombstone(database, receipt.sourceTombstoneId);
    if (source === null || source.personId === receipt.personId
      || source.id === receipt.tombstoneId) add('propagation_source');
  }

  const storedHandles = loadHandles(database, receipt.tombstoneId);
  if (storedHandles === null
    || serializeCanonical(storedHandles) !== serializeCanonical(receipt.result.handles)) {
    add('handle_snapshot');
  } else if (storedHandles.some((handle) => handle.createdAt > receipt.createdAt)) {
    add('handle_chronology');
  }

  const cycle = receipt.closedCycleId === null
    ? null : loadCycle(database, receipt.closedCycleId);
  if ((cycle === null) !== (receipt.result.cycle === null)
    || (cycle !== null && serializeCanonical(cycle) !== serializeCanonical(receipt.result.cycle))) {
    add('cycle_snapshot');
  }

  if (cycle === null) {
    if (receipt.closedCycleId !== null || receipt.terminalStageEventId !== null) {
      add('no_cycle_union');
    }
  } else if (cycle.stage === 'won') {
    validateWonClosure(database, receipt, cycle, effectiveAt, add);
  } else {
    validateLostNurtureClosure(database, receipt, cycle, effectiveAt, add);
  }

  if (database.raw.prepare(`
    SELECT id FROM sales_cycles
    WHERE person_id = ? AND workflow_status IN ('active','onboarding') LIMIT 1
  `).get(receipt.personId) !== undefined) add('open_workflow');
  if (database.raw.prepare(`
    SELECT action.id FROM next_actions AS action
    JOIN sales_cycles AS cycle ON cycle.id = action.sales_cycle_id
    WHERE cycle.person_id = ? AND action.status = 'pending' AND action.channel IS NOT NULL
    LIMIT 1
  `).get(receipt.personId) !== undefined) add('pending_outbound');
  if (database.raw.prepare(`
    SELECT enrollment.id FROM cadence_enrollments AS enrollment
    JOIN sales_cycles AS cycle ON cycle.id = enrollment.sales_cycle_id
    WHERE cycle.person_id = ? AND enrollment.status = 'active' LIMIT 1
  `).get(receipt.personId) !== undefined) add('active_enrollment');

  return Object.freeze(violations);
}

export function assertCanonicalOptOutClosureReceipt(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
): void {
  const violations = collectOptOutClosureReceiptViolations(database, receipt);
  if (violations.length !== 0) {
    throw new LifecycleEvidenceError(
      `Opt-out closure receipt is invalid: ${violations.join(', ')}.`,
    );
  }
}

function validateLostNurtureClosure(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
  cycle: SalesCycle,
  effectiveAt: string,
  add: (reason: string) => void,
): void {
  if (receipt.result.alreadyApplied
    || cycle.stage !== 'lost_nurture' || cycle.workflowStatus !== 'closed'
    || cycle.currentNextActionId !== null || cycle.closeReason !== 'opt_out'
    || cycle.closeNotes !== null || cycle.onboardingStopReason !== null
    || cycle.stageEnteredAt !== effectiveAt || cycle.closedAt !== effectiveAt
    || cycle.updatedAt !== effectiveAt || cycle.createdAt > effectiveAt
    || receipt.terminalStageEventId === null) {
    add('lost_nurture_union');
    return;
  }
  const event = loadStageEvent(database, receipt.terminalStageEventId);
  if (event === null || event.sales_cycle_id !== cycle.id
    || event.from_stage === null || event.from_stage === 'won'
    || event.from_stage === 'lost_nurture' || event.to_stage !== 'lost_nurture'
    || event.effective_at !== effectiveAt || event.confirmed_at !== effectiveAt
    || event.confirmation_kind !== 'mechanical' || event.backfill_provenance_json !== null
    || event.created_at < effectiveAt || event.created_at > receipt.createdAt) {
    add('terminal_stage_event');
    return;
  }
  const eventRows = database.raw.prepare(`
    SELECT id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
      confirmation_kind, transition_sequence, backfill_provenance_json, created_at
    FROM stage_events WHERE sales_cycle_id = ? ORDER BY transition_sequence ASC
  `).all(cycle.id);
  const events = eventRows.map((row) => stageEventRowSchema.safeParse(row));
  const last = events.at(-1);
  const prior = events.at(-2);
  if (events.some((candidate) => !candidate.success)
    || !last?.success || last.data.id !== event.id
    || event.transition_sequence !== events.length
    || (prior?.success
      ? prior.data.to_stage !== event.from_stage
      : event.from_stage !== 'unreviewed')) {
    add('terminal_stage_event_cardinality');
  }
}

function validateWonClosure(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
  cycle: SalesCycle,
  effectiveAt: string,
  add: (reason: string) => void,
): void {
  if (receipt.result.alreadyApplied || cycle.workflowStatus !== 'closed'
    || cycle.currentNextActionId !== null || cycle.closeReason !== null
    || cycle.closeNotes !== null || cycle.onboardingStopReason !== 'opt_out'
    || cycle.closedAt !== effectiveAt || cycle.updatedAt !== effectiveAt
    || cycle.createdAt > effectiveAt || cycle.stageEnteredAt > effectiveAt
    || receipt.terminalStageEventId !== null) {
    add('won_union');
  }
  const termsRow = database.raw.prepare(`
    SELECT sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
      projected_mrr_cents, projection_formula_version, manual_projection_reason,
      founding_customer, effective_at, created_at
    FROM won_terms WHERE sales_cycle_id = ?
  `).get(cycle.id);
  const parsed = wonTermsRowSchema.safeParse(termsRow);
  if (!parsed.success) {
    add('won_terms');
    return;
  }
  const terms = parsed.data;
  const projected = terms.billing_model === 'per_door_monthly'
    ? terms.doors_committed * terms.unit_rate_cents
    : terms.billing_model === 'flat_monthly' ? terms.unit_rate_cents : terms.projected_mrr_cents;
  if (terms.projected_mrr_cents !== projected
    || (terms.billing_model === 'manual_projected_monthly'
      && (terms.manual_projection_reason === null
        || terms.manual_projection_reason.trim().length === 0))
    || terms.effective_at > effectiveAt || terms.created_at > receipt.createdAt) {
    add('won_terms');
  }
}

function commandActivityMatches(
  receipt: OptOutClosureReceipt,
  activity: LoadedOptOutActivity,
): boolean {
  if (receipt.command.kind === 'propagate') {
    const input = receipt.command.input;
    const metadata = activity.metadata;
    return appendedActivityMatches(activity, input.evidenceActivity)
      && activity.kind === 'system' && activity.direction === 'internal'
      && activity.channel === 'identity_propagation'
      && isRecord(metadata) && metadata.sourceTombstoneId === input.sourceTombstoneId;
  }
  const evidence = receipt.command.input.evidence;
  if (evidence.kind === 'append_activity'
    && !appendedActivityMatches(activity, evidence.activity)) return false;
  const decision = receipt.command.input.decision;
  if (decision.channel === 'imessage') {
    return activity.kind === 'text' && activity.direction === 'inbound'
      && activity.channel === 'imessage';
  }
  if (decision.channel === 'gmail') {
    return activity.kind === 'email' && activity.direction === 'inbound'
      && activity.channel === 'gmail';
  }
  if (decision.channel === 'manual') {
    return (activity.kind === 'note' || activity.kind === 'system')
      && activity.direction === 'internal' && activity.channel === 'manual';
  }
  return activity.kind === 'call'
    && (activity.channel === 'phone' || activity.channel === 'call');
}

function appendedActivityMatches(
  activity: LoadedOptOutActivity,
  input: Extract<
    OptOutClosureReceipt['command'], { kind: 'propagate' }
  >['input']['evidenceActivity'],
): boolean {
  return activity.id === input.id
    && activity.personId === input.personId
    && activity.prospectId === (input.prospectId ?? null)
    && activity.salesCycleId === (input.salesCycleId ?? null)
    && activity.cadenceEnrollmentId === (input.cadenceEnrollmentId ?? null)
    && activity.cadenceStepId === (input.cadenceStepId ?? null)
    && activity.cadenceComponentId === (input.cadenceComponentId ?? null)
    && activity.kind === input.kind && activity.direction === input.direction
    && activity.channel === input.channel && activity.occurredAt === input.occurredAt
    && activity.durationSeconds === (input.durationSeconds ?? null)
    && activity.observedOutcome === (input.observedOutcome ?? null)
    && activity.adapter === (input.adapter ?? null)
    && activity.providerIdempotencyKey === (input.providerIdempotencyKey ?? null)
    && activity.providerReference === (input.providerReference ?? null)
    && activity.consentPolicyRecordId === (input.consentPolicyRecordId ?? null)
    && activity.recordingStorageRef === (input.recordingStorageRef ?? null)
    && activity.transcriptStorageRef === (input.transcriptStorageRef ?? null)
    && isDeepStrictEqual(activity.metadata, input.metadata ?? {});
}

function requestedTombstoneId(receipt: OptOutClosureReceipt): string {
  return receipt.command.kind === 'apply'
    ? receipt.command.input.tombstoneId : receipt.command.input.targetTombstoneId;
}

function expectedObservedChannel(
  receipt: OptOutClosureReceipt,
): OptOutTombstone['observedChannel'] {
  return receipt.command.kind === 'apply'
    ? receipt.command.input.decision.channel : 'identity_propagation';
}

function expectedTombstoneRequestedAt(
  database: AppDatabase,
  receipt: OptOutClosureReceipt,
): string | null {
  if (receipt.command.kind === 'apply') return receipt.command.input.requestedAt;
  return receipt.sourceTombstoneId === null
    ? null : loadTombstone(database, receipt.sourceTombstoneId)?.requestedAt ?? null;
}

function loadTombstone(database: AppDatabase, id: string): OptOutTombstone | null {
  const row = database.raw.prepare(`
    SELECT ${tombstoneColumns} FROM opt_out_tombstones WHERE id = ?
  `).get(id);
  if (row === undefined) return null;
  const parsed = tombstoneRowSchema.safeParse(row);
  return parsed.success ? Object.freeze({
    id: parsed.data.id, personId: parsed.data.person_id,
    requestedAt: parsed.data.requested_at, observedChannel: parsed.data.observed_channel,
    sourceActivityId: parsed.data.source_activity_id, evidenceRef: parsed.data.evidence_ref,
    policyVersion: parsed.data.policy_version, createdAt: parsed.data.created_at,
  }) : null;
}

function loadHandles(database: AppDatabase, tombstoneId: string): readonly OptOutHandle[] | null {
  const rows = database.raw.prepare(`
    SELECT id, tombstone_id, kind, normalized_value, created_at
    FROM opt_out_handles WHERE tombstone_id = ?
    ORDER BY kind ASC, normalized_value ASC, id ASC
  `).all(tombstoneId);
  const handles: OptOutHandle[] = [];
  for (const row of rows) {
    const parsed = handleRowSchema.safeParse(row);
    if (!parsed.success) return null;
    try {
      const normalized = parsed.data.kind === 'phone'
        ? normalizePhone(parsed.data.normalized_value)
        : normalizeEmail(parsed.data.normalized_value);
      if (normalized !== parsed.data.normalized_value) return null;
    } catch {
      return null;
    }
    handles.push(Object.freeze({
      id: parsed.data.id, tombstoneId: parsed.data.tombstone_id, kind: parsed.data.kind,
      normalizedValue: parsed.data.normalized_value, createdAt: parsed.data.created_at,
    }));
  }
  return Object.freeze(handles);
}

function loadCycle(database: AppDatabase, id: string): SalesCycle | null {
  const row = database.raw.prepare(`SELECT ${cycleColumns} FROM sales_cycles WHERE id = ?`).get(id);
  const parsed = cycleRowSchema.safeParse(row);
  return parsed.success ? deepFreezeLifecycle({
    id: parsed.data.id, personId: parsed.data.person_id, prospectId: parsed.data.prospect_id,
    entrySourceEventId: parsed.data.entry_source_event_id, stage: parsed.data.stage,
    workflowStatus: parsed.data.workflow_status,
    currentNextActionId: parsed.data.current_next_action_id,
    stageEnteredAt: parsed.data.stage_entered_at,
    designPartnerFitness: parsed.data.design_partner_fitness,
    closeReason: parsed.data.close_reason, closeNotes: parsed.data.close_notes,
    onboardingStopReason: parsed.data.onboarding_stop_reason, closedAt: parsed.data.closed_at,
    version: parsed.data.version, createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
  }) as SalesCycle : null;
}

function loadStageEvent(
  database: AppDatabase,
  id: string,
): z.infer<typeof stageEventRowSchema> | null {
  const row = database.raw.prepare(`
    SELECT id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
      confirmation_kind, transition_sequence, backfill_provenance_json, created_at
    FROM stage_events WHERE id = ?
  `).get(id);
  const parsed = stageEventRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

function loadActivity(database: AppDatabase, id: string): LoadedOptOutActivity | null {
  const row = database.raw.prepare(`
    SELECT id, person_id, prospect_id, sales_cycle_id, cadence_enrollment_id,
      cadence_step_id, cadence_component_id, kind, direction, channel, occurred_at,
      duration_seconds, observed_outcome, adapter, provider_idempotency_key,
      provider_reference, consent_policy_record_id, recording_storage_ref,
      transcript_storage_ref, metadata_json, created_at
    FROM activities WHERE id = ?
  `).get(id);
  const parsed = activityRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const metadata = parseOptOutActivityMetadataJson(parsed.data.metadata_json);
  if (!metadata.success) return Object.freeze({
    id: parsed.data.id, personId: parsed.data.person_id, kind: parsed.data.kind,
    prospectId: parsed.data.prospect_id, salesCycleId: parsed.data.sales_cycle_id,
    cadenceEnrollmentId: parsed.data.cadence_enrollment_id,
    cadenceStepId: parsed.data.cadence_step_id, cadenceComponentId: parsed.data.cadence_component_id,
    direction: parsed.data.direction, channel: parsed.data.channel,
    durationSeconds: parsed.data.duration_seconds,
    occurredAt: parsed.data.occurred_at, observedOutcome: parsed.data.observed_outcome,
    adapter: parsed.data.adapter, providerIdempotencyKey: parsed.data.provider_idempotency_key,
    providerReference: parsed.data.provider_reference,
    consentPolicyRecordId: parsed.data.consent_policy_record_id,
    recordingStorageRef: parsed.data.recording_storage_ref,
    transcriptStorageRef: parsed.data.transcript_storage_ref,
    metadata: null, metadataValid: false, createdAt: parsed.data.created_at,
  });
  return Object.freeze({
    id: parsed.data.id, personId: parsed.data.person_id, kind: parsed.data.kind,
    prospectId: parsed.data.prospect_id, salesCycleId: parsed.data.sales_cycle_id,
    cadenceEnrollmentId: parsed.data.cadence_enrollment_id,
    cadenceStepId: parsed.data.cadence_step_id, cadenceComponentId: parsed.data.cadence_component_id,
    direction: parsed.data.direction, channel: parsed.data.channel,
    durationSeconds: parsed.data.duration_seconds,
    occurredAt: parsed.data.occurred_at, observedOutcome: parsed.data.observed_outcome,
    adapter: parsed.data.adapter, providerIdempotencyKey: parsed.data.provider_idempotency_key,
    providerReference: parsed.data.provider_reference,
    consentPolicyRecordId: parsed.data.consent_policy_record_id,
    recordingStorageRef: parsed.data.recording_storage_ref,
    transcriptStorageRef: parsed.data.transcript_storage_ref,
    metadata: metadata.metadata, metadataValid: true, createdAt: parsed.data.created_at,
  });
}

function loadEvidenceNode(database: AppDatabase, id: string): OptOutEvidenceNode | null {
  const tombstone = loadTombstone(database, id);
  return tombstone === null ? null : Object.freeze({
    tombstone, activity: loadActivity(database, tombstone.sourceActivityId),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
