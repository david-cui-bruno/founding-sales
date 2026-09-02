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
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const GENERATED_AT = '2026-08-31T16:00:00.000Z';
const EVAL_AT = '2026-08-31T15:00:00.000Z';

type Stack = Readonly<{
  database: AppDatabase;
  unitOfWork: DomainUnitOfWork;
  priorities: PrioritizationService;
  prioritizationRepository: PrioritizationRepository;
  today: TodayService;
}>;

describe('Today coherent snapshot across independent encrypted connections', () => {
  let temp: TempDatabase;
  let key: ReturnType<typeof createTestWorkspaceKey>;
  let reader: Stack;
  let writer: Stack;
  let phoneCounter = 4000;

  function buildStack(database: AppDatabase): Stack {
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => GENERATED_AT };
    const ids = {
      next: (): string => {
        throw new Error('Today must not consume generated IDs.');
      },
    };
    const prioritizationRepository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    const priorities = new PrioritizationService({
      database, unitOfWork, clock, repository: prioritizationRepository, outboundPermission,
    });
    const repository = new TodayRepository({ database, unitOfWork });
    const today = new TodayService({
      database, unitOfWork, clock, repository, priorities, outboundPermission,
    });
    return { database, unitOfWork, priorities, prioritizationRepository, today };
  }

  beforeEach(async () => {
    temp = createTempDatabase();
    key = createTestWorkspaceKey();
    const database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    reader = buildStack(database);
    writer = buildStack(openDatabase({ path: temp.path, key }));
    reader.unitOfWork.immediate(() => {
      const installed = reader.prioritizationRepository.installRuleVersion(
        BUILTIN_PRIORITIZATION_RULE_V1,
      );
      reader.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
    });
  });

  afterEach(() => {
    closeDatabase(writer.database);
    closeDatabase(reader.database);
    temp.cleanup();
  });

  function insertCycleWithAction(prefix: string, prospect: SeededProspect): {
    cycleId: string;
    actionId: string;
  } {
    const cycleId = `${prefix}-cycle`;
    const actionId = `${prefix}-action`;
    const database = reader.database;
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage,
          workflow_status, current_next_action_id, stage_entered_at,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ready', 'active', ?, ?, 1, ?, ?)
      `).run(
        cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
        actionId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status,
          timezone, work_intent, created_at
        ) VALUES (?, ?, 'call', 'phone', 'pending', 'America/New_York',
                  'discretionary_prospecting', ?)
      `).run(actionId, cycleId, DOMAIN_TIMESTAMP);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    return { cycleId, actionId };
  }

  function addDirectPhone(prospect: SeededProspect, id: string): void {
    phoneCounter += 1;
    reader.database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, `+1401555${phoneCounter}`,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function recalc(stack: Stack, prospect: SeededProspect, evaluationId: string, at = EVAL_AT): void {
    stack.priorities.recalculateProspect({
      evaluationId,
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: at,
      expectedProjectionVersion: null,
    });
  }

  function build(stack: Stack) {
    return stack.today.build({
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1,
    });
  }

  it('sees a complete before-or-after state for an independent priority writer', () => {
    const prospect = seedProspect(reader.database.raw, 'snapshot-writer');
    addDirectPhone(prospect, 'snapshot-writer-phone');
    insertCycleWithAction('snapshot-writer', prospect);
    recalc(reader, prospect, 'snapshot-writer-eval');
    const before = build(reader);
    // Independent connection recalculates with a later evaluation.
    writer.priorities.recalculateProspect({
      evaluationId: 'snapshot-writer-second',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: '2026-08-31T15:30:00.000Z',
      expectedProjectionVersion: 1,
    });
    const after = build(reader);
    const itemBefore = before.lanes.flatMap((entry) => entry.items)[0]!;
    const itemAfter = after.lanes.flatMap((entry) => entry.items)[0]!;
    // Both are complete coherent snapshots; the second reflects the new version.
    expect(itemBefore.priority!.projectionVersion).toBe(1);
    expect(itemAfter.priority!.projectionVersion).toBe(2);
    expect(itemAfter.priority!.evaluationId).toBe('snapshot-writer-second');
  });

  it('omits a person whose opt-out committed before Today begins', () => {
    const prospect = seedProspect(reader.database.raw, 'snapshot-optout');
    addDirectPhone(prospect, 'snapshot-optout-phone');
    insertCycleWithAction('snapshot-optout', prospect);
    recalc(reader, prospect, 'snapshot-optout-eval');
    // The writer marks the person opted out. A production opt-out first
    // closes lifecycle work and inserts a tombstone; relax the projection
    // guard to simulate the already-committed state for this read-only test.
    for (const name of writer.database.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'
       AND sql LIKE '%opt-out projection%'`,
    ).all() as { name: string }[]) {
      writer.database.raw.exec(`DROP TRIGGER ${name.name}`);
    }
    writer.database.raw.prepare(`
      UPDATE persons SET opted_out = 1, opted_out_at = ? WHERE id = ?
    `).run(DOMAIN_TIMESTAMP, prospect.personId);
    const queue = build(reader);
    const laneItems = queue.lanes.flatMap((entry) => entry.items);
    expect(laneItems).toHaveLength(0);
    // The SQL projection filter removes the row from the candidate universe.
    expect(queue.diagnostics.filter(
      (entry) => entry.cycleId === 'snapshot-optout-cycle',
    )).toHaveLength(0);
  });

  it('performs zero writes and leaves no transaction on either connection', () => {
    const prospect = seedProspect(reader.database.raw, 'snapshot-clean');
    addDirectPhone(prospect, 'snapshot-clean-phone');
    insertCycleWithAction('snapshot-clean', prospect);
    recalc(reader, prospect, 'snapshot-clean-eval');
    const changesBefore = reader.database.raw.prepare(
      'SELECT total_changes() AS c',
    ).get() as { c: number };
    build(reader);
    const changesAfter = reader.database.raw.prepare(
      'SELECT total_changes() AS c',
    ).get() as { c: number };
    expect(changesAfter.c).toBe(changesBefore.c);
    expect(reader.database.raw.inTransaction).toBe(false);
    // The writer connection can immediately take an immediate transaction.
    writer.unitOfWork.immediate(() => {
      writer.database.raw.prepare('SELECT 1').get();
    });
  });

  it('never yields duplicate cycles or torn priority fields under interleaved builds', () => {
    const prospects = ['snapshot-a', 'snapshot-b', 'snapshot-c'].map((prefix) => {
      const prospect = seedProspect(reader.database.raw, prefix);
      addDirectPhone(prospect, `${prefix}-phone`);
      insertCycleWithAction(prefix, prospect);
      recalc(reader, prospect, `${prefix}-eval`);
      return prospect;
    });
    // Interleave: writer updates the middle prospect between two builds.
    const first = build(reader);
    writer.priorities.recalculateProspect({
      evaluationId: 'snapshot-b-second',
      prospectId: prospects[1]!.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: '2026-08-31T15:45:00.000Z',
      expectedProjectionVersion: 1,
    });
    const second = build(reader);
    for (const queue of [first, second]) {
      const cycleIds = queue.lanes.flatMap((entry) => entry.items.map((item) => item.cycleId));
      expect(new Set(cycleIds).size).toBe(cycleIds.length);
      for (const item of queue.lanes.flatMap((entry) => entry.items)) {
        // Complete snapshot: identity fields agree.
        expect(item.priority!.prospectId).toBe(item.prospectId);
        expect((item.priority!.lastContactActivityId === null))
          .toBe(item.priority!.lastContactAt === null);
      }
    }
  });
});
