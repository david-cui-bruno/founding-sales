import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { receiveCalcomEvent } from '@fss/domain/meetings/calcom.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * `fss admin meetings attendance-report` on real PostgreSQL (lane M1): what the attendance
 * correction will change, as counts. Synthetic throughout (`example.test`), and built through
 * the real Cal.com path (`receiveCalcomEvent`), so the meetings, facts, deliveries and stage
 * evidence are the rows production has, not rows this file imagined.
 *
 * Alpha:
 *   * A (Alder): booked → opens Alder's opportunity at Demo booked; ended in the past → held.
 *   * B (Birch, which has an opportunity in Interested): booked → moves it; ended → held;
 *     then a no-show → no_show remembering held.
 *   * C (Alder again): booked (Alder is already at Demo booked: no evidence); ended while its
 *     end is still in the future → held, ending in the future.
 *   * D (an unmatched domain): booked, then cancelled.
 *   * E (Cedar): booked → opens Cedar's opportunity; nothing more.
 * Beta: one held meeting that must not be counted.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let url = '';

const PAST = { startTime: '2025-06-02T15:00:00.000Z', endTime: '2025-06-02T15:30:00.000Z' };
const FUTURE = { startTime: '2099-06-02T15:00:00.000Z', endTime: '2099-06-02T15:30:00.000Z' };

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv, { DATABASE_URL: url }), stdout: printed.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

let minute = 0;
async function deliver(workspaceId: string, trigger: string, uid: string, domain: string, times: typeof PAST, extra: Record<string, unknown> = {}): Promise<void> {
  minute += 1;
  const createdAt = new Date(Date.UTC(2025, 4, 1, 12, minute)).toISOString();
  const body = {
    triggerEvent: trigger,
    createdAt,
    payload: {
      uid,
      ...times,
      organizer: { email: 'host@callie.example.test' },
      attendees: [{ email: `partner@${domain}`, name: 'A Partner' }],
      ...extra,
    },
  };
  await withTransaction(database.session, async () =>
    await receiveCalcomEvent(database.session, { workspaceId, rawBody: Buffer.from(JSON.stringify(body)), body }),
  );
}

