import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { AppDatabase } from '../../db/database';
import type { EventRepository } from '../events/eventRepository';
import type { Activity, AppendActivityInput } from '../events/eventTypes';
import type { IdentityRepository } from '../identity/identityRepository';
import type { LifecycleService } from '../lifecycle/lifecycleService';
import type { SalesCycle } from '../lifecycle/lifecycleTypes';
import { serializeCanonical } from '../lifecycle/lifecycleValidation';
import {
  DomainRepositoryDatabaseMismatchError,
  LifecycleEvidenceError,
  LifecycleInvariantError,
  OptOutPersistenceConflictError,
} from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import type { OptOutRepository } from './optOutRepository';
import {
  assertCanonicalOptOutEvidence,
  expectedEvidenceRef,
  optOutCallEvidenceMatches,
} from './optOutEvidenceValidator';
import {
  optOutIdSchema,
  optOutUtcTimestampSchema,
  type ApplyOptOutInput,
  type ApplyOptOutResult,
  type OptOutFaultPoint,
  type OptOutHandle,
  type OptOutTombstone,
  type PropagateOptOutInput,
  type RecordPastOffAppTouchInput,
} from './optOutTypes';
import {
  applyOptOutInputSchema,
  optOutClosureCommandSchema,
  propagateOptOutInputSchema,
  retrospectiveOptOutInputSchema,
  type OptOutClosureCommand,
} from './optOutValidation';

