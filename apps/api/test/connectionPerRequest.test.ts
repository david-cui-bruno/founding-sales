import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db';
import type { SuppressionJournal, SuppressionJournalRecord } from '@fss/domain/suppression';
import { createApiServer } from '../src/server.ts';
import { createRequestPool, poolConnections, type RequestConnections } from '../src/bootstrap/connections.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import type { RouteModule } from '../src/bootstrap/routeRegistry.ts';
import { drainApi } from '../src/bootstrap/shutdown.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { databaseUrlOf, leased, testRequestPool } from './support/poolFixture.ts';

/**
 * One database connection per request (lane g75, audit item C01).
 *
 * Until this lane `bootstrap/main.ts` served every request on one `pg.Client`, and
 * `withTransaction` runs `BEGIN`, the work and `COMMIT` as separate statements on
 * whatever session it is given. node-postgres queues statements on a client; it does
 * not queue transactions. So while one request was inside its transaction waiting on
 * something — the suppression journal's S3 write, a Gmail or KMS call — a second
 * request's statements ran inside the first one's transaction.
 *
 * Every scenario here is made deterministic the same way: a request is stopped *inside*
 * its transaction on a gate the test holds, with no statement in flight, which is
 * exactly the moment the shared client was exposed. The other request runs to the end,
 * and only then does the test open the gate. Nothing waits on a clock except the
 * bounded polls, which fail rather than pass when they run out.
 *
 * The same two scenarios are also run on one shared connection — the shape this lane
 * replaced — and must lose the writes the pool keeps. That is what keeps the pool
 * assertions from passing vacuously: if the scenario ever stopped interleaving, the
 * control would stop losing writes and go red.
 */

interface Gate {
  /** Resolves when the request has reached the gate. */
  readonly reached: Promise<void>;
  release(): void;
  /** Called by the request: say it has arrived, then wait to be let through. */
  arrive(): Promise<void>;
}

function gate(): Gate {
  let reach: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return {
    reached,
    release: () => open(),
    arrive: async () => {
      reach();
      await opened;
    },
  };
}

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

/** Poll until `done` or five seconds. Returns whether it happened. */
async function eventually(done: () => boolean | Promise<boolean>): Promise<boolean> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await done()) return true;
    await sleep(20);
  }
  return false;
}

/** A suppression journal whose next append can be held — the S3 write, awaited inside the command. */
function gatedJournal(): SuppressionJournal & { holdNext(): Gate; readonly appended: string[] } {
  const appended: string[] = [];
  const holds: Gate[] = [];
  return {
    appended,
    holdNext: () => {
      const next = gate();
      holds.push(next);
      return next;
    },
    async append(record: SuppressionJournalRecord): Promise<void> {
      await holds.shift()?.arrive();
      appended.push(record.eventId);
    },
  };
}

