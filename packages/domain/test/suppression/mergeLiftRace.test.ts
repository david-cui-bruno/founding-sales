import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { withTransaction } from '../../db/queryable.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { recordAdminSupersession, recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedChannelFirm, userContext } from './support/channelWorld.ts';

/**
 * Review P2 of brief RF: an admin lift of a source firm's stop that commits while a merge
 * has read the source's stops and not yet committed.
 *
 * Without coordination the merge copies the stop it read (active) and the lift lifts only
 * the source's original, so the survivor stays stopped with no lift. The stop-history lock
 * (`lockSuppressionHistory`) makes the lift wait for the merge, and the lift then carries
 * itself onto the survivor's copy (`liftMergeCopies`). Driven on two real connections; the
 * wait is observed with `pg_blocking_pids`.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
const clients: pg.Client[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => undefined);
  await database.drop();
});

async function connection(): Promise<{ readonly session: SessionQueryable; readonly pid: number }> {
  const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
  url.pathname = `/${database.name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  client.on('error', () => undefined);
  await client.connect();
  clients.push(client);
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const session = {
    async query(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  } as unknown as SessionQueryable;
  return { session, pid: Number(rows[0]?.pid) };
}

async function blockedBehind(waiter: number, blocker: number): Promise<boolean> {
  const { rows } = await database.session.query<{ blocked: boolean }>('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [
    waiter,
    blocker,
  ]);
  return rows[0]?.blocked === true;
}

describe('an admin lift racing a firm merge', () => {
  it('waits for the merge, then lifts the survivor’s copy of the stop too', async () => {
    const source = await seedChannelFirm(database.session, seeded.alpha);
    const target = await seedChannelFirm(database.session, seeded.alpha);
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: source.firmId,
        source: 'prospect_do_not_call',
        channel: 'phone',
        commandId: randomUUID(),
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    const stopId = recorded.value.eventId;

    const merger = await connection();
    const lifter = await connection();
    // The merge has read and copied the source's stops, and has not committed.
    await merger.session.query('BEGIN');
    const merged = await mergeFirms(userContext(merger.session, seeded.alpha, 'admin'), { journal: recordingSuppressionJournal(),
      sourceFirmId: source.firmId,
      targetFirmId: target.firmId,
    });
    expect(merged.ok, JSON.stringify(merged)).toBe(true);

    let done = false;
    const lift = withTransaction(lifter.session, async () =>
      await recordAdminSupersession(userContext(lifter.session, seeded.alpha, 'admin'), {
        eventId: stopId,
        reason: 'documented_reconsent',
        commandId: randomUUID(),
      }),
    ).finally(() => {
      done = true;
    });
    let sawBlocked = false;
    for (let attempt = 0; attempt < 200 && !done; attempt += 1) {
      if (await blockedBehind(lifter.pid, merger.pid)) {
        sawBlocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await merger.session.query('COMMIT');
    const lifted = await lift;
    expect(lifted.ok, JSON.stringify(lifted)).toBe(true);

    // The survivor's copy is lifted, linked to the copy, and nothing of the stop is effective
    // on either firm.
    const copyLift = await database.session.query<{ event_id: string }>(
      'SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2',
      [seeded.alpha.workspaceId, `merge:${stopId}`],
    );
    expect(copyLift.rows.map(row => row.event_id)).toEqual([`merge:${lifted.ok ? lifted.value.supersessionEventId : ''}`]);
    const effective = await database.session.query(
      `SELECT event_id FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = ANY($2::text[])`,
      [seeded.alpha.workspaceId, [source.firmId, target.firmId]],
    );
    expect(effective.rows).toEqual([]);
    expect(sawBlocked).toBe(true);
  });
});
