import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0029 adds (`meeting_booking_uids`,
 * Cal.com slice M1). Each case breaks exactly one constraint, inside the transaction the
 * caller rolls back.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

const workspace = (f: Fixture): string => f.seeded.alpha.workspaceId;
/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000029a1';

let sequence = 0;
const nextUid = (): string => {
  sequence += 1;
  return `aliascase${String(sequence)}`;
};

/** An unmatched meeting of its own, to alias. */
async function meeting(f: Fixture): Promise<string> {
  const uid = nextUid();
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, state, starts_at, ends_at, last_event_at)
     VALUES ($1, $2, $2, 'booked', '2026-10-05T15:00:00Z', '2026-10-05T15:30:00Z', '2026-09-30T12:00:00Z')
     RETURNING id`,
    [workspace(f), uid],
  );
  return rows[0]?.id ?? '';
}

async function alias(f: Fixture, input: { readonly uid?: string; readonly meetingId?: string } = {}): Promise<unknown> {
  return await f.session.query('INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id) VALUES ($1, $2, $3)', [
    workspace(f),
    input.uid ?? nextUid(),
    input.meetingId ?? (await meeting(f)),
  ]);
}

export const MEETING_BOOKING_UIDS_CONSTRAINT_CASES: readonly Case[] = [
  {
    // One uid, two meetings.
    constraint: 'meeting_booking_uids_pkey',
    run: async f => {
      const uid = nextUid();
      await alias(f, { uid });
      return await alias(f, { uid });
    },
  },
  { constraint: 'meeting_booking_uids_meeting_fkey', run: async f => await alias(f, { meetingId: ABSENT }) },
  { constraint: 'meeting_booking_uids_uid_shape', run: async f => await alias(f, { uid: 'not a uid' }) },
];