export class OptOutService {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly identities: IdentityRepository;
  private readonly events: EventRepository;
  private readonly optOuts: OptOutRepository;
  private readonly lifecycle: LifecycleService;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly faultInjector: ((point: OptOutFaultPoint) => void) | undefined;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    identities: IdentityRepository;
    events: EventRepository;
    optOuts: OptOutRepository;
    lifecycle: LifecycleService;
    clock: Clock;
    ids: IdGenerator;
    faultInjector?: (point: OptOutFaultPoint) => void;
  }) {
    if (input.database.raw !== input.unitOfWork.database.raw) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
    input.identities.assertBoundTo(input.database, input.unitOfWork);
    input.events.assertBoundTo(input.database, input.unitOfWork);
    input.optOuts.assertBoundTo(input.database, input.unitOfWork);
    input.lifecycle.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.identities = input.identities;
    this.events = input.events;
    this.optOuts = input.optOuts;
    this.lifecycle = input.lifecycle;
    this.clock = input.clock;
    this.ids = input.ids;
    this.faultInjector = input.faultInjector;
  }

  apply(input: ApplyOptOutInput): ApplyOptOutResult {
    const parsed = applyOptOutInputSchema.parse(input) as ApplyOptOutInput;
    return this.unitOfWork.immediate(() => this.applyInScope(parsed));
  }

  propagateMostRestrictiveOptOut(input: PropagateOptOutInput): ApplyOptOutResult {
    const parsed = propagateOptOutInputSchema.parse(input) as PropagateOptOutInput;
    if (parsed.sourceTombstoneId === parsed.targetTombstoneId) {
      throw new LifecycleEvidenceError('Source and target tombstones must be distinct.');
    }
    return this.unitOfWork.immediate(() => {
      const source = this.optOuts.getById(parsed.sourceTombstoneId);
      const person = this.identities.getPerson(parsed.targetPersonId);
      if (source === null || person === null || source.personId === person.id) {
        throw new LifecycleEvidenceError('Opt-out propagation source or target is invalid.');
      }
      const activity = this.appendOrLoadExactActivity(parsed.evidenceActivity);
      if (activity.personId !== person.id
        || activity.direction !== 'internal'
        || activity.kind !== 'system'
        || activity.channel !== 'identity_propagation'
        || activity.observedOutcome !== 'opted_out'
        || !metadataHasSourceTombstone(activity.metadata, source.id)) {
        throw new LifecycleEvidenceError('Identity propagation requires exact internal evidence.');
      }
      assertCanonicalOptOutEvidence({
        tombstone: {
          id: parsed.targetTombstoneId,
          personId: person.id,
          requestedAt: source.requestedAt,
          observedChannel: 'identity_propagation',
          sourceActivityId: activity.id,
          evidenceRef: `tombstone:${source.id}`,
          policyVersion: source.policyVersion,
          createdAt: activity.occurredAt,
        },
        activity,
        sourceTombstone: source,
      });
      const command = optOutClosureCommandSchema.parse({
        version: 1, kind: 'propagate', input: parsed,
      }) as OptOutClosureCommand;
      const replay = this.loadExactClosureReceipt(activity.id, command);
      if (replay !== null) return replay;
      this.faultInjector?.('after_activity');
      const snapshots = this.captureProtectedSnapshots(person.id);
      const existing = this.optOuts.getForPerson(person.id);
      if (existing?.sourceActivityId === activity.id) {
        this.assertExactPropagationReplay(parsed, source, existing, activity);
      }
      const close = this.lifecycle.scopedWriter().closeForOptOut({
        personId: person.id, evidenceActivityId: activity.id,
        effectiveAt: activity.occurredAt,
        terminalStageEventId: parsed.terminalStageEventId,
      });
      this.faultInjector?.('after_lifecycle_close');
      const tombstone = existing ?? this.optOuts.insertTombstone({
        id: parsed.targetTombstoneId,
        personId: person.id,
        requestedAt: source.requestedAt,
        observedChannel: 'identity_propagation',
        sourceActivityId: activity.id,
        evidenceRef: `tombstone:${source.id}`,
        policyVersion: source.policyVersion,
        createdAt: optOutUtcTimestampSchema.parse(this.clock.now()),
      });
      this.faultInjector?.('after_tombstone');
      const candidates = [
        ...this.optOuts.listHandles(source.id).map(({ kind, normalizedValue }) => ({
          kind, normalizedValue,
        })),
        ...this.identities.listContactMethodsForPerson(person.id).map(({ kind, normalizedValue }) => ({
          kind, normalizedValue,
        })),
      ];
      const handles = this.captureHandles(tombstone, candidates);
      this.assertPostconditions({
        personId: person.id, tombstone, evidenceActivityId: activity.id,
        snapshots, requiredHandles: candidates,
      });
      this.faultInjector?.('after_postcondition');
      const result = freezeResult({
        tombstone, handles, cycle: close.cycle, alreadyApplied: existing !== null,
      });
      return this.optOuts.insertClosureReceipt({
        sourceActivityId: activity.id, operationKind: 'propagate', personId: person.id,
        tombstoneId: tombstone.id, sourceTombstoneId: source.id,
        closedCycleId: close.cycle?.id ?? null,
        terminalStageEventId: parsed.terminalStageEventId,
        command, result, createdAt: optOutUtcTimestampSchema.parse(this.clock.now()),
      }).result;
    });
  }

  recordPastOffAppTouch(input: RecordPastOffAppTouchInput): Activity {
    const parsed = retrospectiveOptOutInputSchema.parse(input) as RecordPastOffAppTouchInput;
    if (parsed.activity.occurredAt > parsed.reportedAt) {
      throw new LifecycleEvidenceError('Retrospective evidence cannot occur after it is reported.');
    }
    if (containsSelectionReceipt(parsed.activity.metadata)) {
      throw new LifecycleEvidenceError('Retrospective evidence cannot fabricate queue selection.');
    }
    return this.unitOfWork.immediate(() => {
      if (this.identities.getPerson(parsed.personId) === null
        || parsed.activity.personId !== parsed.personId) {
        throw new LifecycleEvidenceError('Retrospective evidence must belong to the exact Person.');
      }
      const tombstone = this.optOuts.getForPerson(parsed.personId);
      if (tombstone === null) {
        throw new LifecycleEvidenceError('Retrospective prohibited-touch logging requires opt-out.');
      }
      if (parsed.activity.occurredAt < tombstone.requestedAt) {
        throw new LifecycleEvidenceError('Retrospective prohibited-touch evidence predates opt-out.');
      }
      const metadata = isRecord(parsed.activity.metadata) ? parsed.activity.metadata : {};
      const activity = this.appendOrLoadExactActivity({
        ...parsed.activity,
        metadata: {
          ...metadata,
          reportedAfterOptOut: true,
          prohibitedTouchReported: true,
        },
      });
      if (activity.direction !== 'outbound') {
        throw new LifecycleEvidenceError('Retrospective touch evidence must be outbound.');
      }
      return activity;
    });
  }

  private applyInScope(input: ApplyOptOutInput): ApplyOptOutResult {
    const activity = input.evidence.kind === 'existing_activity'
      ? this.events.getActivity(input.evidence.activityId)
      : this.appendOrLoadExactActivity(input.evidence.activity);
    if (activity === null) throw new LifecycleEvidenceError('Opt-out Activity does not exist.');
    this.assertDecisionEvidence(input, activity);
    const command = optOutClosureCommandSchema.parse({
      version: 1, kind: 'apply', input,
    }) as OptOutClosureCommand;
    const replay = this.loadExactClosureReceipt(activity.id, command);
    if (replay !== null) return replay;
    this.faultInjector?.('after_activity');
    const person = this.identities.getPerson(input.personId);
    if (person === null) throw new LifecycleEvidenceError('Opt-out Person does not exist.');
    const existing = this.optOuts.getForPerson(person.id);
    if (existing?.sourceActivityId === activity.id) {
      this.assertExactObservationReplay(input, existing, activity);
    }
    const snapshots = this.captureProtectedSnapshots(person.id);
    const close = this.lifecycle.scopedWriter().closeForOptOut({
      personId: person.id, evidenceActivityId: activity.id,
      effectiveAt: input.requestedAt,
      terminalStageEventId: input.terminalStageEventId,
    });
    this.faultInjector?.('after_lifecycle_close');
    const tombstone = existing ?? this.optOuts.insertTombstone({
      id: input.tombstoneId,
      personId: person.id,
      requestedAt: input.requestedAt,
      observedChannel: input.decision.channel,
      sourceActivityId: activity.id,
      evidenceRef: activity.providerReference
        ?? (activity.adapter !== null && activity.providerIdempotencyKey !== null
          ? `${activity.adapter}:${activity.providerIdempotencyKey}` : null),
      policyVersion: input.policyVersion,
      createdAt: optOutUtcTimestampSchema.parse(this.clock.now()),
    });
    this.faultInjector?.('after_tombstone');
    const candidates = this.identities.listContactMethodsForPerson(person.id)
      .map(({ kind, normalizedValue }) => ({ kind, normalizedValue }));
    const handles = this.captureHandles(tombstone, candidates);
    this.assertPostconditions({
      personId: person.id, tombstone, evidenceActivityId: activity.id,
      snapshots, requiredHandles: candidates,
    });
    this.faultInjector?.('after_postcondition');
    const result = freezeResult({
      tombstone, handles, cycle: close.cycle, alreadyApplied: existing !== null,
    });
    return this.optOuts.insertClosureReceipt({
      sourceActivityId: activity.id, operationKind: 'apply', personId: person.id,
      tombstoneId: tombstone.id, sourceTombstoneId: null,
      closedCycleId: close.cycle?.id ?? null,
      terminalStageEventId: input.terminalStageEventId,
      command, result, createdAt: optOutUtcTimestampSchema.parse(this.clock.now()),
    }).result;
  }

  private loadExactClosureReceipt(
    sourceActivityId: string,
    command: OptOutClosureCommand,
  ): ApplyOptOutResult | null {
    const receipt = this.optOuts.getClosureReceiptForActivity(sourceActivityId);
    if (receipt === null) return null;
    this.optOuts.assertCanonicalClosureReceipt(receipt);
    if (serializeCanonical(receipt.command) !== serializeCanonical(command)) {
      throw new OptOutPersistenceConflictError('closure_receipt', sourceActivityId);
    }
    return receipt.result;
  }

  private appendOrLoadExactActivity(input: AppendActivityInput & { id: string; occurredAt: string }): Activity {
    const existing = this.events.getActivity(input.id);
    if (existing !== null) {
      if (!activityMatches(existing, input)) {
        throw new LifecycleEvidenceError('Activity retry changed immutable evidence.');
      }
      return existing;
    }
    const appended = this.events.appendActivity(input);
    if (!activityMatches(appended, input)) {
      throw new LifecycleEvidenceError('Provider evidence resolved to different immutable Activity.');
    }
    return appended;
  }

  private assertDecisionEvidence(input: ApplyOptOutInput, activity: Activity): void {
    if (activity.personId !== input.personId
      || activity.observedOutcome !== 'opted_out'
      || activity.occurredAt > input.requestedAt) {
      throw new LifecycleEvidenceError('Opt-out evidence ownership, outcome, or time is invalid.');
    }
    const decision = input.decision;
    if (decision.kind === 'structured_written') {
      const expectedKind = decision.channel === 'gmail' ? 'email' : 'text';
      if (activity.direction !== 'inbound'
        || activity.channel !== decision.channel
        || activity.kind !== expectedKind) {
        throw new LifecycleEvidenceError('Structured written opt-out evidence is mismatched.');
      }
      return;
    }
    if (decision.channel === 'manual') {
      if (activity.direction !== 'internal'
        || activity.channel !== 'manual'
        || (activity.kind !== 'note' && activity.kind !== 'system')) {
        throw new LifecycleEvidenceError('Manual opt-out requires founder-recorded internal evidence.');
      }
      return;
    }
    if (!optOutCallEvidenceMatches(activity)) {
      throw new LifecycleEvidenceError('Call opt-out requires founder-confirmed call evidence.');
    }
  }

  private assertExactObservationReplay(
    input: ApplyOptOutInput,
    tombstone: OptOutTombstone,
    activity: Activity,
  ): void {
    if (tombstone.id !== input.tombstoneId
      || tombstone.personId !== input.personId
      || tombstone.requestedAt !== input.requestedAt
      || tombstone.observedChannel !== input.decision.channel
      || tombstone.policyVersion !== input.policyVersion
      || tombstone.evidenceRef !== expectedEvidenceRef(activity)) {
      throw new LifecycleEvidenceError('Same opt-out observation replay changed its command wrapper.');
    }
  }

  private assertExactPropagationReplay(
    input: PropagateOptOutInput,
    source: OptOutTombstone,
    target: OptOutTombstone,
    activity: Activity,
  ): void {
    if (target.id !== input.targetTombstoneId
      || target.personId !== input.targetPersonId
      || target.requestedAt !== source.requestedAt
      || target.observedChannel !== 'identity_propagation'
      || target.policyVersion !== source.policyVersion
      || target.evidenceRef !== `tombstone:${source.id}`
      || !metadataHasSourceTombstone(activity.metadata, source.id)) {
      throw new LifecycleEvidenceError('Same propagation observation replay changed its command wrapper.');
    }
  }

  private captureHandles(
    tombstone: OptOutTombstone,
    candidates: ReadonlyArray<{ kind: 'phone' | 'email'; normalizedValue: string }>,
  ): readonly OptOutHandle[] {
    const unique = new Map<string, { kind: 'phone' | 'email'; normalizedValue: string }>();
    for (const candidate of candidates) unique.set(`${candidate.kind}:${candidate.normalizedValue}`, candidate);
    const existing = new Map(this.optOuts.listHandles(tombstone.id)
      .map((handle) => [`${handle.kind}:${handle.normalizedValue}`, handle]));
    for (const candidate of [...unique.values()].sort(compareHandleFact)) {
      if (existing.has(`${candidate.kind}:${candidate.normalizedValue}`)) continue;
      const inserted = this.optOuts.insertBlockedHandle({
        id: optOutIdSchema.parse(this.ids.next()), tombstoneId: tombstone.id,
        ...candidate, createdAt: optOutUtcTimestampSchema.parse(this.clock.now()),
      });
      existing.set(`${candidate.kind}:${candidate.normalizedValue}`, inserted);
      this.faultInjector?.('after_handle');
    }
    return Object.freeze(this.optOuts.listHandles(tombstone.id));
  }

  private captureProtectedSnapshots(personId: string): ProtectedSnapshots {
    return {
      wonTerms: JSON.stringify(this.database.raw.prepare(`
        SELECT terms.* FROM won_terms AS terms
        JOIN sales_cycles AS cycle ON cycle.id = terms.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY terms.sales_cycle_id
      `).all(personId)),
      sources: JSON.stringify(this.database.raw.prepare(`
        SELECT * FROM source_events WHERE person_id = ? ORDER BY id
      `).all(personId)),
      prospects: JSON.stringify(this.database.raw.prepare(`
        SELECT * FROM prospects WHERE person_id = ? ORDER BY id
      `).all(personId)),
      reactivationCount: rowCount(this.database.raw.prepare(`
        SELECT COUNT(*) AS count FROM reactivation_rules AS rule
        JOIN sales_cycles AS cycle ON cycle.id = rule.sales_cycle_id
        WHERE cycle.person_id = ?
      `).get(personId)),
    };
  }

  private assertPostconditions(input: {
    personId: string;
    tombstone: OptOutTombstone;
    evidenceActivityId: string;
    snapshots: ProtectedSnapshots;
    requiredHandles: ReadonlyArray<{ kind: 'phone' | 'email'; normalizedValue: string }>;
  }): void {
    const person = this.identities.getPerson(input.personId);
    const canonical = this.optOuts.getForPerson(input.personId);
    const evidence = this.events.getActivity(input.evidenceActivityId);
    if (person === null || !person.optedOut || person.optedOutAt !== input.tombstone.requestedAt
      || canonical?.id !== input.tombstone.id
      || evidence?.personId !== input.personId) {
      throw new LifecycleInvariantError('Permanent opt-out projection or evidence is inconsistent.');
    }
    const open = rowCount(this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).get(input.personId));
    const activeEnrollments = rowCount(this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM cadence_enrollments AS enrollment
      JOIN sales_cycles AS cycle ON cycle.id = enrollment.sales_cycle_id
      WHERE cycle.person_id = ? AND enrollment.status = 'active'
    `).get(input.personId));
    const pendingOutbound = rowCount(this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions AS action
      JOIN sales_cycles AS cycle ON cycle.id = action.sales_cycle_id
      WHERE cycle.person_id = ? AND action.status = 'pending' AND action.channel IS NOT NULL
    `).get(input.personId));
    if (open !== 0 || activeEnrollments !== 0 || pendingOutbound !== 0) {
      throw new LifecycleInvariantError('Opted-out Person retains outbound workflow work.');
    }
    const handleKeys = new Set(this.optOuts.listHandles(input.tombstone.id)
      .map(({ kind, normalizedValue }) => `${kind}:${normalizedValue}`));
    if (input.requiredHandles.some(({ kind, normalizedValue }) => (
      !handleKeys.has(`${kind}:${normalizedValue}`)
    ))) throw new LifecycleInvariantError('A known Person handle was not retained.');
    const after = this.captureProtectedSnapshots(input.personId);
    if (after.wonTerms !== input.snapshots.wonTerms
      || after.sources !== input.snapshots.sources
      || after.prospects !== input.snapshots.prospects
      || after.reactivationCount !== input.snapshots.reactivationCount) {
      throw new LifecycleInvariantError('Opt-out closure changed protected history or reactivation rows.');
    }
  }
}

