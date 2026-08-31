import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
const [databasePath, nativeBinding, readyPath, keyHex] = process.argv.slice(2);
if (!databasePath || !nativeBinding || !readyPath || !keyHex) {
  throw new Error('Missing source-intake contender arguments.');
}

const database = new Database(databasePath, { nativeBinding });
try {
  database.pragma("cipher='sqlcipher'");
  database.pragma('legacy=4');
  database.pragma(`key="x'${keyHex}'"`);
  database.prepare('SELECT count(*) FROM sqlite_master').get();
  database.pragma('recursive_triggers = ON');
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec('BEGIN IMMEDIATE');
  writeFileSync(readyPath, 'locked', { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);

  const timestamp = '2026-08-30T12:00:00.000Z';
  database.prepare(`
    INSERT INTO persons (
      id, display_name, aliases_json, opted_out, never_record,
      version, created_at, updated_at
    ) VALUES ('contended-person', 'Contended Person', '[]', 0, 0, 1, ?, ?)
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO person_contact_methods (
      id, person_id, kind, normalized_value, raw_value, validation_state,
      reachability, is_primary, created_at, updated_at
    ) VALUES (
      'contended-contact', 'contended-person', 'phone', '+14015550100',
      '(401) 555-0100', 'valid', 'direct', 1, ?, ?
    )
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO source_events (
      id, person_id, channel, observed_at, source_record_json, created_at
    ) VALUES ('contended-source-one', 'contended-person', 'frbo', ?, ?, ?)
  `).run(
    '2026-08-29T15:00:00.000Z',
    JSON.stringify({
      formatVersion: 1,
      sourceRecord: { listingId: 'contended-one' },
      customSourceReason: null,
    }),
    timestamp,
  );
  database.prepare(`
    INSERT INTO prospects (
      id, person_id, original_source_event_id, segment, qualification_state,
      version, created_at, updated_at
    ) VALUES (
      'contended-prospect', 'contended-person', 'contended-source-one',
      'hot_frbo', 'unreviewed', 1, ?, ?
    )
  `).run(timestamp, timestamp);
  database.exec('COMMIT');
} catch (error) {
  if (database.inTransaction) database.exec('ROLLBACK');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
