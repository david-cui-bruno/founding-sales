import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readCallsPlacedToday } from '../../today/callsPlaced.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * "Calls placed today" against a real PostgreSQL (specification 8.2; David, 29
 * September 2026).
 *
 * The number on Today is one business date's, and a business date is the workspace's own:
 * 23:59 in the workspace's evening and 00:01 the next morning are thirty-one minutes
 * apart and on two different days, and in UTC they are on the same one. So the boundary
 * is what is tested, twice — once from each side of it — and then again in a second zone
 * at the same instant, where the same three calls fall differently.
 *
 * Every instant is computed by PostgreSQL from a local date and time, so no offset is
 * written down by hand and no test needs editing when a rule changes.
 *
 * The workspaces, firms and people are fictional; `example.test` is reserved by RFC 6761.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
/** A firm in alpha that nobody is assigned, so 8.2's audience rule has something to cut. */
let unassignedFirmId = '';

const NEW_YORK = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

/** `HH:MM:SS` on `date` in `zone`, as a UTC instant, computed by PostgreSQL. */
const localInstant = async (zone: string, date: string, time: string): Promise<string> => {
  const { rows } = await database.session.query<{ at: Date }>(
    'SELECT (($1::date + $2::time) AT TIME ZONE $3) AS at',
    [date, time, zone],
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('no instant');
  return at.toISOString();
};

const setZone = async (workspaceId: string, zone: string): Promise<void> => {
  await database.session.query('UPDATE workspaces SET business_time_zone = $2 WHERE id = $1', [workspaceId, zone]);
};

const logCall = async (input: {
  readonly workspaceId: string;
  readonly firmId: string;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): Promise<void> => {
  await database.session.query(
    `INSERT INTO call_logs (workspace_id, firm_id, outcome, step_effect, occurred_at, recorded_at, actor_user_id)
     VALUES ($1, $2, 'no_answer', 'none', $3::timestamptz, $3::timestamptz, $4)`,
    [input.workspaceId, input.firmId, input.occurredAt, input.actorUserId],
  );
};

const asAdmin = () =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    database.session,
  );

const asSalesperson = () =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  await setZone(seeded.alpha.workspaceId, NEW_YORK);
  await setZone(seeded.beta.workspaceId, NEW_YORK);

  const unassigned = await database.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, 'Aspen Test Wealth', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [seeded.alpha.workspaceId],
  );
  unassignedFirmId = unassigned.rows[0]?.id ?? '';

  // Three calls at alpha's assigned firm: the last minute of the 21st, the first of the
  // 22nd, and the middle of the 22nd's morning — all in New York's wall clock.
  for (const [date, time] of [
    ['2026-09-21', '23:59:00'],
    ['2026-09-22', '00:01:00'],
    ['2026-09-22', '09:30:00'],
  ] as const) {
    await logCall({
      workspaceId: seeded.alpha.workspaceId,
      firmId: crm.alpha.firmId,
      actorUserId: seeded.alpha.salesperson.userId,
      occurredAt: await localInstant(NEW_YORK, date, time),
    });
  }

  // One at the firm nobody is assigned, on the 22nd.
  await logCall({
    workspaceId: seeded.alpha.workspaceId,
    firmId: unassignedFirmId,
    actorUserId: seeded.alpha.admin.userId,
    occurredAt: await localInstant(NEW_YORK, '2026-09-22', '10:00:00'),
  });

  // And one in the other workspace, at the same hour, which is nobody's business here.
  await logCall({
    workspaceId: seeded.beta.workspaceId,
    firmId: crm.beta.firmId,
    actorUserId: seeded.beta.salesperson.userId,
    occurredAt: await localInstant(NEW_YORK, '2026-09-22', '10:30:00'),
  });
});

afterAll(async () => {
  await database.drop();
});

describe('the business date boundary', () => {
  it('counts the day the call happened on in the workspace’s zone, from either side of midnight', async () => {
    // 23:00 on the 21st: the 23:59 call is that day's, and the two on the 22nd are not —
    // although in UTC the 23:59 call is already the 22nd.
    const evening = await readCallsPlacedToday(asAdmin(), { now: await localInstant(NEW_YORK, '2026-09-21', '23:00:00') });
    expect(evening).toEqual({ businessDate: '2026-09-21', businessTimeZone: NEW_YORK, calls: 1 });

    // 00:30 on the 22nd, thirty-one minutes later: a new day, and the 23:59 call is not
    // in it. Three calls fall on the 22nd — two at the assigned firm and one at the firm
    // nobody is assigned.
    const midnight = await readCallsPlacedToday(asAdmin(), { now: await localInstant(NEW_YORK, '2026-09-22', '00:30:00') });
    expect(midnight).toEqual({ businessDate: '2026-09-22', businessTimeZone: NEW_YORK, calls: 3 });
  });

  it('is the workspace’s own zone, so the same instant is a different day elsewhere', async () => {
    const instant = await localInstant(NEW_YORK, '2026-09-22', '00:30:00');
    await setZone(seeded.alpha.workspaceId, TOKYO);
    try {
      // 00:30 in New York is 13:30 the same afternoon in Tokyo, so the local date is the
      // 22nd there too — but the calls move with it: the 23:59 one is 12:59 on the 22nd
      // in Tokyo and now counts, and the two after midnight in New York are the 22nd's
      // afternoon and evening there.
      const answer = await readCallsPlacedToday(asAdmin(), { now: instant });
      expect(answer.businessTimeZone).toBe(TOKYO);
      expect(answer.businessDate).toBe('2026-09-22');
      expect(answer.calls).toBe(4);
    } finally {
      await setZone(seeded.alpha.workspaceId, NEW_YORK);
    }
  });

  it('is zero on a date with no calls, rather than nothing at all', async () => {
    const quiet = await readCallsPlacedToday(asAdmin(), { now: await localInstant(NEW_YORK, '2026-09-25', '09:00:00') });
    expect(quiet).toEqual({ businessDate: '2026-09-25', businessTimeZone: NEW_YORK, calls: 0 });
  });
});

describe('who it counts for (8.2)', () => {
  it('gives an admin the workspace’s calls and a salesperson their own firms’', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-22', '12:00:00');
    expect((await readCallsPlacedToday(asAdmin(), { now })).calls).toBe(3);
    // The call at the firm nobody is assigned is not this salesperson's to be told about.
    expect((await readCallsPlacedToday(asSalesperson(), { now })).calls).toBe(2);
  });

  it('never counts another workspace’s calls', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-22', '12:00:00');
    const beta = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
    expect((await readCallsPlacedToday(beta, { now })).calls).toBe(1);
  });
});
