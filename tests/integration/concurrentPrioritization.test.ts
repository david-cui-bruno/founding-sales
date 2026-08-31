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
  PrioritizationIdempotencyConflictError,
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

const EVAL_AT = '2026-08-30T13:00:00.000Z';
const LATER = '2026-08-30T14:00:00.000Z';
const CLOCK_NOW = '2026-08-30T15:00:00.000Z';

type Stack = Readonly<{
  database: AppDatabase;
  unitOfWork: DomainUnitOfWork;
  repository: PrioritizationRepository;
  service: PrioritizationService;
}>;

describe('independent encrypted prioritization contention', () => {
  let temp: TempDatabase;
  let key: ReturnType<typeof createTestWorkspaceKey>;
  let first: Stack;
  let second: Stack;
  let phoneCounter = 2000;

  function buildStack(database: AppDatabase): Stack {
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => CLOCK_NOW };
    const ids = {
      next: (): string => {
        throw new Error('The prioritization stack must not consume generated IDs.');
      },
    };
    const repository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    const service = new PrioritizationService({
      database, unitOfWork, clock, repository, outboundPermission,
    });
    return { database, unitOfWork, repository, service };
  }

  beforeEach(async () => {
    temp = createTempDatabase();
    key = createTestWorkspaceKey();
    const database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    first = buildStack(database);
    second = buildStack(openDatabase({ path: temp.path, key }));
    first.unitOfWork.immediate(() => {
      const installed = first.repository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      first.repository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
    });
  });

  afterEach(() => {
    closeDatabase(second.database);
    closeDatabase(first.database);
    temp.cleanup();
  });

  function addDirectPhone(prospect: SeededProspect, id: string): void {
    phoneCounter += 1;
    first.database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, `+1401555${phoneCounter}`,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function referralSource(prospect: SeededProspect, id: string): void {
    first.database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json,
        referred_by_person_id, referrer_unknown_reason, created_at
      ) VALUES (?, ?, 'referral', ?, '{}', NULL, 'fixture', ?)
    `).run(id, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function triggerCommand(prospect: SeededProspect, sourceId: string, id: string) {
    return {
      id,
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
          sourceEventId: sourceId,
          sourceObservedAt: DOMAIN_TIMESTAMP,
        },
      },
    };
  }

  function recalc(stack: Stack, prospect: SeededProspect, evaluationId: string, overrides: {
    evaluatedAt?: string;
    expectedProjectionVersion?: number | null;
  } = {}) {
    return stack.service.recalculateProspect({
      evaluationId,
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: overrides.evaluatedAt ?? EVAL_AT,
      expectedProjectionVersion: overrides.expectedProjectionVersion ?? null,
    });
  }

  it('serializes same-SourceEvent trigger contention to one canonical row', () => {
    const prospect = seedProspect(first.database.raw, 'race-trigger');
    referralSource(prospect, 'race-trigger-referral');
    const command = triggerCommand(prospect, 'race-trigger-referral', 'race-trigger-event');
    const stored = first.service.recordTriggerEvent(command);
    // Same command from an independent connection replays canonically.
    expect(second.service.recordTriggerEvent(command)).toEqual(stored);
    // Same proof/different command is a typed idempotency conflict, not SQLITE_BUSY.
    expect(() => second.service.recordTriggerEvent({
      ...command,
      id: 'race-trigger-event-other',
    })).toThrow(PrioritizationIdempotencyConflictError);
    expect(first.database.raw.prepare(
      'SELECT COUNT(*) AS count FROM trigger_events',
    ).get()).toEqual({ count: 1 });
  });

  it('serializes first-projection insert contention to one success and one typed conflict', () => {
    const prospect = seedProspect(first.database.raw, 'race-insert');
    addDirectPhone(prospect, 'race-insert-phone');
    const won = recalc(first, prospect, 'race-insert-a');
    expect(won.kind).toBe('evaluated');
    expect(() => recalc(second, prospect, 'race-insert-b'))
      .toThrow(PrioritizationStaleWriteError);
    // The loser consumed no evaluation ID.
    expect(first.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM prioritization_evaluations
    `).get()).toEqual({ count: 1 });
  });

  it('serializes two updates with one expected projection version', () => {
    const prospect = seedProspect(first.database.raw, 'race-update');
    addDirectPhone(prospect, 'race-update-phone');
    recalc(first, prospect, 'race-update-first');
    const winner = recalc(first, prospect, 'race-update-second', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(winner.kind).toBe('evaluated');
    expect(() => recalc(second, prospect, 'race-update-loser', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    })).toThrow(PrioritizationStaleWriteError);
  });

  it('serializes an evaluated update against a gated deletion', () => {
    const prospect = seedProspect(first.database.raw, 'race-gate');
    addDirectPhone(prospect, 'race-gate-phone');
    recalc(first, prospect, 'race-gate-first');
    first.database.raw.prepare(`
      UPDATE prospects
      SET qualification_state = 'disqualified', qualification_gate_reason = 'out_of_area'
      WHERE id = ?
    `).run(prospect.prospectId);
    const gated = recalc(first, prospect, 'race-gate-second', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    });
    expect(gated.kind).toBe('not_prioritizable');
    // The stale evaluated contender fails with a typed conflict.
    expect(() => recalc(second, prospect, 'race-gate-loser', {
      evaluatedAt: LATER, expectedProjectionVersion: 1,
    })).toThrow(PrioritizationStaleWriteError);
  });

  it('serializes rule activation against recalculation', () => {
    const prospect = seedProspect(first.database.raw, 'race-rule');
    addDirectPhone(prospect, 'race-rule-phone');
    const replacement = {
      ...BUILTIN_PRIORITIZATION_RULE_V1,
      id: 'founder-priority-v2',
      version: 2,
      contentHash: undefined,
    } as never;
    first.unitOfWork.immediate(() => {
      const installed = first.repository.installRuleVersion(replacement);
      first.repository.activateRuleVersion({
        ruleVersionId: installed.id,
        expectedActiveRuleVersionId: 'founder-priority-v1',
      });
    });
    // A recalculation naming the retired rule fails with a typed stale conflict.
    expect(() => recalc(second, prospect, 'race-rule-eval'))
      .toThrow(PrioritizationStaleWriteError);
    // Stale pointer CAS also conflicts.
    expect(() => second.unitOfWork.immediate(() => second.repository.activateRuleVersion({
      ruleVersionId: 'founder-priority-v1',
      expectedActiveRuleVersionId: 'founder-priority-v1',
    }))).toThrow(PrioritizationStaleWriteError);
  });

  it('serializes overlapping same-kind controls to one success and one typed overlap', () => {
    const winner = seedProspect(first.database.raw, 'race-control-winner');
    const loser = seedProspect(first.database.raw, 'race-control-loser');
    addDirectPhone(winner, 'race-control-winner-phone');
    addDirectPhone(loser, 'race-control-loser-phone');
    recalc(first, winner, 'race-control-winner-eval');
    recalc(first, loser, 'race-control-loser-eval');
    const comparison = {
      winner: {
        prospectId: winner.prospectId,
        evaluationId: 'race-control-winner-eval',
        projectionVersion: 1,
      },
      loser: {
        prospectId: loser.prospectId,
        evaluationId: 'race-control-loser-eval',
        projectionVersion: 1,
      },
    };
    first.service.pinProspect({
      controlId: 'race-pin-a',
      preferenceEventId: 'race-pin-a-event',
      controlledProspectId: winner.prospectId,
      comparison,
      reason: 'First founder pin',
      asOf: LATER,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(() => second.service.pinProspect({
      controlId: 'race-pin-b',
      preferenceEventId: 'race-pin-b-event',
      controlledProspectId: winner.prospectId,
      comparison,
      reason: 'Second founder pin',
      asOf: LATER,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })).toThrow(PriorityControlOverlapError);
    expect(first.database.raw.prepare(
      'SELECT COUNT(*) AS count FROM priority_overrides',
    ).get()).toEqual({ count: 1 });
  });

  it('serializes same-ID same/different evaluation and preference commands', () => {
    const winner = seedProspect(first.database.raw, 'race-idem-winner');
    const loser = seedProspect(first.database.raw, 'race-idem-loser');
    addDirectPhone(winner, 'race-idem-winner-phone');
    addDirectPhone(loser, 'race-idem-loser-phone');
    const original = recalc(first, winner, 'race-idem-eval');
    const replay = recalc(second, winner, 'race-idem-eval');
    expect(JSON.stringify(replay.evaluation)).toBe(JSON.stringify(original.evaluation));
    expect(() => recalc(second, winner, 'race-idem-eval', { evaluatedAt: LATER }))
      .toThrow(PrioritizationIdempotencyConflictError);

    recalc(first, loser, 'race-idem-loser-eval');
    const preference = {
      preferenceEventId: 'race-idem-preference',
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'race-idem-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'race-idem-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Reorder decision',
      asOf: LATER,
    };
    const stored = first.service.recordReorder(preference);
    expect(second.service.recordReorder(preference)).toEqual(stored);
    expect(() => second.service.recordOutOfOrderChoice(preference))
      .toThrow(PrioritizationIdempotencyConflictError);
  });

  it('sees expiration sweep and control retirement coherently across connections', () => {
    const winner = seedProspect(first.database.raw, 'race-sweep-winner');
    const loser = seedProspect(first.database.raw, 'race-sweep-loser');
    addDirectPhone(winner, 'race-sweep-winner-phone');
    addDirectPhone(loser, 'race-sweep-loser-phone');
    recalc(first, winner, 'race-sweep-winner-eval');
    recalc(first, loser, 'race-sweep-loser-eval');
    first.service.snoozeProspect({
      controlId: 'race-sweep-snooze',
      preferenceEventId: 'race-sweep-snooze-event',
      controlledProspectId: loser.prospectId,
      comparison: {
        winner: {
          prospectId: winner.prospectId,
          evaluationId: 'race-sweep-winner-eval',
          projectionVersion: 1,
        },
        loser: {
          prospectId: loser.prospectId,
          evaluationId: 'race-sweep-loser-eval',
          projectionVersion: 1,
        },
      },
      reason: 'Snooze for one hour',
      asOf: EVAL_AT,
      expiresAt: LATER,
    });
    const swept = second.service.sweepExpiredControls({
      prospectId: loser.prospectId, asOf: LATER,
    });
    expect(swept).toHaveLength(1);
    // Idempotent from either connection.
    expect(first.service.sweepExpiredControls({
      prospectId: loser.prospectId, asOf: LATER,
    })).toHaveLength(0);
    // Explicit retirement of the already-expired row is a typed stale conflict.
    expect(() => first.service.expireControl({
      controlId: 'race-sweep-snooze',
      expectedStatus: 'active',
      expectedExpiresAt: LATER,
      newExpiresAt: LATER,
      asOf: LATER,
    })).toThrow(PrioritizationStaleWriteError);
  });

  it('keeps busy timeout and recursive triggers active on both connections', () => {
    for (const stack of [first, second]) {
      expect(stack.database.raw.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
      expect(stack.database.raw.pragma('recursive_triggers', { simple: true })).toBe(1);
    }
  });
});
