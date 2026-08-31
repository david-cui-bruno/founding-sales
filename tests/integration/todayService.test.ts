import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { createTodayProvider, type TodayProvider } from '../../src/main/today/todayService';
import { todaySnapshotSchema } from '../../src/shared/contracts/todayContract';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  seedProspect,
  type SeededProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

const FIXED_LANE_ORDER = [
  'onboarding', 'fresh_inbound', 'overdue', 'post_interview_offer',
  'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
];

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('todayService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;
  let provider: TodayProvider;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    clock = new FixedClock();
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
    provider = createTodayProvider(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect,
    });
    return { prospect, cycleId, actionId };
  }

  it('returns a strict snapshot with every lane in fixed order and the dial budget', async () => {
    const snapshot = await provider.get();

    expect(() => todaySnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.lanes.map((lane) => lane.id)).toEqual(FIXED_LANE_ORDER);
    expect(snapshot.dialBudget).toBe(40);
    expect(snapshot.conversationTarget).toBe(5);
    expect(snapshot.scheduledDials).toBeGreaterThanOrEqual(0);
    expect(snapshot.revision).toBeGreaterThanOrEqual(0);
  });

  it('places a seeded overdue promise in the Overdue lane exactly once', async () => {
    const { prospect, cycleId } = seedLead('alpha');

    const snapshot = await provider.get();

    const memberships = snapshot.lanes.filter(
      (lane) => lane.items.some((item) => item.salesCycleId === cycleId),
    );
    expect(memberships.map((lane) => lane.id)).toEqual(['overdue']);
    const item = memberships[0]!.items.find(
      (candidate) => candidate.salesCycleId === cycleId,
    )!;
    expect(item.personId).toBe(prospect.personId);
    expect(item.personName).toBe(`Person ${prospect.personId}`);
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item.action.overdue).toBe(true);
    expect(item.pinned).toBe(false);
  });

  it('never lists one cycle in two lanes', async () => {
    seedLead('alpha');
    seedLead('beta');

    const snapshot = await provider.get();

    const cycleIds = snapshot.lanes.flatMap(
      (lane) => lane.items.map((item) => item.salesCycleId),
    );
    expect(new Set(cycleIds).size).toBe(cycleIds.length);
  });

  it('keeps promised work visible regardless of the dial budget', async () => {
    database.raw.prepare(
      'UPDATE workspace_settings SET daily_dial_capacity = 0 WHERE singleton = 1',
    ).run();
    const { cycleId } = seedLead('alpha');

    const snapshot = await provider.get();

    expect(snapshot.dialBudget).toBe(0);
    const overdue = snapshot.lanes.find((lane) => lane.id === 'overdue')!;
    expect(overdue.items.map((item) => item.salesCycleId)).toContain(cycleId);
  });

  it('logs a past activity through the provider and bumps the revision', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    const before = await provider.get();

    const receipt = await provider.logPastActivity({
      personId: prospect.personId,
      salesCycleId: cycleId,
      kind: 'note',
      direction: 'internal',
      occurredAt: DOMAIN_TIMESTAMP,
      summary: 'Met at the RIREIG meetup.',
      outcome: null,
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.affectedSalesCycleIds).toEqual([cycleId]);
    expect(receipt.revision).toBeGreaterThan(before.revision);
  });

  it('rejects pin and snooze with a safe error when priority projections are missing', async () => {
    const { cycleId } = seedLead('alpha');
    const { cycleId: comparedCycleId } = seedLead('beta');

    await expect(provider.pin({
      salesCycleId: cycleId,
      reason: 'Founder context',
      expiresAt: '2026-09-01T15:00:00.000Z',
      comparedSalesCycleId: comparedCycleId,
    })).rejects.toThrow('priority projection');
    await expect(provider.snooze({
      salesCycleId: cycleId,
      reason: 'Founder is travelling',
      expiresAt: '2026-09-01T15:00:00.000Z',
      comparedSalesCycleId: comparedCycleId,
    })).rejects.toThrow('priority projection');
  });

  it('pins within the lane after both prospects hold current projections', async () => {
    const first = seedLead('alpha');
    const second = seedLead('beta');
    services.prioritization.recalculateProspect({
      evaluationId: 'eval-alpha',
      prospectId: first.prospect.prospectId,
      ruleVersionId: BUILTIN_PRIORITIZATION_RULE_V1.id,
      evaluatedAt: CLOCK_NOW,
      expectedProjectionVersion: null,
    });
    services.prioritization.recalculateProspect({
      evaluationId: 'eval-beta',
      prospectId: second.prospect.prospectId,
      ruleVersionId: BUILTIN_PRIORITIZATION_RULE_V1.id,
      evaluatedAt: CLOCK_NOW,
      expectedProjectionVersion: null,
    });

    const receipt = await provider.pin({
      salesCycleId: first.cycleId,
      reason: 'Founder context',
      expiresAt: '2026-09-01T15:00:00.000Z',
      comparedSalesCycleId: second.cycleId,
    });
    expect(receipt.affectedSalesCycleIds).toEqual([first.cycleId]);

    const snapshot = await provider.get();
    const laneOf = (cycleId: string) => snapshot.lanes.find(
      (lane) => lane.items.some((item) => item.salesCycleId === cycleId),
    )?.id;
    expect(laneOf(first.cycleId)).toBe('overdue');
    const pinnedItem = snapshot.lanes
      .flatMap((lane) => lane.items)
      .find((item) => item.salesCycleId === first.cycleId);
    expect(pinnedItem?.pinned).toBe(true);
  });

  it('rejects completing an action that is not the current cadence-bound action', async () => {
    const { cycleId, actionId } = seedLead('alpha');

    await expect(provider.complete({
      salesCycleId: cycleId,
      actionId: 'not-the-current-action',
      outcome: 'answered',
      activityId: null,
    })).rejects.toThrow('no longer current');
    await expect(provider.complete({
      salesCycleId: cycleId,
      actionId,
      outcome: 'answered',
      activityId: null,
    })).rejects.toThrow('cadence-bound');
  });
});
