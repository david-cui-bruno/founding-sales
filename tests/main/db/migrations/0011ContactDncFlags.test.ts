import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, productionMigrations } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../../src/main/db/migrations/0006SourcingState';
import { migration0007SourcingOutbox } from '../../../../src/main/db/migrations/0007SourcingOutbox';
import { migration0008DedupeCloudPersons } from '../../../../src/main/db/migrations/0008DedupeCloudPersons';
import { migration0009SourcingFileLedger } from '../../../../src/main/db/migrations/0009SourcingFileLedger';
import { migration0010NoDueDates } from '../../../../src/main/db/migrations/0010NoDueDates';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThrough11 = createMigrationRunner(productionMigrations.filter(x => x.schemaVersion <= 11));

const migrateThroughSchema10 = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
  { id: '0008DedupeCloudPersons', schemaVersion: 8, migration: migration0008DedupeCloudPersons },
  { id: '0009SourcingFileLedger', schemaVersion: 9, migration: migration0009SourcingFileLedger },
  { id: '0010NoDueDates', schemaVersion: 10, migration: migration0010NoDueDates },
]);

const TS = '2026-09-01T12:00:00.000Z';

describe('0011 contact DNC flags migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: {
    backupDirectory: string;
    workspaceKey: ReturnType<typeof createTestWorkspaceKey>;
  };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThroughSchema10(database, options);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('migrates schema 10 to schema 11 and adds both compliance columns', async () => {
    const result = await migrateThrough11(database, options);

    expect(result.fromVersion).toBe(10);
    expect(result.toVersion).toBe(11);
    expect(result.appliedMigrationIds).toEqual([
      '0011ContactDncFlags',
    ]);
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 11 });

    const columns = database.raw
      .prepare<[], { name: string; notnull: number; dflt_value: string }>(
        'PRAGMA table_info(person_contact_methods)',
      )
      .all()
      .filter((column) => column.name === 'dnc_listed' || column.name === 'tcpa_flag');
    expect(columns).toHaveLength(2);
    for (const column of columns) {
      expect(column.notnull).toBe(1);
      expect(column.dflt_value).toBe('0');
    }
  });

  it('defaults existing rows to 0 and constrains new values to 0/1', async () => {
    database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record,
        provenance_json, version, created_at, updated_at
      ) VALUES ('person-1', 'Existing Person', '[]', 0, 0, NULL, 1, ?, ?)
    `).run(TS, TS);
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('contact-1', 'person-1', 'phone', '+14015550100', 'valid', 'direct', 1, ?, ?)
    `).run(TS, TS);

    await migrateThrough11(database, options);

    expect(database.raw.prepare<[string], { dnc_listed: number; tcpa_flag: number }>(
      'SELECT dnc_listed, tcpa_flag FROM person_contact_methods WHERE id = ?',
    ).get('contact-1')).toEqual({ dnc_listed: 0, tcpa_flag: 0 });

    expect(() => database.raw.prepare(`
      UPDATE person_contact_methods SET dnc_listed = 2 WHERE id = 'contact-1'
    `).run()).toThrow(/CHECK/i);
    expect(() => database.raw.prepare(`
      UPDATE person_contact_methods SET tcpa_flag = 2 WHERE id = 'contact-1'
    `).run()).toThrow(/CHECK/i);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await migrateThrough11(database, options);
    const secondResult = await migrateThrough11(database, options);

    expect(secondResult).toEqual({
      fromVersion: 11,
      toVersion: 11,
      appliedMigrationIds: [],
    });
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 11 });
  });
});
