import { productionDomainGate } from '../fixtures/productionDomainGate';
import { createImportProvider } from '../../src/main/ipc/registerApplicationIpc';
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
import { type ImportProvider } from '../../src/main/imports/importService';
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

describe('organization assignment after genuine CSV intake', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;
  let service: ImportProvider;

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
    service = createImportProvider(productionDomainGate(domain));
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  const listAll = () => domain.listLeadRows({
    query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 200,
  });

  async function importPeople(content = 'Alice,alice@fixture.invalid,Shared Org\nBob,bob@fixture.invalid,Shared Org\nControl,control@fixture.invalid,Shared Org\n') {
    const preview = await service.preview({
      kind: 'csv', sourceName: 'organizations.csv', content: `Name,Email,Organization\n${content}`,
    });
    expect(preview.errors).toEqual([]);
    const receipt = await service.commit({
      previewId: preview.previewId, contentHash: preview.contentHash,
      mapping: { Name: 'person_name', Email: 'email', Organization: 'organization' },
      source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [],
    });
    expect(receipt.importedRowCount).toBe(content.trim().split('\n').length);
    return listAll().rows;
  }

  function rows(table: string) {
    // Only fixed local table names are passed by these test helpers.
    return database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }

  function state() {
    return JSON.stringify(Object.fromEntries([
      'persons', 'prospects', 'organizations', 'organization_aliases', 'properties',
      'prospect_organizations', 'prospect_properties', 'source_events', 'sales_cycles',
    ].map((table) => [table, rows(table)])));
  }

  function assign(personId: string, value: string | null) {
    return domain.updateLeadField({ personId, field: 'organization_label', value });
  }

  it('preserves the shared identity, aliases, property and source history when Alice moves', async () => {
    const people = await importPeople();
    const alice = people.find((row) => row.personName === 'Alice')!;
    const shared = database.raw.prepare('SELECT id FROM organizations').get() as { id: string };
    services.unitOfWork.immediate(() => {
      services.identities.createProperty({
        organizationId: shared.id, addressLine1: '1 Fixture Street', locality: 'Boston',
        region: 'MA', countryCode: 'US', sourceRecord: { evidence: 'original' },
      });
    });
    const original = JSON.stringify({
      organizations: rows('organizations'), aliases: rows('organization_aliases'),
      properties: rows('properties'), sources: rows('source_events'), cycles: rows('sales_cycles'),
    });
    const receipt = assign(alice.personId, 'New Employer');
    expect(listAll().rows.map((row) => [row.personName, row.organization])).toEqual([
      ['Alice', 'New Employer'], ['Bob', 'Shared Org'], ['Control', 'Shared Org'],
    ]);
    expect(receipt.affectedPersonIds).toEqual([alice.personId]);
    expect(JSON.stringify({
      organizations: database.raw.prepare('SELECT * FROM organizations WHERE id = ?').all(shared.id),
      aliases: database.raw.prepare('SELECT * FROM organization_aliases WHERE organization_id = ?').all(shared.id),
      properties: rows('properties'), sources: rows('source_events'), cycles: rows('sales_cycles'),
    })).toBe(original);
  });

  function prospectId(personId: string): string {
    return (database.raw.prepare('SELECT id FROM prospects WHERE person_id = ?')
      .get(personId) as { id: string }).id;
  }

  function makeOrganization(name: string, aliases: string[] = []) {
    return services.unitOfWork.immediate(() => {
      const organization = services.identities.createOrganization({ canonicalName: name });
      for (const alias of aliases) {
        services.identities.addOrganizationAlias({ organizationId: organization.id, alias });
      }
      return organization;
    });
  }

  it.each([
    ['canonical without aliases', 'Legacy Employer', [], '  Ｌｅｇａｃｙ   Employer  '],
    ['normalized aliases', 'Existing Employer', ['new employer', 'ＮＥＷ  Employer'], ' New   EMPLOYER '],
  ] as const)('reuses a unique target via %s and preserves a normalization-equivalent retry', async (_case, name, aliases, value) => {
    const [alice] = await importPeople();
    const target = makeOrganization(name, [...aliases]);
    const identities = JSON.stringify([rows('organizations'), rows('organization_aliases')]);
    assign(alice.personId, value);
    expect(listAll().rows[0].organization).toBe(name);
    expect(database.raw.prepare('SELECT organization_id, relationship FROM prospect_organizations WHERE prospect_id = ?')
      .all(prospectId(alice.personId))).toEqual([{ organization_id: target.id, relationship: null }]);
    expect(JSON.stringify([rows('organizations'), rows('organization_aliases')])).toBe(identities);
    const beforeRetry = state();
    assign(alice.personId, value.toLowerCase());
    expect(state()).toBe(beforeRetry);
  });

  it('creates a normalized alias reused by assignment and subsequent normal CSV intake without copying the old role', async () => {
    const [alice, bob] = await importPeople();
    database.raw.prepare('UPDATE prospect_organizations SET relationship = ? WHERE prospect_id = ?')
      .run('owner', prospectId(alice.personId));
    assign(alice.personId, 'New Employer');
    assign(bob.personId, ' Ｎｅｗ   EMPLOYER ');
    expect(rows('organizations')).toHaveLength(2);
    expect(rows('organization_aliases')).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'new employer' }),
    ]));
    expect(database.raw.prepare('SELECT relationship FROM prospect_organizations WHERE prospect_id = ?')
      .get(prospectId(alice.personId))).toEqual({ relationship: null });
    await importPeople('Later,later@fixture.invalid,New Employer\n');
    expect(rows('organizations')).toHaveLength(2);
    expect(listAll().rows.find((row) => row.personName === 'Later')?.organization).toBe('New Employer');
  });

  it('clears only Alice, retains shared history and permits zero-link assignment', async () => {
    const [alice] = await importPeople();
    const history = JSON.stringify([rows('organizations'), rows('organization_aliases'), rows('source_events')]);
    assign(alice.personId, null);
    expect(listAll().rows.map((row) => [row.personName, row.organization])).toEqual([
      ['Alice', null], ['Bob', 'Shared Org'], ['Control', 'Shared Org'],
    ]);
    expect(JSON.stringify([rows('organizations'), rows('organization_aliases'), rows('source_events')])).toBe(history);
    const cleared = state();
    assign(alice.personId, null);
    expect(state()).toBe(cleared);
    assign(alice.personId, 'Shared Org');
    expect(rows('organizations')).toHaveLength(1);
    expect(listAll().rows[0].organization).toBe('Shared Org');
  });

  it.each([null, 'New Employer', 'Shared Org'])('rejects ambiguous current membership for %j without writes', async (value) => {
    const [alice] = await importPeople();
    const second = makeOrganization('Second Employer');
    services.unitOfWork.immediate(() => services.identities.linkOrganization({
      prospectId: prospectId(alice.personId), organizationId: second.id,
    }));
    const before = state();
    expect(() => assign(alice.personId, value)).toThrow('The organization assignment is ambiguous.');
    expect(() => assign(alice.personId, value)).toThrow(expect.objectContaining({ code: 'ACTION_NOT_SUPPORTED' }));
    expect(state()).toBe(before);
  });

  it.each(['alias-alias', 'canonical-alias', 'canonical-canonical', 'current-target'])('rejects distinct normalized target identities: %s', async (kind) => {
    const [alice] = await importPeople();
    const value = kind === 'current-target' ? 'Shared Org' : 'Target Employer';
    if (kind !== 'current-target') {
      makeOrganization(kind === 'alias-alias' ? 'First' : 'Target Employer',
        kind === 'alias-alias' ? ['target employer'] : []);
    }
    makeOrganization(kind === 'canonical-canonical' ? ' Ｔａｒｇｅｔ  Employer ' : 'Second',
      kind === 'canonical-canonical' ? [] : [value.toLowerCase()]);
    const before = state();
    expect(() => assign(alice.personId, value)).toThrow('The organization assignment is ambiguous.');
    expect(state()).toBe(before);
  });

  it.each(['', '   ', '\t\n', '\u3000'])('rejects whitespace %j with no writes', async (value) => {
    const [alice] = await importPeople();
    const before = state();
    expect(() => assign(alice.personId, value)).toThrow(expect.objectContaining({
      code: 'ACTION_NOT_SUPPORTED', message: 'The organization assignment must not be blank.',
    }));
    expect(state()).toBe(before);
  });

  it('bulk assigns selected people while leaving the unselected control and original history intact', async () => {
    const [alice, bob] = await importPeople();
    const original = rows('organizations');
    const aliases = rows('organization_aliases');
    const sources = rows('source_events');
    const receipt = domain.bulkUpdateLeads({
      personIds: [alice.personId, bob.personId], field: 'organization_label', value: 'New Employer',
    });
    expect(listAll().rows.map((row) => [row.personName, row.organization])).toEqual([
      ['Alice', 'New Employer'], ['Bob', 'New Employer'], ['Control', 'Shared Org'],
    ]);
    expect(receipt.affectedPersonIds).toEqual([alice.personId, bob.personId].sort());
    expect(rows('organizations')).toHaveLength(2);
    expect(rows('organizations')).toEqual(expect.arrayContaining(original));
    expect(rows('organization_aliases')).toEqual(expect.arrayContaining(aliases));
    expect(rows('source_events')).toEqual(sources);
  });

  it('rolls back earlier links, newly created identity and alias when a later bulk person is invalid', async () => {
    const [alice] = await importPeople();
    const before = state();
    expect(() => domain.bulkUpdateLeads({
      personIds: [alice.personId, 'missing-person'], field: 'organization_label', value: 'New Employer',
    })).toThrow('The person does not exist.');
    expect(state()).toBe(before);
  });

  it('leaves an unchanged unique membership including its verified role byte-equivalent', async () => {
    const [alice] = await importPeople();
    database.raw.prepare('UPDATE prospect_organizations SET relationship = ? WHERE prospect_id = ?')
      .run('owner', prospectId(alice.personId));
    const before = state();
    assign(alice.personId, ' Ｓｈａｒｅｄ   ORG ');
    expect(state()).toBe(before);
  });

  it('rolls back a bulk assignment when a later selected prospect has ambiguous membership', async () => {
    const [alice, bob] = await importPeople();
    const second = makeOrganization('Second Employer');
    services.unitOfWork.immediate(() => services.identities.linkOrganization({
      prospectId: prospectId(bob.personId), organizationId: second.id,
    }));
    const before = state();
    expect(() => domain.bulkUpdateLeads({
      personIds: [alice.personId, bob.personId], field: 'organization_label', value: 'New Employer',
    })).toThrow('The organization assignment is ambiguous.');
    expect(state()).toBe(before);
  });
});
