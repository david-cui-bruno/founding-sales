import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { JurisdictionRepository } from '../../src/main/domain/compliance/jurisdictionRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NOW = '2026-09-04T14:00:00.000Z';

describe('JurisdictionRepository', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let repository: JurisdictionRepository;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    repository = new JurisdictionRepository({ database, unitOfWork: new DomainUnitOfWork(database) });
    database.raw.prepare(`INSERT INTO persons
      (id, display_name, aliases_json, opted_out, never_record, provenance_json, version, created_at, updated_at)
      VALUES ('p', 'P', '[]', 0, 0, NULL, 1, ?, ?)` ).run(NOW, NOW);
  });
  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  it('strictly reads current jurisdiction and channel clearance without phone inference', () => {
    expect(repository.getPersonJurisdiction('p')).toBeNull();
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES ('p', 'RI', 'America/New_York', 'manual_review', ?, ?)` ).run(NOW, NOW);
    expect(repository.getPersonJurisdiction('p')).toEqual({
      regionCode: 'RI', timezone: 'America/New_York', reviewAt: null,
    });
    expect(repository.getClearance('RI', 'call')).toEqual({
      decision: 'unknown', registrationConfirmed: null, stateDncSubscriptionConfirmed: null,
      consentRuleConfirmed: null, effectiveAt: '2026-09-04T00:00:00.000Z', expiresAt: null,
    });
    expect(repository.getClearance('RI', 'text')).toBeNull();
  });

  it('fails closed on malformed persisted timezone and obligations', () => {
    database.raw.prepare(`INSERT INTO person_outbound_jurisdictions
      (person_id, region_code, timezone, source, effective_at, updated_at)
      VALUES ('p', 'RI', '', 'manual_review', ?, ?)` ).run(NOW, NOW);
    expect(() => repository.getPersonJurisdiction('p')).toThrow();
  });
});
