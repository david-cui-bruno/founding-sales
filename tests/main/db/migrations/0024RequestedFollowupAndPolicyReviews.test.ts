import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../../../src/main/db/database';
import { createPmFixture, PM_NOW } from '../../../fixtures/pmAccounts';
import { createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

it('persists threadless drafts and immutable owner reviews with strict SQL boundaries across encrypted reopen', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional Followup PM', domain: null });
    expect(f.db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 24 });
    const draft = f.db.raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)');
    const values = ['workspace', account.id, 'draft', 1, 'a'.repeat(64), '{}', null, PM_NOW];
    draft.run(...values);
    for (const [column, value] of [[0, ' bad'], [1, 'missing'], [2, ''], [3, 0], [3, 1.5], [3, 9007199254740992], [4, 'z'.repeat(64)], [5, '[]'], [5, 'bad'], [6, '[]'], [7, 'not-time'], [7, '2026-02-30T12:00:00.000Z']] as const) {
      const invalid = [...values]; invalid[2] = randomUUID(); invalid[column] = value;
      expect(() => draft.run(...invalid)).toThrow();
    }
    const review = f.db.raw.prepare('INSERT INTO account_route_policy_import_reviews VALUES(?,?,?,?,?,?,?,?,?,?)');
    const reviewId = randomUUID();
    const reviewValues = [reviewId, randomUUID(), 'b'.repeat(64), Buffer.from('fictional owner artifact'), '[{}]', 1, 'Reviewed exact fictional evidence', PM_NOW, 'local_owner_review', 'account_route_policy_import_review_v1'];
    review.run(...reviewValues);
    for (const [column, value] of [[0, 'x'.repeat(36)], [1, 'bad'], [2, 'Z'.repeat(64)], [3, 'not-blob'], [4, '{}'], [5, 2], [5, 0], [6, ' '], [7, 'nonsense'], [7, '2026-02-30T12:00:00.000Z'], [8, 'automatic'], [9, 'v2']] as const) {
      const invalid = [...reviewValues]; invalid[0] = randomUUID(); invalid[2] = 'c'.repeat(64); invalid[column] = value;
      expect(() => review.run(...invalid)).toThrow();
    }
    expect(() => f.db.raw.prepare('UPDATE account_route_policy_import_reviews SET review_reason=? WHERE id=?').run('Changed', reviewId)).toThrow('immutable');
    expect(() => f.db.raw.prepare('DELETE FROM account_route_policy_import_reviews WHERE id=?').run(reviewId)).toThrow('immutable');
    expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    closeDatabase(f.db);
    const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try {
      expect(reopened.raw.prepare('SELECT id,approval_json FROM delegated_requested_followup_drafts').all()).toEqual([{ id: 'draft', approval_json: null }]);
      expect(reopened.raw.prepare('SELECT id,artifact_bytes FROM account_route_policy_import_reviews').all()).toEqual([{ id: reviewId, artifact_bytes: Buffer.from('fictional owner artifact') }]);
      expect(reopened.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { closeDatabase(reopened); }
  } finally { f.close(); }
});

it('preserves the genuine23 catalog and every historical business row while adding only24, then reopens idempotently', async () => {
  const { createMigrationRunner, migrateToLatest, productionMigrations } = await import('../../../../src/main/db/migrate');
  const { createTempDatabase } = await import('../../../fixtures/tempDatabase');
  const { createHash } = await import('node:crypto');
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 23))(database, options);
    database.raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run('historical23-person', 'Fictional retained23', PM_NOW, PM_NOW);
    database.raw.prepare('INSERT INTO delegated_local_configuration VALUES(?,?,?,?,?)').run('workspace', 'pairing', 1, '{"retained":true}', PM_NOW);
    const catalog = database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type COLLATE BINARY,name COLLATE BINARY").all() as { type: string; name: string; sql: string }[];
    expect(catalog.filter(row => row.type === 'table')).toHaveLength(118);
    expect(catalog.filter(row => row.type === 'index')).toHaveLength(29);
    expect(catalog.filter(row => row.type === 'trigger')).toHaveLength(186);
    expect(createHash('sha256').update(JSON.stringify(catalog.map(row => [row.type, row.name, row.sql.replace(/\s+/g, ' ').trim()]))).digest('hex'))
      .toBe('53f24bedc785b09d913ee35d89fa7d07ebafa0ebea493efba1660234cc8fb89a');
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta', 'kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const before = rows();
    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 23, toVersion: 24, appliedMigrationIds: ['0024RequestedFollowupAndPolicyReviews'] });
    expect(rows()).toEqual(before);
    for (const original of catalog) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(original.name)).toEqual(original);
    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 24, toVersion: 24, appliedMigrationIds: [] });
      expect(reopened.raw.prepare('SELECT * FROM delegated_requested_followup_drafts').all()).toEqual([]);
      expect(reopened.raw.prepare('SELECT * FROM account_route_policy_import_reviews').all()).toEqual([]);
      expect(reopened.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