async function firm(workspaceId: string, name: string, domain: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name, website) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, name, `https://www.${domain}/`],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the firm insert returned no row');
  return id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();
  seeded = await seedTwoWorkspaces(database.session);
  const alpha = seeded.alpha.workspaceId;
  const beta = seeded.beta.workspaceId;

  await firm(alpha, 'Synthetic Alder Test Co', 'alder.example.test');
  const birch = await firm(alpha, 'Synthetic Birch Test Co', 'birch.example.test');
  await firm(alpha, 'Synthetic Cedar Test Co', 'cedar.example.test');
  await database.session.query(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     SELECT $1, $2, id, now() FROM pipeline_stages WHERE workspace_id = $1 AND key = 'new'`,
    [alpha, birch],
  );
  await firm(beta, 'Synthetic Beta Test Co', 'beta.example.test');

  await deliver(alpha, 'BOOKING_CREATED', 'synA', 'alder.example.test', PAST);
  await deliver(alpha, 'MEETING_ENDED', 'synA', 'alder.example.test', PAST);
  await deliver(alpha, 'BOOKING_CREATED', 'synB', 'birch.example.test', PAST);
  await deliver(alpha, 'MEETING_ENDED', 'synB', 'birch.example.test', PAST);
  await deliver(alpha, 'BOOKING_NO_SHOW_UPDATED', 'synB', 'birch.example.test', PAST, { noShowHost: false, attendees: [{ email: 'partner@birch.example.test', name: 'A Partner', noShow: true }] });
  await deliver(alpha, 'BOOKING_CREATED', 'synC', 'alder.example.test', FUTURE);
  await deliver(alpha, 'MEETING_ENDED', 'synC', 'alder.example.test', FUTURE);
  await deliver(alpha, 'BOOKING_CREATED', 'synD', 'unknown.example.test', FUTURE);
  await deliver(alpha, 'BOOKING_CANCELLED', 'synD', 'unknown.example.test', FUTURE);
  await deliver(alpha, 'BOOKING_CREATED', 'synE', 'cedar.example.test', FUTURE);
  await deliver(beta, 'BOOKING_CREATED', 'synZ', 'beta.example.test', PAST);
  await deliver(beta, 'MEETING_ENDED', 'synZ', 'beta.example.test', PAST);
});

afterAll(async () => {
  await database.drop();
});

describe('fss admin meetings attendance-report', () => {
  it('is a parseable database-only command that needs the workspace id', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(parseFssCommand(['admin', 'meetings', 'attendance-report', '--workspace-id', id])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'meetings', 'attendance-report'])).toMatchObject({ ok: false, reason: 'flag_missing' });
    expect(COMMAND_DEPENDENCIES['meetings attendance-report']).toBe('database');
  });

  it('the fixture is what the report is meant to count', async () => {
    // A guard on the fixture itself: if the Cal.com path stops producing these rows, the
    // expectations below would be testing nothing.
    const { rows } = await database.session.query<{ booking_uid: string; state: string; state_before_no_show: string | null }>(
      'SELECT booking_uid, state, state_before_no_show FROM meetings WHERE workspace_id = $1 ORDER BY booking_uid',
      [seeded.alpha.workspaceId],
    );
    expect(rows).toEqual([
      { booking_uid: 'synA', state: 'held', state_before_no_show: null },
      { booking_uid: 'synB', state: 'no_show', state_before_no_show: 'held' },
      { booking_uid: 'synC', state: 'held', state_before_no_show: null },
      { booking_uid: 'synD', state: 'cancelled', state_before_no_show: null },
      { booking_uid: 'synE', state: 'booked', state_before_no_show: null },
    ]);
  });

  it('prints one line of counts, for the named workspace only, and nothing that names a meeting or a person', async () => {
    const alpha = seeded.alpha.workspaceId;
    const before = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events');
    const { code, stdout } = await run(['admin', 'meetings', 'attendance-report', '--workspace-id', alpha]);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      meetingsByState: { booked: 1, rescheduled: 0, cancelled: 1, held: 2, no_show: 1 },
      heldEndedInPast: 1,
      heldEndingInFuture: 1,
      noShowBeforeHeld: 1,
      // A, B and C each reached held once.
      meetingHeldFacts: 3,
      // A, B, C and E were matched bookings; D never matched a firm.
      meetingBookedFacts: 4,
      calcomMeetingEndedApplied: 3,
      // A opened Alder's, B moved Birch's, E opened Cedar's; C found Alder already there.
      meetingsWithBookedEvidence: 3,
      opportunitiesOpenedByBookedEvidence: 2,
      opportunitiesMovedByBookedEvidence: 1,
      opportunitiesOpenedByBookedEvidenceAudited: 2,
    });
    // Log hygiene: no workspace id, booking uid, address, name or domain.
    for (const forbidden of [alpha, 'synA', 'partner', 'Synthetic', 'example.test']) expect(stdout).not.toContain(forbidden);
    // Read only.
    const after = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('counts the other workspace on its own', async () => {
    const { code, stdout } = await run(['admin', 'meetings', 'attendance-report', '--workspace-id', seeded.beta.workspaceId]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      meetingsByState: { booked: 0, rescheduled: 0, cancelled: 0, held: 1, no_show: 0 },
      heldEndedInPast: 1,
      meetingHeldFacts: 1,
      calcomMeetingEndedApplied: 1,
      opportunitiesOpenedByBookedEvidence: 1,
    });
  });

  it('refuses a malformed id and a workspace that does not exist, printing nothing', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const { code, stdout } = await run(['admin', 'meetings', 'attendance-report', '--workspace-id', id]);
      expect(code, id).not.toBe(0);
      expect(stdout).toBe('');
    }
  });
});
