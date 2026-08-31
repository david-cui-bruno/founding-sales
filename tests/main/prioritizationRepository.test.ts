import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import type {
  PrioritizationEvaluation,
  ProspectPriorityProjection,
  TriggerEvent,
} from '../../src/main/domain/prioritization/prioritizationTypes';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
  PrioritizationInputCorruptionError,
  PrioritizationRuleConflictError,
  PrioritizationStaleWriteError,
  PriorityControlOverlapError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const LATER = '2026-08-30T13:00:00.000Z';
const MUCH_LATER = '2026-08-30T14:00:00.000Z';

class FixedClock {
  constructor(private value: string = LATER) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

describe('PrioritizationRepository', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let clock: FixedClock;
  let repository: PrioritizationRepository;

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
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function installBuiltinRule() {
    return unitOfWork.immediate(() => repository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1));
  }

  function referralSource(prospect: SeededProspect, id: string): void {
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json,
        referred_by_person_id, referrer_unknown_reason, created_at
      ) VALUES (?, ?, 'referral', ?, '{}', NULL, 'fixture', ?)
    `).run(id, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function referralTrigger(prospect: SeededProspect, sourceId: string, id: string): TriggerEvent {
    return {
      id,
      prospectId: prospect.prospectId,
      sourceEventId: sourceId,
      reactivationReceiptActivationKey: null,
      reactivationRuleId: null,
      triggerType: 'direct_referral',
      effectiveAt: DOMAIN_TIMESTAMP,
      expiresAt: null,
      strengthMultiplier: 1,
      verificationState: 'verified',
      evidence: {
        formatVersion: 1,
        triggerType: 'direct_referral',
        authoredUnderRuleVersionId: 'founder-priority-v1',
        evidenceRefs: ['ref-1'],
        function: 'decaying',
        proof: {
          kind: 'source_event',
          sourceEventId: sourceId,
          sourceObservedAt: DOMAIN_TIMESTAMP,
        },
      },
      createdAt: DOMAIN_TIMESTAMP,
    };
  }

  function evaluatedRow(
    prospect: SeededProspect,
    id: string,
    overrides: Partial<{
      reachability: 'direct' | 'indirect' | 'none';
      priority: 'p0' | 'p1' | 'p2' | 'p3';
      evaluatedAt: string;
    }> = {},
  ): PrioritizationEvaluation {
    return {
      decisionKind: 'evaluated',
      id,
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: overrides.evaluatedAt ?? DOMAIN_TIMESTAMP,
      fitPoints: 15,
      fitBand: 'medium',
      timingMilliPoints: 12_000,
      timingBand: 'warm',
      reachability: overrides.reachability ?? 'direct',
      dataConfidence: 7,
      priority: overrides.priority ?? 'p1',
      play: 'contact_today',
      earliestTriggerExpiresAt: null,
      verifyFirst: false,
      lastContactActivityId: null,
      lastContactAt: null,
      explanation: [],
    } as PrioritizationEvaluation;
  }

  function appendEvaluation(evaluation: PrioritizationEvaluation): PrioritizationEvaluation {
    return unitOfWork.immediate(() => repository.appendEvaluation({
      evaluation,
      commandJson: JSON.stringify({ id: evaluation.id }),
      inputSnapshotJson: '{}',
      resultJson: JSON.stringify({ play: 'contact_today' }),
    }));
  }

  function projectionFor(
    evaluation: PrioritizationEvaluation,
  ): ProspectPriorityProjection {
    if (evaluation.decisionKind !== 'evaluated') throw new Error('needs evaluated');
    return {
      prospectId: evaluation.prospectId,
      ruleVersionId: evaluation.ruleVersionId,
      evaluationId: evaluation.id,
      fitPoints: evaluation.fitPoints,
      fitBand: evaluation.fitBand,
      timingMilliPoints: evaluation.timingMilliPoints,
      timingBand: evaluation.timingBand,
      reachability: evaluation.reachability,
      dataConfidence: evaluation.dataConfidence,
      priority: evaluation.priority,
      earliestTriggerExpiresAt: evaluation.earliestTriggerExpiresAt,
      verifyFirst: evaluation.verifyFirst,
      lastContactActivityId: evaluation.lastContactActivityId,
      lastContactAt: evaluation.lastContactAt,
      version: 1,
      evaluatedAt: evaluation.evaluatedAt,
      updatedAt: evaluation.evaluatedAt,
    };
  }

  it('requires the exact database/UoW binding and an active write scope', () => {
    expect(() => new PrioritizationRepository({
      database,
      unitOfWork: new DomainUnitOfWork(database),
      clock,
    })).not.toThrow();
    const other = new DomainUnitOfWork(database);
    expect(() => repository.assertBoundTo(database, other))
      .toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => repository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1))
      .toThrow(DomainTransactionRequiredError);
  });

  it('installs, replays, and conflicts the immutable canonical rule document', () => {
    const installed = installBuiltinRule();
    expect(installed).toMatchObject({
      id: 'founder-priority-v1',
      version: 1,
      contentHash: BUILTIN_PRIORITIZATION_RULE_V1.contentHash,
    });
    const replayed = installBuiltinRule();
    expect(replayed).toEqual(installed);
    expect(() => unitOfWork.immediate(() => repository.installRuleVersion({
      ...BUILTIN_PRIORITIZATION_RULE_V1,
      contentHash: undefined,
      version: 2,
    } as never))).toThrow(PrioritizationRuleConflictError);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM prioritization_rule_versions',
    ).get()).toEqual({ count: 1 });
  });

  it('activates the workspace rule pointer only through an exact CAS', () => {
    const installed = installBuiltinRule();
    expect(repository.getActiveRuleVersion()).toBeNull();
    const activated = unitOfWork.immediate(() => repository.activateRuleVersion({
      ruleVersionId: installed.id,
      expectedActiveRuleVersionId: null,
    }));
    expect(activated.id).toBe(installed.id);
    expect(repository.getActiveRuleVersion()?.id).toBe(installed.id);
    expect(() => unitOfWork.immediate(() => repository.activateRuleVersion({
      ruleVersionId: installed.id,
      expectedActiveRuleVersionId: null,
    }))).toThrow(PrioritizationStaleWriteError);
    expect(() => unitOfWork.immediate(() => repository.activateRuleVersion({
      ruleVersionId: 'missing-rule',
      expectedActiveRuleVersionId: installed.id,
    }))).toThrow(PrioritizationRuleConflictError);
  });

  it('parses stored rule rows strictly and rejects hash/identity divergence', () => {
    installBuiltinRule();
    database.raw.exec('DROP TRIGGER immutable_prioritization_rule_versions');
    database.raw.prepare(`
      UPDATE prioritization_rule_versions SET content_hash = ?
      WHERE id = 'founder-priority-v1'
    `).run('0'.repeat(64));
    expect(() => repository.getRuleVersion('founder-priority-v1'))
      .toThrow(PrioritizationInputCorruptionError);
  });

  it('appends and strictly reparses trigger events with source proof columns', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'trigger-append');
    referralSource(prospect, 'trigger-append-referral');
    const stored = unitOfWork.immediate(() => repository.appendTriggerEvent(
      referralTrigger(prospect, 'trigger-append-referral', 'trigger-append-event'),
    ));
    expect(stored).toMatchObject({
      id: 'trigger-append-event',
      sourceEventId: 'trigger-append-referral',
      reactivationReceiptActivationKey: null,
      triggerType: 'direct_referral',
    });
    expect(repository.getTriggerEventById('trigger-append-event')).toEqual(stored);
    expect(repository.getTriggerEventBySourceEvent('trigger-append-referral')).toEqual(stored);
    expect(repository.listTriggerEvents(prospect.prospectId)).toEqual([stored]);
  });

  it('rejects stored trigger rows whose evidence diverges from proof columns', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'trigger-diverge');
    referralSource(prospect, 'trigger-diverge-referral');
    referralSource(prospect, 'trigger-diverge-other');
    unitOfWork.immediate(() => repository.appendTriggerEvent(
      referralTrigger(prospect, 'trigger-diverge-referral', 'trigger-diverge-event'),
    ));
    database.raw.exec('DROP TRIGGER immutable_trigger_events');
    database.raw.prepare(`
      UPDATE trigger_events SET source_event_id = 'trigger-diverge-other'
      WHERE id = 'trigger-diverge-event'
    `).run();
    expect(() => repository.getTriggerEventById('trigger-diverge-event'))
      .toThrow(PrioritizationInputCorruptionError);
  });

  it('rejects unsorted or duplicate trigger evidence refs', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'trigger-refs');
    referralSource(prospect, 'trigger-refs-referral');
    const bad = referralTrigger(prospect, 'trigger-refs-referral', 'trigger-refs-event');
    expect(() => unitOfWork.immediate(() => repository.appendTriggerEvent({
      ...bad,
      evidence: { ...bad.evidence, evidenceRefs: ['z-ref', 'a-ref'] },
    }))).toThrow(PrioritizationInputCorruptionError);
    expect(() => unitOfWork.immediate(() => repository.appendTriggerEvent({
      ...bad,
      evidence: { ...bad.evidence, evidenceRefs: ['a-ref', 'a-ref'] },
    }))).toThrow(PrioritizationInputCorruptionError);
  });

  it('derives the authoritative last contact from immutable Activities only', () => {
    const prospect = seedProspect(database.raw, 'last-contact');
    const insertActivity = (
      id: string, occurredAt: string, direction: string, outcome: string | null,
    ): void => {
      database.raw.prepare(`
        INSERT INTO activities (
          id, person_id, prospect_id, kind, direction, channel, occurred_at,
          observed_outcome, metadata_json, created_at
        ) VALUES (?, ?, ?, 'text', ?, 'text', ?, ?, '{}', ?)
      `).run(
        id, prospect.personId, prospect.prospectId, direction, occurredAt,
        outcome, DOMAIN_TIMESTAMP,
      );
    };
    expect(repository.loadQualifyingLastContact(prospect.prospectId, LATER)).toBeNull();
    insertActivity('delivered-only', DOMAIN_TIMESTAMP, 'outbound', 'delivered');
    insertActivity('no-outcome', DOMAIN_TIMESTAMP, 'outbound', null);
    expect(repository.loadQualifyingLastContact(prospect.prospectId, LATER)).toBeNull();
    insertActivity('accepted-b', DOMAIN_TIMESTAMP, 'outbound', 'accepted');
    insertActivity('accepted-a', DOMAIN_TIMESTAMP, 'outbound', 'accepted');
    // Equal timestamps use the binary Activity ID tie-break: greatest wins.
    expect(repository.loadQualifyingLastContact(prospect.prospectId, LATER))
      .toEqual({ activityId: 'accepted-b', occurredAt: DOMAIN_TIMESTAMP });
    insertActivity('inbound-reply', LATER, 'inbound', 'replied');
    expect(repository.loadQualifyingLastContact(prospect.prospectId, LATER))
      .toEqual({ activityId: 'inbound-reply', occurredAt: LATER });
    // A qualifying activity after evaluatedAt corrupts the input.
    insertActivity('future-contact', MUCH_LATER, 'inbound', 'answered');
    expect(() => repository.loadQualifyingLastContact(prospect.prospectId, LATER))
      .toThrow(PrioritizationInputCorruptionError);
    // The dormant prospect column never participates.
    database.raw.prepare(`
      UPDATE prospects SET last_contact_at = '2020-01-01T00:00:00.000Z' WHERE id = ?
    `).run(prospect.prospectId);
    expect(repository.loadQualifyingLastContact(prospect.prospectId, MUCH_LATER))
      .toEqual({ activityId: 'future-contact', occurredAt: MUCH_LATER });
  });

  it('appends evaluated and gated evaluations and reparses them strictly', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'evaluation-append');
    const stored = appendEvaluation(evaluatedRow(prospect, 'evaluation-append-a'));
    expect(stored).toMatchObject({
      decisionKind: 'evaluated', fitPoints: 15, play: 'contact_today',
    });
    const gated = unitOfWork.immediate(() => repository.appendEvaluation({
      evaluation: {
        decisionKind: 'not_prioritizable',
        id: 'evaluation-append-gated',
        prospectId: prospect.prospectId,
        ruleVersionId: 'founder-priority-v1',
        evaluatedAt: LATER,
        qualification: {
          kind: 'gated',
          prospectId: prospect.prospectId,
          reasons: ['out_of_area'],
          evidenceIds: [prospect.prospectId],
        },
        explanation: [],
      } as PrioritizationEvaluation,
      commandJson: '{"id":"evaluation-append-gated"}',
      inputSnapshotJson: '{}',
      resultJson: '{"kind":"not_prioritizable"}',
    }));
    expect(gated).toMatchObject({
      decisionKind: 'not_prioritizable',
      qualification: { kind: 'gated', reasons: ['out_of_area'] },
    });
  });

  it('inserts, CAS-updates, and CAS-deletes the projection with typed staleness', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'projection-cas');
    const first = appendEvaluation(evaluatedRow(prospect, 'projection-cas-a'));
    const projection = unitOfWork.immediate(() => repository.insertProjection(
      projectionFor(first),
    ));
    expect(projection.version).toBe(1);
    const second = appendEvaluation(evaluatedRow(prospect, 'projection-cas-b', {
      evaluatedAt: LATER,
    }));
    expect(() => unitOfWork.immediate(() => repository.updateProjectionCas({
      prospectId: prospect.prospectId,
      expectedVersion: 99,
      projection: { ...projectionFor(second), evaluatedAt: LATER, updatedAt: LATER },
    }))).toThrow(PrioritizationStaleWriteError);
    const updated = unitOfWork.immediate(() => repository.updateProjectionCas({
      prospectId: prospect.prospectId,
      expectedVersion: 1,
      projection: { ...projectionFor(second), evaluatedAt: LATER, updatedAt: LATER },
    }));
    expect(updated).toMatchObject({ version: 2, evaluationId: 'projection-cas-b' });
    expect(() => unitOfWork.immediate(() => repository.deleteProjectionCas({
      prospectId: prospect.prospectId, expectedVersion: 1,
    }))).toThrow(PrioritizationStaleWriteError);
    unitOfWork.immediate(() => repository.deleteProjectionCas({
      prospectId: prospect.prospectId, expectedVersion: 2,
    }));
    expect(repository.getProjection(prospect.prospectId)).toBeNull();
  });

  it('creates controls, rejects overlaps, sweeps deterministically, and retires one-way', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'control-life');
    const control = unitOfWork.immediate(() => repository.createOverride({
      id: 'control-snooze',
      prospectId: prospect.prospectId,
      kind: 'snooze',
      priority: null,
      reason: 'Vacation follow-up',
      createdAt: DOMAIN_TIMESTAMP,
      expiresAt: LATER,
      status: 'active',
      expiredAt: null,
    }));
    expect(control).toMatchObject({ status: 'active', expiredAt: null });
    expect(() => unitOfWork.immediate(() => repository.createOverride({
      id: 'control-snooze-overlap',
      prospectId: prospect.prospectId,
      kind: 'snooze',
      priority: null,
      reason: 'Overlapping',
      createdAt: DOMAIN_TIMESTAMP,
      expiresAt: MUCH_LATER,
      status: 'active',
      expiredAt: null,
    }))).toThrow(PriorityControlOverlapError);
    expect(repository.listActiveOverrides(prospect.prospectId, DOMAIN_TIMESTAMP))
      .toHaveLength(1);
    // Read-time effectiveness requires the half-open interval.
    expect(repository.listActiveOverrides(prospect.prospectId, LATER)).toHaveLength(0);
    const swept = unitOfWork.immediate(() => repository.sweepExpiredControls({
      prospectId: prospect.prospectId, asOf: LATER,
    }));
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      id: 'control-snooze', status: 'expired', expiredAt: LATER, expiresAt: LATER,
    });
    // Idempotent at the same asOf.
    expect(unitOfWork.immediate(() => repository.sweepExpiredControls({
      prospectId: prospect.prospectId, asOf: LATER,
    }))).toHaveLength(0);
    // One-way: raw reactivation is blocked.
    expect(() => database.raw.prepare(`
      UPDATE priority_overrides SET status = 'active', expired_at = NULL
      WHERE id = 'control-snooze'
    `).run()).toThrow();
    expect(() => database.raw.prepare(`
      DELETE FROM priority_overrides WHERE id = 'control-snooze'
    `).run()).toThrow();
  });

  it('expireOverrideCas shortens expiration exactly once with a typed stale conflict', () => {
    installBuiltinRule();
    const prospect = seedProspect(database.raw, 'control-retire');
    unitOfWork.immediate(() => repository.createOverride({
      id: 'control-retire-pin',
      prospectId: prospect.prospectId,
      kind: 'pin_to_top',
      priority: null,
      reason: 'Keep on top',
      createdAt: DOMAIN_TIMESTAMP,
      expiresAt: MUCH_LATER,
      status: 'active',
      expiredAt: null,
    }));
    const retired = unitOfWork.immediate(() => repository.expireOverrideCas({
      controlId: 'control-retire-pin',
      prospectId: prospect.prospectId,
      expectedStatus: 'active',
      expectedExpiresAt: MUCH_LATER,
      newExpiresAt: LATER,
      expiredAt: LATER,
    }));
    expect(retired).toMatchObject({ status: 'expired', expiresAt: LATER, expiredAt: LATER });
    expect(() => unitOfWork.immediate(() => repository.expireOverrideCas({
      controlId: 'control-retire-pin',
      prospectId: prospect.prospectId,
      expectedStatus: 'active',
      expectedExpiresAt: LATER,
      newExpiresAt: LATER,
      expiredAt: LATER,
    }))).toThrow(PrioritizationStaleWriteError);
    expect(() => unitOfWork.immediate(() => repository.expireOverrideCas({
      controlId: 'control-retire-pin',
      prospectId: prospect.prospectId,
      expectedStatus: 'active',
      expectedExpiresAt: LATER,
      newExpiresAt: MUCH_LATER,
      expiredAt: MUCH_LATER,
    }))).toThrow(PrioritizationInputCorruptionError);
  });

  it('appends immutable preference events with exact evaluated-side ownership', () => {
    installBuiltinRule();
    const winner = seedProspect(database.raw, 'pref-winner');
    const loser = seedProspect(database.raw, 'pref-loser');
    appendEvaluation(evaluatedRow(winner, 'pref-winner-eval'));
    appendEvaluation(evaluatedRow(loser, 'pref-loser-eval'));
    const event = unitOfWork.immediate(() => repository.appendPreferenceEvent({
      id: 'pref-event-1',
      controlId: null,
      controlledProspectId: null,
      action: 'reordered',
      winnerProspectId: winner.prospectId,
      winnerEvaluationId: 'pref-winner-eval',
      loserProspectId: loser.prospectId,
      loserEvaluationId: 'pref-loser-eval',
      observedAt: DOMAIN_TIMESTAMP,
      context: { formatVersion: 1, reason: 'Founder moved the row' },
      createdAt: DOMAIN_TIMESTAMP,
    }));
    expect(repository.getPreferenceEventById('pref-event-1')).toEqual(event);
    // Cross-prospect forged evaluation ownership fails at the database.
    expect(() => unitOfWork.immediate(() => repository.appendPreferenceEvent({
      ...event,
      id: 'pref-event-forged',
      winnerEvaluationId: 'pref-loser-eval',
    }))).toThrow();
    // Immutability.
    expect(() => database.raw.prepare(`
      UPDATE prioritization_preference_events SET action_kind = 'pinned'
      WHERE id = 'pref-event-1'
    `).run()).toThrow();
    expect(() => database.raw.prepare(`
      DELETE FROM prioritization_preference_events WHERE id = 'pref-event-1'
    `).run()).toThrow();
  });
});
