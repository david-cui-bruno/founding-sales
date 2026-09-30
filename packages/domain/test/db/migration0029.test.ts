import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0029 on a database at schema 28 that holds meetings (slice M1, review
 * fold 2): every meeting's original and current booking uid becomes an alias of it, a
 * meeting that was never rescheduled gets one alias, and deleting a meeting removes its
 * aliases.
 */
describe('migration 0029 on a database at schema 28', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  const meetings: Record<string, string> = {};

  async function meeting(label: string, workspaceId: string, original: string, current: string): Promise<void> {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, state, starts_at, ends_at, last_event_at)
       VALUES ($1, $2, $3, 'booked', '2026-10-06T15:00:00Z', '2026-10-06T15:30:00Z', '2026-09-30T12:00:00Z') RETURNING id`,
      [workspaceId, original, current],
    );
    meetings[label] = rows[0]?.id ?? '';
  }

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 28 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(28);
    seeded = await seedTwoWorkspaces(database.session);
    await meeting('plain', seeded.alpha.workspaceId, 'plainuid1', 'plainuid1');
    await meeting('moved', seeded.alpha.workspaceId, 'moveduidA', 'moveduidB');
    // The same uid in another workspace is another booking.
    await meeting('elsewhere', seeded.beta.workspaceId, 'plainuid1', 'plainuid1');
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 29 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 29', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(29);
  });

  it('aliases both uids of every meeting to it, once each', async () => {
    const { rows } = await database.session.query<{ workspace_id: string; booking_uid: string; meeting_id: string }>(
      'SELECT workspace_id, booking_uid, meeting_id FROM meeting_booking_uids ORDER BY workspace_id, booking_uid',
    );
    const expected = [
      { workspace_id: seeded.alpha.workspaceId, booking_uid: 'moveduidA', meeting_id: meetings['moved'] },
      { workspace_id: seeded.alpha.workspaceId, booking_uid: 'moveduidB', meeting_id: meetings['moved'] },
      { workspace_id: seeded.alpha.workspaceId, booking_uid: 'plainuid1', meeting_id: meetings['plain'] },
      { workspace_id: seeded.beta.workspaceId, booking_uid: 'plainuid1', meeting_id: meetings['elsewhere'] },
    ];
    expect(rows).toHaveLength(expected.length);
    expect(rows).toEqual(expect.arrayContaining(expected));
  });

  it('removes a meeting s aliases with the meeting', async () => {
    await database.session.query('DELETE FROM meetings WHERE id = $1', [meetings['moved']]);
    const { rows } = await database.session.query('SELECT 1 FROM meeting_booking_uids WHERE meeting_id = $1', [meetings['moved']]);
    expect(rows).toHaveLength(0);
  });
});
