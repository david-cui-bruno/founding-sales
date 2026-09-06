import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDatabase, closeDatabase } from '../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest } from '../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../src/main/db/migrations/0006SourcingState';
import { migration0007SourcingOutbox } from '../../../src/main/db/migrations/0007SourcingOutbox';
import { createRecoveryKeyMaterial } from '../../../src/main/security/recoveryKey';
import { createTestWorkspaceKey } from '../../fixtures/tempDatabase';

export const TIME = '2026-09-06T12:00:00.000Z';
const through7 = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
]);

export async function identityFixture() {
  const directory = mkdtempSync(join(resolve('.superpowers'), 'identity-fixture-'));
  const before = join(directory, 'before.db');
  const current = join(directory, 'current.db');
  const material = join(directory, 'material.txt');
  const key = createTestWorkspaceKey();
  const options = { backupDirectory: join(directory, 'backups'), workspaceKey: key };
  let db = openDatabase({ path: before, key });
  try {
    await through7(db, options);
    // Retained source-event ownership proves merges. Names never prove them.
    for (const [group, addressB, postalB, cloud] of [
      ['address', '2 Example Road', '02100', false],
      ['postal', '1 Example Road', '02900', false],
      ['cloud', '1 Example Road', '02100', true],
      ['duplicate', '1 Example Road', '02100', false],
      ['name-only', '2 Example Road', '02900', false],
    ] as const) {
      for (const suffix of ['a', 'b']) {
        const id = `${group}-${suffix}`;
        const name = suffix === 'a' ? `${group} LLC` : `  ${group} llc. `;
        db.raw.prepare(`INSERT INTO persons (id, display_name, aliases_json, created_at, updated_at)
          VALUES (?, ?, '[]', ?, ?)`).run(id, name, TIME, TIME);
        db.raw.prepare(`INSERT INTO source_events (id, person_id, channel, observed_at, source_record_json, created_at)
          VALUES (?, ?, 'parcel', ?, '{}', ?)`).run(`event-${id}`, id, TIME, TIME);
        db.raw.prepare(`INSERT INTO prospects (id, person_id, original_source_event_id, segment,
          qualification_state, created_at, updated_at) VALUES (?, ?, ?, 'cold', 'unreviewed', ?, ?)`)
          .run(`prospect-${id}`, id, `event-${id}`, TIME, TIME);
        db.raw.prepare(`INSERT INTO properties (id, address_line_1, locality, region, postal_code, created_at, updated_at)
          VALUES (?, ?, 'Example City', 'MA', ?, ?, ?)`)
          .run(`property-${id}`, suffix === 'a' ? '1 Example Road' : addressB,
            suffix === 'a' ? '02100' : postalB, TIME, TIME);
        db.raw.prepare(`INSERT INTO prospect_properties (prospect_id, property_id, created_at) VALUES (?, ?, ?)`)
          .run(`prospect-${id}`, `property-${id}`, TIME);
        if (cloud) db.raw.prepare(`INSERT INTO cloud_entity_links VALUES (?, ?, ?)`)
          .run(`entity-${id}`, id, TIME);
      }
    }
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
    db.raw.pragma('journal_mode = DELETE');
    closeDatabase(db);
    copyFileSync(before, current);
    db = openDatabase({ path: current, key });
    await migrateToLatest(db, options);
    // Schema8 only merges cloud-linked rows. Model other historical merged
    // evidence explicitly so every conflict axis can be tested independently.
    db.raw.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER immutable_source_events');
    for (const group of ['address', 'postal', 'duplicate']) {
      db.raw.prepare('UPDATE source_events SET person_id=? WHERE person_id=?')
        .run(`${group}-a`, `${group}-b`);
      db.raw.prepare('DELETE FROM prospect_properties WHERE prospect_id=?').run(`prospect-${group}-b`);
      db.raw.prepare('DELETE FROM prospects WHERE person_id=?').run(`${group}-b`);
      db.raw.prepare('DELETE FROM person_outbound_jurisdictions WHERE person_id=?').run(`${group}-b`);
      db.raw.prepare('DELETE FROM persons WHERE id=?').run(`${group}-b`);
    }
    db.raw.exec(`CREATE TRIGGER immutable_source_events
      BEFORE UPDATE ON source_events BEGIN SELECT RAISE(ABORT, 'source_events rows are immutable'); END`);
    db.raw.pragma('foreign_keys = ON');
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
    db.raw.pragma('journal_mode = DELETE');
    closeDatabase(db);
    for (const path of [before, current]) chmodSync(path, 0o600);
    writeFileSync(material, createRecoveryKeyMaterial(key), { mode: 0o600 });
    return {
      directory, before, current, material,
      key: () => createTestWorkspaceKey(),
      mutate(path: string, sql: string) {
        const writable = openDatabase({ path, key: createTestWorkspaceKey() });
        try { writable.raw.exec(sql); writable.raw.pragma('wal_checkpoint(TRUNCATE)'); writable.raw.pragma('journal_mode=DELETE'); }
        finally { closeDatabase(writable); }
      },
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
    };
  } catch (error) {
    closeDatabase(db);
    rmSync(directory, { force: true, recursive: true });
    throw error;
  } finally { key.bytes.fill(0); }
}
