import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * Rows HEAD adds to the fixture at N, in N's own column list, before the snapshot.
 *
 * The fixture is written by the base checkout's own loader, so a row shape the base's
 * code never produced cannot come from there — yet the migration under test has to meet
 * it, because production can hold it. The case that made this file: schema 25 lets a
 * `follow_up_permissions` row be spent (`consumed_at` set) and 0026 adds a CHECK pairing
 * `consumed_at` with a new `consumed_reason`, so 0026 must backfill the reason first
 * (review of PR 335, P1-1). The base's fixture holds no spent permission, and a run
 * without one would pass whether the backfill existed or not.
 *
 * Each seed is plain SQL against schema N — never HEAD's domain code, which writes
 * schema M — and names the versions it applies to. After the upgrade its `verify` reads
 * the row back and says what is wrong, or null. A seed changes rows in a table the
 * snapshot then records, so step 6 sees the migration's effect on it like any other.
 */
export interface HeadSeed {
  readonly name: string;
  /** The base schemas this seed is written for: its SQL uses exactly their columns. */
  readonly fromVersions: readonly number[];
  readonly seed: (session: SessionQueryable) => Promise<string>;
  readonly verify: (session: SessionQueryable, seededId: string) => Promise<string | null>;
}

export const HEAD_SEEDS: readonly HeadSeed[] = Object.freeze([
  {
    name: 'spent follow-up permission (0026 backfills consumed_reason)',
    fromVersions: [25],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `INSERT INTO follow_up_permissions
           (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
            expires_at, granted_by_user_id, consumed_at)
         SELECT c.workspace_id, c.firm_id, c.id, 'request', 'contextual_reply', 'upgrade-spent-0026', 1,
                now() + interval '14 days', m.user_id, now()
           FROM contacts c
           JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
          ORDER BY c.created_at, c.id, m.user_id
          LIMIT 1
         RETURNING id`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no contact to hang a spent permission on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<{ consumed_reason: string | null; consumed_at: Date | null }>(
        'SELECT consumed_reason, consumed_at FROM follow_up_permissions WHERE id = $1',
        [seededId],
      );
      const row = rows[0];
      if (row === undefined) return 'the spent permission is gone';
      if (row.consumed_at === null) return 'the spent permission lost its consumed_at';
      if (row.consumed_reason !== 'sent') return `consumed_reason is ${String(row.consumed_reason)}, expected sent`;
      return null;
    },
  },
  {
    // Lane M1 (0039): production's held meetings all came from Cal.com's scheduled end, and
    // the base's fixture writes no meeting at all. A held meeting with its meeting.held fact,
    // and a no-show that remembers held, in schema 38's columns, so the run meets the rows the
    // correction rewrites: held → ended, the remembered held → ended, the fact withdrawn.
    name: 'held meetings and their meeting.held fact (0039 corrects them)',
    fromVersions: [38],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `WITH firm AS (
           SELECT workspace_id, id FROM firms WHERE status = 'active' ORDER BY created_at, id LIMIT 1
         ), held AS (
           INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
           SELECT workspace_id, 'upgrade0039held', 'upgrade0039held', id, 'held',
                  TIMESTAMPTZ '2026-09-29 15:00:00+00', TIMESTAMPTZ '2026-09-29 15:30:00+00', TIMESTAMPTZ '2026-09-29 15:30:00+00'
             FROM firm
           RETURNING workspace_id, id, firm_id
         ), absent AS (
           INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, state_before_no_show, starts_at, ends_at, last_event_at)
           SELECT workspace_id, 'upgrade0039absent', 'upgrade0039absent', id, 'no_show', 'held',
                  TIMESTAMPTZ '2026-09-28 15:00:00+00', TIMESTAMPTZ '2026-09-28 15:30:00+00', TIMESTAMPTZ '2026-09-28 16:00:00+00'
             FROM firm
           RETURNING id
         ), aliased AS (
           INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id)
           SELECT workspace_id, 'upgrade0039held', id FROM held
           RETURNING meeting_id
         ), fact AS (
           INSERT INTO funnel_facts (workspace_id, kind, firm_id, dedupe_key, source, actor_kind, occurred_at)
           SELECT workspace_id, 'meeting.held', firm_id, 'upgrade0039held', 'calendar', 'system', TIMESTAMPTZ '2026-09-29 15:31:00+00'
             FROM held
           RETURNING id
         )
         SELECT held.id FROM held, absent, aliased, fact`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no active firm to hang a held meeting on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<{
        booking_uid: string;
        state: string;
        state_before_no_show: string | null;
        attendance_source: string | null;
        calcom_absent_pending: boolean;
      }>(
        `SELECT booking_uid, state, state_before_no_show, attendance_source, calcom_absent_pending FROM meetings
          WHERE booking_uid IN ('upgrade0039held', 'upgrade0039absent') ORDER BY booking_uid`,
      );
      const absent = rows.find(row => row.booking_uid === 'upgrade0039absent');
      const held = rows.find(row => row.booking_uid === 'upgrade0039held');
      if (held === undefined || absent === undefined) return 'a seeded meeting is gone';
      if (held.state !== 'ended') return `the held meeting is ${held.state}, expected ended`;
      if (absent.state !== 'no_show' || absent.state_before_no_show !== 'ended') return `the no-show is ${absent.state} remembering ${String(absent.state_before_no_show)}`;
      if (absent.attendance_source !== 'calcom_no_show') return `the no-show's source is ${String(absent.attendance_source)}`;
      // 0039's new column: no stored meeting has a deferred Cal.com absence.
      if (held.calcom_absent_pending || absent.calcom_absent_pending) return 'a migrated meeting holds a deferred Cal.com absence';
      const facts = await session.query<{ withdrawn_reason: string | null; occurred_at: Date }>(
        "SELECT withdrawn_reason, occurred_at FROM funnel_facts WHERE kind = 'meeting.held' AND dedupe_key = 'upgrade0039held'",
      );
      const fact = facts.rows[0];
      if (fact === undefined) return 'the meeting.held fact is gone';
      if (fact.withdrawn_reason !== 'scheduled_end_not_attendance') return `the fact's withdrawal is ${String(fact.withdrawn_reason)}`;
      if (fact.occurred_at.toISOString() !== '2026-09-29T15:00:00.000Z') return `the fact is dated ${fact.occurred_at.toISOString()}, not the meeting's start`;
      const meeting = await session.query('SELECT 1 FROM meetings WHERE id = $1', [seededId]);
      return meeting.rows.length === 1 ? null : 'the seeded meeting id no longer resolves';
    },
  },
  {
    // Lane M2 (0040): a meeting stored at 39 has no booking details; the migration adds the
    // columns empty and rewrites nothing.
    name: 'a meeting at 39 gains empty booking details (0040)',
    fromVersions: [39],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
         SELECT workspace_id, 'upgrade0040booked', 'upgrade0040booked', id, 'booked',
                TIMESTAMPTZ '2026-10-08 15:00:00+00', TIMESTAMPTZ '2026-10-08 15:30:00+00', TIMESTAMPTZ '2026-10-01 12:00:00+00'
           FROM firms WHERE status = 'active' ORDER BY created_at, id LIMIT 1
         RETURNING id`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no active firm to hang a meeting on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<Record<string, unknown>>(
        `SELECT state, event_title, attendee_name, booking_notes, booking_answers, location_type, video_call_url, zoom_meeting_id
           FROM meetings WHERE id = $1`,
        [seededId],
      );
      const row = rows[0];
      if (row === undefined) return 'the seeded meeting is gone';
      if (row['state'] !== 'booked') return `the meeting is ${String(row['state'])}, expected booked`;
      const filled = Object.entries(row).filter(([column, value]) => column !== 'state' && value !== null);
      return filled.length === 0 ? null : `0040 filled ${filled.map(([column]) => column).join(', ')}`;
    },
  },
]);

export function seedsFor(fromVersion: number): readonly HeadSeed[] {
  return HEAD_SEEDS.filter(seed => seed.fromVersions.includes(fromVersion));
}
