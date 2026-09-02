import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import {
  OutboundPermissionService,
} from '../../src/main/domain/optOut/outboundPermissionService';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import {
  PrioritizationService,
} from '../../src/main/domain/prioritization/prioritizationService';
import { TodayRepository } from '../../src/main/domain/today/todayRepository';
import { TodayService } from '../../src/main/domain/today/todayService';
import { DEFAULT_TODAY_CAPACITY } from '../../src/main/domain/today/todayTypes';
import {
  DomainRepositoryDatabaseMismatchError,
  PrioritizationInputCorruptionError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

// 12:00 local in New York on 2026-08-31.
const GENERATED_AT = '2026-08-31T16:00:00.000Z';
const EVAL_AT = '2026-08-31T15:00:00.000Z';

class FixedClock {
  private reads = 0;

  constructor(private value: string = GENERATED_AT) {}

  now(): string {
    this.reads += 1;
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }

  readCount(): number {
    return this.reads;
  }
}

describe('TodayService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let clock: FixedClock;
  let priorities: PrioritizationService;
  let prioritizationRepository: PrioritizationRepository;
  let service: TodayService;
  let phoneCounter = 3000;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    clock = new FixedClock();
    const ids = {
      next: (): string => {
        throw new Error('Today must not consume generated IDs.');
      },
    };
    prioritizationRepository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    priorities = new PrioritizationService({
      database, unitOfWork, clock, repository: prioritizationRepository, outboundPermission,
    });
    const repository = new TodayRepository({ database, unitOfWork });
    service = new TodayService({
      database, unitOfWork, clock, repository, priorities, outboundPermission,
    });
    unitOfWork.immediate(() => {
      const installed = prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function insertCycleWithAction(input: {
    prefix: string;
    prospect: SeededProspect;
    workflowStatus?: 'active' | 'onboarding';
    stage?: string;
    workIntent?: string;
    actionType?: string;
    channel?: string | null;
  }): { cycleId: string; actionId: string } {
    const cycleId = `${input.prefix}-cycle`;
    const actionId = `${input.prefix}-action`;
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        cycleId,
        input.prospect.personId,
        input.prospect.prospectId,
        input.prospect.sourceEventId,
        input.stage ?? 'ready',
        input.workflowStatus ?? 'active',
        actionId,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
        DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status,
          timezone, work_intent, created_at
        ) VALUES (?, ?, ?, ?, 'pending', 'America/New_York', ?, ?)
      `).run(
        actionId,
        cycleId,
        input.actionType ?? 'call',
        input.channel === undefined ? 'phone' : input.channel,
        input.workIntent ?? 'discretionary_prospecting',
        DOMAIN_TIMESTAMP,
      );
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    return { cycleId, actionId };
  }

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

  function recalc(prospect: SeededProspect, evaluationId: string): void {
    priorities.recalculateProspect({
      evaluationId,
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: EVAL_AT,
      expectedProjectionVersion: null,
    });
  }

  function build() {
    return service.build({
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1,
    });
  }

  function laneOf(queue: ReturnType<typeof build>, lane: string) {
    return queue.lanes.find((entry) => entry.lane === lane)!.items;
  }

  it('rejects mixed composition and an already-active raw transaction', () => {
    const otherUnit = new DomainUnitOfWork(database);
    const otherRepository = new TodayRepository({ database, unitOfWork: otherUnit });
    expect(() => new TodayService({
      database,
      unitOfWork,
      clock,
      repository: otherRepository,
      priorities,
      outboundPermission: {
        assertBoundTo: (): void => undefined,
      } as unknown as OutboundPermissionService,
    })).toThrow(DomainRepositoryDatabaseMismatchError);
    database.raw.exec('BEGIN');
    try {
      expect(() => build()).toThrow(PrioritizationInputCorruptionError);
    } finally {
      database.raw.exec('ROLLBACK');
    }
  });

  it('builds one coherent queue with zero writes and one clock read', () => {
    const prospect = seedProspect(database.raw, 'today-basic');
    addDirectPhone(prospect, 'today-basic-phone');
    insertCycleWithAction({ prefix: 'today-basic', prospect });
    recalc(prospect, 'today-basic-eval');
    const changesBefore = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    const readsBefore = clock.readCount();
    const queue = build();
    const changesAfter = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    expect(changesAfter.c).toBe(changesBefore.c);
    expect(clock.readCount()).toBe(readsBefore + 1);
    expect(queue.generatedAt).toBe(GENERATED_AT);
    expect(queue.localDate).toBe('2026-08-31');
    expect(database.raw.inTransaction).toBe(false);
    // The evaluated projection is from the same local day so the row lands in
    // the priority lane matching its effective priority (p3 -> exploration).
    expect(laneOf(queue, 'exploration')).toHaveLength(1);
    const item = laneOf(queue, 'exploration')[0]!;
    expect(item.priority).not.toBeNull();
    expect(item.priority!.prospectId).toBe(prospect.prospectId);
  });

  it('reports blocked persons only as sanitized diagnostics', () => {
    const prospect = seedProspect(database.raw, 'today-blocked');
    insertCycleWithAction({ prefix: 'today-blocked', prospect });
    // Retained-handle opt-out from another person.
    const optedOut = seedProspect(database.raw, 'today-optout-src');
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES ('today-optout-evidence', ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(optedOut.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO opt_out_tombstones (
        id, person_id, requested_at, observed_channel, source_activity_id,
        policy_version, created_at
      ) VALUES ('today-optout-tombstone', ?, ?, 'imessage', 'today-optout-evidence',
                'founder_opt_out_v1', ?)
    `).run(optedOut.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
      VALUES ('today-optout-handle', 'today-optout-tombstone', 'phone', '+14015559999', ?)
    `).run(DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('today-blocked-phone', ?, 'phone', '+14015559999', 'valid', 'direct', 1, ?, ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const queue = build();
    expect(queue.diagnostics).toContainEqual(expect.objectContaining({
      cycleId: 'today-blocked-cycle',
      kind: 'outbound_permission_blocked',
      relatedIds: ['today-optout-tombstone'],
    }));
    const laneItems = queue.lanes.flatMap((entry) => entry.items);
    expect(laneItems).toHaveLength(0);
    // Diagnostics never carry phone/email values.
    expect(JSON.stringify(queue.diagnostics)).not.toContain('+1401');
  });

  it('keeps promise work visible with a diagnostic when the projection is stale', () => {
    const prospect = seedProspect(database.raw, 'today-stale');
    addDirectPhone(prospect, 'today-stale-phone');
    insertCycleWithAction({
      prefix: 'today-stale', prospect,
      workIntent: 'promised_follow_up',
    });
    // Evaluated yesterday: stale for today.
    priorities.recalculateProspect({
      evaluationId: 'today-stale-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: '2026-08-30T15:00:00.000Z',
      expectedProjectionVersion: null,
    });
    const queue = build();
    const item = laneOf(queue, 'due_primary')[0]!;
    expect(item).toBeDefined();
    expect(item.inlineDiagnostics).toContain('stale_priority_projection');
  });

  it('turns stale discretionary rows into diagnostics instead of rescoring', () => {
    const prospect = seedProspect(database.raw, 'today-stale-disc');
    addDirectPhone(prospect, 'today-stale-disc-phone');
    insertCycleWithAction({ prefix: 'today-stale-disc', prospect });
    priorities.recalculateProspect({
      evaluationId: 'today-stale-disc-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: '2026-08-30T15:00:00.000Z',
      expectedProjectionVersion: null,
    });
    const queue = build();
    expect(queue.diagnostics).toContainEqual(expect.objectContaining({
      cycleId: 'today-stale-disc-cycle',
      kind: 'stale_priority_projection',
    }));
    expect(queue.lanes.flatMap((entry) => entry.items)).toHaveLength(0);
  });

  it('counts durable selected-call usage that survives refresh', () => {
    const prospect = seedProspect(database.raw, 'today-usage');
    addDirectPhone(prospect, 'today-usage-phone');
    const { cycleId, actionId } = insertCycleWithAction({ prefix: 'today-usage', prospect });
    recalc(prospect, 'today-usage-eval');
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
        occurred_at, observed_outcome, metadata_json, created_at
      ) VALUES ('today-usage-call', ?, ?, ?, 'call', 'outbound', 'phone',
                ?, 'answered', ?, ?)
    `).run(
      prospect.personId, prospect.prospectId, cycleId,
      '2026-08-31T15:30:00.000Z',
      JSON.stringify({
        todaySelectedCallReceipt: {
          version: 1,
          kind: 'discretionary_call',
          currentActionId: actionId,
          queueGeneratedAt: GENERATED_AT,
          queueTimezone: 'America/New_York',
          queueLocalDate: '2026-08-31',
        },
      }),
      '2026-08-31T15:30:00.000Z',
    );
    const first = build();
    expect(first.completedDiscretionaryDialCount).toBe(1);
    const second = build();
    expect(second.completedDiscretionaryDialCount).toBe(1);
    expect(second.dialCount).toBe(second.completedDiscretionaryDialCount
      + second.queuedDiscretionaryDialCount);
  });

  it('produces identical output regardless of the process timezone', () => {
    const prospect = seedProspect(database.raw, 'today-tz');
    addDirectPhone(prospect, 'today-tz-phone');
    insertCycleWithAction({ prefix: 'today-tz', prospect });
    recalc(prospect, 'today-tz-eval');
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = JSON.stringify(build());
      process.env.TZ = 'America/Los_Angeles';
      const losAngeles = JSON.stringify(build());
      expect(losAngeles).toBe(tokyo);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('rejects malformed channel policy snapshots before reading the clock', () => {
    const readsBefore = clock.readCount();
    expect(() => service.build({
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      channelPolicies: { call: { id: '', windows: [] } } as never,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(clock.readCount()).toBe(readsBefore);
  });
});
