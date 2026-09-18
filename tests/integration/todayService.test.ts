import { productionDomainGate } from '../fixtures/productionDomainGate';
import { createTodayProvider } from '../fixtures/legacyDomainProviders';
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
import { type TodayProvider } from '../fixtures/legacyDomainProviders';
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
  'onboarding', 'fresh_inbound', 'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
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
    provider = createTodayProvider(productionDomainGate(domain));
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string, stage?: 'unreviewed' | 'ready' | 'contacted'): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect, stage: stage ?? 'ready',
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
    expect(snapshot.unreviewedBacklogCount).toBe(0);
    expect(snapshot.revision).toBeGreaterThanOrEqual(0);
  });

  it('summarizes Unreviewed backlog while exposing one dated internal action', async () => {
    const prospect = seedProspect(database.raw, 'backlog');
    database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage,
        workflow_status, current_next_action_id, stage_entered_at,
        version, created_at, updated_at
      ) VALUES ('backlog-cycle', ?, ?, ?, 'unreviewed', 'active', NULL, ?, 1, ?, ?)
    `).run(
      prospect.personId, prospect.prospectId, prospect.sourceEventId,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    const cycleId = 'backlog-cycle';
    seedLead('reviewed');
    database.raw.prepare("UPDATE prospects SET segment = 'cold' WHERE id = 'reviewed-prospect'").run();
    const before = database.raw.prepare("SELECT * FROM sales_cycles WHERE id = 'backlog-cycle'").get();

    const snapshot = await provider.get();

    expect(() => todaySnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.unreviewedBacklogCount).toBe(1);
    const laneIdsWithBacklogCycle = snapshot.lanes.filter(
      (lane) => lane.items.some((item) => item.salesCycleId === cycleId),
    );
    expect(laneIdsWithBacklogCycle).toHaveLength(1);
    expect(snapshot.lanes.flatMap(lane => lane.items)).toHaveLength(1);
    expect(laneIdsWithBacklogCycle[0].items[0].action.label).toBe('Contact');
    expect(database.raw.prepare("SELECT * FROM sales_cycles WHERE id = 'backlog-cycle'").get()).toEqual(before);
    const dueCadence = snapshot.lanes.find((lane) => lane.id === 'due_cadence')!;
    expect(dueCadence.items.map((item) => item.salesCycleId).sort()).toEqual(['backlog-cycle']);
    expect(dueCadence.items.find(item => item.salesCycleId === cycleId)?.action.dueAt).toBe(DOMAIN_TIMESTAMP);
  });

  it('places a seeded promise in the Due cadence lane exactly once', async () => {
    const { prospect, cycleId } = seedLead('alpha');

    const snapshot = await provider.get();

    const memberships = snapshot.lanes.filter(
      (lane) => lane.items.some((item) => item.salesCycleId === cycleId),
    );
    expect(memberships.map((lane) => lane.id)).toEqual(['due_cadence']);
    const item = memberships[0]!.items.find(
      (candidate) => candidate.salesCycleId === cycleId,
    )!;
    expect(item.personId).toBe(prospect.personId);
    expect(item.personName).toBe(`Person ${prospect.personId}`);
    expect(item.reason.length).toBeGreaterThan(0);
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

  it('keeps warm work actionable even with no remaining discretionary dial capacity', async () => {
    database.raw.prepare(
      'UPDATE workspace_settings SET daily_dial_capacity = 0 WHERE singleton = 1',
    ).run();
    const { cycleId } = seedLead('alpha');

    const snapshot = await provider.get();

    expect(snapshot.dialBudget).toBe(0);
    const dueCadence = snapshot.lanes.find((lane) => lane.id === 'due_cadence')!;
    expect(dueCadence.items).toHaveLength(1);
    expect(dueCadence.overflowCount).toBe(0);
    const later = snapshot.lanes.find((lane) => lane.id === 'later')!;
    expect(later.items.map((item) => item.salesCycleId)).not.toContain(cycleId);
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

  it('snoozes by writing resurface_at', async () => {
    const { cycleId } = seedLead('alpha');

    // Snooze no longer records a preference comparison: it hides the cycle
    // behind a founder-chosen resurface instant.
    await expect(provider.snooze({
      salesCycleId: cycleId,
      resurfaceAt: '2026-08-30T15:00:00.000Z',
    })).rejects.toThrow('future');
    const receipt = await provider.snooze({
      salesCycleId: cycleId,
      resurfaceAt: '2026-09-01T15:00:00.000Z',
    });
    expect(receipt.affectedSalesCycleIds).toEqual([cycleId]);
    expect(database.raw.prepare(
      'SELECT resurface_at, resurface_reason FROM sales_cycles WHERE id = ?',
    ).get(cycleId)).toEqual({
      resurface_at: '2026-09-01T15:00:00.000Z', resurface_reason: 'snooze',
    });

    const snapshot = await provider.get();
    const laneMembership = snapshot.lanes.filter(
      (lane) => lane.items.some((item) => item.salesCycleId === cycleId),
    );
    expect(laneMembership).toHaveLength(0);
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

  it('counts unreviewed cloud-scored leads for the backlog card', async () => {
    const scored = seedLead('alpha', 'unreviewed');
    seedLead('beta', 'unreviewed');
    database.raw.prepare(`
      UPDATE prospects SET cloud_fit = 62, cloud_timing = 41 WHERE id = ?
    `).run(scored.prospect.prospectId);

    const snapshot = await provider.get();
    expect(snapshot.unreviewedBacklogCount).toBe(2);
    expect(snapshot.unreviewedCloudSignalCount).toBe(1);
  });
});
