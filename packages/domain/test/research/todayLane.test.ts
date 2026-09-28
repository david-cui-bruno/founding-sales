import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { buildTodaySnapshot, newFirmSource } from '../../today/build.ts';
import { readTodayFirm, readTodayList, todayFirmVersion1 } from '../../today/dto.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { TODAY_ALGORITHM_VERSION } from '../../today/types.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Lane 4's order, and the brief on the expanded card.
 *
 * The three firms below are created oldest first and the *middle* one is the one
 * research says to call first, so a list that simply kept the creation order and a
 * list that simply reversed it both fail. That is the vacuous-pass trap this lane's
 * ordering could otherwise walk into.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

async function firm(name: string, createdAt: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz) RETURNING id`,
    [seeded.alpha.workspaceId, name, seeded.alpha.salesperson.userId, createdAt],
  );
  return rows[0]?.id ?? '';
}

async function judge(firmId: string, callFirst: boolean): Promise<string> {
  const run = await database.session.query<{ id: string }>(
    `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome, brief)
     VALUES ($1, $2, 1, 'sweep', now(), 'completed',
             '{"questions":["How do you take work orders?","Who handles them?"],"opening":"Hello","generated":true}'::jsonb)
     RETURNING id`,
    [seeded.alpha.workspaceId, firmId],
  );
  const runId = run.rows[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO firm_judgments (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, call_first)
     VALUES ($1, $2, $3, $4, 'unknown', 'unknown', $5, $6)`,
    [seeded.alpha.workspaceId, firmId, runId, callFirst ? 'yes' : 'unknown', callFirst ? 'yes' : 'unknown', callFirst],
  );
  return runId;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});

afterAll(async () => {
  await database.drop();
});

describe('lane 4 puts the call-first firms in front', () => {
  it('orders call_first first and the rest after, each group oldest first', async () => {
    const oldest = await firm('Oldest, not researched', '2026-09-01T12:00:00Z');
    const middle = await firm('Middle, call first', '2026-09-02T12:00:00Z');
    const newest = await firm('Newest, researched but not a fit', '2026-09-03T12:00:00Z');
    const alsoCallFirst = await firm('Newest of all, call first', '2026-09-04T12:00:00Z');
    await judge(middle, true);
    await judge(newest, false);
    await judge(alsoCallFirst, true);

    const context = worker();
    const now = await databaseNow(context);
    const businessDate = await businessDateOf(context, now);
    await buildTodaySnapshot(context, { businessDate, now, sources: [newFirmSource()] });

    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    const list = await readTodayList(salesperson, { now });
    expect(list.cards.map(card => card.firmId)).toEqual([middle, alsoCallFirst, oldest, newest]);
  });

  it('is `today.2`, on both sides of the seam', async () => {
    const { rows } = await database.session.query<{ version: string }>('SELECT today_algorithm_version() AS version');
    expect(TODAY_ALGORITHM_VERSION).toBe('today.2');
    expect(rows[0]?.version).toBe(TODAY_ALGORITHM_VERSION);
  });
});

describe('the brief on the expanded card', () => {
  it('is on card version 2 and absent from card version 1', async () => {
    const researched = await firm('Researched firm', '2026-09-05T12:00:00Z');
    await judge(researched, true);
    const context = worker();
    const now = await databaseNow(context);
    const businessDate = await businessDateOf(context, now);
    await buildTodaySnapshot(context, { businessDate, now, sources: [newFirmSource()] });

    const page = await readTodayFirm(context, { firmId: researched, now });
    expect(page?.brief?.judgments.fit).toBe('yes');
    expect(page?.brief?.generated).toBe(true);
    expect(page?.brief?.questions).toEqual(['How do you take work orders?', 'Who handles them?']);

    // An installed desktop that asked for version 1 gets the card it always parsed.
    expect(page === null ? null : 'brief' in todayFirmVersion1(page)).toBe(false);
  });

  it('is null for a firm nobody has researched', async () => {
    const plain = await firm('Never researched', '2026-09-06T12:00:00Z');
    const context = worker();
    const now = await databaseNow(context);
    const businessDate = await businessDateOf(context, now);
    await buildTodaySnapshot(context, { businessDate, now, sources: [newFirmSource()] });
    expect((await readTodayFirm(context, { firmId: plain, now }))?.brief).toBeNull();
  });
});
