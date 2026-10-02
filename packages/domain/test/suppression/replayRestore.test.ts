import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordAdminSupersession, recordSuppression } from '../../suppression/events.ts';
import {
  deterministicEventId,
  recordingSuppressionJournal,
  type RecordingSuppressionJournal,
  type SuppressionJournalRecord,
} from '../../suppression/journal.ts';
import { replaySuppressionJournal } from '../../suppression/replay.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedChannelFirm, type ChannelFirm } from './support/channelWorld.ts';

/**
 * RC2 (brief RF): a restore replay of a journal holding
 *
 *   (a) R1's two objects: two admin supersessions of one stop, only one of which the
 *       database ever accepted (the other is the journal object the pre-RF code wrote for
 *       the loser of the race);
 *   (b) a lift enumerated before the stop it lifts; and
 *   (c) a fresh admin supersession of a manual stop still inside its ten-minute window,
 *
 * completes, leaves the workspace exactly as the live history left it, and leaves no
 * review hold. The "restore" deletes the rows the replay must put back, as superuser, the
 * way a point-in-time restore to before them would leave the database.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});

afterAll(async () => {
  await database.drop();
});

const as = (actor: 'salesperson' | 'admin' | 'restore'): RepositoryContext => {
  const workspace = seeded.alpha;
  const scope =
    actor === 'restore'
      ? workspaceScope(workspace.workspaceId, { kind: 'system', component: 'migration' })
      : workspaceScope(workspace.workspaceId, {
          kind: 'user',
          userId: actor === 'admin' ? workspace.admin.userId : workspace.salesperson.userId,
          role: actor,
        });
  return repositoryContext(scope, database.session);
};

async function stop(
  journal: RecordingSuppressionJournal,
  firm: ChannelFirm,
  source: 'prospect_do_not_call' | 'salesperson_manual',
  channel: 'phone' | 'all',
): Promise<string> {
  const recorded = await withTransaction(database.session, async () =>
    await recordSuppression(as('salesperson'), { scope: 'firm', firmId: firm.firmId, source, channel, commandId: randomUUID(), journal }),
  );
  if (!recorded.ok) throw new Error(recorded.reason);
  return recorded.value.eventId;
}

async function lift(journal: RecordingSuppressionJournal, eventId: string): Promise<string> {
  const lifted = await withTransaction(database.session, async () =>
    await recordAdminSupersession(as('admin'), { eventId, reason: 'correction', commandId: randomUUID() }),
  );
  if (!lifted.ok) throw new Error(lifted.reason);
  // Journalled after the commit, as the API route does (brief RF).
  await journal.append(lifted.value.journalRecord);
  return lifted.value.supersessionEventId;
}

/** Everything a replay writes, for the firms in play: rows, the effective set, holds, claims, jobs. */
async function stateOf(keys: readonly string[]): Promise<unknown> {
  const workspaceId = seeded.alpha.workspaceId;
  const events = await database.session.query(
    `SELECT event_id, scope, canonical_key, source, supersedes_event_id, supersession_reason, channel,
            to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS recorded_at
       FROM suppression_events WHERE workspace_id = $1 AND canonical_key = ANY($2::text[]) ORDER BY event_id`,
    [workspaceId, keys],
  );
  const ids = events.rows.map(row => String(row['event_id']));
  const effective = await database.session.query(
    'SELECT event_id FROM effective_suppressions WHERE workspace_id = $1 AND canonical_key = ANY($2::text[]) ORDER BY event_id',
    [workspaceId, keys],
  );
  const holds = await database.session.query(
    `SELECT source_event_id, reason_code FROM active_holds
      WHERE workspace_id = $1 AND released_at IS NULL AND (scope_key = ANY($2::text[]) OR source_event_id = ANY($3::text[]))
      ORDER BY source_event_id`,
    [workspaceId, keys, ids],
  );
  const claims = await database.session.query(
    'SELECT event_id, outcome FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = ANY($2::text[]) ORDER BY event_id',
    [workspaceId, ids],
  );
  const jobs = await database.session.query(
    `SELECT payload->>'eventId' AS event_id FROM jobs
      WHERE workspace_id = $1 AND kind = 'suppression.finalize' AND payload->>'eventId' = ANY($2::text[]) ORDER BY 1`,
    [workspaceId, ids],
  );
  return { events: events.rows, effective: effective.rows, holds: holds.rows, claims: claims.rows, jobs: jobs.rows };
}