type ProtectedSnapshots = {
  wonTerms: string;
  sources: string;
  prospects: string;
  reactivationCount: number;
};

function activityMatches(
  activity: Activity,
  input: AppendActivityInput & { id: string; occurredAt: string },
): boolean {
  return activity.id === input.id
    && activity.personId === input.personId
    && activity.prospectId === (input.prospectId ?? null)
    && activity.salesCycleId === (input.salesCycleId ?? null)
    && activity.cadenceEnrollmentId === (input.cadenceEnrollmentId ?? null)
    && activity.cadenceStepId === (input.cadenceStepId ?? null)
    && activity.cadenceComponentId === (input.cadenceComponentId ?? null)
    && activity.kind === input.kind
    && activity.direction === input.direction
    && activity.channel === input.channel
    && activity.occurredAt === input.occurredAt
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

function freezeResult(input: {
  tombstone: OptOutTombstone;
  handles: readonly OptOutHandle[];
  cycle: SalesCycle | null;
  alreadyApplied: boolean;
}): ApplyOptOutResult {
  return Object.freeze({ ...input, handles: Object.freeze([...input.handles]) });
}

function compareHandleFact(
  left: { kind: string; normalizedValue: string },
  right: { kind: string; normalizedValue: string },
): number {
  return left.kind.localeCompare(right.kind) || left.normalizedValue.localeCompare(right.normalizedValue);
}

function metadataHasSourceTombstone(value: unknown, id: string): boolean {
  return isRecord(value) && value.sourceTombstoneId === id;
}

function containsSelectionReceipt(value: unknown): boolean {
  return isRecord(value)
    && ('todaySelectedCallReceipt' in value || 'selectedCallReceipt' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowCount(value: unknown): number {
  return z.object({ count: z.number().int().nonnegative() }).parse(value).count;
}
