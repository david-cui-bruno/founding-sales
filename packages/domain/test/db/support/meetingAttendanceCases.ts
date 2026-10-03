import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0039 adds (lane M1): the attendance columns
 * on `meetings` and the withdrawal marker on `funnel_facts`. Each case breaks exactly one
 * constraint, inside the transaction the caller rolls back. No real person: the meeting
 * helper's addresses are `.example`.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000039a1';
const CONFIRMED_AT = '2026-10-05T16:00:00Z';

async function fact(f: Fixture, withdrawnAt: string | null, withdrawnReason: string | null): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO funnel_facts (workspace_id, kind, firm_id, dedupe_key, source, actor_kind, withdrawn_at, withdrawn_reason)
     VALUES ($1, 'meeting.held', $2, $3, 'calendar', 'system', $4::timestamptz, $5)`,
    [f.seeded.alpha.workspaceId, f.crm.alpha.firmId, `case-0039-${String(Date.now())}`, withdrawnAt, withdrawnReason],
  );
}

export const MEETING_ATTENDANCE_CONSTRAINT_CASES: readonly Case[] = [
  // Held with no source: a confirmation nobody made.
  { constraint: 'meetings_attendance_confirmed', run: async f => await meeting(f, { state: 'held' }) },
  // A person's confirmation that names nobody.
  {
    constraint: 'meetings_attendance_confirmer',
    run: async f => await meeting(f, { state: 'held', attendance_source: 'manual', attendance_confirmed_at: CONFIRMED_AT }),
  },
  // A person's confirmation by somebody who is not a member of the workspace.
  {
    constraint: 'meetings_attendance_confirmer_fkey',
    run: async f =>
      await meeting(f, { state: 'held', attendance_source: 'manual', attendance_confirmed_at: CONFIRMED_AT, attendance_confirmed_by: ABSENT }),
  },
  // A deferred Cal.com absence on a cancelled meeting: only an unconfirmed, live one waits.
  { constraint: 'meetings_absent_pending_unconfirmed', run: async f => await meeting(f, { state: 'cancelled', calcom_absent_pending: true }) },
  // Withdrawn, with no reason.
  { constraint: 'funnel_facts_withdrawal_consistent', run: async f => await fact(f, CONFIRMED_AT, null) },
  // A reason that is a sentence rather than a code.
  { constraint: 'funnel_facts_withdrawn_reason_shape', run: async f => await fact(f, CONFIRMED_AT, 'Scheduled end') },
];
