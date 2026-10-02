import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { SuppressionJournal, SuppressionJournalRecord } from '@fss/domain/suppression/journal.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

/**
 * RC1 (brief RF, defect R1): two admin supersessions of one event, with different command
 * ids, on two real connections and interleaved.
 *
 * The partial unique index `suppression_events_one_direct_supersession` (0001) lets one of
 * them win. The loser must be a clean refusal: `already_superseded`, its command receipt
 * written, and no journal object of its own — a journal object for a supersession that does
 * not exist is a lift a restore replay would try to apply.
 *
 * Each command runs through `dispatch` on its own backend, so the receipt INSERT is the real
 * one `runCommand` makes after the work. The interleaving is forced with a journal that
 * holds the first append until the test releases it, and the second command's wait is
 * observed through `pg_blocking_pids` rather than inferred from an outcome.
 */

/** A journal that records every append and can hold the next one until released. */
function gatedJournal(): {
  readonly journal: SuppressionJournal;
  readonly appended: SuppressionJournalRecord[];
  holdNext(): { readonly reached: Promise<void>; release(): void };
} {
  const appended: SuppressionJournalRecord[] = [];
  let gate: { reached: () => void; wait: Promise<void> } | null = null;
  return {
    appended,
    holdNext() {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>(resolve => (reached = resolve));
      const wait = new Promise<void>(resolve => (release = resolve));
      gate = { reached, wait };
      return { reached: reachedPromise, release };
    },
    journal: {
      async append(record: SuppressionJournalRecord): Promise<void> {
        const held = gate;
        gate = null;
        if (held !== null) {
          held.reached();
          await held.wait;
        }
        appended.push(record);
      },
    },
  };
}

