import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  createLeadsService,
  type LeadsProvider,
} from '../../src/main/leads/leadsService';
import {
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

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('leadsService over a real encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let leads: LeadsProvider;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = new FixedClock();
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
    leads = createLeadsService(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): SeededProspect {
    const prospect = seedProspect(database.raw, prefix);
    insertOpenCycleWithAction({ database: database.raw, prefix, prospect });
    return prospect;
  }

  const listAll = (overrides: Partial<Parameters<LeadsProvider['list']>[0]> = {}) =>
    leads.list({
      query: '', stages: [], priorities: [], sort: 'person_name',
      cursor: null, limit: 50, ...overrides,
    });

  it('lists seeded people as strict lead rows', async () => {
    seedLead('alpha');
    seedLead('beta');

    const page = await listAll();

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.personName)).toEqual([
      'Person alpha-person',
      'Person beta-person',
    ]);
    for (const row of page.rows) {
      expect(row.initials.length).toBeGreaterThan(0);
      expect(Object.keys(row)).not.toContain('score');
    }
  });

  it('paginates with a stable cursor and no repeated people', async () => {
    seedLead('alpha');
    seedLead('beta');
    seedLead('gamma');

    const first = await listAll({ limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAll({ limit: 2, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.rows, ...second.rows].map((row) => row.personId);
    expect(new Set(seen).size).toBe(3);
  });

  it('filters by query text', async () => {
    seedLead('alpha');
    seedLead('beta');

    const page = await listAll({ query: 'alpha' });

    expect(page.total).toBe(1);
    expect(page.rows[0]?.personName).toBe('Person alpha-person');
  });

  it('updates an allowed field and reflects it in the next list read', async () => {
    const prospect = seedLead('alpha');
    const before = await listAll();

    const receipt = await leads.updateField({
      personId: prospect.personId, field: 'person_name', value: 'Renamed Person',
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.revision).toBeGreaterThan(before.revision);
    const after = await listAll();
    expect(after.rows[0]?.personName).toBe('Renamed Person');
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('bulk-updates the organization label for many people', async () => {
    const alpha = seedLead('alpha');
    const beta = seedLead('beta');

    const receipt = await leads.bulkUpdate({
      personIds: [alpha.personId, beta.personId],
      field: 'organization_label',
      value: 'Shared Holdings',
    });

    expect(receipt.affectedPersonIds.sort()).toEqual(
      [alpha.personId, beta.personId].sort(),
    );
    const page = await listAll();
    expect(page.rows.map((row) => row.organization)).toEqual([
      'Shared Holdings',
      'Shared Holdings',
    ]);
  });

  it('rejects an update for an unknown person without corrupting reads', async () => {
    seedLead('alpha');

    await expect(
      leads.updateField({
        personId: 'missing-person', field: 'person_name', value: 'Nope',
      }),
    ).rejects.toThrow(/does not exist/);
    const page = await listAll();
    expect(page.total).toBe(1);
  });
});
