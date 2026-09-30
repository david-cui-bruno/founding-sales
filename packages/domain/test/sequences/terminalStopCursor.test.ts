import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { consumeTerminalStops } from '../../sequences/terminalStops.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Two first drains of one workspace (review of PR 335, round 2, P2).
 *
 * With no cursor row there was nothing to lock: two drains read from nothing, each took
 * a different batch, and the unconditional upsert let the one that committed last — the
 * older batch — set the cursor back. The drain now takes the send gate, inserts-or-locks
 * the cursor row before it reads, and only ever moves the cursor forward.
 */
let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
const eventIds: string[] = [];

const workerOn = (session: SessionQueryable): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  for (const index of [1, 2, 3]) {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO crm_domain_events
         (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind, occurred_at, owed_enrollment_ids)
       VALUES ($1, 'opportunity.manual_mode', $2, $3, $4, 'system', now() + make_interval(secs => $5), '{}')
       RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.opportunityId, `cursor-${String(index)}`, index],
    );
    eventIds.push(rows[0]?.id ?? '');
  }
});

afterAll(async () => {
  await database.drop();
});

describe('the terminal-stop cursor', () => {
  it('never moves back when two first drains overlap', async () => {
    const { rows: before } = await database.session.query('SELECT 1 FROM sequence_event_cursors WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);
    expect(before).toHaveLength(0);

    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    await first.query('BEGIN');
    await second.query('BEGIN');
    const firstReport = await consumeTerminalStops(workerOn(first), { limit: 1 });
    expect(firstReport.eventsConsumed).toBe(1);
    const pidOf = async (session: SessionQueryable): Promise<number> => {
      const { rows: pidRows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = pidRows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      return pid;
    };
    const firstPid = await pidOf(first);
    const secondPid = await pidOf(second);
    let secondDone = false;
    const secondDrain = consumeTerminalStops(workerOn(second), { limit: 2 }).finally(() => {
      secondDone = true;
    });
    // No timer decides the branch. Session 2 is observed in one of exactly two states:
    // finished (nothing made it wait — the old drain), or blocked **by session 1** on a
    // statement the new drain runs **before it reads**: the send gate, or the cursor
    // row's insert-or-lock. Waiting on anything else, or on anyone else, is not accepted,
    // and neither state within the deadline fails the test (round 4 of the review).
    const PRE_READ_STATEMENTS = [
      /pg_advisory_xact_lock\(/u,
      /INSERT INTO sequence_event_cursors \(workspace_id, subscriber\) VALUES/u,
      /SELECT last_event_at, last_event_id FROM sequence_event_cursors/u,
    ];
    let secondWaiting = false;
    let lastSeen = 'nothing observed';
    const deadline = Date.now() + 10_000;
    while (!secondDone && !secondWaiting && Date.now() < deadline) {
      const { rows: activity } = await database.session.query<{ blocked_by_first: boolean; query: string }>(
        `SELECT $1::int = ANY(pg_blocking_pids(pid)) AS blocked_by_first, query
           FROM pg_stat_activity WHERE pid = $2`,
        [firstPid, secondPid],
      );
      const row = activity[0];
      if (row !== undefined) {
        lastSeen = `blocked by session 1: ${String(row.blocked_by_first)}; statement: ${row.query.slice(0, 120)}`;
        secondWaiting = row.blocked_by_first && PRE_READ_STATEMENTS.some(pattern => pattern.test(row.query));
      }
      if (!secondWaiting && !secondDone) await new Promise(resolve => setTimeout(resolve, 10));
    }
    try {
      expect(
        secondDone || secondWaiting,
        `session 2 was neither finished nor blocked by session 1 before its read (${lastSeen})`,
      ).toBe(true);
      if (secondDone) {
        // Nothing made the second drain wait: commit it first, and the older batch after.
        await secondDrain;
        await second.query('COMMIT');
        await first.query('COMMIT');
      } else {
        await first.query('COMMIT');
        await secondDrain;
        await second.query('COMMIT');
      }
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await secondDrain.catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
    }

    const { rows } = await database.session.query<{ last_event_id: string }>(
      `SELECT last_event_id FROM sequence_event_cursors WHERE workspace_id = $1 AND subscriber = 'sequences.terminal_stop'`,
      [seeded.alpha.workspaceId],
    );
    expect(rows).toEqual([{ last_event_id: eventIds[2] }]);
  });
});