/** A restore to before these events: every row a replay must put back is gone. */
async function lose(keys: readonly string[]): Promise<void> {
  const workspaceId = seeded.alpha.workspaceId;
  const { rows } = await database.session.query<{ event_id: string }>(
    'SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND canonical_key = ANY($2::text[])',
    [workspaceId, keys],
  );
  const ids = rows.map(row => row.event_id);
  await database.session.query(
    `DELETE FROM jobs WHERE workspace_id = $1 AND kind = 'suppression.finalize' AND payload->>'eventId' = ANY($2::text[])`,
    [workspaceId, ids],
  );
  await database.session.query('DELETE FROM active_holds WHERE workspace_id = $1 AND source_event_id = ANY($2::text[])', [workspaceId, ids]);
  await database.session.query('DELETE FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = ANY($2::text[])', [
    workspaceId,
    ids,
  ]);
  await database.session.query(
    'DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = ANY($2::text[]) AND supersedes_event_id IS NOT NULL',
    [workspaceId, ids],
  );
  await database.session.query('DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = ANY($2::text[])', [workspaceId, ids]);
}

/** The journal object the pre-RF code left for the loser of R1's race: never in the database. */
function losingSupersession(winner: SuppressionJournalRecord, offsetMilliseconds: number): SuppressionJournalRecord {
  const commandId = randomUUID();
  return {
    ...winner,
    eventId: deterministicEventId({
      workspaceId: winner.workspaceId,
      scope: winner.scope,
      canonicalKey: winner.canonicalKey,
      source: 'admin_supersession',
      commandId,
      supersedesEventId: winner.supersedesEventId ?? '',
      channel: winner.channel,
    }),
    commandId,
    recordedAt: new Date(Date.parse(winner.recordedAt) + offsetMilliseconds).toISOString(),
  };
}

describe('RC2: a restore replay of competing, out-of-order and fresh supersessions', () => {
  it('completes, ends exactly where the live history ended, and leaves no review hold', async () => {
    const journal = recordingSuppressionJournal();
    const [one, two, three] = [
      await seedChannelFirm(database.session, seeded.alpha),
      await seedChannelFirm(database.session, seeded.alpha),
      await seedChannelFirm(database.session, seeded.alpha),
    ];
    // (a) a stop, lifted; the journal also holds the race's losing lift.
    const stopOne = await stop(journal, one, 'prospect_do_not_call', 'phone');
    const liftOne = await lift(journal, stopOne);
    // (b) a stop and its lift.
    const stopTwo = await stop(journal, two, 'prospect_do_not_call', 'all');
    const liftTwo = await lift(journal, stopTwo);
    // (c) a manual stop inside its window, lifted at once: the live lift released its hold.
    const stopThree = await stop(journal, three, 'salesperson_manual', 'all');
    const liftThree = await lift(journal, stopThree);

    const keys = [one.firmId, two.firmId, three.firmId];
    const live = await stateOf(keys);
    expect((live as { holds: unknown[] }).holds).toEqual([]);

    const byId = new Map(journal.appended.map(record => [record.eventId, record] as const));
    const winner = byId.get(liftOne);
    if (winner === undefined) throw new Error('the live lift was not journalled');
    const loser = losingSupersession(winner, 1000);

    await lose(keys);

    // Enumerated adversarially: lifts before their stops, the loser before the winner.
    const records = [liftTwo, loser.eventId, liftOne, liftThree, stopTwo, stopOne, stopThree].map(id =>
      id === loser.eventId ? loser : byId.get(id)!,
    );
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(as('restore'), { records }));

    expect(await stateOf(keys)).toEqual(live);
    expect(report).toMatchObject({ inserted: 6, competingSupersessions: [loser.eventId] });
  });
});
