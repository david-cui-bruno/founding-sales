import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { inspectDatabaseEncryption } from '../../src/main/db/databaseEncryption';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

const scenario = process.argv[2];
void run();

async function run(): Promise<void> {
 const workspace = createTempDatabase();
 try {
  const key = createTestWorkspaceKey();
  const database = openDatabase({
    path: workspace.path,
    key,
  });
  await migrateToLatest(database, {
    backupDirectory: `${workspace.path}.backups`,
    workspaceKey: key,
  });
  if (scenario === 'create-and-health') {
    assert.notEqual(
      readFileSync(workspace.path).subarray(0, 16).toString('utf8'),
      'SQLite format 3\u0000',
    );
    const health = inspectDatabaseEncryption(database);
    assert.equal(health.encrypted, true);
    assert.match(health.cipherVersion, /^SQLite3 Multiple Ciphers \d+\.\d+\.\d+$/);
    assert.equal(health.integrity, 'ok');
    closeDatabase(database);
  } else if (scenario === 'reopen-and-wrong-key') {
    database.raw.prepare(`
      INSERT INTO jobs (
        id, type, state, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('retained', 'test', 'queued', '{}', '2026-08-30T12:00:00.000Z', '2026-08-30T12:00:00.000Z');
    closeDatabase(database);
    const reopened = openDatabase({
      path: workspace.path,
      key: createTestWorkspaceKey(),
    });
    assert.deepEqual(
      reopened.raw.prepare('SELECT id FROM jobs WHERE id = ?').get('retained'),
      { id: 'retained' },
    );
    closeDatabase(reopened);
    assert.throws(() => openDatabase({
      path: workspace.path,
      key: createTestWorkspaceKey(0x7b),
    }));
  } else {
    closeDatabase(database);
    assert.fail('Unknown encrypted database scenario.');
  }
 } finally {
   workspace.cleanup();
 }
}
