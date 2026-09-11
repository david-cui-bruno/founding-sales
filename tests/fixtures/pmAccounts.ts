import { randomUUID } from 'node:crypto';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';
import { insertPerson } from './domainRows';

export const PM_NOW = '2026-09-08T12:00:00.000Z';
/** Real isolated encrypted storage, initially migrated only through historical 19. */
export async function createPmFixture() {
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  const db = openDatabase({ path: temp.path, key });
  try {
    const options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await createMigrationRunner(productionMigrations.slice(0, 19))(db, options);
    insertPerson(db.raw, 'historical-person');
    db.raw.prepare(`INSERT INTO organizations(id,canonical_name,created_at,updated_at) VALUES(?,?,?,?)`)
      .run('historical-org', 'Historical Fictional PM', PM_NOW, PM_NOW);
    const historicalPersons = db.raw.prepare('SELECT * FROM persons ORDER BY id').all();
    const historicalOrganizations = db.raw.prepare('SELECT * FROM organizations ORDER BY id').all();
    await migrateToLatest(db, options);
    const repo = new AccountRepository({ database: db, clock: { now: () => PM_NOW }, ids: { next: randomUUID },
      sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
    return { db, repo, historicalPersons, historicalOrganizations, close() {
      closeDatabase(db); key.bytes.fill(0); temp.cleanup();
    } };
  } catch (error) { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); throw error; }
}
