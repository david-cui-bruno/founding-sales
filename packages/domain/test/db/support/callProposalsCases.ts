import { callSession, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0036 adds (`call_tasks` and
 * `active_holds_one_pending_review`, slice 3a lane B). Each case breaks exactly one
 * constraint, inside the transaction the caller rolls back. `call_logs_agreement_needs_interest`
 * (swapped under its own name, now any reached outcome) has its case beside the other agreement
 * cases (`followUpCases.ts`).
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

type Row = Readonly<Record<string, unknown>>;

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000036a1';
const KEY = 'task:0123456789abcdef';

/** A valid open task on a call session of its own, with `overrides` on top. */
async function task(f: Fixture, overrides: Row = {}, sessionId?: string): Promise<unknown> {
  const session = sessionId ?? (await callSession(f));
  const { rows } = await f.session.query<{ firm_id: string; contact_id: string | null }>(
    'SELECT firm_id, contact_id FROM call_sessions WHERE id = $1',
    [session],
  );
  const all: Record<string, unknown> = {
    workspace_id: f.seeded.alpha.workspaceId,
    firm_id: rows[0]?.firm_id,
    contact_id: rows[0]?.contact_id ?? null,
    call_session_id: session,
    quote_key: KEY,
    text: 'Send the pricing sheet',
    due_at: '2026-10-02T15:00:00Z',
    created_by_user_id: f.seeded.alpha.salesperson.userId,
    ...overrides,
  };
  const names = Object.keys(all);
  return await f.session.query(
    `INSERT INTO call_tasks (${names.join(', ')}) VALUES (${names.map((_name, index) => `$${String(index + 1)}`).join(', ')})`,
    names.map(name => all[name]),
  );
}

export const CALL_PROPOSALS_CONSTRAINT_CASES: readonly Case[] = [
  {
    constraint: 'call_tasks_pkey',
    run: async f => {
      const id = '00000000-0000-4000-8000-0000000036b1';
      await task(f, { id });
      return await task(f, { id });
    },
  },
  {
    // One spoken promise, one task per call.
    constraint: 'call_tasks_one_per_quote',
    run: async f => {
      const sessionId = await callSession(f);
      await task(f, {}, sessionId);
      return await task(f, {}, sessionId);
    },
  },
  { constraint: 'call_tasks_firm_fkey', run: async f => await task(f, { firm_id: ABSENT, contact_id: null }) },
  {
    // A task at one firm naming a person at another.
    constraint: 'call_tasks_contact_fkey',
    run: async f => await task(f, { contact_id: f.crm.alpha.contactId }),
  },
  { constraint: 'call_tasks_session_fkey', run: async f => await task(f, { call_session_id: ABSENT }) },
  { constraint: 'call_tasks_creator_fkey', run: async f => await task(f, { created_by_user_id: ABSENT }) },
  { constraint: 'call_tasks_quote_key_shape', run: async f => await task(f, { quote_key: 'task:SEND-PRICING' }) },
  { constraint: 'call_tasks_text_present', run: async f => await task(f, { text: '   ' }) },
  { constraint: 'call_tasks_status_known', run: async f => await task(f, { status: 'someday' }) },
  { constraint: 'call_tasks_completion_consistent', run: async f => await task(f, { status: 'done' }) },
  {
    constraint: 'call_tasks_updated_not_before_created',
    run: async f => await task(f, { created_at: '2026-10-02T15:00:00Z', updated_at: '2026-10-01T15:00:00Z' }),
  },
  {
    // A session's pending-review hold, ever: a second one — even after the first was
    // released — is refused, so a released hold is never reopened.
    constraint: 'active_holds_one_pending_review',
    run: async f => {
      const sessionId = await callSession(f);
      const insert = async (released: boolean): Promise<unknown> =>
        await f.session.query(
          `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                                     source_event_kind, source_event_id, recovery_action, released_at)
           VALUES ($1, 'firm', 'firm-1', 'scoped_pause', ARRAY['email_send'], 'call_analysis_pending', $2, 'review_call',
                   CASE WHEN $3 THEN now() ELSE NULL END)`,
          [f.seeded.alpha.workspaceId, sessionId, released],
        );
      await insert(true);
      return await insert(false);
    },
  },
];
