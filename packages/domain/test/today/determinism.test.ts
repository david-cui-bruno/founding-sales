import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { readTodayList } from '../../today/dto.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * The determinism property (8.2, and this lane's acceptance criterion).
 *
 * "Within a lane, ordering is due instant, firm name, and firm ID" and "two builds
 * from the same data identical". Building twice on one database proves the build is
 * idempotent; it does not prove the build is a *function of the data*, because the
 * second run sees the rows the first one wrote and could be agreeing with itself.
 *
 * So this test builds the same logical data twice on two databases, inserting the
 * firms and callbacks in a different order each time, and compares the lists. Rows
 * created in a different order have different ids and different `created_at`s, so the
 * comparison is over the part of the card that a person sees and that the
 * specification fixes: the sequence of firm names, their lanes, and their counts. An
 * ordering rule that quietly depended on insertion order — on a uuid, on a physical
 * row order, on a sort that was not total — would come out different.
 *
 * No real business name appears; `example.test` is reserved by RFC 6761.
 */

interface Firm {
  readonly name: string;
  /** Minutes past the business day's 08:00 for the callback, or null for no callback. */
  readonly callbackMinute: number | null;
}

/**
 * Eleven firms. Several share a callback instant, and two share a name, so the
 * tiebreaks after the due instant are exercised rather than assumed unnecessary.
 */
const FIRMS: readonly Firm[] = [
  { name: 'Alpha Test Holdings', callbackMinute: 120 },
  { name: 'Beta Test Holdings', callbackMinute: 120 },
  { name: 'Gamma Test Holdings', callbackMinute: 30 },
  { name: 'Delta Test Holdings', callbackMinute: null },
  { name: 'Epsilon Test Holdings', callbackMinute: 480 },
  { name: 'Zeta Test Holdings', callbackMinute: null },
  { name: 'Eta Test Holdings', callbackMinute: 30 },
  { name: 'Theta Test Holdings', callbackMinute: null },
  { name: 'Iota Test Holdings', callbackMinute: 240 },
  { name: 'Kappa Test Holdings', callbackMinute: null },
  // The same display name as the first one: the firm id is the last tiebreak, and it
  // is the only thing separating these two inside their lane.
  { name: 'Alpha Test Holdings', callbackMinute: 120 },
];

/** A tiny deterministic generator, so a failure is reproducible from its seed. */
function randoms(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const next = randoms(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const held = copy[index] as T;
    copy[index] = copy[swap] as T;
    copy[swap] = held;
  }
  return copy;
}

/** The part of the list the specification fixes, with nothing generated in it. */
interface Comparable {
  readonly name: string;
  readonly lane: string;
  readonly dueAt: string;
  readonly counts: Readonly<Record<string, number>>;
}

async function buildOnce(seed: number): Promise<{
  readonly list: readonly Comparable[];
  readonly drop: () => Promise<void>;
}> {
  const database = await createTestDatabase();
  const seeded = await seedTwoWorkspaces(database.session);
  const workspaceId = seeded.alpha.workspaceId;
  const userId = seeded.alpha.salesperson.userId;
  const admin: RepositoryContext = repositoryContext(
    workspaceScope(workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    database.session,
  );
  const now = await databaseNow(admin);
  const businessDate = await businessDateOf(admin, now);

  const dayStart = await database.session.query<{ at: Date }>(
    `SELECT (($2::date + TIME '08:00') AT TIME ZONE w.business_time_zone) AS at
       FROM workspaces w WHERE w.id = $1`,
    [workspaceId, businessDate],
  );
  const base = Date.parse((dayStart.rows[0]?.at ?? new Date()).toISOString());

  for (const firm of shuffled(FIRMS, seed)) {
    // A fixed creation instant per firm, from its place in FIRMS rather than from the
    // order it happens to be inserted in. The new-firm lane sorts on it, and it is
    // *data*: two databases holding the same firms hold the same creation instants,
    // however they were written.
    const createdAt = new Date(base - (FIRMS.indexOf(firm) + 1) * 86_400_000).toISOString();
    const created = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz) RETURNING id`,
      [workspaceId, firm.name, userId, createdAt],
    );
    const firmId = created.rows[0]?.id ?? '';
    if (firm.callbackMinute === null) continue;
    await database.session.query(
      `INSERT INTO callbacks
         (workspace_id, firm_id, assigned_user_id, requested_local_date, source_time_zone, due_at,
          confirmed_at, confirmed_by_user_id)
       VALUES ($1, $2, $3, $4::date, 'America/New_York', $5::timestamptz, now(), $3)`,
      [
        workspaceId,
        firmId,
        userId,
        businessDate,
        new Date(base + firm.callbackMinute * 60_000).toISOString(),
      ],
    );
  }

  await buildTodaySnapshot(
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session),
    { businessDate, now },
  );

  const read = await readTodayList(
    repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'salesperson' }), database.session),
    { now },
  );
  return {
    list: read.cards.map(card => ({
      name: card.firmName,
      lane: card.lane,
      // As an offset from the day's 08:00, so two databases built at different
      // instants are still comparable.
      dueAt: `${String(Math.round((Date.parse(card.dueAt) - base) / 60_000))}m`,
      counts: { ...card.counts },
    })),
    drop: async () => {
      await database.drop();
    },
  };
}

let first: Awaited<ReturnType<typeof buildOnce>>;
let second: Awaited<ReturnType<typeof buildOnce>>;

beforeAll(async () => {
  first = await buildOnce(11);
  second = await buildOnce(9_973);
}, 120_000);

afterAll(async () => {
  await first.drop();
  await second.drop();
});

describe('two builds of the same data', () => {
  it('produce the same list, whatever order the rows were created in', () => {
    expect(second.list).toEqual(first.list);
  });

  it('put every callback ahead of every new firm', () => {
    const lanes = first.list.map(card => card.lane);
    expect(lanes.indexOf('new_firm')).toBeGreaterThan(lanes.lastIndexOf('callback'));
  });

  it('order one lane by due instant', () => {
    const callbacks = first.list.filter(card => card.lane === 'callback').map(card => card.dueAt);
    expect(callbacks).toEqual(['30m', '30m', '120m', '120m', '120m', '240m', '480m']);
  });

  it('shows every firm exactly once', () => {
    expect(first.list).toHaveLength(FIRMS.length);
  });
});