/** The shape lane g75 replaced: every request handed the same backend, nothing ever given back. */
function oneSharedConnection(client: pg.Client): RequestConnections {
  const session: SessionQueryable = {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
  return { checkout: async () => await Promise.resolve({ session, release: () => undefined }) };
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function send(origin: string, method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<Answer> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('one database connection per request', () => {
  let fixture: AuthFixture;
  let journal: ReturnType<typeof gatedJournal>;
  let pool: pg.Pool;
  let sharedClient: pg.Client;
  let assigneeToken: string;
  let firmId: string;
  const holds = new Map<string, Gate>();
  const closers: (() => Promise<void>)[] = [];

  const hold = (label: string): Gate => {
    const held = gate();
    holds.set(label, held);
    return held;
  };

  /**
   * Four test-only commands, each a real `withTransaction` on the request's own
   * connection (`request.db`), mounted through `extraRoutes` beside the real ones.
   */
  const probe: RouteModule = {
    name: 'g75-probe',
    paths: ['/probe/commit', '/probe/rollback', '/probe/throw', '/probe/abandon'],
    handle: async request => {
      const label = String(request.body?.['label'] ?? '');
      const db = request.db;
      if (request.path === '/probe/throw') {
        await db.query('SELECT 1');
        throw new Error('the probe failed after its first statement');
      }
      if (request.path === '/probe/abandon') {
        // A route that opens a transaction and returns without closing it.
        await db.query('BEGIN');
        await db.query('INSERT INTO g75_probe (label) VALUES ($1)', [label]);
        return { status: 200, body: { label } };
      }
      await withTransaction(db, async () => {
        await db.query('INSERT INTO g75_probe (label) VALUES ($1)', [label]);
        await holds.get(label)?.arrive();
        if (request.path === '/probe/rollback') throw new Error('the probe rolls back');
      });
      return { status: 200, body: { label } };
    },
  };

  const serve = async (
    connections: RequestConnections,
  ): Promise<{ origin: string; server: Server; log: ReturnType<typeof recordingLogger> }> => {
    const log = recordingLogger();
    const server = createApiServer({
      connections,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
      expectedSystemGeneration: null,
      auth: fixture.deps,
      suppressionJournal: journal,
      extraRoutes: [probe],
      log,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    closers.push(
      async () =>
        await new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { origin: `http://127.0.0.1:${String(port)}`, server, log };
  };

  const labels = async (prefix: string): Promise<string[]> => {
    const { rows } = await fixture.db.query<{ label: string }>(
      'SELECT label FROM g75_probe WHERE label LIKE $1 ORDER BY label',
      [`${prefix}%`],
    );
    return rows.map(row => row.label);
  };

  const command = (extra: Record<string, unknown>): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    journal = gatedJournal();
    await fixture.db.query('CREATE TABLE g75_probe (label text PRIMARY KEY)');
    pool = testRequestPool(fixture.database);
    sharedClient = new pg.Client({ connectionString: databaseUrlOf(fixture.database) });
    await sharedClient.connect();

    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Assignee Mac' }))
      .accessToken;
    // Set up on the fixture's own session, as every route test does.
    firmId = await seedFirm(fixture, {
      name: 'Harbor Lane Test Partners',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
  });

  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
    if (!pool.ended && !pool.ending) await pool.end();
    await sharedClient.end();
    await fixture.stop();
  });

  describe('two overlapping commands, one rolling back and one committing', () => {
    it('a request that rolls back does not keep its write by riding another request’s COMMIT', async () => {
      const { origin } = await serve(poolConnections(pool));
      const held = hold('pool-a-rolled-back');
      const rolledBack = send(origin, 'POST', '/probe/rollback', { label: 'pool-a-rolled-back' });
      // Inside its transaction, its row written, no statement in flight.
      await held.reached;

      const committed = await send(origin, 'POST', '/probe/commit', { label: 'pool-a-committed' });
      expect(committed.status).toBe(200);

      held.release();
      expect((await rolledBack).status).toBe(500);
      expect(await labels('pool-a-')).toEqual(['pool-a-committed']);
      expect(leased(pool)).toBe(0);
    });

    it('a request that answered 200 keeps its write when another request rolls back', async () => {
      const { origin } = await serve(poolConnections(pool));
      const held = hold('pool-b-committed');
      const committed = send(origin, 'POST', '/probe/commit', { label: 'pool-b-committed' });
      await held.reached;

      const rolledBack = await send(origin, 'POST', '/probe/rollback', { label: 'pool-b-rolled-back' });
      expect(rolledBack.status).toBe(500);

      held.release();
      expect((await committed).status).toBe(200);
      expect(await labels('pool-b-')).toEqual(['pool-b-committed']);
      expect(leased(pool)).toBe(0);
    });

    it('the one shared connection this replaced loses exactly those writes', async () => {
      // The control. Same two scenarios, one backend for every request.
      const { origin } = await serve(oneSharedConnection(sharedClient));

      const heldA = hold('shared-a-rolled-back');
      const rolledBackA = send(origin, 'POST', '/probe/rollback', { label: 'shared-a-rolled-back' });
      await heldA.reached;
      // Its BEGIN is a no-op inside the open transaction, so its COMMIT commits both rows.
      expect((await send(origin, 'POST', '/probe/commit', { label: 'shared-a-committed' })).status).toBe(200);
      heldA.release();
      expect((await rolledBackA).status).toBe(500);
      expect(await labels('shared-a-')).toEqual(['shared-a-committed', 'shared-a-rolled-back']);

      const heldB = hold('shared-b-committed');
      const committedB = send(origin, 'POST', '/probe/commit', { label: 'shared-b-committed' });
      await heldB.reached;
      // Its ROLLBACK ends the other request's transaction too.
      expect((await send(origin, 'POST', '/probe/rollback', { label: 'shared-b-rolled-back' })).status).toBe(500);
      heldB.release();
      // 200, and its row is gone: the COMMIT found no transaction to commit.
      expect((await committedB).status).toBe(200);
      expect(await labels('shared-b-')).toEqual([]);
    });

    it('a real command waits for the row lock another request holds instead of running inside its transaction', async () => {
      // Two do-not-call suppressions on one firm, through sign-in, `runCommand` and its
      // receipt. `recordSuppression` locks the firm row FOR UPDATE and then awaits the
      // journal inside the command's transaction; the first request is held there. On
      // its own connection the second must wait for that lock. On the shared one it was
      // the same transaction, already "held" the lock, and ran straight through.
      const { origin } = await serve(poolConnections(pool));
      const contactId = await seedContact(fixture, { firmId, fullName: 'Pat Example' });
      const routeFor = async (value: string): Promise<string> => {
        const added = await send(
          origin,
          'POST',
          '/contacts/routes/add',
          command({ firmId, contactId, routeKind: 'phone', value, source: 'salesperson' }),
          assigneeToken,
        );
        expect(added.status).toBe(200);
        return String((added.body['result'] as { id: string }).id);
      };
      const firstRoute = await routeFor('+14015550194');
      const secondRoute = await routeFor('+14015550195');
      const first = journal.holdNext();
      const firstCommand = command({ firmId, contactId, routeId: firstRoute, outcome: 'do_not_call' });
      const secondCommand = command({ firmId, contactId, routeId: secondRoute, outcome: 'do_not_call' });

      const firstAnswer = send(origin, 'POST', '/calls/log', firstCommand, assigneeToken);
      await first.reached;

      let secondSettled = false;
      const secondAnswer = send(origin, 'POST', '/calls/log', secondCommand, assigneeToken).finally(() => {
        secondSettled = true;
      });
      const waited = await eventually(async () => {
        if (secondSettled) return true;
        const { rows } = await fixture.db.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return (rows[0]?.waiting ?? 0) > 0;
      });
      expect(waited).toBe(true);
      expect(secondSettled).toBe(false);

      first.release();
      expect((await firstAnswer).status).toBe(200);
      expect((await secondAnswer).status).toBe(200);
      const receipts = await fixture.db.query<{ command_id: string }>(
        `SELECT command_id::text AS command_id FROM command_receipts
          WHERE workspace_id = $1 AND command_id::text = ANY($2::text[])`,
        [fixture.alpha.workspaceId, [firstCommand['commandId'], secondCommand['commandId']]],
      );
      expect(receipts.rowCount).toBe(2);
      expect(leased(pool)).toBe(0);
    });
  });

  describe('the connection goes back', () => {
    it('a request that throws gives its connection back to the pool', async () => {
      const { origin } = await serve(poolConnections(pool));
      // Warm, so the baseline is a pool that already has an idle connection to lend.
      expect((await send(origin, 'POST', '/probe/commit', { label: 'leak-warm' })).status).toBe(200);
      const baseline = { total: pool.totalCount, idle: pool.idleCount };
      expect(baseline.idle).toBe(baseline.total);

      const failed = await send(origin, 'POST', '/probe/throw', {});
      expect(failed.status).toBe(500);
      expect(failed.body['error']).toBe('internal_error');
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual(baseline);
      expect(leased(pool)).toBe(0);

      const again = await send(origin, 'POST', '/probe/throw', {});
      expect(again.status).toBe(500);
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual(baseline);
    });

    it('a connection left inside a transaction is discarded, not lent to the next request', async () => {
      const discardLog = recordingLogger();
      const { origin: watched } = await serve(poolConnections(pool, discardLog));
      const before = pool.totalCount;

      expect((await send(watched, 'POST', '/probe/abandon', { label: 'abandoned' })).status).toBe(200);
      expect(leased(pool)).toBe(0);
      expect(pool.totalCount).toBe(Math.max(0, before - 1));
      expect(discardLog.lines.some(line => line['event'] === 'api_connection_discarded' && line['transaction_status'] === 'T')).toBe(
        true,
      );

      // The next request runs in a transaction of its own, and the abandoned row was
      // never committed.
      expect((await send(watched, 'POST', '/probe/commit', { label: 'after-abandon' })).status).toBe(200);
      expect(await labels('abandoned')).toEqual([]);
      expect(await labels('after-abandon')).toEqual(['after-abandon']);
    });
  });

  describe('when there is no connection to be had', () => {
    it('answers 503 database_busy inside the checkout timeout rather than hanging', async () => {
      const tiny = testRequestPool(fixture.database, { max: 1, checkoutTimeoutMilliseconds: 250 });
      const { origin, log } = await serve(poolConnections(tiny));
      const taken = await tiny.connect();
      try {
        const started = Date.now();
        const refused = await send(origin, 'GET', '/firms', undefined, assigneeToken);
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(refused.status).toBe(503);
        expect(refused.body).toEqual({ error: 'database_busy', message: 'The API is busy. Nothing was changed; try again.' });
        expect(log.lines).toContainEqual(expect.objectContaining({ event: 'refusal', reason: 'database_busy', path: '/firms' }));
        expect(log.lines.some(line => line['event'] === 'request_failed')).toBe(false);

        // Readiness says so truthfully; liveness needs no connection and still answers.
        const readiness = await send(origin, 'GET', '/readyz');
        expect(readiness.status).toBe(503);
        expect(readiness.body).toMatchObject({ ready: false, reason: 'database_busy' });
        expect((await send(origin, 'GET', '/healthz')).status).toBe(200);
      } finally {
        taken.release();
      }

      expect((await send(origin, 'GET', '/firms', undefined, assigneeToken)).status).toBe(200);
      expect(leased(tiny)).toBe(0);
      await tiny.end();
    });

    it('logs an idle connection whose backend died, drops it, and connects afresh', async () => {
      const log = recordingLogger();
      const watched = testRequestPool(fixture.database, { log });
      const client = await watched.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      client.release();
      await fixture.db.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);

      expect(await eventually(() => log.lines.some(line => line['event'] === 'api_pool_client_error'))).toBe(true);
      expect(log.lines.find(line => line['event'] === 'api_pool_client_error')?.['level']).toBe('warn');
      expect(await eventually(() => watched.totalCount === 0)).toBe(true);
      const fresh = await watched.connect();
      await fresh.query('SELECT 1');
      fresh.release();
      await watched.end();
    });
  });

  describe('readiness on the pool', () => {
    it('is ready on a checked-out connection and gives it back', async () => {
      const { origin } = await serve(poolConnections(pool));
      const ready = await send(origin, 'GET', '/readyz');
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({ ready: true, reason: null });
      expect(leased(pool)).toBe(0);
    });

    it('reports database_unreachable when the pool cannot connect at all, and liveness still answers', async () => {
      const log = recordingLogger();
      const nowhere = createRequestPool('postgresql://nobody@127.0.0.1:1/nothing', log, { checkoutTimeoutMilliseconds: 2_000 });
      const { origin } = await serve(poolConnections(nowhere));
      const readiness = await send(origin, 'GET', '/readyz');
      expect(readiness.status).toBe(503);
      expect(readiness.body).toMatchObject({ ready: false, reason: 'database_unreachable' });
      expect((await send(origin, 'GET', '/healthz')).status).toBe(200);
      await nowhere.end();
    });
  });

  describe('stopping', () => {
    const quietHeartbeat = (): { stopped: boolean; ended: boolean; stop(): Promise<void>; end(): Promise<void> } => {
      const state = {
        stopped: false,
        ended: false,
        stop: async () => {
          state.stopped = true;
          await Promise.resolve();
        },
        end: async () => {
          state.ended = true;
          await Promise.resolve();
        },
      };
      return state;
    };

    it('waits for the request in flight, then ends the pool and the heartbeat', async () => {
      const draining = testRequestPool(fixture.database);
      const { origin, server } = await serve(poolConnections(draining));
      const heartbeat = quietHeartbeat();
      const held = hold('drain-in-flight');
      const inFlight = send(origin, 'POST', '/probe/commit', { label: 'drain-in-flight' });
      await held.reached;

      let settled = false;
      const drain = drainApi({
        server,
        pool: draining,
        heartbeat,
        heartbeatClient: heartbeat,
        timeoutMilliseconds: 10_000,
        log: recordingLogger(),
      }).finally(() => {
        settled = true;
      });
      await sleep(200);
      expect(settled).toBe(false);
      expect(draining.ending).toBe(false);

      held.release();
      expect((await inFlight).status).toBe(200);
      expect(await drain).toEqual({ drained: true });
      expect(draining.ended).toBe(true);
      expect(heartbeat.stopped && heartbeat.ended).toBe(true);
      expect(await labels('drain-in-flight')).toEqual(['drain-in-flight']);
    });

    it('stops waiting at the deadline and says it did not drain', async () => {
      const draining = testRequestPool(fixture.database);
      const { origin, server } = await serve(poolConnections(draining));
      const heartbeat = quietHeartbeat();
      const held = hold('drain-late');
      const inFlight = send(origin, 'POST', '/probe/commit', { label: 'drain-late' });
      await held.reached;

      const log = recordingLogger();
      const started = Date.now();
      const report = await drainApi({
        server,
        pool: draining,
        heartbeat,
        heartbeatClient: heartbeat,
        timeoutMilliseconds: 300,
        log,
      });
      expect(report).toEqual({ drained: false });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(log.lines).toContainEqual(expect.objectContaining({ event: 'api_drained', level: 'warn', drained: false }));

      // The request still finishes and its connection still comes back, to a pool
      // that is now ending.
      held.release();
      expect((await inFlight).status).toBe(200);
      expect(await eventually(() => draining.ended)).toBe(true);
    });
  });
});
