import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import {
  PrioritizationService,
} from '../../src/main/domain/prioritization/prioritizationService';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import {
  OutboundPermissionService,
} from '../../src/main/domain/optOut/outboundPermissionService';
import {
  DomainRepositoryDatabaseMismatchError,
  PrioritizationIdempotencyConflictError,
  PrioritizationInputCorruptionError,
  PrioritizationOperationalBlockError,
  PrioritizationStaleWriteError,
  PriorityP0ReachabilityError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const EVAL_AT = '2026-08-30T13:00:00.000Z';
const LATER = '2026-08-30T14:00:00.000Z';
const CLOCK_NOW = '2026-08-30T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class UnusedIds {
  next(): string {
    throw new Error('The prioritization service must not consume generated IDs.');
  }
}

describe.each(['public', 'scoped'] as const)('PrioritizationService (%s)', (mode) => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let clock: FixedClock;
  let repository: PrioritizationRepository;
  let service: PrioritizationService;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    clock = new FixedClock();
    repository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({
      database, unitOfWork, clock, ids: new UnusedIds(),
    });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    service = new PrioritizationService({
      database, unitOfWork, clock, repository, outboundPermission,
    });
    if (mode === 'scoped') {
      service.recordTriggerEvent = input => unitOfWork.immediate(
        () => service.scopedWriter().recordTriggerEvent(input),
      );
      service.recalculateProspect = input => unitOfWork.immediate(
        () => service.scopedWriter().recalculateProspect(input),
      );
    }
    unitOfWork.immediate(() => {
      const installed = repository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      repository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  let phoneCounter = 1000;

  function addDirectPhone(prospect: SeededProspect, id: string): void {
    phoneCounter += 1;
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, `+1401555${phoneCounter}`,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function addProperty(prospect: SeededProspect, id: string, doorCount: number): void {
    database.raw.prepare(`
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, door_count,
        created_at, updated_at
      ) VALUES (?, ?, 'Providence', 'RI', 'US', ?, ?, ?)
    `).run(id, `${id} Main St`, doorCount, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prospect_properties (prospect_id, property_id, created_at)
      VALUES (?, ?, ?)
    `).run(prospect.prospectId, id, DOMAIN_TIMESTAMP);
  }

  function recalc(
    prospect: SeededProspect,
    evaluationId: string,
    overrides: Partial<{
      evaluatedAt: string;
      expectedProjectionVersion: number | null;
    }> = {},
  ) {
    return service.recalculateProspect({
      evaluationId,
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: overrides.evaluatedAt ?? EVAL_AT,
      expectedProjectionVersion: overrides.expectedProjectionVersion ?? null,
    });
  }

  it('requires the exact active UOW even for a retained writer and rolls back the entire caller scope', () => {
    const prospect = seedProspect(database.raw, 'scoped-rollback');
    const command = { evaluationId: 'scoped-eval', prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: EVAL_AT, expectedProjectionVersion: null as number | null };
    expect(() => service.scopedWriter()).toThrow();
    const writer = unitOfWork.immediate(() => service.scopedWriter());
    expect(() => writer.recalculateProspect(command)).toThrow();
    const foreign = new DomainUnitOfWork(database);
    expect(() => foreign.immediate(() => writer.recalculateProspect(command))).toThrow();
    expect(() => unitOfWork.immediate(() => {
      writer.recalculateProspect(command);
      throw new Error('rollback caller');
    })).toThrow('rollback caller');
    expect(repository.getEvaluationById(command.evaluationId)).toBeNull();
    expect(repository.getProjection(prospect.prospectId)).toBeNull();
    const scoped = unitOfWork.immediate(() => writer.recalculateProspect(command));
    expect(service.recalculateProspect(command)).toEqual(scoped);
  });

  it('rolls back scoped trigger plus recalculation and preserves the actual source proof gate', () => {
    const prospect = seedProspect(database.raw, 'combined-rollback');
    const other = seedProspect(database.raw, 'wrong-proof-owner');
    database.raw.prepare(`INSERT INTO source_events (id, person_id, channel, observed_at, source_record_json, created_at)
      VALUES ('combined-source', ?, 'frbo', ?, '{}', ?)`).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const command = { id: 'combined-trigger', prospectId: prospect.prospectId, triggerType: 'live_vacancy' as const,
      effectiveAt: DOMAIN_TIMESTAMP, sourceExpiresAt: null as string | null, strengthMultiplier: 1, verificationState: 'unverified' as const,
      evidence: { formatVersion: 1 as const, triggerType: 'live_vacancy' as const, authoredUnderRuleVersionId: 'founder-priority-v1',
        function: 'decaying' as const, evidenceRefs: ['fixture-listing'] as const,
        proof: { kind: 'source_event' as const, sourceEventId: 'combined-source', sourceObservedAt: DOMAIN_TIMESTAMP } } };
    const scoped = unitOfWork.immediate(() => service.scopedWriter());
    expect(() => scoped.recordTriggerEvent(command)).toThrow();
    expect(() => service.recordTriggerEvent({ ...command, prospectId: other.prospectId })).toThrow();
    expect(() => unitOfWork.immediate(() => {
      scoped.recordTriggerEvent(command);
      scoped.recalculateProspect({ evaluationId: 'combined-eval', prospectId: prospect.prospectId,
        ruleVersionId: 'founder-priority-v1', evaluatedAt: EVAL_AT, expectedProjectionVersion: null });
      throw new Error('rollback combined');
    })).toThrow('rollback combined');
    expect(repository.getTriggerEventById(command.id)).toBeNull();
    expect(repository.getEvaluationById('combined-eval')).toBeNull();
    expect(repository.getProjection(prospect.prospectId)).toBeNull();
  });

  it('rejects mixed database/UoW composition at construction', () => {
    const otherUnit = new DomainUnitOfWork(database);
    expect(() => new PrioritizationService({
      database,
      unitOfWork: otherUnit,
      clock,
      repository,
      outboundPermission: {
        assertBoundTo: () => { throw new DomainRepositoryDatabaseMismatchError(); },
      } as never,
    })).toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('previews an eligible prospect without writes and byte-identically on repeat', () => {
    const prospect = seedProspect(database.raw, 'preview-basic');
    addDirectPhone(prospect, 'preview-basic-phone');
    addProperty(prospect, 'preview-basic-prop', 10);
    const before = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    const first = service.evaluatePreview({
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    });
    const second = service.evaluatePreview({
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    });
    const after = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.outcome).toMatchObject({
      kind: 'evaluated',
      fitPoints: 15,
      fitBand: 'medium',
      timingMilliPoints: 0,
      timingBand: 'cold',
      reachability: 'direct',
      priority: 'p3',
      play: 'nurture',
      lastContactActivityId: null,
      lastContactAt: null,
    });
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_evaluations',
    ).get()).toEqual({ count: 0 });
  });

  it('preview may evaluate a future explicit time because it cannot mutate state', () => {
    const prospect = seedProspect(database.raw, 'preview-future');
    addDirectPhone(prospect, 'preview-future-phone');
    const future = '2027-01-01T00:00:00.000Z';
    expect(service.evaluatePreview({
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: future,
    }).outcome.kind).toBe('evaluated');
  });

  it('preview returns the exact not_prioritizable outcome for each excluded state', () => {
    const unreviewed = seedProspect(database.raw, 'preview-unreviewed');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(unreviewed.prospectId);
    expect(service.evaluatePreview({
      prospectId: unreviewed.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    }).outcome).toMatchObject({
      kind: 'not_prioritizable',
      qualification: { kind: 'pending_review', qualificationState: 'unreviewed' },
    });
    const disqualified = seedProspect(database.raw, 'preview-disqualified');
    database.raw.prepare(`
      UPDATE prospects
      SET qualification_state = 'disqualified', qualification_gate_reason = 'out_of_area'
      WHERE id = ?
    `).run(disqualified.prospectId);
    expect(service.evaluatePreview({
      prospectId: disqualified.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    }).outcome).toMatchObject({
      kind: 'not_prioritizable',
      qualification: { kind: 'gated', reasons: ['out_of_area'] },
    });
    const deleted = seedProspect(database.raw, 'preview-deleted');
    database.raw.prepare(`
      UPDATE persons SET deleted_at = ? WHERE id = ?
    `).run(DOMAIN_TIMESTAMP, deleted.personId);
    expect(service.evaluatePreview({
      prospectId: deleted.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    }).outcome).toMatchObject({
      kind: 'not_prioritizable',
      qualification: { kind: 'operationally_blocked', reason: 'person_deleted' },
    });
  });

  it('blocks a retained-handle reimported Person before any Fit/Timing read', () => {
    // A fully independent opted-out person retains a handle tombstone.
    const optedOut = seedProspect(database.raw, 'preview-optout-src');
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES ('optout-evidence', ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(optedOut.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO opt_out_tombstones (
        id, person_id, requested_at, observed_channel, source_activity_id,
        policy_version, created_at
      ) VALUES ('optout-tombstone', ?, ?, 'imessage', 'optout-evidence',
                'founder_opt_out_v1', ?)
    `).run(optedOut.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
      VALUES ('optout-handle', 'optout-tombstone', 'phone', '+14015550000', ?)
    `).run(DOMAIN_TIMESTAMP);
    // A fresh reimported person shares only the handle; persons.opted_out=0.
    const fresh = seedProspect(database.raw, 'preview-fresh');
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('fresh-phone', ?, 'phone', '+14015550000', 'valid', 'direct', 1, ?, ?)
    `).run(fresh.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const preview = service.evaluatePreview({
      prospectId: fresh.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
    });
    expect(preview.outcome).toMatchObject({
      kind: 'not_prioritizable',
      qualification: {
        kind: 'operationally_blocked',
        reason: 'person_opted_out',
        evidenceIds: ['optout-tombstone'],
      },
    });
    // Recalculation persists the immutable gated decision with no projection.
    const result = recalc(fresh, 'fresh-blocked-evaluation');
    expect(result).toMatchObject({
      kind: 'not_prioritizable',
      projection: null,
      qualification: { reason: 'person_opted_out' },
    });
    expect(database.raw.prepare(`
      SELECT decision_kind, fit_points FROM prioritization_evaluations
      WHERE id = 'fresh-blocked-evaluation'
    `).get()).toEqual({ decision_kind: 'not_prioritizable', fit_points: null });
  });

  it('recalculates a qualified prospect into an immutable evaluation plus projection', () => {
    const prospect = seedProspect(database.raw, 'recalc-basic');
    addDirectPhone(prospect, 'recalc-basic-phone');
    addProperty(prospect, 'recalc-basic-prop', 10);
    const result = recalc(prospect, 'recalc-basic-evaluation');
    expect(result.kind).toBe('evaluated');
    if (result.kind !== 'evaluated') return;
    expect(result.evaluation).toMatchObject({
      decisionKind: 'evaluated',
      id: 'recalc-basic-evaluation',
      fitPoints: 15,
      priority: 'p3',
    });
    expect(result.projection).toMatchObject({
      prospectId: prospect.prospectId,
      evaluationId: 'recalc-basic-evaluation',
      version: 1,
    });
  });

  it('replays the exact command and conflicts on any changed field without consuming defaults', () => {
    const prospect = seedProspect(database.raw, 'recalc-replay');
    addDirectPhone(prospect, 'recalc-replay-phone');
    const first = recalc(prospect, 'recalc-replay-evaluation');
    // Replay after mutable facts changed: same immutable result, no new rows.
    addProperty(prospect, 'recalc-replay-prop', 10);
    const replayed = recalc(prospect, 'recalc-replay-evaluation');
    expect(JSON.stringify(replayed.evaluation)).toBe(JSON.stringify(first.evaluation));
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_evaluations',
    ).get()).toEqual({ count: 1 });
    expect(() => recalc(prospect, 'recalc-replay-evaluation', { evaluatedAt: LATER }))
      .toThrow(PrioritizationIdempotencyConflictError);
    expect(() => recalc(prospect, 'recalc-replay-evaluation', {
      expectedProjectionVersion: 1,
    })).toThrow(PrioritizationIdempotencyConflictError);
  });

  it('rejects first executions that violate clock, projection, or rule constraints', () => {
    const prospect = seedProspect(database.raw, 'recalc-guards');
    addDirectPhone(prospect, 'recalc-guards-phone');
    expect(() => recalc(prospect, 'recalc-guards-future', {
      evaluatedAt: '2027-01-01T00:00:00.000Z',
    })).toThrow(PrioritizationInputCorruptionError);
    recalc(prospect, 'recalc-guards-first');
    // Earlier than the current projection evaluation.
    expect(() => recalc(prospect, 'recalc-guards-earlier', {
      evaluatedAt: DOMAIN_TIMESTAMP, expectedProjectionVersion: 1,
    })).toThrow(PrioritizationStaleWriteError);
    // Existing projection with expected null.
    expect(() => recalc(prospect, 'recalc-guards-null', { evaluatedAt: LATER }))
      .toThrow(PrioritizationStaleWriteError);
    // Stale expected version.
    expect(() => recalc(prospect, 'recalc-guards-stale', {
      evaluatedAt: LATER, expectedProjectionVersion: 9,
    })).toThrow(PrioritizationStaleWriteError);
    // Inactive rule version.
    expect(() => service.recalculateProspect({
      evaluationId: 'recalc-guards-inactive',
      prospectId: prospect.prospectId,
      ruleVersionId: 'not-the-active-rule',
      evaluatedAt: LATER,
      expectedProjectionVersion: 1,
    })).toThrow(PrioritizationStaleWriteError);
    // A failed rejection consumed no evaluation ID.
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_evaluations',
    ).get()).toEqual({ count: 1 });
  });

  it('CAS-updates the projection on a fresh recalculation and copies last contact', () => {
    const prospect = seedProspect(database.raw, 'recalc-update');
    addDirectPhone(prospect, 'recalc-update-phone');
    recalc(prospect, 'recalc-update-a');
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, kind, direction, channel, occurred_at,
        observed_outcome, metadata_json, created_at
      ) VALUES ('recalc-contact', ?, ?, 'call', 'outbound', 'phone', ?, 'answered', '{}', ?)
    `).run(prospect.personId, prospect.prospectId, EVAL_AT, EVAL_AT);
    const second = recalc(prospect, 'recalc-update-b', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(second.kind).toBe('evaluated');
    if (second.kind !== 'evaluated') return;
    expect(second.projection).toMatchObject({
      version: 2,
      evaluationId: 'recalc-update-b',
      lastContactActivityId: 'recalc-contact',
      lastContactAt: EVAL_AT,
    });
    expect(second.evaluation).toMatchObject({
      lastContactActivityId: 'recalc-contact',
      lastContactAt: EVAL_AT,
    });
  });

  it('gates a disqualified prospect: retires controls, deletes projection, keeps history', () => {
    const prospect = seedProspect(database.raw, 'recalc-gate');
    addDirectPhone(prospect, 'recalc-gate-phone');
    recalc(prospect, 'recalc-gate-first');
    const snapshotBefore = service.getEffectivePrioritySnapshot({
      prospectId: prospect.prospectId, asOf: EVAL_AT,
    });
    expect(snapshotBefore.projectionVersion).toBe(1);
    // Founder snoozes, then the prospect is disqualified.
    unitOfWork.immediate(() => repository.createOverride({
      id: 'recalc-gate-snooze',
      prospectId: prospect.prospectId,
      kind: 'snooze',
      priority: null,
      reason: 'Wait for spring',
      createdAt: EVAL_AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
      status: 'active',
      expiredAt: null,
    }));
    database.raw.prepare(`
      UPDATE prospects
      SET qualification_state = 'disqualified', qualification_gate_reason = 'harmful_operator'
      WHERE id = ?
    `).run(prospect.prospectId);
    const gated = recalc(prospect, 'recalc-gate-second', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(gated).toMatchObject({
      kind: 'not_prioritizable',
      projection: null,
      qualification: { kind: 'gated', reasons: ['harmful_operator'] },
    });
    expect(repository.getProjection(prospect.prospectId)).toBeNull();
    const retired = repository.getOverrideById('recalc-gate-snooze');
    expect(retired).toMatchObject({ status: 'expired', expiresAt: LATER, expiredAt: LATER });
    // Historical evaluated row remains immutable.
    expect(database.raw.prepare(`
      SELECT decision_kind FROM prioritization_evaluations WHERE id = 'recalc-gate-first'
    `).get()).toEqual({ decision_kind: 'evaluated' });
    // Gated exact retry returns the original immutable result without reapplying.
    const retry = recalc(prospect, 'recalc-gate-second', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(JSON.stringify(retry.evaluation)).toBe(JSON.stringify(gated.evaluation));
  });

  it('retires effective P0 overrides in-transaction when Direct reachability is lost', () => {
    const prospect = seedProspect(database.raw, 'recalc-p0');
    addDirectPhone(prospect, 'recalc-p0-phone');
    recalc(prospect, 'recalc-p0-first');
    unitOfWork.immediate(() => repository.createOverride({
      id: 'recalc-p0-override',
      prospectId: prospect.prospectId,
      kind: 'priority',
      priority: 'p0',
      reason: 'Founder priority',
      createdAt: EVAL_AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
      status: 'active',
      expiredAt: null,
    }));
    database.raw.prepare(`
      UPDATE person_contact_methods SET validation_state = 'invalid'
      WHERE id = 'recalc-p0-phone'
    `).run();
    const result = recalc(prospect, 'recalc-p0-second', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(result.kind).toBe('evaluated');
    if (result.kind !== 'evaluated') return;
    expect(result.projection.reachability).toBe('none');
    expect(repository.getOverrideById('recalc-p0-override')).toMatchObject({
      status: 'expired', expiresAt: LATER,
    });
  });

  it('records source-backed trigger events idempotently with typed proof conflicts', () => {
    const prospect = seedProspect(database.raw, 'trigger-record');
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json,
        referred_by_person_id, referrer_unknown_reason, created_at
      ) VALUES ('trigger-record-referral', ?, 'referral', ?, '{}', NULL, 'fixture', ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const command = {
      id: 'trigger-record-event',
      prospectId: prospect.prospectId,
      triggerType: 'direct_referral' as const,
      effectiveAt: DOMAIN_TIMESTAMP,
      sourceExpiresAt: null as string | null,
      strengthMultiplier: 1,
      verificationState: 'verified' as const,
      evidence: {
        formatVersion: 1 as const,
        triggerType: 'direct_referral' as const,
        authoredUnderRuleVersionId: 'founder-priority-v1',
        evidenceRefs: ['ref-1'] as const,
        function: 'decaying' as const,
        proof: {
          kind: 'source_event' as const,
          sourceEventId: 'trigger-record-referral',
          sourceObservedAt: DOMAIN_TIMESTAMP,
        },
      },
    };
    const stored = service.recordTriggerEvent(command);
    expect(stored).toMatchObject({ id: 'trigger-record-event', triggerType: 'direct_referral' });
    expect(service.recordTriggerEvent(command)).toEqual(stored);
    expect(() => service.recordTriggerEvent({ ...command, strengthMultiplier: 2 }))
      .toThrow(PrioritizationIdempotencyConflictError);
    expect(() => service.recordTriggerEvent({ ...command, id: 'different-id' }))
      .toThrow(PrioritizationIdempotencyConflictError);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM trigger_events',
    ).get()).toEqual({ count: 1 });
  });

  it('manual controls insert an active control plus its preference event atomically', () => {
    const winner = seedProspect(database.raw, 'control-winner');
    const loser = seedProspect(database.raw, 'control-loser');
    addDirectPhone(winner, 'control-winner-phone');
    addDirectPhone(loser, 'control-loser-phone');
    recalc(winner, 'control-winner-eval');
    recalc(loser, 'control-loser-eval');
    const command = {
      controlId: 'control-pin',
      preferenceEventId: 'control-pin-event',
      controlledProspectId: winner.prospectId,
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'control-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'control-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Founder pinned during review',
      asOf: LATER,
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    const snapshot = service.pinProspect(command);
    expect(snapshot.controls.pin).toMatchObject({ id: 'control-pin', kind: 'pin_to_top' });
    // Exact replay returns the same canonical snapshot without new writes.
    const replayed = service.pinProspect(command);
    expect(replayed.controls.pin?.id).toBe('control-pin');
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_preference_events',
    ).get()).toEqual({ count: 1 });
    expect(() => service.pinProspect({ ...command, reason: 'changed' }))
      .toThrow(PrioritizationIdempotencyConflictError);
    // Snooze requires the controlled prospect be the loser.
    expect(() => service.snoozeProspect({
      ...command,
      controlId: 'control-snooze',
      preferenceEventId: 'control-snooze-event',
    })).toThrow(PrioritizationInputCorruptionError);
    const snoozed = service.snoozeProspect({
      ...command,
      controlId: 'control-snooze',
      preferenceEventId: 'control-snooze-event',
      controlledProspectId: loser.prospectId,
    });
    expect(snoozed.controls.snooze).toMatchObject({ id: 'control-snooze' });
  });

  it('rejects a P0 override without a current Direct projection at write time', () => {
    const winner = seedProspect(database.raw, 'p0-winner');
    const loser = seedProspect(database.raw, 'p0-loser');
    addDirectPhone(loser, 'p0-loser-phone');
    recalc(winner, 'p0-winner-eval');
    recalc(loser, 'p0-loser-eval');
    // winner has no valid contact so reachability is none.
    expect(() => service.createPriorityOverride({
      controlId: 'p0-control',
      preferenceEventId: 'p0-control-event',
      controlledProspectId: winner.prospectId,
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'p0-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'p0-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Founder priority',
      asOf: LATER,
      expiresAt: '2027-01-01T00:00:00.000Z',
      priority: 'p0',
    })).toThrow(PriorityP0ReachabilityError);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM priority_overrides',
    ).get()).toEqual({ count: 0 });
  });

  it('stale comparison snapshots fail before writes', () => {
    const winner = seedProspect(database.raw, 'stale-winner');
    const loser = seedProspect(database.raw, 'stale-loser');
    addDirectPhone(winner, 'stale-winner-phone');
    addDirectPhone(loser, 'stale-loser-phone');
    recalc(winner, 'stale-winner-eval');
    recalc(loser, 'stale-loser-eval');
    expect(() => service.recordReorder({
      preferenceEventId: 'stale-reorder',
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'stale-winner-eval',
          projectionVersion: 7,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'stale-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Founder reordered',
      asOf: LATER,
    })).toThrow(PrioritizationStaleWriteError);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_preference_events',
    ).get()).toEqual({ count: 0 });
    const stored = service.recordReorder({
      preferenceEventId: 'valid-reorder',
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'stale-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'stale-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Founder reordered',
      asOf: LATER,
    });
    expect(stored).toMatchObject({ action: 'reordered', controlId: null });
    expect(service.recordOutOfOrderChoice({
      preferenceEventId: 'valid-out-of-order',
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'stale-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'stale-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Called out of order',
      asOf: LATER,
    })).toMatchObject({ action: 'acted_out_of_order' });
  });

  it('blocked comparisons fail with the typed operational-block error and no writes', () => {
    const winner = seedProspect(database.raw, 'blocked-winner');
    const loser = seedProspect(database.raw, 'blocked-loser');
    addDirectPhone(winner, 'blocked-winner-phone');
    addDirectPhone(loser, 'blocked-loser-phone');
    recalc(winner, 'blocked-winner-eval');
    recalc(loser, 'blocked-loser-eval');
    database.raw.prepare(`
      UPDATE persons SET deleted_at = ? WHERE id = ?
    `).run(LATER, loser.personId);
    expect(() => service.recordReorder({
      preferenceEventId: 'blocked-reorder',
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'blocked-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'blocked-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Blocked comparison',
      asOf: LATER,
    })).toThrow(PrioritizationOperationalBlockError);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_preference_events',
    ).get()).toEqual({ count: 0 });
  });

  it('expireControl retires exactly once and the read snapshot honours effectiveness', () => {
    const winner = seedProspect(database.raw, 'expire-winner');
    const loser = seedProspect(database.raw, 'expire-loser');
    addDirectPhone(winner, 'expire-winner-phone');
    addDirectPhone(loser, 'expire-loser-phone');
    recalc(winner, 'expire-winner-eval');
    recalc(loser, 'expire-loser-eval');
    service.pinProspect({
      controlId: 'expire-pin',
      preferenceEventId: 'expire-pin-event',
      controlledProspectId: winner.prospectId,
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'expire-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'expire-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Pin for the demo',
      asOf: EVAL_AT,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const retired = service.expireControl({
      controlId: 'expire-pin',
      expectedStatus: 'active',
      expectedExpiresAt: '2027-01-01T00:00:00.000Z',
      newExpiresAt: LATER,
      asOf: LATER,
    });
    expect(retired).toMatchObject({ status: 'expired', expiresAt: LATER });
    const snapshot = service.getEffectivePrioritySnapshot({
      prospectId: winner.prospectId, asOf: LATER,
    });
    expect(snapshot.controls.pin).toBeNull();
    expect(() => service.expireControl({
      controlId: 'expire-pin',
      expectedStatus: 'active',
      expectedExpiresAt: LATER,
      newExpiresAt: LATER,
      asOf: LATER,
    })).toThrow(PrioritizationStaleWriteError);
  });

  it('effective snapshots apply priority overrides and enforce the render-time P0 gate', () => {
    const winner = seedProspect(database.raw, 'snap-winner');
    const loser = seedProspect(database.raw, 'snap-loser');
    addDirectPhone(winner, 'snap-winner-phone');
    addDirectPhone(loser, 'snap-loser-phone');
    recalc(winner, 'snap-winner-eval');
    recalc(loser, 'snap-loser-eval');
    service.createPriorityOverride({
      controlId: 'snap-p0',
      preferenceEventId: 'snap-p0-event',
      controlledProspectId: winner.prospectId,
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'snap-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'snap-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Founder priority',
      asOf: LATER,
      expiresAt: '2027-01-01T00:00:00.000Z',
      priority: 'p0',
    });
    const snapshot = service.getEffectivePrioritySnapshot({
      prospectId: winner.prospectId, asOf: LATER,
    });
    expect(snapshot).toMatchObject({
      computedPriority: 'p3',
      effectivePriority: 'p0',
      reachability: 'direct',
    });
    expect(snapshot.controls.priority).toMatchObject({ id: 'snap-p0', priority: 'p0' });
  });
});
