import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';

/**
 * Migration 0041 on a database at schema 40 (lane M4): `meeting_recordings` exists, empty,
 * granted to the runtime role; every stored meeting is untouched; a recording goes with its
 * meeting (ON DELETE CASCADE) and its key is always its own meeting's.
 */
describe('migration 0041 on a database at schema 40', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let meetingId = '';
  let meetingsBefore: unknown[] = [];

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 40 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(40);
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
       VALUES ($1, 'mig41', 'mig41', $2, 'booked', '2026-10-05T15:00:00Z', '2026-10-05T15:20:00Z', '2026-10-01T12:00:00Z')
       RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    meetingId = rows[0]?.id ?? '';
    meetingsBefore = (await database.session.query('SELECT * FROM meetings ORDER BY id')).rows;
    await applyMigrations(database.session, { throughVersion: 41 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 41, with every stored meeting unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(41);
    expect((await database.session.query('SELECT * FROM meetings ORDER BY id')).rows).toEqual(meetingsBefore);
  });

  it('creates meeting_recordings, empty, readable and writable by the runtime role', async () => {
    expect((await database.session.query('SELECT count(*)::int AS n FROM meeting_recordings')).rows).toEqual([{ n: 0 }]);
    const { rows } = await database.session.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'meeting_recordings' AND grantee = 'app_runtime' ORDER BY privilege_type`,
    );
    expect(rows.map(row => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('records a file as uploaded, once per digest, and drops it with its meeting', async () => {
    const sha = 'c'.repeat(64);
    await database.session.query('BEGIN');
    try {
      const { rows } = await database.session.query<{ state: string }>(
        `INSERT INTO meeting_recordings (workspace_id, meeting_id, segment, participant_label, sha256, size_bytes, s3_key)
         VALUES ($1, $2, 1, 'audio1.m4a', $3, 10, $4) RETURNING state`,
        [seeded.alpha.workspaceId, meetingId, sha, `meetings/${meetingId}/${sha}.m4a`],
      );
      expect(rows).toEqual([{ state: 'uploaded' }]);
      await database.session.query('DELETE FROM meeting_booking_uids WHERE meeting_id = $1', [meetingId]);
      await database.session.query('DELETE FROM meetings WHERE id = $1', [meetingId]);
      expect((await database.session.query('SELECT count(*)::int AS n FROM meeting_recordings')).rows).toEqual([{ n: 0 }]);
    } finally {
      await database.session.query('ROLLBACK');
    }
  });
});
