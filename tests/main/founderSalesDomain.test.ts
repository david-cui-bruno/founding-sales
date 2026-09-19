import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DomainRepositoryDatabaseMismatchError } from '../../src/main/domain/support/domainErrors';

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
import { insertOpenCycleWithAction, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';


const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

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

describe('FounderSalesDomain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string, stage: 'unreviewed' | 'ready' = 'unreviewed'): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect, stage,
    });
    return { prospect, cycleId, actionId };
  }

  const listAll = () => domain.listLeadRows({
    query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
  });

  it('rejects a facade graph with a substitute UOW before any query or clock/ID access', () => {
    const prepare = vi.spyOn(database.raw, 'prepare');
    const now = vi.spyOn(clock, 'now');
    const ids = { next: vi.fn(() => 'unused') };
    expect(() => createFounderSalesDomain({ database, clock, ids,
      services: { ...services, unitOfWork: new DomainUnitOfWork(database) } }))
      .toThrow(DomainRepositoryDatabaseMismatchError);
    expect(prepare).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled(); expect(ids.next).not.toHaveBeenCalled();
  });

  describe('leads', () => {
    it.each(['detail', 'list'] as const)('projects the real dated Unreviewed action in %s without lifecycle writes', (surface) => {
      const prospect = seedProspect(database.raw, `dated-${surface}`);
      database.raw.prepare("UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?").run(prospect.prospectId);
      const cycle = services.lifecycle.createUnreviewedCycle({ personId: prospect.personId,
        prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId, effectiveAt: CLOCK_NOW });
      const persisted = database.raw.prepare('SELECT id, due_at FROM next_actions WHERE id = ?')
        .get(cycle.currentNextActionId) as { id: string; due_at: string };
      const before = database.raw.prepare('SELECT total_changes() AS count').get();
      const action = surface === 'detail' ? domain.getLeadDetail({ personId: prospect.personId }).nextAction
        : listAll().rows.find(row => row.personId === prospect.personId)!.nextAction;
      expect(action).toMatchObject({ id: persisted.id, dueAt: persisted.due_at });
      expect(persisted.due_at).toBe(CLOCK_NOW);
      expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(database.raw.prepare('SELECT stage FROM sales_cycles WHERE id = ?').get(cycle.id))
        .toEqual({ stage: 'unreviewed' });
    });

    it('lists seeded people with strict rows and no blended score', () => {
      seedLead('alpha');
      seedLead('beta');
      const page = listAll();
      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.personName)).toHaveLength(2);
      for (const row of page.rows) {
        expect(row.initials.length).toBeGreaterThan(0);
        expect(Object.keys(row)).not.toContain('score');
        if (row.priorityContext !== null) {
          expect(row.priorityContext.fitPoints).toBeLessThanOrEqual(30);
          expect(row.priorityContext.timingValue).toBeLessThanOrEqual(40);
        }
      }
    });

    it('filters by query and paginates with a stable cursor', () => {
      seedLead('alpha');
      seedLead('beta');
      const filtered = domain.listLeadRows({
        query: 'alpha', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
      });
      expect(filtered.total).toBe(1);
      const first = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 1,
      });
      expect(first.rows).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority',
        cursor: first.nextCursor, limit: 1,
      });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.personId).not.toBe(first.rows[0]!.personId);
    });

    it('returns a strict lead detail for a seeded person', () => {
      const { prospect, cycleId } = seedLead('alpha');
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.personId).toBe(prospect.personId);
      expect(detail.salesCycleId).toBe(cycleId);
      expect(detail.stage).toBe('unreviewed');
      expect(detail.optedOut).toBe(false);
      expect(detail.revision).toBeGreaterThanOrEqual(0);
    });
  });
});
