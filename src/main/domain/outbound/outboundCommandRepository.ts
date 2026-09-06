import { z } from 'zod';

import {
  handoffResultSchema, outboundRequestSchema, type HandoffResult,
  type OutboundAttemptSummary, type OutboundReason, type OutboundRequest,
} from '../../../shared/contracts/outboundContract';
import { outboundIntentFingerprint } from '../../communications/contactSnapshot';
import type { AppDatabase } from '../../db/database';
import type { EventRepository } from '../events/eventRepository';
import type { Activity } from '../events/eventTypes';
import { assertCanonicalOptOutClosureReceipt, parseStoredOptOutClosureReceipt } from '../optOut/optOutClosureReceiptValidator';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';

const adapter = 'callie_outbound_v1';
const phases = ['requested', 'dispatching', 'handoff_accepted', 'refused', 'unavailable', 'unknown'] as const;
export type OutboundCommandPhase = typeof phases[number];
export interface OutboundCommandFact {
  request: OutboundRequest;
  phase: OutboundCommandPhase;
  reasonCode: OutboundReason | null;
  occurredAt: string;
}

type State = Pick<OutboundCommandFact, 'phase' | 'reasonCode'>;
type StoredFact = OutboundCommandFact & { prospectId: string };

/** Constant, owner-free failures. Neither conflict nor corruption is a new command fact. */
export class OutboundCommandEvidenceError extends Error {
  constructor(readonly reasonCode: 'command_conflict' | 'command_evidence_invalid') {
    super(reasonCode === 'command_conflict'
      ? 'Outbound command conflicts with existing intent.' : 'Outbound command evidence is invalid.');
    this.name = 'OutboundCommandEvidenceError';
  }
}
const invalid = () => new OutboundCommandEvidenceError('command_evidence_invalid');
const timestamp = z.string().datetime().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const stateShape = {
  phase: z.enum(phases), reasonCode: handoffResultSchema.shape.reasonCode,
};
function validState(value: { phase: OutboundCommandPhase; reasonCode?: OutboundReason | null }): boolean {
  if (value.reasonCode === 'command_conflict' || value.reasonCode === 'command_evidence_invalid') return false;
  if (value.phase === 'requested' || value.phase === 'dispatching') return value.reasonCode === null;
  return handoffResultSchema.safeParse({ status: value.phase, reasonCode: value.reasonCode }).success;
}
const factSchema = z.object({
  request: outboundRequestSchema, ...stateShape, occurredAt: timestamp,
}).strict().refine(validState);
// Only this versioned identity envelope is stored. No contact values or exception text.
const metadataSchema = z.object({
  version: z.literal(1), request: outboundRequestSchema,
  intentFingerprint: outboundRequestSchema.shape.expectedContactSnapshot, ...stateShape,
}).strict().refine(validState);
const maxMetadataLength = 8192;
const rowSchema = z.object({
  person_id: z.string(), prospect_id: z.string().min(1), sales_cycle_id: z.string(),
  kind: z.literal('system'), direction: z.literal('internal'), channel: z.literal('outbound_command'),
  adapter: z.literal(adapter), provider_idempotency_key: z.string(),
  occurred_at: timestamp, created_at: timestamp, metadata_json: z.string().max(maxMetadataLength),
  owns_cycle: z.literal(1),
  cadence_enrollment_id: z.null(), cadence_step_id: z.null(), cadence_component_id: z.null(),
  observed_outcome: z.null(), duration_seconds: z.null(), provider_reference: z.null(),
  consent_policy_record_id: z.null(), recording_storage_ref: z.null(), transcript_storage_ref: z.null(),
  note_text: z.null(), call_outcome: z.null(), callback_at: z.null(),
});
const manualMetadataSchema = z.object({
  formatVersion: z.literal(1), loggedManually: z.literal(true),
  outboundCommandId: outboundRequestSchema.shape.commandId,
  loggedVia: z.enum(['founder_workflow_ui', 'call_outcome']),
  summary: z.string().min(1).max(2000).optional(),
  callbackAt: z.string().datetime({ offset: true }).nullable().optional(),
  currentBlockPresent: z.boolean(), prohibitedPastTouchReported: z.boolean(),
  prohibitionAssessment: z.enum(['unknown', 'prohibited']),
}).strict().refine((value) => (value.loggedVia === 'founder_workflow_ui') === (value.summary !== undefined)
  && (value.prohibitionAssessment === 'prohibited') === value.prohibitedPastTouchReported
  && (!value.prohibitedPastTouchReported || value.currentBlockPresent));
