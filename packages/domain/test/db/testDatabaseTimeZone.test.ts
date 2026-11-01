import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_TIME_ZONE, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';

/**
 * A DST shift inside a window must not decide whether a fixture is valid. CI's cluster
 * is UTC; the harness pins UTC on every test database so a developer's laptop agrees.
 */
describe('test database time zone', () => {
  const databases: TestDatabase[] = [];
  beforeAll(async () => {
    databases.push(await createTestDatabase(), await createTestDatabase({ throughVersion: 0 }));
  });
  afterAll(async () => {
    for (const database of databases) await database.drop();
  });

  it('runs a template copy and a freshly migrated database in the pinned zone', async () => {
    for (const database of databases) {
      const { rows } = await database.session.query<{ TimeZone: string }>('SHOW TimeZone');
      expect(rows[0]?.TimeZone).toBe(TEST_DATABASE_TIME_ZONE);
    }
  });
});
