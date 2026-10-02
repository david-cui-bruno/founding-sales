import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { SuppressionJournal, SuppressionJournalRecord } from '@fss/domain/suppression/journal.ts';
import { recordingLogger, type Logger } from '../src/bootstrap/log.ts';
import { journalCommittedLifts } from '../src/routes/suppressions.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { replaySuppressionJournal } from '@fss/domain/suppression/replay.ts';
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
 * one `runCommand` makes after the work. The interleaving is forced by holding the first
 * command at its receipt write, and the second command's wait is observed through
 * `pg_blocking_pids` rather than inferred from an outcome.
 */

/** A journal that records every append. */
function gatedJournal(): { readonly journal: SuppressionJournal; readonly appended: SuppressionJournalRecord[] } {
  const appended: SuppressionJournalRecord[] = [];
  return {
    appended,
    journal: {
      async append(record: SuppressionJournalRecord): Promise<void> {
        appended.push(record);
        await Promise.resolve();
      },
    },
  };
}

/**
 * A session that stops at its command's receipt INSERT — the last statement of the command
 * transaction, after the supersession row — until the test releases it. Since review P1 a
 * lift is journalled after the commit, so the journal is no longer where a transaction can be
 * held open; the receipt write is.
 */
function heldAtReceipt(session: SessionQueryable): { readonly session: SessionQueryable; readonly reached: Promise<void>; release(): void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>(resolve => (reached = resolve));
  const wait = new Promise<void>(resolve => (release = resolve));
  let holding = true;
  return {
    reached: reachedPromise,
    release,
    session: {
      async query(text: string, values?: readonly unknown[]) {
        if (holding && text.includes('INSERT INTO command_receipts')) {
          holding = false;
          reached();
          await wait;
        }
        return await session.query(text, values);
      },
    } as unknown as SessionQueryable,
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
    log?: Logger,
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
      ...(log === undefined ? {} : { log }),
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

    // The first supersession stops at its receipt write, its row written and uncommitted.
    const held = heldAtReceipt(first.session);
    const firstAnswer = post(held.session, gated.journal, '/suppressions/supersede', adminToken, {
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
    // And the race was a race: the second waited on the first (on the stop-history lock since
    // review P2; the one-supersession index and the savepoint stay behind it).
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
    const held = heldAtReceipt(admin.session);
    const lift = post(held.session, gated.journal, '/suppressions/supersede', adminToken, { eventId, reason: 'correction' });
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

describe('review P1: a lift is journalled only after its command commits', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;
  let firmId: string;

  const post = async (
    session: SessionQueryable,
    journal: SuppressionJournal,
    path: string,
    token: string,
    body: Record<string, unknown>,
    log?: Logger,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      {
        method: 'POST',
        path,
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
        body: { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body },
      },
      {
        session,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
        auth: { ...fixture.deps, db: session },
        upgradeUrl: 'https://callie.example/downloads/mac',
        suppressionJournal: journal,
        ...(log === undefined ? {} : { log }),
      },
    );
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  /** A journal that records every append and fails the first `failures` of them. */
  const failing = (failures: number): SuppressionJournal & { readonly appended: SuppressionJournalRecord[]; attempts: number } => {
    const appended: SuppressionJournalRecord[] = [];
    const journal = {
      appended,
      attempts: 0,
      async append(record: SuppressionJournalRecord): Promise<void> {
        journal.attempts += 1;
        if (journal.attempts <= failures) throw new Error('the journal is down');
        appended.push(record);
        await Promise.resolve();
      },
    };
    return journal;
  };

  const stop = async (journal: SuppressionJournal): Promise<string> => {
    const recorded = await post(fixture.db, journal, '/suppressions/record', salespersonToken, {
      scope: 'firm',
      firmId,
      source: 'prospect_do_not_call',
      channel: 'all',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    return String((recorded.body['result'] as { eventId: string }).eventId);
  };

  const liftsOf = async (eventId: string): Promise<number> =>
    (
      await fixture.db.query('SELECT 1 FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2', [
        fixture.alpha.workspaceId,
        eventId,
      ])
    ).rows.length;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    firmId = await seedFirm(fixture, {
      name: 'Lift Journal Partners',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('a command that fails at its receipt write, after the lift row, leaves the stop and no journal lift', async () => {
    const journal = failing(0);
    const eventId = await stop(journal);
    // The fault is the receipt INSERT, the last statement of the command transaction.
    const faulty = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes('INSERT INTO command_receipts')) throw new Error('the receipt write failed');
        return await fixture.db.query(text, values);
      },
    } as unknown as SessionQueryable;
    const answer = await post(faulty, journal, '/suppressions/supersede', adminToken, { eventId, reason: 'correction' }).then(
      reply => reply.status,
      () => 'threw',
    );
    expect(answer).not.toBe(200);
    expect(await liftsOf(eventId)).toBe(0);
    expect(journal.appended.filter(record => record.supersedesEventId === eventId)).toEqual([]);
  });

  it('a committed lift is journalled once, after a failed attempt, and a replayed receipt journals nothing', async () => {
    const journal = failing(0);
    const eventId = await stop(journal);
    const flaky = failing(1);
    const commandId = randomUUID();
    const lifted = await post(fixture.db, flaky, '/suppressions/supersede', adminToken, { commandId, eventId, reason: 'correction' });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(flaky.appended.map(record => record.supersedesEventId)).toEqual([eventId]);
    // The journal record is the route's, not the client's: the answer carries no record.
    expect(lifted.body['result']).not.toHaveProperty('journalRecord');
    const again = await post(fixture.db, flaky, '/suppressions/supersede', adminToken, { commandId, eventId, reason: 'correction' });
    expect(again.body['replayed']).toBe(true);
    expect(flaky.appended).toHaveLength(1);
  });

  it('a lift whose journal write never succeeds stays committed and is logged by id', async () => {
    const journal = failing(0);
    const eventId = await stop(journal);
    const down = failing(Number.POSITIVE_INFINITY);
    const log = recordingLogger();
    const lifted = await post(fixture.db, down, '/suppressions/supersede', adminToken, { eventId, reason: 'correction' }, log);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(await liftsOf(eventId)).toBe(1);
    const line = log.lines.find(entry => entry['event'] === 'suppression_lift_unjournalled');
    expect(line).toMatchObject({ level: 'error', event_id: expect.stringMatching(/^sup_/u), supersedes_event_id: eventId });
    expect(down.attempts).toBe(3);
  });

  it('journals nothing for a refusal, or for an acceptance that is another command’s receipt', async () => {
    const journal = failing(0);
    const lifted: SuppressionJournalRecord = {
      eventId: 'sup_never',
      workspaceId: fixture.alpha.workspaceId,
      scope: 'firm',
      canonicalKey: firmId,
      canonicalizerVersion: 'e164-lower.1',
      source: 'admin_supersession',
      actorUserId: null,
      commandId: null,
      supersedesEventId: 'sup_x',
      supersessionReason: 'correction',
      recordedAt: new Date().toISOString(),
      channel: 'all',
    };
    await journalCommittedLifts(journal, [lifted], { status: 409, body: { status: 'refused', replayed: false, reason: 'already_superseded' } }, undefined, []);
    // A replay: the work that set the record may have rolled back under a racing receipt.
    await journalCommittedLifts(journal, [lifted], { status: 200, body: { status: 'accepted', replayed: true, result: null } }, undefined, []);
    expect(journal.appended).toEqual([]);
    await journalCommittedLifts(journal, [lifted], { status: 200, body: { status: 'accepted', replayed: false, result: null } }, undefined, []);
    expect(journal.appended).toEqual([{ ...lifted, committed: true }]);
  });
});

describe('RF reset J1: a merge that fails to commit leaves at most an extra stop, never a missing one', () => {
  let fixture: AuthFixture;
  let adminToken: string;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  const post = async (session: SessionQueryable, journal: SuppressionJournal, path: string, body: Record<string, unknown>) =>
    await dispatch(
      {
        method: 'POST',
        path,
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${adminToken}` },
        body: { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body },
      },
      {
        session,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
        auth: { ...fixture.deps, db: session },
        upgradeUrl: 'https://callie.example/downloads/mac',
        suppressionJournal: journal,
      },
    );

  it('the copied stop is in the journal before the commit, and a replay can only add it', async () => {
    const appended: SuppressionJournalRecord[] = [];
    const journal: SuppressionJournal = {
      async append(record) {
        appended.push(record);
        await Promise.resolve();
      },
    };
    const firm = { regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId };
    const sourceFirmId = await seedFirm(fixture, { name: 'Merged Away Partners', ...firm });
    const targetFirmId = await seedFirm(fixture, { name: 'Surviving Partners', ...firm });
    const stopped = await post(fixture.db, journal, '/suppressions/record', { scope: 'firm', firmId: sourceFirmId, source: 'prospect_do_not_call', channel: 'all' });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const stopId = String(((stopped.body as Record<string, unknown>)['result'] as { eventId: string }).eventId);

    // The merge's last statement, the receipt, fails: the merge and its copy roll back.
    const faulty = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes('INSERT INTO command_receipts')) throw new Error('the receipt write failed');
        return await fixture.db.query(text, values);
      },
    } as unknown as SessionQueryable;
    const merged = await post(faulty, journal, '/merges/firms', { sourceFirmId, targetFirmId }).then(
      reply => reply.status,
      () => 'threw',
    );
    expect(merged).not.toBe(200);
    const onTarget = async (): Promise<number> =>
      (
        await fixture.db.query(
          `SELECT 1 FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`,
          [fixture.alpha.workspaceId, targetFirmId],
        )
      ).rows.length;
    expect(await onTarget()).toBe(0);
    // The journal already holds the copy, under the survivor's key: a restore replay adds a
    // stop the database does not have (an extra one), and never loses one it does.
    const copy = appended.find(record => record.eventId === `merge:${stopId}`);
    expect(copy).toMatchObject({ scope: 'firm', canonicalKey: targetFirmId, supersedesEventId: null });
    const restore = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'migration' }), fixture.db);
    await withTransaction(fixture.db, async () => await replaySuppressionJournal(restore, { records: appended }));
    expect(await onTarget()).toBe(1);
  });

  it('a merge of a firm whose stop was lifted journals the copied lift after the commit, marked', async () => {
    const appended: SuppressionJournalRecord[] = [];
    const journal: SuppressionJournal = {
      async append(record) {
        appended.push(record);
        await Promise.resolve();
      },
    };
    const firm = { regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId };
    const sourceFirmId = await seedFirm(fixture, { name: 'Lifted Away Partners', ...firm });
    const targetFirmId = await seedFirm(fixture, { name: 'Lifted Survivor Partners', ...firm });
    const stopped = await post(fixture.db, journal, '/suppressions/record', { scope: 'firm', firmId: sourceFirmId, source: 'prospect_do_not_call', channel: 'all' });
    const stopId = String(((stopped.body as Record<string, unknown>)['result'] as { eventId: string }).eventId);
    const lifted = await post(fixture.db, journal, '/suppressions/supersede', { eventId: stopId, reason: 'documented_reconsent' });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    const liftId = String(((lifted.body as Record<string, unknown>)['result'] as { supersessionEventId: string }).supersessionEventId);
    const merged = await post(fixture.db, journal, '/merges/firms', { sourceFirmId, targetFirmId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(((merged.body as Record<string, unknown>)['result'] as Record<string, unknown>)['journalAfterCommit']).toBeUndefined();
    const copies = appended.filter(record => record.eventId.startsWith('merge:'));
    expect(copies.map(record => [record.eventId, record.committed ?? false])).toEqual([
      [`merge:${stopId}`, false],
      [`merge:${liftId}`, true],
    ]);
  });
});