const manualAssociationSchema = outboundRequestSchema.pick({
  commandId: true, personId: true, salesCycleId: true, channel: true,
});

/** An unresolved intent is uncertainty, never work to replay or queue. */
export function outboundCommandResult(state: State): HandoffResult {
  return state.phase === 'requested' || state.phase === 'dispatching'
    ? { status: 'unknown', reasonCode: 'handoff_uncertain' }
    : { status: state.phase, reasonCode: state.reasonCode };
}

function follows(previous: OutboundCommandPhase | undefined, next: OutboundCommandPhase): boolean {
  if (previous === undefined) return next === 'requested';
  if (previous === 'requested') return next === 'dispatching' || next === 'refused' || next === 'unavailable';
  return previous === 'dispatching' && next !== 'requested' && next !== 'dispatching';
}

export class OutboundCommandRepository {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly events: EventRepository;

  constructor(input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; events: EventRepository }) {
    if (input.database.raw !== input.unitOfWork.database.raw) throw new DomainRepositoryDatabaseMismatchError();
    input.events.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.events = input.events;
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database.raw !== database.raw || this.unitOfWork !== unitOfWork) throw new DomainRepositoryDatabaseMismatchError();
    this.events.assertBoundTo(database, unitOfWork);
  }

  read(input: OutboundRequest): State | null {
    const request = outboundRequestSchema.parse(input);
    const facts = this.readFacts(request.commandId);
    this.assertIntent(facts, request);
    const latest = facts.at(-1);
    return latest === undefined ? null : { phase: latest.phase, reasonCode: latest.reasonCode };
  }

  append(input: OutboundCommandFact, prospectId: string): void {
    this.unitOfWork.assertWriteScope();
    const parsed = factSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const fact = parsed.data;
    const metadata = { version: 1, request: fact.request, intentFingerprint: outboundIntentFingerprint(fact.request),
      phase: fact.phase, reasonCode: fact.reasonCode };
    if (JSON.stringify(metadata).length > maxMetadataLength) throw invalid();
    const facts = this.readFacts(fact.request.commandId);
    this.assertIntent(facts, fact.request);
    if (!this.database.raw.prepare(`SELECT cycle.id FROM sales_cycles AS cycle
      JOIN prospects AS prospect ON prospect.id = cycle.prospect_id AND prospect.person_id = cycle.person_id
      WHERE cycle.id = ? AND cycle.person_id = ? AND cycle.prospect_id = ?`)
      .get(fact.request.salesCycleId, fact.request.personId, prospectId)) throw invalid();
    const repeated = facts.find((existing) => existing.phase === fact.phase);
    if (repeated !== undefined) {
      if (repeated.reasonCode !== fact.reasonCode || repeated.occurredAt !== fact.occurredAt || repeated.prospectId !== prospectId) throw invalid();
      return;
    }
    const previous = facts.at(-1);
    if (!follows(previous?.phase, fact.phase)
      || (previous !== undefined && (previous.occurredAt > fact.occurredAt || previous.prospectId !== prospectId))) throw invalid();
    this.events.appendActivity({
      personId: fact.request.personId, prospectId, salesCycleId: fact.request.salesCycleId,
      kind: 'system', direction: 'internal', channel: 'outbound_command', occurredAt: fact.occurredAt,
      adapter, providerIdempotencyKey: `${fact.request.commandId}:${fact.phase}`, metadata,
    });
  }

  listRecent(personId: string, limit: number): OutboundAttemptSummary[] {
    z.number().int().safe().nonnegative().parse(limit);
    // Select logical requests using the existing Person/time index. Do not parse history
    // metadata or LIMIT phase rows. Every selected command gets all six exact key slots.
    const requests = this.database.raw.prepare(`SELECT provider_idempotency_key FROM activities
      WHERE person_id = ? AND adapter = ? AND provider_idempotency_key GLOB '*:requested'
      ORDER BY occurred_at DESC, provider_idempotency_key COLLATE BINARY ASC LIMIT ?`)
      .all(personId, adapter, Math.min(limit, 20)) as { provider_idempotency_key: string }[];
    return requests.map((row): OutboundAttemptSummary => {
      const commandId = row.provider_idempotency_key.slice(0, -':requested'.length);
      if (!outboundRequestSchema.shape.commandId.safeParse(commandId).success) throw invalid();
      const facts = this.readFacts(commandId);
      const first = facts[0];
      const latest = facts.at(-1);
      if (first === undefined || latest === undefined || first.request.personId !== personId) throw invalid();
      return {
        commandId, channel: first.request.channel, contactMethodId: first.request.contactMethodId,
        requestedAt: first.occurredAt, manualActivityId: this.readManualActivity(facts)?.id ?? null,
        ...outboundCommandResult(latest),
      };
    });
  }

  /** Historical evidence association only. Does not authorize or change execution. */
  resolveManualAssociation(input: Pick<OutboundRequest, 'commandId' | 'personId' | 'salesCycleId' | 'channel'>): Activity | null {
    const association = manualAssociationSchema.parse(input);
    const facts = this.readFacts(association.commandId);
    const request = facts[0]?.request;
    if (request === undefined || request.personId !== association.personId
      || request.salesCycleId !== association.salesCycleId || request.channel !== association.channel
      || !this.permitsManualAssociation(facts)) throw new OutboundCommandEvidenceError('command_conflict');
    return this.readManualActivity(facts);
  }

  private permitsManualAssociation(facts: StoredFact[]): boolean {
    return ['dispatching', 'handoff_accepted', 'unknown'].includes(facts.at(-1)?.phase ?? '');
  }

  private readManualActivity(facts: StoredFact[]): Activity | null {
    const first = facts[0];
    if (first === undefined) throw invalid();
    const row = this.database.raw.prepare(`SELECT id, channel, metadata_json FROM activities
      INDEXED BY activities_provider_idempotency_idx WHERE adapter = ? AND provider_idempotency_key = ?`)
      .get('callie_manual_outbound_v1', first.request.commandId) as { id: string; channel: string; metadata_json: string } | undefined;
    if (row === undefined) return null;
    if (!this.permitsManualAssociation(facts) || typeof row.metadata_json !== 'string'
      || row.metadata_json.length > 32768) throw invalid();
    let activity: Activity | null;
    try { activity = this.events.getActivity(row.id); } catch { throw invalid(); }
    if (activity === null || activity.id !== row.id || activity.channel !== row.channel
      || (activity.observedOutcome !== null && activity.observedOutcome.length > 200)) throw invalid();
    const metadata = manualMetadataSchema.safeParse(activity.metadata);
    if (!metadata.success || metadata.data.outboundCommandId !== first.request.commandId
      || activity.personId !== first.request.personId || activity.salesCycleId !== first.request.salesCycleId
      || activity.prospectId !== first.prospectId || activity.kind !== first.request.channel
      || activity.direction !== 'outbound' || activity.channel !== (first.request.channel === 'call' ? 'phone' : first.request.channel)
      || activity.providerReference !== null || activity.durationSeconds !== null || activity.recordingStorageRef !== null
      || activity.transcriptStorageRef !== null || activity.consentPolicyRecordId !== null || activity.noteText !== null
      || activity.cadenceEnrollmentId !== null || activity.cadenceStepId !== null || activity.cadenceComponentId !== null
      || (metadata.data.loggedVia === 'call_outcome'
        ? activity.kind !== 'call' || (activity.observedOutcome === 'opted_out'
          ? activity.callOutcome !== null : activity.callOutcome === null || activity.observedOutcome !== activity.callOutcome)
        : activity.callOutcome !== null || activity.callbackAt !== null)) throw invalid();
    const manualOptOut = metadata.data.loggedVia === 'call_outcome' && activity.observedOutcome === 'opted_out';
    if (metadata.data.callbackAt !== undefined && !manualOptOut) throw invalid();
    if (manualOptOut) {
      // A tag alone cannot establish that the indivisible opt-out closure happened.
      try {
        const receipt = parseStoredOptOutClosureReceipt(this.database.raw.prepare(
          'SELECT * FROM opt_out_closure_receipts WHERE source_activity_id = ?',
        ).get(activity.id));
        assertCanonicalOptOutClosureReceipt(this.database, receipt);
      } catch { throw invalid(); }
    }
    return activity;
  }

  private assertIntent(facts: StoredFact[], request: OutboundRequest): void {
    if (facts.length > 0 && outboundIntentFingerprint(facts[0].request) !== outboundIntentFingerprint(request)) {
      throw new OutboundCommandEvidenceError('command_conflict');
    }
  }

  private readFacts(commandId: string): StoredFact[] {
    // The unique indexed adapter/key seam bounds this read to at most six facts.
    // rowid supplies append order when timestamps tie. Neither newest-only nor
    // phase sorting can hide missing, out-of-order, or competing terminal evidence.
    const rows = this.database.raw.prepare(`SELECT activity.*,
      EXISTS (SELECT 1 FROM sales_cycles AS cycle JOIN prospects AS prospect
        ON prospect.id = cycle.prospect_id AND prospect.person_id = cycle.person_id
        WHERE cycle.id = activity.sales_cycle_id AND cycle.person_id = activity.person_id
          AND cycle.prospect_id = activity.prospect_id) AS owns_cycle
      FROM activities AS activity INDEXED BY activities_provider_idempotency_idx
      WHERE adapter = ? AND provider_idempotency_key IN (?, ?, ?, ?, ?, ?)
      ORDER BY activity.rowid ASC`).all(adapter, ...phases.map((phase) => `${commandId}:${phase}`));
    const facts: StoredFact[] = [];
    for (const raw of rows) {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) throw invalid();
      const row = parsed.data;
      let json: unknown;
      try { json = JSON.parse(row.metadata_json); } catch { throw invalid(); }
      const parsedMetadata = metadataSchema.safeParse(json);
      if (!parsedMetadata.success) throw invalid();
      const metadata = parsedMetadata.data;
      const fingerprint = outboundIntentFingerprint(metadata.request);
      const first = facts[0];
      const previous = facts.at(-1);
      if (metadata.request.commandId !== commandId
        || metadata.intentFingerprint !== fingerprint
        || row.person_id !== metadata.request.personId || row.sales_cycle_id !== metadata.request.salesCycleId
        || row.provider_idempotency_key !== `${commandId}:${metadata.phase}`
        || (first !== undefined && (outboundIntentFingerprint(first.request) !== fingerprint || first.prospectId !== row.prospect_id))
        || !follows(previous?.phase, metadata.phase)
        || (previous !== undefined && previous.occurredAt > row.occurred_at)) throw invalid();
      facts.push({ request: metadata.request, phase: metadata.phase, reasonCode: metadata.reasonCode,
        occurredAt: row.occurred_at, prospectId: row.prospect_id });
    }
    return facts;
  }
}
