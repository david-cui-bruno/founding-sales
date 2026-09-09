import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { WorkspaceSettingsRepository } from '../../src/main/domain/workspace/workspaceSettingsRepository';
import type { AccountEvidenceSnapshot } from '../../src/shared/contracts/accountContract';
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
  let outboundPermission: OutboundPermissionService;
  let workspaceSettings: WorkspaceSettingsRepository;
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
    outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    priorities = new PrioritizationService({
      database, unitOfWork, clock, repository: prioritizationRepository, outboundPermission,
    });
    const repository = new TodayRepository({ database, unitOfWork });
    workspaceSettings = new WorkspaceSettingsRepository({ database, unitOfWork });
    service = new TodayService({
      database, unitOfWork, clock, repository, priorities, outboundPermission, workspaceSettings,
    });
    unitOfWork.immediate(() => {
      const installed = prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    // These fixtures exercise cold priority lanes, not warm introduction bypass.
    database.raw.prepare("UPDATE prospects SET segment = 'cold' WHERE id = ?").run(input.prospect.prospectId);
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

  it('shows only real warm Unreviewed contacts without collecting unused priority inputs', () => {
    for (const segment of ['cold', 'hot', 'warm']) {
      const prospect = seedProspect(database.raw, segment);
      insertCycleWithAction({ prefix: segment, prospect, stage: 'unreviewed',
        actionType: 'review_lead', channel: null, workIntent: 'internal_review' });
      database.raw.prepare('UPDATE prospects SET segment = ? WHERE id = ?').run(segment, prospect.prospectId);
    }
    const collect = vi.spyOn(priorities, 'getEffectivePrioritySnapshot');
    const permission = vi.spyOn(OutboundPermissionService.prototype, 'inspectPerson');
    const before = database.raw.prepare('SELECT total_changes() AS count').get();
    const queue = build();
    expect(queue.lanes.flatMap(lane => lane.items).map(item => item.personId)).toEqual(['warm-person']);
    expect(queue.unreviewedBacklogCount).toBe(3);
    expect(collect).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledWith('warm-person');
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    database.raw.prepare("UPDATE prospects SET segment = 'cold' WHERE id = 'warm-prospect'").run();
    expect(build().lanes.flatMap(lane => lane.items)).toEqual([]);
    expect(collect).not.toHaveBeenCalled();
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

  function accountSnapshot(accountId: string, overrides: Partial<AccountEvidenceSnapshot> = {}): AccountEvidenceSnapshot {
    return {
      account: { id: accountId, name: accountId, domain: `${accountId}.example`, version: 1 },
      claims: [
        { kind: 'fact', key: 'residential_scope', value: 'Residential multifamily property management', evidenceIds: [`${accountId}-scope`] },
        { kind: 'fact', key: 'operating_footprint', value: 'Regional property manager', evidenceIds: [`${accountId}-footprint`] },
      ],
      routes: [
        { id: `${accountId}-route`, accountId, personId: null, channel: 'phone', value: '+15555550100', purpose: 'business', evidenceIds: [`${accountId}-route-evidence`], verification: 'published', version: 1 },
      ],
      portfolio: [],
      unknowns: [],
      conflicts: [],
      fingerprint: 'a'.repeat(64),
      ...overrides,
    };
  }

  function addMeetingFirstSettings(newCallSlots: number | null, totalCallCapacity: number | null): void {
    database.raw.prepare(`
      UPDATE meeting_first_call_settings
      SET new_call_slots = ?, total_call_capacity = ?
      WHERE singleton = 1
    `).run(newCallSlots, totalCallCapacity);
  }

  it('plans meeting-first due warm accounts alongside configured new calls from B4 actual outcomes without writes', () => {
    addMeetingFirstSettings(2, 2);
    const actualCalls = vi.fn().mockReturnValue([
      { accountId: 'already-called', attemptId: 'attempt-1', commandId: 'command-1', outcome: 'connected', reportedAt: '2026-08-31T15:30:00.000Z' },
    ]);
    const plannedByB4 = new TodayService({
      database, unitOfWork, clock, repository: new TodayRepository({ database, unitOfWork }),
      priorities, outboundPermission, workspaceSettings, actualCalls,
    });
    const before = database.raw.prepare('SELECT total_changes() AS count').get();
    const plan = plannedByB4.planMeetingFirstAccountCalls({
      due: [accountSnapshot('warm-due')],
      ranked: [accountSnapshot('already-called'), accountSnapshot('new-pm'), accountSnapshot('warm-due')],
      generatedAt: GENERATED_AT,
    });
    expect(plan).toEqual({ accountIds: ['warm-due', 'new-pm'], workloadConflict: false });
    expect(actualCalls).toHaveBeenCalledWith(database, {
      from: '2026-08-31T04:00:00.000Z',
      to: '2026-09-01T04:00:00.000Z',
    });
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('leaves meeting-first account calls disabled when settings are unset and reports explicit capacity conflicts', () => {
    expect(service.planMeetingFirstAccountCalls({
      due: [accountSnapshot('warm-only')],
      ranked: [accountSnapshot('new-disabled')],
      generatedAt: GENERATED_AT,
    })).toEqual({ accountIds: ['warm-only'], workloadConflict: false });

    addMeetingFirstSettings(1, 1);
    expect(service.planMeetingFirstAccountCalls({
      due: [accountSnapshot('warm-a'), accountSnapshot('warm-b')],
      ranked: [accountSnapshot('new-conflict')],
      generatedAt: GENERATED_AT,
    })).toEqual({ accountIds: ['warm-a', 'warm-b', 'new-conflict'], workloadConflict: true });
  });

  it('uses factual contactable account ranks and preserves unknown or non-target accounts outside new calls', () => {
    addMeetingFirstSettings(3, null);
    expect(service.planMeetingFirstAccountCalls({
      due: [],
      ranked: [
        accountSnapshot('unknown', { claims: [], unknowns: ['residential_scope'] }),
        accountSnapshot('uncontactable', { routes: [] }),
        accountSnapshot('supported'),
      ],
      generatedAt: GENERATED_AT,
    })).toEqual({ accountIds: ['supported'], workloadConflict: false });
  });

  it('rejects missing meeting-first account settings singleton', () => {
    database.raw.prepare('DELETE FROM meeting_first_call_settings WHERE singleton = 1').run();
    expect(() => service.planMeetingFirstAccountCalls({
      due: [], ranked: [accountSnapshot('new')], generatedAt: GENERATED_AT,
    })).toThrow('malformed');
  });

  it('updates meeting-first account settings with scoped CAS and rejects stale revisions', () => {
    const first = workspaceSettings.readMeetingFirstAccountCallSettings();
    expect(first).toEqual(expect.objectContaining({ newCallSlots: null, totalCallCapacity: null, revision: 0 }));
    unitOfWork.immediate(() => {
      expect(workspaceSettings.updateMeetingFirstAccountCallSettingsCas({
        expectedRevision: 0,
        newCallSlots: 2,
        totalCallCapacity: 5,
        updatedAt: '2026-08-31T16:01:00.000Z',
      })).toEqual({
        newCallSlots: 2,
        totalCallCapacity: 5,
        revision: 1,
        updatedAt: '2026-08-31T16:01:00.000Z',
      });
    });
    expect(() => unitOfWork.immediate(() => workspaceSettings.updateMeetingFirstAccountCallSettingsCas({
      expectedRevision: 0,
      newCallSlots: 1,
      totalCallCapacity: null,
      updatedAt: '2026-08-31T16:02:00.000Z',
    }))).toThrow('changed before this update');
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
