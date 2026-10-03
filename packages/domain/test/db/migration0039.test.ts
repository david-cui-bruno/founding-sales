import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';

/**
 * Migration 0039 on a database at schema 38 (lane M1): every stored `held` came from Cal.com's
 * scheduled end, so it becomes `ended`; a no-show that remembered `held` remembers `ended`;
 * every stored no-show is Cal.com's; every `meeting.held` fact is withdrawn, re-dated to its
 * meeting's start, and one audit row per workspace says how many of each.
 *
 * Alpha at 38: H1 and H2 held (H2 keyed by an intermediate uid of a reschedule chain), N1 a
 * no-show that was held, N2 a no-show that was booked, B booked, C cancelled; a `meeting.held`
 * fact for H1, H2 and N1 and an unrelated `meeting.booked` fact. Beta: one held meeting with
 * its fact. Every count differs, so a count read from the wrong rows fails.
 */
describe('migration 0039 on a database at schema 38', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  const alpha = (): string => seeded.alpha.workspaceId;

  async function meeting(workspaceId: string, firmId: string, uid: string, state: string, before: string | null, startsAt: string): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, state_before_no_show,
                             starts_at, ends_at, last_event_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '30 minutes', '2026-09-30T12:00:00Z')
       RETURNING id`,
      [workspaceId, uid, firmId, state, before, startsAt],
    );
    const id = rows[0]?.id ?? '';
    await database.session.query('INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id) VALUES ($1, $2, $3)', [workspaceId, uid, id]);
    return id;
  }

  async function fact(workspaceId: string, firmId: string, kind: string, key: string): Promise<void> {
    await database.session.query(
      `INSERT INTO funnel_facts (workspace_id, kind, firm_id, dedupe_key, source, actor_kind, occurred_at)
       VALUES ($1, $2, $3, $4, 'calendar', 'system', '2026-09-30T18:00:00Z')`,
      [workspaceId, kind, firmId, key],
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 38 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(38);
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    const firm = crm.alpha.firmId;
    await meeting(alpha(), firm, 'mig39h1', 'held', null, '2026-09-29T15:00:00Z');
    const h2 = await meeting(alpha(), firm, 'mig39h2', 'held', null, '2026-09-28T15:00:00Z');
    // H2 was rescheduled from an earlier uid, and its fact is keyed by that one.
    await database.session.query('INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id) VALUES ($1, $2, $3)', [alpha(), 'mig39h2old', h2]);
    await meeting(alpha(), firm, 'mig39n1', 'no_show', 'held', '2026-09-27T15:00:00Z');
    await meeting(alpha(), firm, 'mig39n2', 'no_show', 'booked', '2026-09-26T15:00:00Z');
    await meeting(alpha(), firm, 'mig39b', 'booked', null, '2026-10-20T15:00:00Z');
    await meeting(alpha(), firm, 'mig39c', 'cancelled', null, '2026-10-21T15:00:00Z');
    await fact(alpha(), firm, 'meeting.held', 'mig39h1');
    await fact(alpha(), firm, 'meeting.held', 'mig39h2old');
    await fact(alpha(), firm, 'meeting.held', 'mig39n1');
    await fact(alpha(), firm, 'meeting.booked', 'mig39b');
    await meeting(seeded.beta.workspaceId, crm.beta.firmId, 'mig39z', 'held', null, '2026-09-25T15:00:00Z');
    await fact(seeded.beta.workspaceId, crm.beta.firmId, 'meeting.held', 'mig39z');
    await applyMigrations(database.session, { throughVersion: 39 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 39, with no held meeting and no remembered held left', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(39);
    const { rows } = await database.session.query<{ booking_uid: string; state: string; state_before_no_show: string | null; attendance_source: string | null; confirmed: boolean; attendance_confirmed_by: string | null }>(
      `SELECT booking_uid, state, state_before_no_show, attendance_source,
              attendance_confirmed_at = last_event_at AS confirmed, attendance_confirmed_by
         FROM meetings WHERE workspace_id = $1 ORDER BY booking_uid`,
      [alpha()],
    );
    expect(rows).toEqual([
      { booking_uid: 'mig39b', state: 'booked', state_before_no_show: null, attendance_source: null, confirmed: null, attendance_confirmed_by: null },
      { booking_uid: 'mig39c', state: 'cancelled', state_before_no_show: null, attendance_source: null, confirmed: null, attendance_confirmed_by: null },
      { booking_uid: 'mig39h1', state: 'ended', state_before_no_show: null, attendance_source: null, confirmed: null, attendance_confirmed_by: null },
      { booking_uid: 'mig39h2', state: 'ended', state_before_no_show: null, attendance_source: null, confirmed: null, attendance_confirmed_by: null },
      // Both no-shows came from Cal.com's flag, confirmed when its event was applied.
      { booking_uid: 'mig39n1', state: 'no_show', state_before_no_show: 'ended', attendance_source: 'calcom_no_show', confirmed: true, attendance_confirmed_by: null },
      { booking_uid: 'mig39n2', state: 'no_show', state_before_no_show: 'booked', attendance_source: 'calcom_no_show', confirmed: true, attendance_confirmed_by: null },
    ]);
    const beta = await database.session.query<{ state: string }>('SELECT state FROM meetings WHERE workspace_id = $1', [seeded.beta.workspaceId]);
    expect(beta.rows).toEqual([{ state: 'ended' }]);
  });

  it('withdraws every meeting.held fact and re-dates it to its meeting s start; other facts are untouched', async () => {
    const { rows } = await database.session.query<{ dedupe_key: string; kind: string; withdrawn_reason: string | null; withdrawn: boolean; occurred_at: Date }>(
      `SELECT dedupe_key, kind, withdrawn_reason, withdrawn_at IS NOT NULL AS withdrawn, occurred_at
         FROM funnel_facts WHERE workspace_id = $1 AND dedupe_key LIKE 'mig39%' ORDER BY dedupe_key`,
      [alpha()],
    );
    expect(rows.map(row => ({ ...row, occurred_at: row.occurred_at.toISOString() }))).toEqual([
      { dedupe_key: 'mig39b', kind: 'meeting.booked', withdrawn_reason: null, withdrawn: false, occurred_at: '2026-09-30T18:00:00.000Z' },
      { dedupe_key: 'mig39h1', kind: 'meeting.held', withdrawn_reason: 'scheduled_end_not_attendance', withdrawn: true, occurred_at: '2026-09-29T15:00:00.000Z' },
      // Keyed by an intermediate uid: found through meeting_booking_uids.
      { dedupe_key: 'mig39h2old', kind: 'meeting.held', withdrawn_reason: 'scheduled_end_not_attendance', withdrawn: true, occurred_at: '2026-09-28T15:00:00.000Z' },
      { dedupe_key: 'mig39n1', kind: 'meeting.held', withdrawn_reason: 'scheduled_end_not_attendance', withdrawn: true, occurred_at: '2026-09-27T15:00:00.000Z' },
    ]);
  });

  it('records one audit row per workspace with the counts it corrected', async () => {
    const { rows } = await database.session.query<{ workspace_id: string; actor_kind: string; detail: Record<string, unknown> }>(
      "SELECT workspace_id, actor_kind, detail FROM audit_events WHERE action = 'meeting.attendance_corrected' ORDER BY workspace_id = $1 DESC",
      [alpha()],
    );
    expect(rows).toEqual([
      {
        workspace_id: alpha(),
        actor_kind: 'system',
        detail: {
          migration: '0039',
          heldToEnded: 2,
          noShowBeforeHeldToEnded: 1,
          noShowsAttributedToCalcom: 2,
          heldFactsWithdrawn: 3,
          withdrawnReason: 'scheduled_end_not_attendance',
        },
      },
      {
        workspace_id: seeded.beta.workspaceId,
        actor_kind: 'system',
        detail: {
          migration: '0039',
          heldToEnded: 1,
          noShowBeforeHeldToEnded: 0,
          noShowsAttributedToCalcom: 0,
          heldFactsWithdrawn: 1,
          withdrawnReason: 'scheduled_end_not_attendance',
        },
      },
    ]);
  });

  it('refuses held without a confirmation, and a no-show remembering held, from now on', async () => {
    const insert = async (state: string, before: string | null): Promise<unknown> => {
      await database.session.query('BEGIN');
      try {
        return await database.session.query(
          `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, state_before_no_show,
                                 attendance_source, attendance_confirmed_at, starts_at, ends_at, last_event_at)
           VALUES ($1, 'mig39x', 'mig39x', $2, $3, $4, $5, $6, now(), now(), now())`,
          [alpha(), crm.alpha.firmId, state, before, state === 'no_show' ? 'calcom_no_show' : null, state === 'no_show' ? new Date() : null],
        );
      } finally {
        await database.session.query('ROLLBACK');
      }
    };
    await expect(insert('ended', null)).resolves.toBeDefined();
    await expect(insert('no_show', 'ended')).resolves.toBeDefined();
    await expect(insert('held', null)).rejects.toMatchObject({ constraint: 'meetings_attendance_confirmed' });
    await expect(insert('no_show', 'held')).rejects.toMatchObject({ constraint: 'meetings_no_show_remembers' });
  });
});
