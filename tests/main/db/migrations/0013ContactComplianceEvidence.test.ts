import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner } from '../../../../src/main/db/migrate';
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
import { migration0011ContactDncFlags } from '../../../../src/main/db/migrations/0011ContactDncFlags';
import { migration0012UpstreamRequestState } from '../../../../src/main/db/migrations/0012UpstreamRequestState';
import { migration0013ContactComplianceEvidence } from '../../../../src/main/db/migrations/0013ContactComplianceEvidence';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../../../fixtures/tempDatabase';

const migrations = [
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
  { id: '0011ContactDncFlags', schemaVersion: 11, migration: migration0011ContactDncFlags },
  { id: '0012UpstreamRequestState', schemaVersion: 12, migration: migration0012UpstreamRequestState },
];
const migrateThrough12 = createMigrationRunner(migrations);
const migrateThrough13 = createMigrationRunner([
  ...migrations,
  { id: '0013ContactComplianceEvidence', schemaVersion: 13, migration: migration0013ContactComplianceEvidence },
]);
const TS = '2026-09-01T12:00:00.000Z';

describe('0013 contact compliance evidence migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThrough12(database, options);
    database.raw.prepare(`INSERT INTO persons
      (id, display_name, aliases_json, opted_out, never_record, provenance_json, version, created_at, updated_at)
      VALUES ('p', 'P', '[]', 0, 0, NULL, 1, ?, ?)` ).run(TS, TS);
  });

  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  function insertContact(id: string, dncListed: number, tcpaFlag: number): void {
    database.raw.prepare(`INSERT INTO person_contact_methods
      (id, person_id, kind, normalized_value, validation_state, reachability, is_primary,
       dnc_listed, tcpa_flag, created_at, updated_at)
      VALUES (?, 'p', 'phone', ?, 'valid', 'direct', 0, ?, ?, ?, ?)`)
      .run(id, `+14015550${id === 'negative' ? '100' : '101'}`, dncListed, tcpaFlag, TS, TS);
  }

  it('migrates a legacy negative boolean to unknown and null TCPA', async () => {
    insertContact('negative', 0, 0);
    await migrateThrough13(database, options);
    expect(database.raw.prepare(`SELECT federal_status, compliance_tcpa_flag, covered_area_code,
      compliance_source, scrubbed_at, compliance_expires_at FROM person_contact_methods WHERE id = 'negative'`).get())
      .toEqual({ federal_status: 'unknown', compliance_tcpa_flag: null, covered_area_code: null,
        compliance_source: 'legacy', scrubbed_at: null, compliance_expires_at: null });
    expect(database.raw.prepare(`SELECT operation, source, resulting_reason_code
      FROM contact_compliance_audit_events WHERE contact_method_id = 'negative'`).get())
      .toEqual({ operation: 'legacy_backfill', source: 'legacy', resulting_reason_code: 'federal_status_unknown' });
  });

  it('preserves a legacy DNC positive as listed', async () => {
    insertContact('positive', 1, 0);
    await migrateThrough13(database, options);
    expect(database.raw.prepare(`SELECT federal_status, compliance_tcpa_flag
      FROM person_contact_methods WHERE id = 'positive'`).get())
      .toEqual({ federal_status: 'listed', compliance_tcpa_flag: null });
  });

  it('preserves a legacy TCPA positive as blocked', async () => {
    insertContact('positive', 0, 1);
    await migrateThrough13(database, options);
    expect(database.raw.prepare(`SELECT federal_status, compliance_tcpa_flag
      FROM person_contact_methods WHERE id = 'positive'`).get())
      .toEqual({ federal_status: 'unknown', compliance_tcpa_flag: 1 });
  });

  it('rejects invalid federal status, TCPA tri-state, and area-code values', async () => {
    insertContact('negative', 0, 0);
    await migrateThrough13(database, options);
    expect(() => database.raw.prepare("UPDATE person_contact_methods SET federal_status = 'clear' WHERE id = 'negative'").run()).toThrow(/CHECK/i);
    expect(() => database.raw.prepare('UPDATE person_contact_methods SET compliance_tcpa_flag = 2 WHERE id = \'negative\'').run()).toThrow(/CHECK/i);
    expect(() => database.raw.prepare("UPDATE person_contact_methods SET covered_area_code = '40A' WHERE id = 'negative'").run()).toThrow(/CHECK/i);
  });
});