describe('RC1: two admin supersessions of one event, interleaved on two connections', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;
  let firmId: string;
  const clients: pg.Client[] = [];

  async function connection(): Promise<{ readonly session: SessionQueryable; readonly pid: number }> {
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${fixture.database.name}`;
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

  const post = async (
    session: SessionQueryable,
    journal: SuppressionJournal,
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body: { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body },
    };
    const result = await dispatch(request, {
      session,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
      auth: { ...fixture.deps, db: session },
      upgradeUrl: 'https://callie.example/downloads/mac',
      suppressionJournal: journal,
    });
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  /** Whether `waiter` is blocked behind `blocker`. */
  async function blockedBehind(waiter: number, blocker: number): Promise<boolean> {
    const { rows } = await fixture.db.query<{ blocked: boolean }>(
      'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiter, blocker],
    );
    return rows[0]?.blocked === true;
  }

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    firmId = await seedFirm(fixture, {
      name: 'Supersession Race Partners',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    await fixture.stop();
  });

  it('one wins, the other is a clean already_superseded with its receipt, and one journal object supersedes the event', async () => {
    const gated = gatedJournal();
    const recorded = await post(fixture.db, gated.journal, '/suppressions/record', salespersonToken, {
      scope: 'firm',
      firmId,
      source: 'prospect_do_not_call',
      channel: 'phone',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    const eventId = String((recorded.body['result'] as { eventId: string }).eventId);

    const first = await connection();
    const second = await connection();
    const firstCommand = randomUUID();
    const secondCommand = randomUUID();

    // The first supersession stops at its journal append, wherever that append is.
    const held = gated.holdNext();
    const firstAnswer = post(first.session, gated.journal, '/suppressions/supersede', adminToken, {
      commandId: firstCommand,
      eventId,
      reason: 'correction',
    });
    await held.reached;

    // The second runs until it is either done or waiting on the first.
    let secondDone = false;
    const secondAnswer = post(second.session, gated.journal, '/suppressions/supersede', adminToken, {
      commandId: secondCommand,
      eventId,
      reason: 'correction',
    }).finally(() => {
      secondDone = true;
    });
    let sawBlocked = false;
    for (let attempt = 0; attempt < 200 && !secondDone; attempt += 1) {
      if (await blockedBehind(second.pid, first.pid)) {
        sawBlocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    held.release();

    const answers = await Promise.all([firstAnswer, secondAnswer]);
    const statuses = answers.map(answer => answer.status).sort();
    expect(statuses, JSON.stringify(answers.map(answer => answer.body))).toEqual([200, 409]);
    const refused = answers.find(answer => answer.status === 409);
    expect(refused?.body['reason'] ?? refused?.body['error']).toBe('already_superseded');

    // Exactly one supersession row and exactly one journal object superseding the event.
    const rows = await fixture.db.query<{ event_id: string }>(
      'SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2',
      [fixture.alpha.workspaceId, eventId],
    );
    expect(rows.rows).toHaveLength(1);
    const objects = gated.appended.filter(record => record.supersedesEventId === eventId);
    expect(objects.map(record => record.eventId)).toEqual([rows.rows[0]?.event_id]);

    // Both commands have their receipts: the winner's acceptance and the loser's refusal.
    const receipts = await fixture.db.query<{ command_id: string; result_status: string }>(
      'SELECT command_id, result_status FROM command_receipts WHERE workspace_id = $1 AND command_id = ANY($2::text[]) ORDER BY result_status',
      [fixture.alpha.workspaceId, [firstCommand, secondCommand]],
    );
    expect(receipts.rows.map(row => row.result_status)).toEqual(['accepted', 'refused']);
    // And the race was a race: the second waited on the first's index entry.
    expect(sawBlocked).toBe(true);
  });

  it('a supersession after one has committed is refused before anything is journalled', async () => {
    const gated = gatedJournal();
    const recorded = await post(fixture.db, gated.journal, '/suppressions/record', salespersonToken, {
      scope: 'firm',
      firmId,
      source: 'prospect_do_not_call',
      channel: 'all',
    });
    const eventId = String((recorded.body['result'] as { eventId: string }).eventId);
    const lifted = await post(fixture.db, gated.journal, '/suppressions/supersede', adminToken, { eventId, reason: 'correction' });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    const again = randomUUID();
    const refused = await post(fixture.db, gated.journal, '/suppressions/supersede', adminToken, {
      commandId: again,
      eventId,
      reason: 'documented_reconsent',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(gated.appended.filter(record => record.supersedesEventId === eventId)).toHaveLength(1);
    const receipt = await fixture.db.query<{ result_status: string }>(
      'SELECT result_status FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, again],
    );
    expect(receipt.rows.map(row => row.result_status)).toEqual(['refused']);
  });

  it('a correction racing an admin supersession loses cleanly: its claim is taken back, no journal object, its receipt written', async () => {
    const gated = gatedJournal();
    const recorded = await post(fixture.db, gated.journal, '/suppressions/record', salespersonToken, {
      scope: 'firm',
      firmId,
      source: 'salesperson_manual',
      channel: 'all',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    const eventId = String((recorded.body['result'] as { eventId: string }).eventId);

    const admin = await connection();
    const salesperson = await connection();
    const held = gated.holdNext();
    const lift = post(admin.session, gated.journal, '/suppressions/supersede', adminToken, { eventId, reason: 'correction' });
    await held.reached;
    const correctionCommand = randomUUID();
    let done = false;
    const correction = post(salesperson.session, gated.journal, '/suppressions/correct', salespersonToken, {
      commandId: correctionCommand,
      eventId,
    }).finally(() => {
      done = true;
    });
    let sawBlocked = false;
    for (let attempt = 0; attempt < 200 && !done; attempt += 1) {
      if (await blockedBehind(salesperson.pid, admin.pid)) {
        sawBlocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    held.release();
    const [lifted, corrected] = await Promise.all([lift, correction]);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(409);
    expect(corrected.body['reason'] ?? corrected.body['error']).toBe('already_superseded');
    expect(sawBlocked).toBe(true);
    // Only the admin's supersession is journalled, and the correction's claim did not survive.
    expect(gated.appended.filter(record => record.supersedesEventId === eventId).map(record => record.source)).toEqual(['admin_supersession']);
    const claims = await fixture.db.query('SELECT 1 FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2', [
      fixture.alpha.workspaceId,
      eventId,
    ]);
    expect(claims.rows).toHaveLength(0);
    const receipt = await fixture.db.query<{ result_status: string }>(
      'SELECT result_status FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, correctionCommand],
    );
    expect(receipt.rows.map(row => row.result_status)).toEqual(['refused']);
  });
});
